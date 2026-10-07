import { randomUUID } from 'node:crypto';
import { constants, type Dir } from 'node:fs';
import { mkdir, open, opendir, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import sharp from 'sharp';
import { z } from 'zod';
import type { Config } from './config.js';
import { transaction } from './db.js';
import { ApiError, owner, seller } from './http.js';

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_PIXELS = 25_000_000;
const MAX_DIMENSION = 8192;
const storagePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpeg|png|webp)$/;
const mimeByFormat: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const mediaParams = z.object({ id: z.uuid() });
interface MediaRow { id: string; user_id: string; kind: 'product' | 'evidence'; storage_key: string; mime: string; published: boolean }
interface DecodedImage { bytes: Buffer; format: string; mime: string }
const sweeps = new Map<string, { running: boolean; directory: Dir | null }>();

async function decodeImage(bytes: Buffer): Promise<DecodedImage> {
  try {
    const options = { failOn: 'warning' as const, limitInputPixels: MAX_PIXELS };
    const image = sharp(bytes, options);
    const metadata = await image.metadata();
    const format = metadata.format;
    if (!format || !mimeByFormat[format] || !metadata.width || !metadata.height ||
        metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION ||
        metadata.width * metadata.height > MAX_PIXELS || (metadata.pages ?? 1) !== 1) {
      throw new Error('Unsupported image dimensions or format');
    }
    const normalized = await image.rotate().toFormat(format).toBuffer();
    if (!normalized.length || normalized.length > MAX_FILE_SIZE) throw new Error('Image too large after decoding');
    return { bytes: normalized, format, mime: mimeByFormat[format]! };
  } catch {
    throw new ApiError(400, 'invalid_image', 'Upload a valid single-frame JPEG, PNG, or WebP image, at most 10 MiB, 8192 pixels per side and 25 megapixels.');
  }
}

export async function validateStoredProductImage(config: Config, media: { storage_key: string; mime: string }): Promise<void> {
  if (!storagePattern.test(media.storage_key)) throw new ApiError(400, 'invalid_image', 'A selected product image is unavailable. Upload it again.');
  let file: FileHandle | undefined;
  try {
    file = await open(join(config.mediaDir, media.storage_key), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_FILE_SIZE) throw new Error('Invalid stored file');
    const image = await decodeImage(await file.readFile());
    if (image.mime !== media.mime) throw new Error('Invalid stored media type');
  } catch {
    throw new ApiError(400, 'invalid_image', 'A selected product image is missing or invalid. Upload it again.');
  } finally { await file?.close(); }
}

async function sendImage(reply: FastifyReply, media: MediaRow, config: Config): Promise<FastifyReply> {
  if (!storagePattern.test(media.storage_key)) throw new ApiError(404, 'not_found', 'Image not found');
  let file: FileHandle;
  try {
    file = await open(join(config.mediaDir, media.storage_key), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new ApiError(404, 'not_found', 'Image not found');
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new ApiError(404, 'not_found', 'Image not found');
    reply.header('Content-Type', media.mime).header('Content-Length', info.size);
    reply.header('Content-Security-Policy', "default-src 'none'");
    reply.header('Cache-Control', 'no-store');
    return reply.send(file.createReadStream());
  } catch (error) { await file.close(); throw error; }
}

export async function registerMedia(app: FastifyInstance, pool: Pool, config: Config): Promise<void> {
  await mkdir(config.mediaDir, { recursive: true, mode: 0o700 });
  app.post('/api/media', async req => {
    if (!req.isMultipart()) throw new ApiError(400, 'invalid_upload', 'Upload one image with the kind field before the file.');
    let kind: 'product' | 'evidence' | undefined;
    let decoded: DecodedImage | undefined;
    for await (const part of req.parts({ limits: { fileSize: MAX_FILE_SIZE, files: 1, fields: 1, parts: 2 } })) {
      if (part.type === 'field') {
        if (part.fieldname !== 'kind' || kind || (part.value !== 'product' && part.value !== 'evidence')) {
          throw new ApiError(400, 'invalid_upload', 'The kind field must be product or evidence and precede the file.');
        }
        kind = part.value;
        if (kind === 'product') seller(req);
      } else {
        if (part.fieldname !== 'file' || !kind || decoded) {
          part.file.resume();
          throw new ApiError(400, 'invalid_upload', 'Upload one file after the kind field.');
        }
        const bytes = await part.toBuffer();
        if (part.file.truncated || !bytes.length || bytes.length > MAX_FILE_SIZE) throw new ApiError(413, 'file_too_large', 'The image must be no larger than 10 MiB.');
        decoded = await decodeImage(bytes);
      }
    }
    if (!kind || !decoded) throw new ApiError(400, 'invalid_upload', 'Select an image and its upload kind.');
    const id = randomUUID();
    const storageKey = `${id}.${decoded.format}`;
    const path = join(config.mediaDir, storageKey);
    await writeFile(path, decoded.bytes, { flag: 'wx', mode: 0o600 });
    try {
      await pool.query(`INSERT INTO media(id,user_id,kind,storage_key,mime) VALUES($1,$2,$3,$4,$5)`, [id, req.user.id, kind, storageKey, decoded.mime]);
    } catch (error) { await unlink(path).catch(() => undefined); throw error; }
    return { id, mime: decoded.mime };
  });
  app.get('/api/media/:id', async (req, reply) => {
    const { id } = mediaParams.parse(req.params);
    const result = await pool.query<MediaRow>(
      `SELECT m.*,EXISTS(SELECT 1 FROM product_images pi JOIN products p ON p.id=pi.product_id WHERE pi.media_id=m.id AND p.published) AS published FROM media m WHERE m.id=$1`, [id],
    );
    const media = result.rows[0];
    if (!media) throw new ApiError(404, 'not_found', 'Image not found');
    if (media.kind === 'evidence') owner(req, media.user_id);
    else if (!media.published && !req.user.isSeller) throw new ApiError(404, 'not_found', 'Image not found');
    return sendImage(reply, media, config);
  });
  app.get('/api/public-media/:id', async (req, reply) => {
    const { id } = mediaParams.parse(req.params);
    const result = await pool.query<MediaRow>(
      `SELECT m.* FROM media m WHERE m.id=$1 AND m.kind='product' AND EXISTS
       (SELECT 1 FROM product_images pi JOIN products p ON p.id=pi.product_id WHERE pi.media_id=m.id AND p.published)`, [id],
    );
    const media = result.rows[0];
    if (!media) throw new ApiError(404, 'not_found', 'Image not found');
    return sendImage(reply, media, config);
  });
}

export async function cleanupMedia(pool: Pool, config: Config): Promise<void> {
  let sweep = sweeps.get(config.mediaDir);
  if (!sweep) { sweep = { running: false, directory: null }; sweeps.set(config.mediaDir, sweep); }
  if (sweep.running) return;
  sweep.running = true;
  try {
    await mkdir(config.mediaDir, { recursive: true, mode: 0o700 });
    const deleted = await transaction(pool, async client => {
      const result = await client.query<{ id: string; storage_key: string }>(
        `SELECT m.id,m.storage_key FROM media m WHERE m.created_at<clock_timestamp()-interval '24 hours'
         AND NOT EXISTS(SELECT 1 FROM product_images pi WHERE pi.media_id=m.id)
         AND NOT EXISTS(SELECT 1 FROM payment_evidence pe WHERE pe.media_id=m.id)
         ORDER BY m.created_at,m.id LIMIT 100 FOR UPDATE OF m SKIP LOCKED`,
      );
      if (!result.rows.length) return result.rows;
      const removed = await client.query<{ id: string; storage_key: string }>(`DELETE FROM media m WHERE m.id=ANY($1::uuid[])
        AND NOT EXISTS(SELECT 1 FROM product_images pi WHERE pi.media_id=m.id)
        AND NOT EXISTS(SELECT 1 FROM payment_evidence pe WHERE pe.media_id=m.id)
        RETURNING m.id,m.storage_key`, [result.rows.map(row => row.id)]);
      return removed.rows;
    });
    for (const media of deleted) {
      if (storagePattern.test(media.storage_key)) await unlink(join(config.mediaDir, media.storage_key)).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
    // A persistent cursor bounds work without starving orphans beyond the first directory page.
    if (!sweep.directory) sweep.directory = await opendir(config.mediaDir);
    for (let count = 0; count < 100; count++) {
      const entry = await sweep.directory.read();
      if (!entry) { await sweep.directory.close(); sweep.directory = null; break; }
      if (!entry.isFile() || !storagePattern.test(entry.name)) continue;
      const path = join(config.mediaDir, entry.name);
      let info;
      try { info = await stat(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (info.mtimeMs > Date.now() - 24 * 60 * 60 * 1000) continue;
      if ((await pool.query('SELECT 1 FROM media WHERE storage_key=$1', [entry.name])).rowCount) continue;
      await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
  } catch (error) {
    await sweep.directory?.close().catch(() => undefined);
    sweep.directory = null;
    throw error;
  } finally { sweep.running = false; }
}
