import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { transaction } from './db.js';
import { ApiError, seller, version } from './http.js';
import { validateStoredProductImage } from './media.js';

const INT_MAX = 2147483647;
const fields = {
  name: z.string().trim().min(1).max(200),
  comment: z.string().max(4000).default(''),
  price: z.number().int().min(0).max(INT_MAX),
  stock: z.number().int().min(0).max(INT_MAX),
  imageIds: z.array(z.uuid()).min(1).max(20).refine(ids => new Set(ids).size === ids.length, 'Select each image only once.'),
};
const createBody = z.object(fields).strict();
const editBody = z.object({ ...fields, version: z.number().int().positive().max(INT_MAX) }).strict();
const publishBody = z.object({ ids: z.array(z.uuid()).min(1).max(100).refine(ids => new Set(ids).size === ids.length, 'Select each product only once.') }).strict();
const productParams = z.object({ id: z.uuid() });
interface Product { id: string; name: string; comment: string; price: number; remaining_unsold: number; published: boolean; version: number; images: string[]; reserved: number; available: number; bought: number }
interface ProductMedia { id: string; user_id: string; kind: string; storage_key: string; mime: string }
const productSelect = `WITH shop_clock AS MATERIALIZED(SELECT clock_timestamp() AS now)
  SELECT p.id,p.name,p.comment,p.price,p.remaining_unsold,p.published,p.version,
  COALESCE((SELECT array_agg(pi.media_id::text ORDER BY pi.position) FROM product_images pi WHERE pi.product_id=p.id),'{}'::text[]) AS images,
  COALESCE(q.reserved,0)::bigint AS reserved,(p.remaining_unsold-COALESCE(q.reserved,0))::bigint AS available,
  COALESCE(q.bought,0)::bigint AS bought
  FROM products p CROSS JOIN shop_clock t LEFT JOIN LATERAL (
    SELECT SUM(l.quantity) FILTER(WHERE o.status='payment_review' OR (o.status='awaiting_payment' AND o.deadline>t.now)) AS reserved,
           SUM(l.quantity) FILTER(WHERE o.status='paid') AS bought
    FROM order_lines l JOIN orders o ON o.current_revision=l.revision_id WHERE l.product_id=p.id
  ) q ON true`;

async function readProducts(db: Pool | PoolClient, ids: string[] | undefined, publishedOnly = false): Promise<Product[]> {
  const conditions = [publishedOnly ? 'p.published' : 'true'];
  if (ids) conditions.push('p.id=ANY($1::uuid[])');
  const result = await db.query<Product>(`${productSelect} WHERE ${conditions.join(' AND ')} ORDER BY p.created_at,p.id`, ids ? [ids] : []);
  return result.rows;
}

async function validateImages(client: PoolClient, config: Config, ids: string[], userId?: string, existingIds: string[] = []): Promise<void> {
  const result = await client.query<ProductMedia>(`SELECT * FROM media WHERE id=ANY($1::uuid[]) ORDER BY id FOR KEY SHARE`, [ids]);
  const existing = new Set(existingIds);
  const selected = new Map(result.rows.map(row => [row.id, row]));
  for (const id of ids) {
    const media = selected.get(id);
    if (!media || media.kind !== 'product' || (userId && media.user_id !== userId && !existing.has(id))) {
      throw new ApiError(400, 'invalid_image', 'Select successfully uploaded product images belonging to you.', { mediaId: id });
    }
    await validateStoredProductImage(config, media);
  }
}

export async function registerCatalog(app: FastifyInstance, pool: Pool, config: Config): Promise<void> {
  app.get('/api/products', async () => readProducts(pool, undefined, true));
  app.get('/api/seller/products', async req => { seller(req); return readProducts(pool, undefined); });
  app.get('/api/products/:id', async req => {
    const { id } = productParams.parse(req.params);
    const product = (await readProducts(pool, [id], !req.user.isSeller))[0];
    if (!product) throw new ApiError(404, 'not_found', 'Product not found');
    return product;
  });
  app.post('/api/seller/products', async req => {
    const user = seller(req);
    const body = createBody.parse(req.body);
    return transaction(pool, async client => {
      const id = randomUUID();
      await validateImages(client, config, body.imageIds, user.id);
      await client.query(`INSERT INTO products(id,name,comment,price,remaining_unsold) VALUES($1,$2,$3,$4,$5)`, [id, body.name, body.comment, body.price, body.stock]);
      for (const [position, mediaId] of body.imageIds.entries()) {
        await client.query('INSERT INTO product_images(product_id,media_id,position) VALUES($1,$2,$3)', [id, mediaId, position]);
      }
      return (await readProducts(client, [id]))[0]!;
    });
  });
  app.patch('/api/seller/products/:id', async req => {
    const user = seller(req);
    const { id } = productParams.parse(req.params);
    const body = editBody.parse(req.body);
    return transaction(pool, async client => {
      const current = (await client.query<{ version: number }>('SELECT version FROM products WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!current) throw new ApiError(404, 'not_found', 'Product not found');
      version(current.version, body.version);
      // Sample wall-clock time only after waiting for the product lock.
      const time = (await client.query<{ now: string }>('SELECT clock_timestamp()::text AS now')).rows[0]!.now;
      const reserved = (await client.query<{ reserved: number }>(
        `SELECT COALESCE(SUM(l.quantity),0)::bigint AS reserved FROM order_lines l JOIN orders o ON o.current_revision=l.revision_id
         WHERE l.product_id=$1 AND (o.status='payment_review' OR (o.status='awaiting_payment' AND o.deadline>$2))`, [id, time],
      )).rows[0]!.reserved;
      if (body.stock < reserved) throw new ApiError(409, 'stock_reserved', 'Stock cannot be lower than active reserved units.', { reserved, stock: body.stock });
      const existing = (await client.query<{ media_id: string }>('SELECT media_id FROM product_images WHERE product_id=$1', [id])).rows.map(row => row.media_id);
      await validateImages(client, config, body.imageIds, user.id, existing);
      await client.query('UPDATE products SET name=$2,comment=$3,price=$4,remaining_unsold=$5,version=version+1 WHERE id=$1', [id, body.name, body.comment, body.price, body.stock]);
      await client.query('DELETE FROM product_images WHERE product_id=$1', [id]);
      for (const [position, mediaId] of body.imageIds.entries()) {
        await client.query('INSERT INTO product_images(product_id,media_id,position) VALUES($1,$2,$3)', [id, mediaId, position]);
      }
      return (await readProducts(client, [id]))[0]!;
    });
  });
  app.post('/api/seller/products/publish', async req => {
    seller(req);
    const { ids } = publishBody.parse(req.body);
    return transaction(pool, async client => {
      const products = (await client.query<{ id: string; name: string; comment: string; price: number; remaining_unsold: number }>(
        `SELECT id,name,comment,price,remaining_unsold FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [ids],
      )).rows;
      if (products.length !== ids.length) throw new ApiError(404, 'not_found', 'One of the selected products no longer exists.');
      const images = (await client.query<{ product_id: string; media_id: string }>(
        `SELECT product_id,media_id FROM product_images WHERE product_id=ANY($1::uuid[]) ORDER BY product_id,position`, [ids],
      )).rows;
      for (const product of products) {
        if (!product.name.trim() || product.price < 0 || product.remaining_unsold < 0 || !images.some(image => image.product_id === product.id)) {
          throw new ApiError(400, 'invalid_product', 'Each published product needs a name, valid price and stock, and an image.', { productId: product.id });
        }
      }
      await validateImages(client, config, [...new Set(images.map(image => image.media_id))]);
      await client.query(`UPDATE products SET published=true,version=version+1 WHERE id=ANY($1::uuid[]) AND NOT published`, [ids]);
      return readProducts(client, ids);
    });
  });
}
