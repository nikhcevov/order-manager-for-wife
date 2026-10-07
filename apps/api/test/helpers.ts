import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { migrate } from '../src/db.js';

export const SELLER = { id: 1001, first_name: 'Seller', username: 'shop_seller' };
export const ALICE = { id: 2001, first_name: 'Alice', username: 'alice' };
export const BOB = { id: 2002, first_name: 'Bob', username: 'bob' };
export const BOT_TOKEN = '123456:isolated_test_bot_token_abcdefghijklmnopqrstuvwxyz';

/** Telegram's actual two-stage HMAC, usable by the browser smoke without an auth bypass. */
export function signedInitData(botToken: string, user: { id: number; first_name: string; username?: string } = ALICE, authDate = Math.floor(Date.now() / 1000)): string {
  const values = new URLSearchParams({ auth_date: String(authDate), query_id: 'isolated-test-launch', user: JSON.stringify(user) });
  const check = [...values.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  values.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return values.toString();
}

export interface Line { product_id: string; name: string; unit_price: number; quantity: number }
export interface Product { id: string; name: string; comment: string; price: number; remaining_unsold: number; published: boolean; version: number; images: string[]; reserved: number; available: number; bought: number }
export interface Revision { id: string; number: number; total: number; lines: Line[] }
export interface Evidence { id: string; media_id: string; revision_id: string }
export interface Change { id: string; base_revision: string; state: string; requested_total: number; difference: number | null; settlement_note: string; reason: string }
export interface Order { id: string; reference: string; user_id: string; group_id: string; status: string; deadline: string; current_revision: string; version: number; currency: string; total: number; lines: Line[]; revisions: Revision[]; evidence: Evidence[]; decision: null | { decision: string; reason: string; revision_id: string }; changes: Change[] }
export interface Group { id: string; user_id: string; method: 'delivery' | 'in_person'; delivery_code: string | null; state: string; version: number; completion_kind: string | null; completed_at: string | null; orders: Order[]; packing_lines: Line[] }
export interface Item { productId: string; quantity: number }
export interface Session { token: string; user: { id: string; first_name: string; username: string; isSeller: boolean }; currency: string; paymentInstructions: string; holdMinutes: number }
export interface ApiFailure { error: string; message: string; details?: Record<string, unknown> }

export class Harness {
  app!: FastifyInstance;
  pool!: pg.Pool;
  config!: Config;
  seller = '';
  alice = '';
  bob = '';
  private admin!: pg.Pool;
  private schema = `test_${randomUUID().replaceAll('-', '')}`;
  private mediaDir = '';
  private sequence = 0;

  async start(): Promise<void> {
    const url = process.env.TEST_DATABASE_URL;
    assert.ok(url, 'TEST_DATABASE_URL must point to a caller-supplied PostgreSQL test database');
    this.admin = new pg.Pool({ connectionString: url, max: 1 });
    await this.admin.query(`CREATE SCHEMA "${this.schema}"`);
    this.pool = new pg.Pool({ connectionString: url, max: 12, options: `-c search_path=${this.schema}` });
    this.mediaDir = await mkdtemp(join(tmpdir(), 'order-manager-test-'));
    this.config = { databaseUrl: url, botToken: BOT_TOKEN, sellerIds: new Set([String(SELLER.id)]), currency: 'USD', paymentInstructions: 'Transfer externally; include the order reference.', publicOrigin: 'https://shop.example.test', mediaDir: this.mediaDir, holdMinutes: 30, port: 3000, host: '127.0.0.1' };
    await migrate(this.pool);
    this.app = await createApp(this.pool, this.config);
  }

  async reset(): Promise<void> {
    await this.pool.query('TRUNCATE customers, sessions, media, products, product_images, fulfillment_groups, orders, order_revisions, order_lines, payment_evidence, payment_decisions, change_requests, checkout_submissions RESTART IDENTITY CASCADE');
    this.seller = (await this.session(SELLER)).token;
    this.alice = (await this.session(ALICE)).token;
    this.bob = (await this.session(BOB)).token;
    this.sequence = 0;
  }

  async close(): Promise<void> {
    if (this.app) await this.app.close();
    if (this.pool) await this.pool.end();
    if (this.admin) {
      await this.admin.query(`DROP SCHEMA IF EXISTS "${this.schema}" CASCADE`);
      await this.admin.end();
    }
    if (this.mediaDir) await rm(this.mediaDir, { recursive: true, force: true });
  }

  async restart(): Promise<void> {
    await this.app.close();
    this.app = await createApp(this.pool, this.config);
  }

  async session(user = ALICE): Promise<Session> {
    return this.api<Session>('POST', '/api/session', undefined, { initData: signedInitData(BOT_TOKEN, user) });
  }

  async request(method: InjectOptions['method'], url: string, token?: string, payload?: InjectOptions['payload'], headers: Record<string, string> = {}) {
    return this.app.inject({ method, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(payload === undefined ? {} : { payload }) });
  }

  async api<T>(method: InjectOptions['method'], url: string, token?: string, payload?: InjectOptions['payload']): Promise<T> {
    const response = await this.request(method, url, token, payload);
    assert.ok(response.statusCode >= 200 && response.statusCode < 300, `${method} ${url}: ${response.statusCode} ${response.body}`);
    return response.json<T>();
  }

  async denied(method: InjectOptions['method'], url: string, token?: string, payload?: InjectOptions['payload'], statuses = [409]): Promise<ApiFailure> {
    const response = await this.request(method, url, token, payload);
    assert.ok(statuses.includes(response.statusCode), `${method} ${url}: expected ${statuses}, got ${response.statusCode} ${response.body}`);
    const body = response.json<ApiFailure>();
    assert.equal(typeof body.error, 'string');
    assert.equal(typeof body.message, 'string');
    return body;
  }

  async upload(token: string, kind: 'product' | 'evidence', bytes?: Buffer, filename = 'screenshot.png', mime = 'image/png'): Promise<{ id: string; mime: string }> {
    const response = await this.uploadResponse(token, kind, bytes, filename, mime);
    assert.ok(response.statusCode >= 200 && response.statusCode < 300, response.body);
    return response.json();
  }

  async uploadResponse(token: string, kind: 'product' | 'evidence', bytes?: Buffer, filename = 'screenshot.png', mime = 'image/png') {
    const image = bytes ?? await sharp({ create: { width: 64, height: 48, channels: 3, background: '#507aca' } }).png().toBuffer();
    const boundary = 'isolated-image-boundary';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
      image, Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    return this.request('POST', '/api/media', token, payload, { 'content-type': `multipart/form-data; boundary=${boundary}` });
  }

  async draft(price = 100, stock = 10, name = 'Fixture product'): Promise<Product> {
    const image = await this.upload(this.seller, 'product');
    return this.api<Product>('POST', '/api/seller/products', this.seller, { name, comment: 'Prepared privately', price, stock, imageIds: [image.id] });
  }

  async product(price = 100, stock = 10, name = 'Fixture product'): Promise<Product> {
    const draft = await this.draft(price, stock, name);
    return (await this.api<Product[]>('POST', '/api/seller/products/publish', this.seller, { ids: [draft.id] }))[0]!;
  }

  async getProduct(id: string): Promise<Product> { return this.api<Product>('GET', `/api/products/${id}`, this.alice); }
  async getOrder(id: string, token = this.alice): Promise<Order> { return this.api<Order>('GET', `/api/orders/${id}`, token); }
  async getGroup(id: string, token = this.alice): Promise<Group> {
    return (await this.api<Group[]>('GET', token === this.seller ? '/api/seller/groups' : '/api/groups', token)).find(group => group.id === id)!;
  }

  async updateProduct(product: Product, patch: Partial<{ name: string; price: number; stock: number }>): Promise<Product> {
    return this.api<Product>('PATCH', `/api/seller/products/${product.id}`, this.seller, { version: product.version, name: product.name, comment: product.comment, price: product.price, stock: product.remaining_unsold, imageIds: product.images, ...patch });
  }

  async preview(items: Item[], token = this.alice, orderId?: string): Promise<{ lines: Line[]; total: number }> {
    return this.api('POST', '/api/orders/preview', token, { items, ...(orderId ? { orderId } : {}) });
  }

  async checkout(items: Item[], options: { token?: string; groupId?: string; method?: 'delivery' | 'in_person'; key?: string; expectedTotal?: number } = {}): Promise<Order> {
    const token = options.token ?? this.alice;
    const expectedTotal = options.expectedTotal ?? (await this.preview(items, token)).total;
    return this.api<Order>('POST', '/api/orders', token, { items, expectedTotal, key: options.key ?? `checkout-${++this.sequence}`, method: options.method ?? 'delivery', ...(options.groupId ? { groupId: options.groupId } : {}) });
  }

  async review(order: Order, token = this.alice): Promise<Order> {
    const image = await this.upload(token, 'evidence');
    return this.api<Order>('POST', `/api/orders/${order.id}/evidence`, token, { version: order.version, mediaIds: [image.id] });
  }

  async pay(order: Order): Promise<Order> {
    const review = await this.review(order);
    return this.api<Order>('POST', `/api/seller/orders/${order.id}/payment`, this.seller, { version: review.version, decision: 'confirmed' });
  }

  async change(order: Order, items: Item[], note = 'Please change selection'): Promise<Order> {
    const preview = await this.preview(items, this.alice, order.id);
    return this.api<Order>('POST', `/api/orders/${order.id}/changes`, this.alice, { version: order.version, items, expectedTotal: preview.total, note });
  }

  async expireWhileOrderLocked(orderId: string, request: () => Promise<LightMyRequestResponse>) {
    const blocker = await this.pool.connect();
    let pending: Promise<LightMyRequestResponse> | undefined;
    try {
      await blocker.query('BEGIN');
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await blocker.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
      pending = request();
      const limit = Date.now() + 5000;
      let blocked = false;
      // Observe a real lock wait, not a timing assumption or sleep-driven deadline.
      while (Date.now() < limit) {
        const result = await this.pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))) AS blocked', [pid]);
        if (result.rows[0].blocked) { blocked = true; break; }
      }
      assert.ok(blocked, 'The API transaction must reach the controlled order lock');
      await blocker.query('UPDATE orders SET deadline=clock_timestamp() WHERE id=$1', [orderId]);
      await blocker.query('COMMIT');
      return await pending;
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      if (pending) await pending;
    }
  }

  async count(table: 'orders' | 'order_revisions' | 'payment_evidence' | 'payment_decisions' | 'checkout_submissions' | 'change_requests' | 'sessions'): Promise<number> {
    return Number((await this.pool.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
  }
}

export function quantities(lines: Line[]): Record<string, number> {
  return lines.reduce<Record<string, number>>((result, line) => { result[line.product_id] = (result[line.product_id] ?? 0) + line.quantity; return result; }, {});
}
