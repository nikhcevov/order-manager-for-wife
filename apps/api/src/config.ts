import { resolve } from 'node:path';
import { z } from 'zod';
const settings = z.object({
  DATABASE_URL: z.url().refine(v => /^postgres(ql)?:/.test(v), 'Use a PostgreSQL URL'),
  BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]{20,}$/, 'Use a BotFather token'),
  SELLER_IDS: z.string().regex(/^\d+(,\d+)*$/, 'Use comma-separated numeric Telegram IDs'),
  SHOP_CURRENCY: z.string().regex(/^[A-Z]{3}$/),
  PAYMENT_INSTRUCTIONS: z.string().trim().min(1).max(4000),
  PUBLIC_ORIGIN: z.url().refine(v => {const u = new URL(v); return u.pathname === '/' && !u.search && !u.hash && (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost','127.0.0.1'].includes(u.hostname)));}, 'Use HTTPS, or localhost HTTP for development'),
  MEDIA_DIR: z.string().min(1), HOLD_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000), HOST: z.string().default('127.0.0.1')
});
export interface Config { databaseUrl:string; botToken:string; sellerIds:Set<string>; currency:string; paymentInstructions:string; publicOrigin:string; mediaDir:string; holdMinutes:number; port:number; host:string }
export function loadConfig(env:NodeJS.ProcessEnv = process.env):Config {
  const result = settings.safeParse(env);
  if (!result.success) throw new Error('Invalid configuration: ' + result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  const v = result.data;
  return {databaseUrl:v.DATABASE_URL,botToken:v.BOT_TOKEN,sellerIds:new Set(v.SELLER_IDS.split(',')),currency:v.SHOP_CURRENCY,paymentInstructions:v.PAYMENT_INSTRUCTIONS,publicOrigin:new URL(v.PUBLIC_ORIGIN).origin,mediaDir:resolve(v.MEDIA_DIR),holdMinutes:v.HOLD_MINUTES,port:v.PORT,host:v.HOST};
}
