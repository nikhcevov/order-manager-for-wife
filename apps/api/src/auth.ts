import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { transaction } from './db.js';
import { ApiError, type User } from './http.js';

const launchBody = z.object({ initData: z.string().min(1).max(16384) }).strict();
const telegramUser = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  first_name: z.string().min(1).max(256),
  username: z.string().min(1).max(64).optional(),
  is_bot: z.boolean().optional(),
});
const invalidLaunch = () => new ApiError(401, 'invalid_launch', 'Open the shop again from Telegram to sign in.');

function validateLaunch(initData: string, config: Config): User {
  const fields = new URLSearchParams(initData);
  const seen = new Set<string>();
  for (const [key, value] of fields) {
    if (!key || seen.has(key) || /[\r\n=]/.test(key) || /[\r\n]/.test(value)) throw invalidLaunch();
    seen.add(key);
  }
  const hash = fields.get('hash');
  const authDate = fields.get('auth_date');
  if (!hash || !/^[a-fA-F0-9]{64}$/.test(hash) || !authDate || !/^\d+$/.test(authDate)) throw invalidLaunch();
  const timestamp = Number(authDate);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestamp) || timestamp > now || now - timestamp > 3600) throw invalidLaunch();
  const checkString = [...fields.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  const expected = createHmac('sha256', secret).update(checkString).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) throw invalidLaunch();
  let parsed: unknown;
  try { parsed = JSON.parse(fields.get('user') ?? 'null'); } catch { throw invalidLaunch(); }
  const result = telegramUser.safeParse(parsed);
  if (!result.success || result.data.is_bot) throw invalidLaunch();
  const id = String(result.data.id);
  return { id, first_name: result.data.first_name, username: result.data.username ?? null, isSeller: config.sellerIds.has(id) };
}

export async function registerAuth(app: FastifyInstance, pool: Pool, config: Config): Promise<void> {
  app.decorateRequest('user');
  app.addHook('preHandler', async req => {
    const route = req.routeOptions.url ?? '';
    const path = req.url.split('?')[0] ?? '';
    if (!route.startsWith('/api/') && !path.startsWith('/api/')) return;
    if (req.method === 'POST' && route === '/api/session') return;
    if (req.method === 'GET' && (route === '/api/health' || route === '/api/public-media/:id')) return;
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '');
    if (!match) throw new ApiError(401, 'unauthorized', 'Open the shop from Telegram to sign in.');
    const result = await pool.query<{ id: string; first_name: string; username: string | null }>(
      `SELECT c.id,c.first_name,c.username FROM sessions s JOIN customers c ON c.id=s.user_id
       WHERE s.token_hash=$1 AND s.expires_at>clock_timestamp()`, [createHash('sha256').update(match[1]!).digest('hex')],
    );
    const user = result.rows[0];
    if (!user) throw new ApiError(401, 'session_expired', 'Your session expired. Reopen the shop in Telegram.');
    req.user = { ...user, isSeller: config.sellerIds.has(user.id) };
  });
  app.post('/api/session', async (req, reply) => {
    const { initData } = launchBody.parse(req.body);
    const user = validateLaunch(initData, config);
    const token = randomBytes(32).toString('base64url');
    await transaction(pool, async client => {
      await client.query(
        `INSERT INTO customers(id,first_name,username) VALUES($1,$2,$3)
         ON CONFLICT(id) DO UPDATE SET first_name=EXCLUDED.first_name,username=EXCLUDED.username`,
        [user.id, user.first_name, user.username],
      );
      await client.query(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '24 hours')`, [createHash('sha256').update(token).digest('hex'), user.id]);
      await client.query(`DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`);
    });
    reply.header('Cache-Control', 'no-store');
    return { token, user, currency: config.currency, paymentInstructions: config.paymentInstructions, holdMinutes: config.holdMinutes };
  });
}
