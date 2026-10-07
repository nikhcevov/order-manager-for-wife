import pg, { type Pool, type PoolClient } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
pg.types.setTypeParser(20, value => { const n = Number(value); if (!Number.isSafeInteger(n)) throw new Error('Unsafe database integer'); return n; });
export function createPool(url:string):Pool { return new pg.Pool({connectionString:url,max:15}); }
export async function transaction<T>(pool:Pool, fn:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client = await pool.connect();
  try {await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result;}
  catch (error) {await client.query('ROLLBACK'); throw error;} finally {client.release();}
}
export async function migrate(pool:Pool):Promise<void> {
  await transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(48173620)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
    const dir = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(dir)).filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
      if ((await client.query('SELECT 1 FROM schema_migrations WHERE name=$1',[name])).rowCount) continue;
      await client.query(await readFile(new URL(name, dir),'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES($1)',[name]);
    }
  });
}
