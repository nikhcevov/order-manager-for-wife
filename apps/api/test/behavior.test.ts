import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { expireOrders } from '../src/orders.js';
import { cleanupMedia } from '../src/media.js';
import { ALICE, BOT_TOKEN, SELLER, Harness, quantities, signedInitData, type Group, type Order, type Product } from './helpers.js';

const h = new Harness();

describe('PostgreSQL-backed Telegram shop capability contracts', { concurrency: false }, () => {
  before(async () => { await h.start(); });
  beforeEach(async () => { await h.reset(); });
  after(async () => { await h.close(); });

  describe('telegram-access: verified identities and private resources', () => {
    it('accepts signed identity and seller ID rather than username; stores opaque session hashes', async () => {
      const customer = await h.session({ ...ALICE, username: SELLER.username });
      assert.equal(String(customer.user.id), String(ALICE.id));
      assert.equal(customer.user.isSeller, false);
      assert.equal(customer.currency, 'USD');
      assert.equal(customer.paymentInstructions, h.config.paymentInstructions);
      assert.equal(customer.holdMinutes, 30);
      const seller = await h.session({ ...SELLER, username: 'renamed_seller' });
      assert.equal(seller.user.isSeller, true);
      assert.deepEqual(await h.api('GET', '/api/seller/products', seller.token), []);
      await h.denied('GET', '/api/seller/products', customer.token, undefined, [403]);
      const rows = (await h.pool.query('SELECT token_hash FROM sessions')).rows;
      assert.ok(rows.every(row => row.token_hash !== customer.token && row.token_hash !== seller.token));
      assert.ok(rows.every(row => /^[a-f0-9]{64}$/.test(row.token_hash)));
      assert.deepEqual(await h.api('GET', '/api/health'), { ok: true });
      h.config.sellerIds.delete(String(SELLER.id));
      try { await h.denied('GET', '/api/seller/products', seller.token, undefined, [403]); }
      finally { h.config.sellerIds.add(String(SELLER.id)); }
    });

    it('rejects absent, forged, stale, future and malformed launch data without creating sessions', async () => {
      const initial = await h.count('sessions');
      const now = Math.floor(Date.now() / 1000);
      const forged = new URLSearchParams(signedInitData(BOT_TOKEN));
      forged.set('user', JSON.stringify(SELLER));
      for (const initData of ['', forged.toString(), signedInitData(BOT_TOKEN, { id: 0, first_name: 'Invalid' }), signedInitData(BOT_TOKEN, ALICE, now - 7200), signedInitData(BOT_TOKEN, ALICE, now + 3600), 'user=not-json&auth_date=1&hash=bad']) {
        await h.denied('POST', '/api/session', undefined, { initData }, [400, 401]);
      }
      await h.denied('GET', '/api/orders', undefined, undefined, [401]);
      await h.denied('GET', '/api/orders', 'forged-session', undefined, [401]);
      assert.equal(await h.count('sessions'), initial);
      await h.pool.query('UPDATE sessions SET expires_at=clock_timestamp() WHERE user_id=$1', [String(ALICE.id)]);
      await h.denied('GET', '/api/orders', h.alice, undefined, [401]);
    });

    it('enforces owner and seller boundaries for orders, groups, evidence and every administrative mutation', async () => {
      const product = await h.product();
      const order = await h.review(await h.checkout([{ productId: product.id, quantity: 1 }]));
      const image = order.evidence[0]!.media_id;
      const group = await h.getGroup(order.group_id);
      await h.denied('GET', `/api/orders/${order.id}`, h.bob, undefined, [403, 404]);
      await h.denied('GET', '/api/orders/ORD-1', h.alice, undefined, [400]);
      await h.denied('POST', `/api/orders/${order.id}/changes`, h.bob, { version: order.version, items: [], expectedTotal: 0 }, [403, 404]);
      await h.denied('PATCH', `/api/groups/${group.id}`, h.bob, { version: group.version, method: 'delivery', deliveryCode: 'private-code' }, [403, 404]);
      await h.denied('GET', `/api/media/${image}`, h.bob, undefined, [403, 404]);
      await h.denied('GET', `/api/media/${image}`, undefined, undefined, [401]);
      await h.denied('GET', `/api/public-media/${image}`, undefined, undefined, [404]);
      for (const token of [h.alice, h.seller]) {
        const response = await h.request('GET', `/api/media/${image}`, token);
        assert.equal(response.statusCode, 200);
        assert.equal((await sharp(response.rawPayload).metadata()).format, 'png');
      }
      await h.denied('POST', `/api/seller/orders/${order.id}/payment`, h.alice, { version: order.version, decision: 'confirmed' }, [403]);
      await h.denied('POST', '/api/seller/products/publish', h.alice, { ids: [product.id] }, [403]);
      await h.denied('POST', `/api/seller/groups/${group.id}/pack`, h.alice, { version: group.version }, [403]);
      const listed = await h.api<Order[]>('GET', '/api/orders', h.bob);
      assert.deepEqual(listed, []);
      assert.deepEqual(await h.api<Group[]>('GET', '/api/groups', h.bob), []);
      assert.equal((await h.getOrder(order.id)).status, 'payment_review');
      assert.equal((await h.api<Order[]>('GET', '/api/seller/orders', h.seller))[0]!.id, order.id);
    });

    it('rejects disguised images, oversized files, unsupported formats and traversal identifiers', async () => {
      for (const [bytes, filename, mime] of [
        [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'fake.png', 'image/png'],
        [Buffer.from('not an image'), 'receipt.jpg', 'image/jpeg'],
        [Buffer.alloc(11 * 1024 * 1024), 'huge.png', 'image/png']
      ] as const) {
        const response = await h.uploadResponse(h.alice, 'evidence', bytes, filename, mime);
        assert.ok([400, 413, 415].includes(response.statusCode), response.body);
      }
      const oversizedDimensions = await sharp({ create: { width: 12001, height: 1, channels: 3, background: '#ffffff' } }).png().toBuffer();
      const dimensions = await h.uploadResponse(h.alice, 'evidence', oversizedDimensions);
      assert.ok([400, 413, 415].includes(dimensions.statusCode), dimensions.body);
      const response = await h.uploadResponse(h.alice, 'product');
      assert.equal(response.statusCode, 403);
      await h.denied('GET', '/api/media/%2e%2e%2f%2e%2e%2fetc%2fpasswd', h.alice, undefined, [400, 404]);
      assert.equal(Number((await h.pool.query('SELECT count(*) FROM media')).rows[0].count), 0);
    });

    it('removes abandoned old uploads while retaining referenced draft and evidence images', async () => {
      const draft = await h.draft();
      const product = await h.product();
      const reviewed = await h.review(await h.checkout([{ productId: product.id, quantity: 1 }]));
      const abandoned = await h.upload(h.alice, 'evidence');
      const recent = await h.upload(h.alice, 'evidence');
      await h.pool.query('UPDATE media SET created_at=clock_timestamp() - interval \'2 days\' WHERE id<>$1', [recent.id]);
      await cleanupMedia(h.pool, h.config);
      await h.denied('GET', `/api/media/${abandoned.id}`, h.alice, undefined, [404]);
      for (const [id, token] of [[draft.images[0]!, h.seller], [reviewed.evidence[0]!.media_id, h.alice], [recent.id, h.alice]]) {
        const response = await h.request('GET', `/api/media/${id}`, token);
        assert.equal(response.statusCode, 200);
        assert.equal((await sharp(response.rawPayload).metadata()).format, 'png');
      }
      assert.equal((await h.getOrder(reviewed.id)).evidence.length, 1);
    });
  });

  describe('product-catalog: private drafts, atomic publication and derived inventory', () => {
    it('keeps drafts and their images private, then publishes the entire valid batch', async () => {
      const first = await h.draft(125, 3, 'First');
      const second = await h.draft(225, 4, 'Second');
      const extra = await h.upload(h.seller, 'product');
      const edited = await h.api<Product>('PATCH', `/api/seller/products/${first.id}`, h.seller, { version: first.version, name: first.name, comment: 'Two ordered images', price: first.price, stock: first.remaining_unsold, imageIds: [extra.id, first.images[0]] });
      assert.deepEqual(edited.images, [extra.id, first.images[0]]);
      assert.deepEqual(await h.api('GET', '/api/products', h.alice), []);
      await h.denied('GET', `/api/products/${first.id}`, h.alice, undefined, [403, 404]);
      await h.denied('GET', `/api/public-media/${first.images[0]}`, undefined, undefined, [404]);
      await h.denied('GET', `/api/media/${first.images[0]}`, h.alice, undefined, [403, 404]);
      assert.equal((await h.request('GET', `/api/media/${first.images[0]}`, h.seller)).statusCode, 200);
      await h.denied('POST', '/api/orders', h.alice, { items: [{ productId: first.id, quantity: 1 }], expectedTotal: 125, key: 'draft', method: 'delivery' }, [400, 404, 409]);
      await h.denied('POST', '/api/seller/products/publish', h.seller, { ids: [first.id, randomUUID()] }, [400, 404, 409]);
      assert.deepEqual(await h.api('GET', '/api/products', h.alice), []);
      const stored = (await h.pool.query('SELECT storage_key FROM media WHERE id=$1', [second.images[0]])).rows[0].storage_key;
      const imagePath = join(h.config.mediaDir, stored);
      const validBytes = await readFile(imagePath);
      await writeFile(imagePath, 'corrupted stored image');
      try {
        await h.denied('POST', '/api/seller/products/publish', h.seller, { ids: [first.id, second.id] }, [400]);
        assert.deepEqual(await h.api('GET', '/api/products', h.alice), []);
        assert.ok((await h.api<Product[]>('GET', '/api/seller/products', h.seller)).every(product => !product.published));
      } finally { await writeFile(imagePath, validBytes); }
      const published = await h.api<Product[]>('POST', '/api/seller/products/publish', h.seller, { ids: [first.id, second.id] });
      assert.equal(published.length, 2);
      assert.ok(published.every(product => product.published));
      const catalog = await h.api<Product[]>('GET', '/api/products', h.alice);
      assert.deepEqual(new Set(catalog.map(product => product.id)), new Set([first.id, second.id]));
      const detail = await h.getProduct(first.id);
      assert.equal(detail.comment, 'Two ordered images');
      assert.equal(detail.available, 3);
      assert.deepEqual(detail.images, edited.images);
      const publicImage = await h.request('GET', `/api/public-media/${extra.id}`);
      assert.equal(publicImage.statusCode, 200);
      assert.equal((await sharp(publicImage.rawPayload).metadata()).width, 64);
    });

    it('rejects invalid product fields and foreign or evidence image associations', async () => {
      const sellerImage = await h.upload(h.seller, 'product');
      const evidence = await h.upload(h.alice, 'evidence');
      const sellerEvidence = await h.upload(h.seller, 'evidence');
      const base = { name: 'Valid', comment: '', price: 100, stock: 2, imageIds: [sellerImage.id] };
      for (const patch of [{ name: '' }, { price: -1 }, { price: 1.5 }, { price: 2147483648 }, { stock: -1 }, { stock: 1.5 }, { stock: 2147483648 }, { imageIds: [] }, { imageIds: [evidence.id] }, { imageIds: [sellerEvidence.id] }, { imageIds: [randomUUID()] }]) {
        await h.denied('POST', '/api/seller/products', h.seller, { ...base, ...patch }, [400, 403, 404, 409]);
      }
      assert.deepEqual(await h.api('GET', '/api/seller/products', h.seller), []);
    });

    it('protects active reservations, ignores elapsed holds, and preserves accepted descriptions and prices', async () => {
      let product = await h.product(100, 5, 'Original name');
      const order = await h.checkout([{ productId: product.id, quantity: 3 }]);
      assert.equal((await h.getProduct(product.id)).reserved, 3);
      await h.denied('PATCH', `/api/seller/products/${product.id}`, h.seller, { version: product.version, name: product.name, comment: '', price: 200, stock: 2, imageIds: product.images });
      assert.equal((await h.getProduct(product.id)).remaining_unsold, 5);
      product = await h.updateProduct(product, { price: 200, name: 'New name' });
      const history = await h.getOrder(order.id);
      assert.equal(history.lines[0]!.unit_price, 100);
      assert.equal(history.lines[0]!.name, 'Original name');
      assert.equal(history.total, 300);
      assert.equal((await h.preview([{ productId: product.id, quantity: 1 }])).total, 200);
      await h.pool.query('UPDATE orders SET deadline=clock_timestamp() WHERE id=$1', [order.id]);
      assert.equal((await h.getProduct(product.id)).reserved, 0);
      assert.equal((await h.getProduct(product.id)).available, 5);
      product = await h.updateProduct(product, { stock: 2 });
      assert.equal(product.available, 2);
      assert.equal((await h.getOrder(order.id)).status, 'expired');
    });
  });

  describe('order-management: atomic checkout, unpaid revisions and reviewed corrections', () => {
    it('previews without holding stock and admits exactly one concurrent buyer of the last unit', async () => {
      const product = await h.product(100, 1);
      assert.equal((await h.preview([{ productId: product.id, quantity: 1 }])).total, 100);
      assert.equal((await h.getProduct(product.id)).available, 1);
      const payload = { items: [{ productId: product.id, quantity: 1 }], expectedTotal: 100, method: 'delivery' };
      const results = await Promise.all([
        h.request('POST', '/api/orders', h.alice, { ...payload, key: 'alice-last-unit' }),
        h.request('POST', '/api/orders', h.bob, { ...payload, key: 'bob-last-unit' })
      ]);
      assert.equal(results.filter(result => result.statusCode >= 200 && result.statusCode < 300).length, 1);
      const loser = results.find(result => result.statusCode === 409)!;
      assert.ok(loser, results.map(result => result.body).join('\n'));
      assert.equal(loser.json().error, 'stock_conflict');
      assert.equal(await h.count('orders'), 1);
      assert.equal(await h.count('checkout_submissions'), 1);
      const stock = await h.getProduct(product.id);
      assert.equal(stock.available, 0);
      assert.equal(stock.reserved, 1);
      assert.equal(stock.bought, 0);
    });

    it('rolls back all items on shortage and rejects empty, duplicate or invalid quantities', async () => {
      const first = await h.product(100, 2);
      const second = await h.product(200, 0);
      await h.denied('POST', '/api/orders', h.alice, { items: [{ productId: first.id, quantity: 1 }, { productId: second.id, quantity: 1 }], expectedTotal: 300, key: 'shortage', method: 'delivery' });
      for (const items of [[], [{ productId: first.id, quantity: 0 }], [{ productId: first.id, quantity: 1.5 }], [{ productId: first.id, quantity: 1 }, { productId: first.id, quantity: 1 }]]) {
        await h.denied('POST', '/api/orders', h.alice, { items, expectedTotal: 100, key: randomUUID(), method: 'delivery' }, [400]);
      }
      assert.equal(await h.count('orders'), 0);
      assert.equal(await h.count('order_revisions'), 0);
      assert.equal(await h.count('checkout_submissions'), 0);
      assert.equal((await h.getProduct(first.id)).available, 2);
      assert.deepEqual(await h.api('GET', '/api/groups', h.alice), []);
    });

    it('requires acceptance of changed prices and replays checkout only for identical customer-scoped payloads', async () => {
      let product = await h.product(100, 5);
      const items = [{ productId: product.id, quantity: 1 }];
      const oldPreview = await h.preview(items);
      product = await h.updateProduct(product, { price: 175 });
      const outdated = await h.denied('POST', '/api/orders', h.alice, { items, expectedTotal: oldPreview.total, key: 'accepted-key', method: 'delivery' });
      assert.equal(outdated.error, 'price_changed');
      assert.equal(await h.count('orders'), 0);
      const payload = { items, expectedTotal: 175, key: 'accepted-key', method: 'delivery' };
      const [left, right] = await Promise.all([
        h.api<Order>('POST', '/api/orders', h.alice, payload),
        h.api<Order>('POST', '/api/orders', h.alice, payload)
      ]);
      assert.equal(left.id, right.id);
      assert.equal((await h.api<Order>('POST', '/api/orders', h.alice, payload)).id, left.id);
      for (const patch of [{ expectedTotal: 100 }, { method: 'in_person' }, { items: [{ productId: product.id, quantity: 2 }] }]) {
        assert.equal((await h.denied('POST', '/api/orders', h.alice, { ...payload, ...patch })).error, 'idempotency_conflict');
      }
      assert.equal(await h.count('orders'), 1);
      assert.equal((await h.getProduct(product.id)).reserved, 1);
      const other = await h.api<Order>('POST', '/api/orders', h.bob, payload);
      assert.notEqual(other.id, left.id);
      assert.equal(await h.count('orders'), 2);
      await h.pool.query('UPDATE orders SET deadline=clock_timestamp() WHERE id=$1', [left.id]);
      const afterExpiry = await h.api<Order>('POST', '/api/orders', h.alice, payload);
      assert.equal(afterExpiry.id, left.id);
      assert.equal(afterExpiry.status, 'expired');
      assert.equal(await h.count('orders'), 2);
      assert.equal((await h.getProduct(product.id)).reserved, 1);
    });

    it('atomically edits unpaid selection, keeps old price lots and deadline, rejects stale edits, and cancels once', async () => {
      let original = await h.product(100, 6, 'Original');
      const added = await h.product(300, 2, 'Added');
      const unavailable = await h.product(500, 0, 'Unavailable');
      const order = await h.checkout([{ productId: original.id, quantity: 2 }]);
      original = await h.updateProduct(original, { price: 150 });
      await h.denied('PATCH', `/api/orders/${order.id}`, h.alice, { version: order.version, items: [{ productId: unavailable.id, quantity: 1 }], expectedTotal: 500 });
      assert.deepEqual((await h.getOrder(order.id)).lines, order.lines);
      assert.equal((await h.getOrder(order.id)).current_revision, order.current_revision);
      assert.equal((await h.getProduct(original.id)).reserved, 2);
      const desired = [{ productId: original.id, quantity: 3 }, { productId: added.id, quantity: 1 }];
      const preview = await h.preview(desired, h.alice, order.id);
      assert.equal(preview.total, 650);
      assert.deepEqual(preview.lines.filter(line => line.product_id === original.id).map(line => [line.unit_price, line.quantity]).sort((a, b) => a[0]! - b[0]!), [[100, 2], [150, 1]]);
      await h.denied('PATCH', `/api/orders/${order.id}`, h.alice, { version: order.version, items: desired, expectedTotal: 600 });
      const edited = await h.api<Order>('PATCH', `/api/orders/${order.id}`, h.alice, { version: order.version, items: desired, expectedTotal: preview.total });
      assert.equal(edited.deadline, order.deadline);
      assert.equal(edited.total, 650);
      assert.equal(edited.revisions.length, 2);
      assert.equal(edited.revisions[0]!.id, order.current_revision);
      assert.deepEqual(edited.revisions[0]!.lines, order.lines);
      const stale = await h.denied('PATCH', `/api/orders/${order.id}`, h.alice, { version: order.version, items: desired, expectedTotal: 650 });
      assert.equal(stale.error, 'stale_version');
      assert.equal((stale.details?.order as Order).current_revision, edited.current_revision);
      assert.equal((stale.details?.order as Order).version, edited.version);
      assert.equal((await h.getProduct(original.id)).reserved, 3);
      assert.equal((await h.getProduct(added.id)).reserved, 1);
      const reducedItems = [{ productId: original.id, quantity: 1 }];
      const reducedPreview = await h.preview(reducedItems, h.alice, order.id);
      assert.equal(reducedPreview.total, 100);
      const reduced = await h.api<Order>('PATCH', `/api/orders/${order.id}`, h.alice, { version: edited.version, items: reducedItems, expectedTotal: 100 });
      assert.equal(reduced.deadline, order.deadline);
      assert.equal((await h.getProduct(added.id)).reserved, 0);
      const cancelled = await h.api<Order>('POST', `/api/orders/${order.id}/cancel`, h.alice, { version: reduced.version });
      assert.equal(cancelled.status, 'cancelled');
      const repeated = await h.api<Order>('POST', `/api/orders/${order.id}/cancel`, h.alice, { version: reduced.version });
      assert.equal(repeated.version, cancelled.version);
      assert.equal((await h.getProduct(original.id)).reserved, 0);
      assert.equal((await h.getProduct(original.id)).available, 6);
    });

    it('rejects all unpaid mutations at the deadline and empty edit explicitly cancels', async () => {
      const product = await h.product(100, 3);
      const first = await h.checkout([{ productId: product.id, quantity: 1 }]);
      await h.pool.query('UPDATE orders SET deadline=clock_timestamp() WHERE id=$1', [first.id]);
      await h.denied('PATCH', `/api/orders/${first.id}`, h.alice, { version: first.version, items: [{ productId: product.id, quantity: 2 }], expectedTotal: 200 });
      await h.denied('POST', `/api/orders/${first.id}/cancel`, h.alice, { version: first.version });
      assert.equal((await h.getOrder(first.id)).status, 'expired');
      assert.equal((await h.getOrder(first.id)).revisions.length, 1);
      const second = await h.checkout([{ productId: product.id, quantity: 1 }]);
      const empty = await h.api<Order>('PATCH', `/api/orders/${second.id}`, h.alice, { version: second.version, items: [], expectedTotal: 0 });
      assert.equal(empty.status, 'cancelled');
      assert.equal((await h.getProduct(product.id)).available, 3);
    });

    it('keeps review change requests inventory-neutral; supports withdrawal, rejection, zero-difference approval and payment with pending request', async () => {
      const original = await h.product(100, 2, 'Original');
      const replacement = await h.product(100, 2, 'Replacement');
      let order = await h.review(await h.checkout([{ productId: original.id, quantity: 1 }]));
      const originalRevision = order.current_revision;
      const evidence = order.evidence;
      await h.denied('PATCH', `/api/orders/${order.id}`, h.alice, { version: order.version, items: [], expectedTotal: 0 });
      await h.denied('POST', `/api/orders/${order.id}/cancel`, h.alice, { version: order.version });
      order = await h.change(order, [{ productId: replacement.id, quantity: 1 }]);
      assert.equal(order.current_revision, originalRevision);
      assert.equal((await h.getProduct(original.id)).reserved, 1);
      assert.equal((await h.getProduct(replacement.id)).reserved, 0);
      await h.denied('POST', `/api/orders/${order.id}/changes`, h.alice, { version: order.version, items: [], expectedTotal: 0 });
      const firstChange = order.changes.find(change => change.state === 'pending')!;
      order = await h.api<Order>('POST', `/api/orders/${order.id}/changes/${firstChange.id}/withdraw`, h.alice, { version: order.version });
      assert.equal(order.changes.find(change => change.id === firstChange.id)!.state, 'withdrawn');
      order = await h.change(order, [{ productId: replacement.id, quantity: 1 }]);
      const rejectedChange = order.changes.find(change => change.state === 'pending')!;
      order = await h.api<Order>('POST', `/api/seller/orders/${order.id}/changes/${rejectedChange.id}/resolve`, h.seller, { version: order.version, decision: 'rejected', reason: 'Keep original selection' });
      assert.equal(order.current_revision, originalRevision);
      assert.equal(order.changes.find(change => change.id === rejectedChange.id)!.reason, 'Keep original selection');
      order = await h.change(order, [{ productId: replacement.id, quantity: 1 }]);
      const approvedChange = order.changes.find(change => change.state === 'pending')!;
      order = await h.api<Order>('POST', `/api/seller/orders/${order.id}/changes/${approvedChange.id}/resolve`, h.seller, { version: order.version, decision: 'approved' });
      assert.equal(order.status, 'payment_review');
      assert.equal(order.changes.find(change => change.id === approvedChange.id)!.difference, 0);
      assert.deepEqual(order.evidence, evidence);
      assert.equal(order.evidence[0]!.revision_id, originalRevision);
      assert.equal((await h.getProduct(original.id)).reserved, 0);
      assert.equal((await h.getProduct(replacement.id)).reserved, 1);
      order = await h.change(order, [{ productId: replacement.id, quantity: 1 }]);
      const pending = order.changes.find(change => change.state === 'pending')!;
      order = await h.api<Order>('POST', `/api/seller/orders/${order.id}/payment`, h.seller, { version: order.version, decision: 'confirmed' });
      assert.equal(order.status, 'paid');
      assert.equal(order.changes.find(change => change.id === pending.id)!.state, 'pending');
      assert.equal(order.decision!.revision_id, order.current_revision);
      assert.equal((await h.getProduct(replacement.id)).bought, 1);
    });

    it('applies paid corrections atomically with external settlement and preserves original purchase/payment history through full refund', async () => {
      const original = await h.product(100, 3, 'Original');
      const replacement = await h.product(250, 2, 'Replacement');
      const unavailable = await h.product(400, 0, 'Unavailable');
      let paid = await h.pay(await h.checkout([{ productId: original.id, quantity: 2 }]));
      const originalRevision = paid.current_revision;
      const originalEvidence = paid.evidence;
      const originalDecision = paid.decision;
      paid = await h.change(paid, [{ productId: unavailable.id, quantity: 1 }]);
      let pending = paid.changes.find(change => change.state === 'pending')!;
      await h.denied('POST', `/api/seller/orders/${paid.id}/changes/${pending.id}/resolve`, h.seller, { version: paid.version, decision: 'approved', settlementNote: 'Received additional amount' });
      assert.equal((await h.getOrder(paid.id)).current_revision, originalRevision);
      assert.equal((await h.getProduct(original.id)).remaining_unsold, 1);
      paid = await h.api<Order>('POST', `/api/orders/${paid.id}/changes/${pending.id}/withdraw`, h.alice, { version: paid.version });
      paid = await h.change(paid, [{ productId: replacement.id, quantity: 1 }]);
      pending = paid.changes.find(change => change.state === 'pending')!;
      await h.denied('POST', `/api/seller/orders/${paid.id}/changes/${pending.id}/resolve`, h.seller, { version: paid.version, decision: 'approved' });
      assert.equal((await h.getProduct(original.id)).remaining_unsold, 1);
      assert.equal((await h.getProduct(replacement.id)).remaining_unsold, 2);
      const payload = { version: paid.version, decision: 'approved', settlementNote: 'Extra 50 received externally' };
      paid = await h.api<Order>('POST', `/api/seller/orders/${paid.id}/changes/${pending.id}/resolve`, h.seller, payload);
      assert.equal(paid.total, 250);
      assert.equal(paid.status, 'paid');
      assert.equal(paid.changes.find(change => change.id === pending.id)!.difference, 50);
      assert.equal(paid.changes.find(change => change.id === pending.id)!.settlement_note, payload.settlementNote);
      assert.equal((await h.getProduct(original.id)).remaining_unsold, 3);
      assert.equal((await h.getProduct(replacement.id)).remaining_unsold, 1);
      assert.deepEqual(paid.evidence, originalEvidence);
      assert.deepEqual(paid.decision, originalDecision);
      assert.equal(paid.revisions.find(revision => revision.id === originalRevision)!.total, 200);
      const repeated = await h.api<Order>('POST', `/api/seller/orders/${paid.id}/changes/${pending.id}/resolve`, h.seller, payload);
      assert.equal(repeated.version, paid.version);
      assert.equal(repeated.revisions.length, 2);
      paid = await h.change(paid, []);
      const refund = paid.changes.find(change => change.state === 'pending')!;
      await h.denied('POST', `/api/seller/orders/${paid.id}/changes/${refund.id}/resolve`, h.seller, { version: paid.version, decision: 'approved' });
      paid = await h.api<Order>('POST', `/api/seller/orders/${paid.id}/changes/${refund.id}/resolve`, h.seller, { version: paid.version, decision: 'approved', settlementNote: 'Full 250 refunded externally' });
      assert.equal(paid.status, 'paid');
      assert.equal(paid.total, 0);
      assert.deepEqual(paid.lines, []);
      assert.equal(paid.changes.find(change => change.id === refund.id)!.difference, -250);
      assert.equal((await h.getProduct(replacement.id)).remaining_unsold, 2);
      assert.deepEqual(paid.evidence, originalEvidence);
      assert.deepEqual(paid.decision, originalDecision);
      assert.equal(paid.revisions.length, 3);
      assert.deepEqual((await h.getGroup(paid.group_id, h.seller)).packing_lines, []);
      const group = await h.getGroup(paid.group_id);
      await h.denied('POST', `/api/seller/groups/${group.id}/pack`, h.seller, { version: group.version });
    });

    it('preserves accepted price lots when review-held and paid corrections add units after a price change', async () => {
      for (const state of ['payment_review', 'paid']) {
        let product = await h.product(100, 6, `Price lots ${state}`);
        const initial = await h.checkout([{ productId: product.id, quantity: 2 }]);
        let order = state === 'paid' ? await h.pay(initial) : await h.review(initial);
        const evidence = order.evidence;
        const decision = order.decision;
        product = await h.getProduct(product.id);
        product = await h.updateProduct(product, { price: 200, name: 'Renamed product' });
        order = await h.change(order, [{ productId: product.id, quantity: 3 }]);
        const request = order.changes.find(change => change.state === 'pending')!;
        assert.equal(request.requested_total, 400);
        order = await h.api<Order>('POST', `/api/seller/orders/${order.id}/changes/${request.id}/resolve`, h.seller, { version: order.version, decision: 'approved', settlementNote: 'Additional 200 settled externally' });
        assert.equal(order.status, state);
        assert.equal(order.total, 400);
        assert.deepEqual(order.lines.map(line => [line.unit_price, line.quantity]).sort((a, b) => a[0]! - b[0]!), [[100, 2], [200, 1]]);
        assert.equal(order.lines.find(line => line.unit_price === 100)!.name, `Price lots ${state}`);
        assert.deepEqual(order.evidence, evidence);
        assert.deepEqual(order.decision, decision);
        const stock = await h.getProduct(product.id);
        assert.equal(stock.available, 3);
        assert.equal(stock.reserved, state === 'paid' ? 0 : 3);
        assert.equal(stock.remaining_unsold, state === 'paid' ? 3 : 6);
      }
    });

    it('rejects correction approval after unaccepted addition price changes without releasing originals', async () => {
      const original = await h.product(100, 2);
      let replacement = await h.product(150, 2);
      let order = await h.pay(await h.checkout([{ productId: original.id, quantity: 1 }]));
      order = await h.change(order, [{ productId: replacement.id, quantity: 1 }]);
      const pending = order.changes.find(change => change.state === 'pending')!;
      assert.equal(pending.requested_total, 150);
      replacement = await h.updateProduct(replacement, { price: 200 });
      const result = await h.denied('POST', `/api/seller/orders/${order.id}/changes/${pending.id}/resolve`, h.seller, { version: order.version, decision: 'approved', settlementNote: 'Received 50' });
      assert.equal(result.error, 'requested_price_changed');
      assert.equal((await h.getOrder(order.id)).current_revision, order.current_revision);
      assert.equal((await h.getProduct(original.id)).remaining_unsold, 1);
      assert.equal((await h.getProduct(replacement.id)).remaining_unsold, 2);
      assert.equal((await h.getOrder(order.id)).changes.find(change => change.id === pending.id)!.state, 'pending');
    });
  });

  describe('manual-payments: explicit private evidence, deadline races and exactly-once decisions', () => {
    it('upload alone does not submit evidence; validates ownership and attaches once to the accepted revision', async () => {
      const product = await h.product(100, 2);
      const order = await h.checkout([{ productId: product.id, quantity: 1 }]);
      const screenshot = await h.upload(h.alice, 'evidence');
      const foreign = await h.upload(h.bob, 'evidence');
      const productImage = await h.upload(h.seller, 'product');
      assert.equal((await h.getOrder(order.id)).status, 'awaiting_payment');
      assert.deepEqual((await h.getOrder(order.id)).evidence, []);
      for (const mediaIds of [[], [foreign.id], [productImage.id], [randomUUID()]]) {
        await h.denied('POST', `/api/orders/${order.id}/evidence`, h.alice, { version: order.version, mediaIds }, [400, 403, 404, 409]);
      }
      const payload = { version: order.version, mediaIds: [screenshot.id] };
      const reviewed = await h.api<Order>('POST', `/api/orders/${order.id}/evidence`, h.alice, payload);
      assert.equal(reviewed.status, 'payment_review');
      assert.equal(reviewed.evidence.length, 1);
      assert.equal(reviewed.evidence[0]!.revision_id, order.current_revision);
      const repeated = await h.api<Order>('POST', `/api/orders/${order.id}/evidence`, h.alice, payload);
      assert.equal(repeated.version, reviewed.version);
      assert.equal(await h.count('payment_evidence'), 1);
      assert.equal((await h.getProduct(product.id)).bought, 0);
    });

    it('checks database wall-clock deadlines after controlled lock waits for evidence, edits and cancellation', async () => {
      const product = await h.product(100, 3);
      for (const operation of ['evidence', 'edit', 'cancel']) {
        const order = await h.checkout([{ productId: product.id, quantity: 1 }]);
        const image = operation === 'evidence' ? await h.upload(h.alice, 'evidence') : undefined;
        const response = await h.expireWhileOrderLocked(order.id, () => {
          if (operation === 'evidence') return h.request('POST', `/api/orders/${order.id}/evidence`, h.alice, { version: order.version, mediaIds: [image!.id] });
          if (operation === 'edit') return h.request('PATCH', `/api/orders/${order.id}`, h.alice, { version: order.version, items: [{ productId: product.id, quantity: 2 }], expectedTotal: 200 });
          return h.request('POST', `/api/orders/${order.id}/cancel`, h.alice, { version: order.version });
        });
        assert.equal(response.statusCode, 409, response.body);
        assert.equal(response.json().error, 'order_expired');
        assert.equal((await h.getOrder(order.id)).status, 'expired');
        assert.equal((await h.getOrder(order.id)).revisions.length, 1);
        assert.equal((await h.getProduct(product.id)).reserved, 0);
      }
      assert.equal(await h.count('payment_evidence'), 0);
    });

    it('rejects evidence at the exact database deadline even with an earlier upload and concurrent expiry', async () => {
      const product = await h.product(100, 1);
      const order = await h.checkout([{ productId: product.id, quantity: 1 }]);
      const screenshot = await h.upload(h.alice, 'evidence');
      await h.pool.query('UPDATE orders SET deadline=clock_timestamp() WHERE id=$1', [order.id]);
      const [submission] = await Promise.all([
        h.request('POST', `/api/orders/${order.id}/evidence`, h.alice, { version: order.version, mediaIds: [screenshot.id] }),
        expireOrders(h.pool)
      ]);
      assert.equal(submission.statusCode, 409, submission.body);
      assert.equal((await h.getOrder(order.id)).status, 'expired');
      assert.equal(await h.count('payment_evidence'), 0);
      assert.equal((await h.getProduct(product.id)).available, 1);
      assert.equal((await h.getProduct(product.id)).reserved, 0);
      await expireOrders(h.pool);
      assert.equal((await h.getOrder(order.id)).status, 'expired');
    });

    it('keeps review holds past the deadline and restart while unpaid expiry catches up', async () => {
      const product = await h.product(100, 4);
      const reviewed = await h.review(await h.checkout([{ productId: product.id, quantity: 2 }]));
      const unpaid = await h.checkout([{ productId: product.id, quantity: 1 }]);
      await h.pool.query('UPDATE orders SET deadline=clock_timestamp() - interval \'1 day\' WHERE id=ANY($1::uuid[])', [[reviewed.id, unpaid.id]]);
      assert.equal((await h.getOrder(unpaid.id)).status, 'expired');
      assert.equal((await h.getProduct(product.id)).available, 2);
      await h.restart();
      await expireOrders(h.pool);
      await expireOrders(h.pool);
      assert.equal((await h.getOrder(reviewed.id)).status, 'payment_review');
      assert.equal((await h.getOrder(unpaid.id)).status, 'expired');
      assert.equal((await h.getProduct(product.id)).reserved, 2);
      const currentProduct = await h.getProduct(product.id);
      await h.denied('PATCH', `/api/seller/products/${product.id}`, h.seller, { version: currentProduct.version, name: currentProduct.name, comment: currentProduct.comment, price: currentProduct.price, stock: 1, imageIds: currentProduct.images });
      const image = await h.request('GET', `/api/media/${reviewed.evidence[0]!.media_id}`, h.seller);
      assert.equal(image.statusCode, 200);
      assert.equal((await sharp(image.rawPayload).metadata()).height, 48);
      await h.denied('POST', '/api/orders', h.bob, { items: [{ productId: product.id, quantity: 3 }], expectedTotal: 300, key: 'review-still-held', method: 'delivery' });
    });

    it('confirms payment once despite concurrent duplicate decisions; never expires paid purchases', async () => {
      const product = await h.product(100, 3);
      const order = await h.review(await h.checkout([{ productId: product.id, quantity: 2 }]));
      const payload = { version: order.version, decision: 'confirmed' };
      const results = await Promise.all([
        h.api<Order>('POST', `/api/seller/orders/${order.id}/payment`, h.seller, payload),
        h.api<Order>('POST', `/api/seller/orders/${order.id}/payment`, h.seller, payload)
      ]);
      assert.ok(results.every(result => result.status === 'paid'));
      assert.equal(results[0]!.version, results[1]!.version);
      const stock = await h.getProduct(product.id);
      assert.equal(stock.remaining_unsold, 1);
      assert.equal(stock.available, 1);
      assert.equal(stock.reserved, 0);
      assert.equal(stock.bought, 2);
      assert.equal(await h.count('payment_decisions'), 1);
      assert.deepEqual(results[0]!.evidence, order.evidence);
      assert.equal(results[0]!.decision!.revision_id, order.current_revision);
      await h.denied('POST', `/api/seller/orders/${order.id}/payment`, h.seller, { version: results[0]!.version, decision: 'rejected', reason: 'Cannot reverse purchase' });
      await h.pool.query('UPDATE orders SET deadline=clock_timestamp() - interval \'1 day\' WHERE id=$1', [order.id]);
      await h.restart();
      await expireOrders(h.pool);
      assert.equal((await h.getOrder(order.id)).status, 'paid');
      assert.equal((await h.getProduct(product.id)).remaining_unsold, 1);
      assert.equal((await h.getGroup(order.group_id)).state, 'open');
    });

    it('requires rejection reason, preserves evidence, and releases review-held units once', async () => {
      const product = await h.product(100, 1);
      const reviewed = await h.review(await h.checkout([{ productId: product.id, quantity: 1 }]));
      await h.denied('POST', `/api/seller/orders/${reviewed.id}/payment`, h.seller, { version: reviewed.version, decision: 'rejected' }, [400]);
      const payload = { version: reviewed.version, decision: 'rejected', reason: 'No matching bank transfer' };
      const rejected = await h.api<Order>('POST', `/api/seller/orders/${reviewed.id}/payment`, h.seller, payload);
      assert.equal(rejected.status, 'payment_rejected');
      assert.equal(rejected.decision!.reason, payload.reason);
      assert.deepEqual(rejected.evidence, reviewed.evidence);
      const duplicate = await h.api<Order>('POST', `/api/seller/orders/${reviewed.id}/payment`, h.seller, payload);
      assert.equal(duplicate.version, rejected.version);
      assert.equal(await h.count('payment_decisions'), 1);
      assert.equal((await h.getProduct(product.id)).available, 1);
      assert.equal((await h.getProduct(product.id)).bought, 0);
      const retryPurchase = await h.checkout([{ productId: product.id, quantity: 1 }]);
      assert.notEqual(retryPurchase.id, reviewed.id);
      assert.equal((await h.getOrder(reviewed.id)).status, 'payment_rejected');
    });
  });

  describe('order-fulfillment: whole-group method, packing, splitting and completion', () => {
    it('enforces customer association and one method, accepts optional code, and clears it on handover', async () => {
      const product = await h.product(100, 8);
      const first = await h.checkout([{ productId: product.id, quantity: 1 }]);
      let group = await h.getGroup(first.group_id);
      assert.equal(group.delivery_code, null);
      await h.denied('POST', '/api/orders', h.bob, { items: [{ productId: product.id, quantity: 1 }], expectedTotal: 100, key: 'foreign-group', method: 'delivery', groupId: group.id }, [403, 404]);
      await h.denied('POST', '/api/orders', h.alice, { items: [{ productId: product.id, quantity: 1 }], expectedTotal: 100, key: 'mixed-method', method: 'in_person', groupId: group.id });
      const second = await h.checkout([{ productId: product.id, quantity: 1 }], { groupId: group.id });
      assert.equal(second.group_id, first.group_id);
      assert.match(first.reference, /^ORD-\d+$/);
      assert.match(second.reference, /^ORD-\d+$/);
      assert.notEqual(second.reference, first.reference);
      assert.ok(Number(second.reference.slice(4)) > Number(first.reference.slice(4)), 'later order must carry the greater reference');
      group = await h.getGroup(group.id);
      assert.equal(group.orders.length, 2);
      group = await h.api<Group>('PATCH', `/api/groups/${group.id}`, h.alice, { version: group.version, method: 'delivery', deliveryCode: 'External-request-123' });
      assert.equal(group.delivery_code, 'External-request-123');
      group = await h.api<Group>('PATCH', `/api/groups/${group.id}`, h.alice, { version: group.version, method: 'delivery', deliveryCode: 'Replacement-request' });
      assert.equal(group.delivery_code, 'Replacement-request');
      const previous = group.version;
      group = await h.api<Group>('PATCH', `/api/groups/${group.id}`, h.alice, { version: group.version, method: 'in_person' });
      assert.equal(group.method, 'in_person');
      assert.equal(group.delivery_code, null);
      await h.denied('PATCH', `/api/groups/${group.id}`, h.alice, { version: previous, method: 'delivery' });
      group = await h.api<Group>('PATCH', `/api/groups/${group.id}`, h.alice, { version: group.version, method: 'delivery' });
      assert.equal(group.delivery_code, null);
      assert.equal(await h.count('orders'), 2);
    });

    it('packs only whole paid orders, splits unpaid and review-held additions without copying code, freezes and reopens', async () => {
      const paidProduct = await h.product(100, 10, 'Paid');
      const unpaidProduct = await h.product(200, 10, 'Unpaid');
      const first = await h.pay(await h.checkout([{ productId: paidProduct.id, quantity: 2 }]));
      const second = await h.pay(await h.checkout([{ productId: paidProduct.id, quantity: 1 }], { groupId: first.group_id }));
      const unpaid = await h.checkout([{ productId: unpaidProduct.id, quantity: 2 }], { groupId: first.group_id });
      const reviewed = await h.review(await h.checkout([{ productId: unpaidProduct.id, quantity: 1 }], { groupId: first.group_id }));
      let group = await h.getGroup(first.group_id);
      group = await h.api<Group>('PATCH', `/api/groups/${group.id}`, h.alice, { version: group.version, method: 'delivery', deliveryCode: 'Keep-with-paid-package' });
      assert.deepEqual(quantities((await h.getGroup(group.id, h.seller)).packing_lines), { [paidProduct.id]: 3 });
      const beforePaid = await h.getProduct(paidProduct.id);
      const beforeUnpaid = await h.getProduct(unpaidProduct.id);
      const packing = await h.api<Group>('POST', `/api/seller/groups/${group.id}/pack`, h.seller, { version: group.version });
      assert.equal(packing.state, 'packing');
      assert.equal(packing.delivery_code, 'Keep-with-paid-package');
      assert.deepEqual(new Set(packing.orders.map(order => order.id)), new Set([first.id, second.id]));
      assert.deepEqual(quantities(packing.packing_lines), { [paidProduct.id]: 3 });
      const movedUnpaid = await h.getOrder(unpaid.id);
      const movedReview = await h.getOrder(reviewed.id);
      assert.notEqual(movedUnpaid.group_id, packing.id);
      assert.equal(movedUnpaid.group_id, movedReview.group_id);
      assert.equal(movedUnpaid.status, 'awaiting_payment');
      assert.equal(movedReview.status, 'payment_review');
      assert.equal(movedUnpaid.deadline, unpaid.deadline);
      assert.deepEqual(movedReview.evidence, reviewed.evidence);
      const remaining = await h.getGroup(movedUnpaid.group_id);
      assert.equal(remaining.state, 'open');
      assert.equal(remaining.method, 'delivery');
      assert.equal(remaining.delivery_code, null);
      assert.equal((await h.getProduct(paidProduct.id)).remaining_unsold, beforePaid.remaining_unsold);
      assert.equal((await h.getProduct(unpaidProduct.id)).reserved, beforeUnpaid.reserved);
      await h.denied('PATCH', `/api/groups/${packing.id}`, h.alice, { version: packing.version, method: 'in_person' });
      await h.denied('POST', '/api/orders', h.alice, { items: [{ productId: paidProduct.id, quantity: 1 }], expectedTotal: 100, key: 'frozen-addition', method: 'delivery', groupId: packing.id });
      const firstCurrent = await h.getOrder(first.id);
      await h.denied('POST', `/api/orders/${first.id}/changes`, h.alice, { version: firstCurrent.version, items: [], expectedTotal: 0 });
      const fresh = await h.checkout([{ productId: paidProduct.id, quantity: 1 }]);
      assert.notEqual(fresh.group_id, packing.id);
      const reopened = await h.api<Group>('POST', `/api/seller/groups/${packing.id}/reopen`, h.seller, { version: packing.version });
      assert.equal(reopened.state, 'open');
      const changed = await h.api<Group>('PATCH', `/api/groups/${reopened.id}`, h.alice, { version: reopened.version, method: 'in_person' });
      assert.equal(changed.delivery_code, null);
      const request = await h.change(await h.getOrder(first.id), [{ productId: paidProduct.id, quantity: 1 }]);
      assert.ok(request.changes.some(change => change.state === 'pending'));
    });

    it('blocks packing pending corrections, then warns for missing delivery code and completes exactly once without stock/payment mutation', async () => {
      const product = await h.product(100, 5);
      let order = await h.pay(await h.checkout([{ productId: product.id, quantity: 2 }]));
      assert.equal((await h.getGroup(order.group_id)).delivery_code, null);
      order = await h.change(order, [{ productId: product.id, quantity: 1 }]);
      let group = await h.getGroup(order.group_id);
      await h.denied('POST', `/api/seller/groups/${group.id}/pack`, h.seller, { version: group.version });
      const pending = order.changes.find(change => change.state === 'pending')!;
      order = await h.api<Order>('POST', `/api/seller/orders/${order.id}/changes/${pending.id}/resolve`, h.seller, { version: order.version, decision: 'rejected', reason: 'Keep both purchased items' });
      group = await h.getGroup(group.id);
      await h.denied('POST', `/api/seller/groups/${group.id}/complete`, h.seller, { version: group.version });
      const packing = await h.api<Group>('POST', `/api/seller/groups/${group.id}/pack`, h.seller, { version: group.version });
      const missingCode = await h.denied('POST', `/api/seller/groups/${packing.id}/complete`, h.seller, { version: packing.version });
      assert.equal(missingCode.error, 'missing_delivery_code');
      assert.equal((await h.getGroup(group.id)).state, 'packing');
      const before = await h.getProduct(product.id);
      const completePayload = { version: packing.version, allowMissingCode: true };
      const completed = await h.api<Group>('POST', `/api/seller/groups/${packing.id}/complete`, h.seller, completePayload);
      assert.equal(completed.state, 'completed');
      assert.equal(completed.completion_kind, 'sent');
      assert.ok(completed.completed_at);
      const repeated = await h.api<Group>('POST', `/api/seller/groups/${packing.id}/complete`, h.seller, completePayload);
      assert.equal(repeated.version, completed.version);
      assert.equal(repeated.completed_at, completed.completed_at);
      assert.equal((await h.getProduct(product.id)).remaining_unsold, before.remaining_unsold);
      assert.equal((await h.getProduct(product.id)).bought, before.bought);
      assert.equal((await h.getOrder(order.id)).status, 'paid');
      assert.deepEqual((await h.getOrder(order.id)).decision, order.decision);
      await h.denied('POST', '/api/orders', h.alice, { items: [{ productId: product.id, quantity: 1 }], expectedTotal: 100, key: 'completed-addition', method: 'delivery', groupId: completed.id });
      await h.denied('PATCH', `/api/groups/${completed.id}`, h.alice, { version: completed.version, method: 'in_person' });
      await h.denied('POST', `/api/orders/${order.id}/changes`, h.alice, { version: order.version, items: [], expectedTotal: 0 });
      await h.denied('POST', `/api/seller/groups/${completed.id}/reopen`, h.seller, { version: completed.version });
      const next = await h.checkout([{ productId: product.id, quantity: 1 }]);
      assert.notEqual(next.group_id, completed.id);
      assert.equal((await h.getGroup(completed.id)).completion_kind, 'sent');
    });

    it('completes an in-person handover with no delivery code or extra stock effect', async () => {
      const product = await h.product(100, 3);
      const paid = await h.pay(await h.checkout([{ productId: product.id, quantity: 1 }], { method: 'in_person' }));
      const group = await h.getGroup(paid.group_id);
      assert.equal(group.method, 'in_person');
      assert.equal(group.delivery_code, null);
      const packing = await h.api<Group>('POST', `/api/seller/groups/${group.id}/pack`, h.seller, { version: group.version });
      const completed = await h.api<Group>('POST', `/api/seller/groups/${group.id}/complete`, h.seller, { version: packing.version });
      assert.equal(completed.completion_kind, 'handed_over');
      assert.equal(completed.delivery_code, null);
      assert.equal((await h.getProduct(product.id)).remaining_unsold, 2);
      assert.equal((await h.getOrder(paid.id)).status, 'paid');
    });
  });
});
