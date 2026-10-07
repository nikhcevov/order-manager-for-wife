import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import pg from 'pg';

const canary = 'isolated-publishing-canary-not-a-shop-secret';
const image = process.env.SMOKE_IMAGE;
const databaseUrl = process.env.TEST_DATABASE_URL;
const name = `order-manager-smoke-${randomUUID()}`;
const schema = `smoke_${randomUUID().replaceAll('-', '')}`;
let media;
let admin;
let createdSchema = false;
let attemptedContainer = false;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = true; });
function docker(args) {
  try { return execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error(`docker ${args[0]} failed`); }
}
async function scanLayers() {
  // docker save emits uncompressed layer tar archives. Scan across chunk boundaries,
  // including deleted files in older layers, without loading the entire image in RAM.
  await new Promise((resolve, reject) => {
    const child = spawn('docker', ['image', 'save', image], { stdio: ['ignore', 'pipe', 'ignore'] });
    const needle = Buffer.from(canary);
    let previous = Buffer.alloc(0);
    let found = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Image layer scan timed out')); }, 120_000);
    child.stdout.on('data', chunk => {
      const bytes = Buffer.concat([previous, chunk]);
      if (bytes.includes(needle)) found = true;
      previous = bytes.subarray(Math.max(0, bytes.length - needle.length + 1));
    });
    child.once('error', () => { clearTimeout(timer); reject(new Error('Image layer scan failed')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('Image layer scan failed'));
      else if (found) reject(new Error('Canary runtime/data secret is present in image layers'));
      else resolve();
    });
  });
}
try {
  if (!image || !databaseUrl) throw new Error('SMOKE_IMAGE and TEST_DATABASE_URL are required; use only an isolated test database');
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error('Smoke port 127.0.0.1:4893 is already in use')));
    server.listen(4893, '127.0.0.1', () => server.close(resolve));
  });
  const config = JSON.parse(docker(['image', 'inspect', image]))[0];
  if (config.Os !== 'linux' || config.Architecture !== 'amd64') throw new Error('Candidate must be linux/amd64');
  if (JSON.stringify(config).includes(canary)) throw new Error('Canary is present in image configuration');
  await scanLayers();
  admin = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10_000, query_timeout: 30_000 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  createdSchema = true;
  const scopedUrl = new URL(databaseUrl);
  scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
  media = await mkdtemp(join(tmpdir(), 'order-manager-smoke-'));
  // Only this synthetic temporary directory is made writable for container UID 1000.
  await chmod(media, 0o777);
  const runtime = {
    NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '4893', DATABASE_URL: scopedUrl.href,
    BOT_TOKEN: '123456:isolated_test_bot_token_abcdefghijklmnopqrstuvwxyz', SELLER_IDS: '1001',
    SHOP_CURRENCY: 'USD', PAYMENT_INSTRUCTIONS: 'Synthetic smoke payment instructions.',
    PUBLIC_ORIGIN: 'http://127.0.0.1:4893', MEDIA_DIR: '/app/var/media', HOLD_MINUTES: '30',
    PUBLISHING_RUNTIME_CANARY: canary
  };
  attemptedContainer = true;
  docker(['run', '--detach', '--name', name, '--network', 'host', '--mount', `type=bind,src=${media},dst=/app/var/media`,
    ...Object.entries(runtime).flatMap(([key, value]) => ['--env', `${key}=${value}`]), image]);
  const container = JSON.parse(docker(['inspect', name]))[0];
  if (!container.Config.Env.includes(`PUBLISHING_RUNTIME_CANARY=${canary}`)) throw new Error('Canary runtime injection was not exercised');
  const deadline = Date.now() + 60_000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error('Smoke interrupted');
    if (docker(['inspect', '--format', '{{.State.Running}}', name]) !== 'true') throw new Error('Candidate exited before becoming healthy');
    try {
      const response = await fetch('http://127.0.0.1:4893/api/health', { signal: AbortSignal.timeout(2_000) });
      if (response.ok && (await response.json()).ok === true) { healthy = true; break; }
    } catch { /* Retry only inside the bounded startup window. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!healthy) throw new Error('Candidate did not become healthy within 60 seconds');
  const frontend = await fetch('http://127.0.0.1:4893/', { signal: AbortSignal.timeout(5_000) });
  const html = await frontend.text();
  if (!frontend.ok || !frontend.headers.get('content-type')?.includes('text/html') || !html.includes('id="root"')) throw new Error('Built frontend was not served');
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"<>]+)"/g)].map(match => match[1]);
  if (!assets.some(asset => asset.endsWith('.js'))) throw new Error('Built frontend JavaScript asset is missing');
  for (const asset of assets) {
    const response = await fetch(`http://127.0.0.1:4893${asset}`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok || (await response.arrayBuffer()).byteLength === 0) throw new Error('Built frontend asset could not be loaded');
  }
  const uid = docker(['exec', name, 'node', '-e', "if(process.getuid()!==1000)process.exit(1);require('node:fs').writeFileSync('/app/var/media/smoke-write','synthetic-media');console.log(process.getuid())"]);
  if (uid !== '1000') throw new Error('Candidate must execute as UID 1000');
  const migrations = await admin.query(`SELECT count(*)::integer AS count FROM "${schema}".schema_migrations`);
  if (migrations.rows[0].count === 0) throw new Error('Actual entrypoint did not apply database migrations');
  if (interrupted) throw new Error('Smoke interrupted');
  console.log(JSON.stringify({ image, imageId: config.Id, uid: 1000, healthy: true, frontend: true, migrations: migrations.rows[0].count, canaryExcluded: true }));
} catch (error) {
  // Container logs/config may include runtime values, so report only controlled errors.
  console.error(error instanceof Error && !('code' in error) ? error.message : 'Candidate smoke failed');
  process.exitCode = 1;
} finally {
  if (attemptedContainer) {
    try { docker(['rm', '--force', name]); }
    catch { console.error('Smoke container cleanup failed'); process.exitCode = 1; }
  }
  if (createdSchema) {
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
    catch { console.error('Smoke schema cleanup failed'); process.exitCode = 1; }
  }
  if (admin) await admin.end();
  if (media) await rm(media, { recursive: true, force: true });
}
