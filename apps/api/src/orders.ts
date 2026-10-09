import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { transaction } from './db.js';
import { ApiError, owner, seller, version } from './http.js';

const MAX_INT = 2_147_483_647;
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const expectedVersion = z.number().int().min(1).max(MAX_INT);
const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const selection = z.array(z.object({productId:uuid,quantity:z.number().int().min(1).max(MAX_INT)}).strict()).max(200)
  .superRefine((items, context) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(item.productId)) context.addIssue({code:'custom',path:[index,'productId'],message:'Select each product only once.'});
      seen.add(item.productId);
    });
  });
const orderParams = z.object({id:uuid});
const changeParams = orderParams.extend({changeId:uuid});
const note = z.string().trim().max(4000);
type Selection = z.infer<typeof selection>;
type Queryable = Pool | PoolClient;
export interface OrderLine { product_id:string; name:string; unit_price:number; quantity:number }
interface LockedOrder {
  id:string; user_id:string; group_id:string; status:string; deadline:Date; current_revision:string;
  version:number; currency:string;
}
interface LockedGroup { id:string; user_id:string; method:string|null; state:string; version:number }
interface Product { id:string; name:string; price:number; remaining_unsold:number; published:boolean }
interface ChangeRequest {
  id:string; order_id:string; base_revision:string; selection:Selection; requested_total:number;
  state:string; resolved_revision:string|null; difference:number|null; settlement_note:string; reason:string;
}
export interface OrderView extends LockedOrder {
  reference:string; created_at:Date; total:number; lines:OrderLine[];
  revisions:unknown[]; evidence:{id:string;media_id:string;revision_id:string;created_at:string}[];
  decision:{decision:string;reason:string;[key:string]:unknown}|null; changes:ChangeRequest[];
  customer:{first_name:string;username:string|null}; group:Record<string,unknown>;
}

// One statement gives the reader a coherent accepted revision and its complete history.
const orderViewSql = `
 SELECT o.*, CASE WHEN o.status='awaiting_payment' AND o.deadline<=clock_timestamp()
   THEN 'expired' ELSE o.status END AS status, r.total,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id',l.product_id,'name',l.name,
     'unit_price',l.unit_price,'quantity',l.quantity) ORDER BY l.position)
     FROM order_lines l WHERE l.revision_id=o.current_revision),'[]'::jsonb) AS lines,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('id',v.id,'number',v.number,'total',v.total,
     'author_id',v.author_id,'created_at',v.created_at,'lines',COALESCE((SELECT jsonb_agg(
       jsonb_build_object('product_id',l.product_id,'name',l.name,'unit_price',l.unit_price,
       'quantity',l.quantity) ORDER BY l.position) FROM order_lines l WHERE l.revision_id=v.id),'[]'::jsonb))
     ORDER BY v.number) FROM order_revisions v WHERE v.order_id=o.id),'[]'::jsonb) AS revisions,
   COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.created_at,e.id)
     FROM payment_evidence e WHERE e.order_id=o.id),'[]'::jsonb) AS evidence,
   (SELECT to_jsonb(d) FROM payment_decisions d WHERE d.order_id=o.id) AS decision,
   COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.created_at,c.id)
     FROM change_requests c WHERE c.order_id=o.id),'[]'::jsonb) AS changes,
   jsonb_build_object('first_name',u.first_name,'username',u.username) AS customer,
   to_jsonb(g) AS "group"
 FROM orders o JOIN order_revisions r ON r.id=o.current_revision
 JOIN customers u ON u.id=o.user_id JOIN fulfillment_groups g ON g.id=o.group_id`;

export async function readOrder(db:Queryable, id:string):Promise<OrderView> {
  const result = await db.query<OrderView>(`${orderViewSql} WHERE o.id=$1`,[id]);
  if (!result.rows[0]) throw new ApiError(404,'not_found','Order not found.');
  return result.rows[0];
}

export async function readOrders(db:Queryable, userId?:string):Promise<OrderView[]> {
  const result = await db.query<OrderView>(`${orderViewSql}
    WHERE ($1::text IS NULL OR o.user_id=$1) ORDER BY o.created_at DESC,o.id`,[userId ?? null]);
  return result.rows;
}

async function checkVersion(client:PoolClient, order:LockedOrder, expected:number):Promise<void> {
  try {version(order.version,expected);} catch (error) {
    if (error instanceof ApiError) error.details = {version:order.version,order:await readOrder(client,order.id)};
    throw error;
  }
}

async function lockedOrder<T>(pool:Pool, req:FastifyRequest, id:string,
  action:(client:PoolClient, order:LockedOrder, group:LockedGroup)=>Promise<T>):Promise<T> {
  return transaction(pool,async client => {
    const initial = (await client.query<{group_id:string;user_id:string}>(
      'SELECT group_id,user_id FROM orders WHERE id=$1',[id])).rows[0];
    if (!initial) throw new ApiError(404,'not_found','Order not found.');
    owner(req,initial.user_id);
    const group = (await client.query<LockedGroup>('SELECT * FROM fulfillment_groups WHERE id=$1 FOR UPDATE',[initial.group_id])).rows[0];
    const order = (await client.query<LockedOrder>('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if (!group || !order) throw new ApiError(404,'not_found','Order not found.');
    owner(req,order.user_id);
    // Shipping can move a whole order between packages while our first read is waiting.
    // Do not acquire its new group after an order lock (the global lock order forbids it).
    if (order.group_id !== group.id) throw new ApiError(409,'group_changed','This order moved to another fulfillment group. Refresh and try again.');
    return action(client,order,group);
  });
}

function openPackage(group:LockedGroup):void {
  if (group.state !== 'open') throw new ApiError(409,'package_completed','This package has already been shipped. Shipped packages cannot be changed.');
}

async function linesFor(client:Queryable, revisionId:string):Promise<OrderLine[]> {
  return (await client.query<OrderLine>(`SELECT product_id,name,unit_price,quantity FROM order_lines
    WHERE revision_id=$1 ORDER BY position`,[revisionId])).rows;
}

function quantities(lines:OrderLine[]):Map<string,number> {
  const result = new Map<string,number>();
  for (const line of lines) result.set(line.product_id,(result.get(line.product_id) ?? 0)+line.quantity);
  return result;
}

async function productsFor(client:Queryable, items:Selection, old:OrderLine[], lock:boolean):Promise<Map<string,Product>> {
  const ids = [...new Set([...items.map(item => item.productId),...old.map(line => line.product_id)])].sort();
  if (!ids.length) return new Map();
  const result = await client.query<Product>(`SELECT id,name,price,remaining_unsold,published FROM products
    WHERE id=ANY($1::uuid[]) ORDER BY id ${lock ? 'FOR UPDATE' : ''}`,[ids]);
  const products = new Map(result.rows.map(product => [product.id,product]));
  for (const id of ids) if (!products.has(id)) throw new ApiError(409,'product_unavailable','A selected product is no longer available.',{productId:id});
  return products;
}

function quote(items:Selection, old:OrderLine[], products:Map<string,Product>):{lines:OrderLine[];total:number} {
  const wanted = new Map(items.map(item => [item.productId,item.quantity]));
  const lines:OrderLine[] = [];
  // Retain the oldest accepted price lots first. Removing quantities never reprices the rest.
  for (const line of old) {
    const remaining = wanted.get(line.product_id) ?? 0;
    const retained = Math.min(line.quantity,remaining);
    if (retained) lines.push({...line,quantity:retained});
    wanted.set(line.product_id,remaining-retained);
  }
  for (const item of [...items].sort((a,b) => a.productId.localeCompare(b.productId))) {
    const added = wanted.get(item.productId) ?? 0;
    if (!added) continue;
    const product = products.get(item.productId)!;
    if (!product.published) throw new ApiError(409,'product_unavailable','A selected product is not published.',{productId:item.productId});
    lines.push({product_id:product.id,name:product.name,unit_price:product.price,quantity:added});
  }
  let total = 0;
  for (const line of lines) {
    const subtotal = line.unit_price*line.quantity;
    if (!Number.isSafeInteger(subtotal) || !Number.isSafeInteger(total+subtotal))
      throw new ApiError(400,'invalid_total','This selection exceeds the supported monetary total.');
    total += subtotal;
  }
  return {lines,total};
}

function acceptedTotal(actual:number, expected:number, lines:OrderLine[], code='price_changed'):void {
  if (actual !== expected) throw new ApiError(409,code,'Prices changed. Review and accept the current total before continuing.',{total:actual,lines});
}

async function databaseTime(client:PoolClient):Promise<string> {
  // Keep PostgreSQL's microsecond precision instead of truncating through a JS Date.
  return (await client.query<{now:string}>('SELECT clock_timestamp()::text AS now')).rows[0]!.now;
}

async function awaiting(client:PoolClient, order:LockedOrder, now:string):Promise<void> {
  const elapsed = order.status==='awaiting_payment' && (await client.query<{elapsed:boolean}>(
    'SELECT deadline<=$2::timestamptz AS elapsed FROM orders WHERE id=$1',[order.id,now])).rows[0]!.elapsed;
  if (order.status === 'expired' || elapsed)
    throw new ApiError(409,'order_expired','The payment deadline passed. Create a new order.',{order:await readOrder(client,order.id)});
  if (order.status !== 'awaiting_payment')
    throw new ApiError(409,'invalid_order_state','Only an awaiting-payment order can be edited, cancelled, or submitted for review.',{order:await readOrder(client,order.id)});
}

async function checkStock(client:PoolClient, products:Map<string,Product>, desired:OrderLine[],
  old:OrderLine[], ownOrder:string|null, paid:boolean, now:string):Promise<void> {
  const ids = [...products.keys()];
  if (!ids.length) return;
  const held = await client.query<{product_id:string;quantity:number}>(`SELECT l.product_id,SUM(l.quantity)::bigint AS quantity
    FROM order_lines l JOIN orders o ON o.current_revision=l.revision_id
    WHERE l.product_id=ANY($1::uuid[]) AND ($2::uuid IS NULL OR o.id<>$2)
      AND (o.status='payment_review' OR (o.status='awaiting_payment' AND o.deadline>$3))
    GROUP BY l.product_id`,[ids,ownOrder,now]);
  const reserved = new Map(held.rows.map(row => [row.product_id,row.quantity]));
  const before = quantities(old);
  const after = quantities(desired);
  const shortages:{productId:string;requested:number;available:number}[] = [];
  for (const product of products.values()) {
    const requested = after.get(product.id) ?? 0;
    const restored = paid ? before.get(product.id) ?? 0 : 0;
    const available = product.remaining_unsold-(reserved.get(product.id) ?? 0)+restored;
    if (requested>available) shortages.push({productId:product.id,requested,available:Math.max(0,available)});
    if (paid && product.remaining_unsold+restored-requested>MAX_INT)
      throw new ApiError(409,'stock_limit','Returning these units would exceed the stock limit. Adjust unsold stock before approving.',{productId:product.id});
  }
  if (shortages.length) throw new ApiError(409,'stock_conflict','Some selected quantities are unavailable. The original order is unchanged.',{shortages});
}

async function appendRevision(client:PoolClient, orderId:string, authorId:string,
  lines:OrderLine[], total:number):Promise<string> {
  const id = randomUUID();
  await client.query(`INSERT INTO order_revisions(id,order_id,number,total,author_id)
    SELECT $1,$2,COALESCE(MAX(number),0)+1,$3,$4 FROM order_revisions WHERE order_id=$2`,[id,orderId,total,authorId]);
  if (lines.length) await client.query(`INSERT INTO order_lines(revision_id,position,product_id,name,unit_price,quantity)
    SELECT $1,(entry.ordinality-1)::integer,(entry.value->>'product_id')::uuid,entry.value->>'name',
      (entry.value->>'unit_price')::integer,(entry.value->>'quantity')::integer
    FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS entry(value,ordinality)`,[id,JSON.stringify(lines)]);
  return id;
}

async function bumpGroup(client:PoolClient, id:string):Promise<void> {
  await client.query('UPDATE fulfillment_groups SET version=version+1 WHERE id=$1',[id]);
}

// Every customer has at most one open package; a confirmed order joins it, creating one if needed.
// The partial unique index guarantees the invariant under concurrent checkouts.
async function openPackageId(client:PoolClient, userId:string):Promise<string> {
  const find = async ():Promise<{id:string}|undefined> => (await client.query<{id:string}>(
    "SELECT id FROM fulfillment_groups WHERE user_id=$1 AND state='open' FOR UPDATE",[userId])).rows[0];
  const existing = await find();
  if (existing) return existing.id;
  const inserted = (await client.query<{id:string}>(
    "INSERT INTO fulfillment_groups(id,user_id) VALUES($1,$2) ON CONFLICT (user_id) WHERE state='open' DO NOTHING RETURNING id",
    [randomUUID(),userId])).rows[0];
  return inserted ? inserted.id : (await find())!.id;
}

async function adjustPaidStock(client:PoolClient, products:Map<string,Product>, old:OrderLine[], desired:OrderLine[]):Promise<void> {
  const before = quantities(old);
  const after = quantities(desired);
  for (const id of [...products.keys()].sort()) {
    const delta = (before.get(id) ?? 0)-(after.get(id) ?? 0);
    if (delta) await client.query('UPDATE products SET remaining_unsold=remaining_unsold+$2,version=version+1 WHERE id=$1',[id,delta]);
  }
}

async function requestedChange(client:PoolClient, orderId:string, changeId:string):Promise<ChangeRequest> {
  const change = (await client.query<ChangeRequest>('SELECT * FROM change_requests WHERE id=$1 AND order_id=$2',[changeId,orderId])).rows[0];
  if (!change) throw new ApiError(404,'not_found','Change request not found.');
  return change;
}

export async function registerOrders(app:FastifyInstance, pool:Pool, config:Config):Promise<void> {
  app.get('/api/orders',async req => readOrders(pool,req.user.id));
  app.get('/api/seller/orders',async req => {seller(req); return readOrders(pool);});
  app.get('/api/orders/:id',async req => {
    const {id} = orderParams.parse(req.params);
    const order = await readOrder(pool,id);
    owner(req,order.user_id);
    return order;
  });

  app.post('/api/orders/preview',async req => {
    const body = z.object({items:selection,orderId:uuid.optional()}).strict().parse(req.body);
    let old:OrderLine[] = [];
    if (body.orderId) {
      const order = await readOrder(pool,body.orderId);
      owner(req,order.user_id);
      old = order.lines;
    }
    const products = await productsFor(pool,body.items,old,false);
    return quote(body.items,old,products);
  });

  app.post('/api/orders',async req => {
    const body = z.object({items:selection.refine(items => items.length>0,'Select at least one item.'),
      expectedTotal:amount,key:z.string().trim().min(1).max(200)}).strict().parse(req.body);
    const canonical = {...body,items:[...body.items].sort((a,b) => a.productId.localeCompare(b.productId))};
    const hash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
    return transaction(pool,async client => {
      // Serialize customer/key pairs even before a submission row exists.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`checkout:${req.user.id}:${body.key}`]);
      const previous = (await client.query<{payload_hash:string;order_id:string}>(
        'SELECT payload_hash,order_id FROM checkout_submissions WHERE user_id=$1 AND key=$2',[req.user.id,body.key])).rows[0];
      if (previous) {
        if (previous.payload_hash !== hash) throw new ApiError(409,'idempotency_conflict','This checkout key was already used for a different selection.');
        return readOrder(client,previous.order_id);
      }
      const groupId = await openPackageId(client,req.user.id);
      const products = await productsFor(client,body.items,[],true);
      const now = await databaseTime(client);
      const proposed = quote(body.items,[],products);
      acceptedTotal(proposed.total,body.expectedTotal,proposed.lines);
      await checkStock(client,products,proposed.lines,[],null,false,now);
      const id = randomUUID();
      const revisionId = randomUUID();
      // The reference is assigned by the orders.reference column default from order_number_seq.
      // The current revision FK is deferred, so both immutable records commit together.
      await client.query(`INSERT INTO orders(id,user_id,group_id,deadline,current_revision,currency)
        VALUES($1,$2,$3,$4::timestamptz+($7::integer*interval '1 minute'),$5,$6)`,
        [id,req.user.id,groupId,now,revisionId,config.currency,config.holdMinutes]);
      await client.query('INSERT INTO order_revisions(id,order_id,number,total,author_id) VALUES($1,$2,1,$3,$4)',
        [revisionId,id,proposed.total,req.user.id]);
      await client.query(`INSERT INTO order_lines(revision_id,position,product_id,name,unit_price,quantity)
        SELECT $1,(entry.ordinality-1)::integer,(entry.value->>'product_id')::uuid,entry.value->>'name',
          (entry.value->>'unit_price')::integer,(entry.value->>'quantity')::integer
        FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS entry(value,ordinality)`,[revisionId,JSON.stringify(proposed.lines)]);
      await client.query('INSERT INTO checkout_submissions(user_id,key,payload_hash,order_id) VALUES($1,$2,$3,$4)',
        [req.user.id,body.key,hash,id]);
      await bumpGroup(client,groupId);
      return readOrder(client,id);
    });
  });

  app.patch('/api/orders/:id',async req => {
    const {id} = orderParams.parse(req.params);
    const body = z.object({version:expectedVersion,items:selection,expectedTotal:amount}).strict().parse(req.body);
    return lockedOrder(pool,req,id,async (client,order,group) => {
      openPackage(group);
      await checkVersion(client,order,body.version);
      const old = await linesFor(client,order.current_revision);
      const products = await productsFor(client,body.items,old,true);
      const now = await databaseTime(client);
      await awaiting(client,order,now);
      const proposed = quote(body.items,old,products);
      acceptedTotal(proposed.total,body.expectedTotal,proposed.lines);
      await checkStock(client,products,proposed.lines,old,id,false,now);
      const revision = await appendRevision(client,id,req.user.id,proposed.lines,proposed.total);
      await client.query('UPDATE orders SET current_revision=$2,status=$3,version=version+1 WHERE id=$1',
        [id,revision,proposed.lines.length ? 'awaiting_payment' : 'cancelled']);
      await bumpGroup(client,group.id);
      return readOrder(client,id);
    });
  });

  app.post('/api/orders/:id/cancel',async req => {
    const {id} = orderParams.parse(req.params);
    const body = z.object({version:expectedVersion}).strict().parse(req.body);
    return lockedOrder(pool,req,id,async (client,order,group) => {
      if (order.status === 'cancelled') return readOrder(client,id);
      openPackage(group);
      await checkVersion(client,order,body.version);
      const old = await linesFor(client,order.current_revision);
      await productsFor(client,[],old,true);
      await awaiting(client,order,await databaseTime(client));
      await client.query("UPDATE orders SET status='cancelled',version=version+1 WHERE id=$1",[id]);
      await bumpGroup(client,group.id);
      return readOrder(client,id);
    });
  });

  app.post('/api/orders/:id/evidence',async req => {
    const {id} = orderParams.parse(req.params);
    const body = z.object({version:expectedVersion,mediaIds:z.array(uuid).min(1).max(20)
      .refine(ids => new Set(ids).size===ids.length,'Submit each screenshot only once.')}).strict().parse(req.body);
    return lockedOrder(pool,req,id,async (client,order,group) => {
      const existing = (await client.query<{media_id:string}>('SELECT media_id FROM payment_evidence WHERE order_id=$1 ORDER BY media_id',[id])).rows;
      const submitted = [...body.mediaIds].sort();
      if (existing.length && existing.length===submitted.length && existing.every((entry,index) => entry.media_id===submitted[index]))
        return readOrder(client,id);
      openPackage(group);
      await checkVersion(client,order,body.version);
      const old = await linesFor(client,order.current_revision);
      const products = await productsFor(client,[],old,true);
      const now = await databaseTime(client);
      await awaiting(client,order,now);
      // Lock uploads against abandoned-media cleanup until they have durable references.
      const media = await client.query<{id:string;user_id:string;kind:string}>(
        'SELECT id,user_id,kind FROM media WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[submitted]);
      if (media.rows.length !== submitted.length || media.rows.some(file => file.user_id!==order.user_id || file.kind!=='evidence'))
        throw new ApiError(400,'invalid_evidence','Select successfully uploaded screenshots belonging to this order owner.');
      const used = await client.query('SELECT 1 FROM payment_evidence WHERE media_id=ANY($1::uuid[])',[submitted]);
      if (used.rowCount) throw new ApiError(409,'evidence_used','A screenshot is already attached to another submission.');
      // Media waits can cross the deadline: sample once more immediately before accepting.
      const submittedAt = await databaseTime(client);
      await awaiting(client,order,submittedAt);
      await checkStock(client,products,old,old,id,false,submittedAt);
      for (const mediaId of submitted) await client.query(`INSERT INTO payment_evidence(id,order_id,revision_id,media_id,created_at)
        VALUES($1,$2,$3,$4,$5)`,[randomUUID(),id,order.current_revision,mediaId,submittedAt]);
      await client.query("UPDATE orders SET status='payment_review',version=version+1 WHERE id=$1",[id]);
      await bumpGroup(client,group.id);
      return readOrder(client,id);
    });
  });

  app.post('/api/seller/orders/:id/payment',async req => {
    seller(req);
    const {id} = orderParams.parse(req.params);
    const body = z.object({version:expectedVersion,decision:z.enum(['confirmed','rejected']),reason:note.optional()})
      .strict().superRefine((value,context) => {
        if (value.decision==='rejected' && !value.reason) context.addIssue({code:'custom',path:['reason'],message:'Explain why payment was rejected.'});
      }).parse(req.body);
    return lockedOrder(pool,req,id,async (client,order,group) => {
      const existing = (await client.query<{decision:string}>('SELECT decision FROM payment_decisions WHERE order_id=$1',[id])).rows[0];
      if (existing) {
        if (existing.decision===body.decision) return readOrder(client,id);
        throw new ApiError(409,'payment_already_decided','This payment already has a final decision.',{order:await readOrder(client,id)});
      }
      openPackage(group);
      await checkVersion(client,order,body.version);
      if (order.status!=='payment_review') throw new ApiError(409,'invalid_order_state','Only submitted evidence can receive a payment decision.');
      const old = await linesFor(client,order.current_revision);
      const products = await productsFor(client,[],old,true);
      const now = await databaseTime(client);
      if (body.decision==='confirmed') {
        await checkStock(client,products,old,old,id,false,now);
        await adjustPaidStock(client,products,[],old);
      }
      await client.query(`INSERT INTO payment_decisions(id,order_id,revision_id,seller_id,decision,reason)
        VALUES($1,$2,$3,$4,$5,$6)`,[randomUUID(),id,order.current_revision,req.user.id,body.decision,body.reason ?? '']);
      await client.query('UPDATE orders SET status=$2,version=version+1 WHERE id=$1',
        [id,body.decision==='confirmed' ? 'paid' : 'payment_rejected']);
      await bumpGroup(client,group.id);
      return readOrder(client,id);
    });
  });

  app.post('/api/orders/:id/changes',async req => {
    const {id} = orderParams.parse(req.params);
    const body = z.object({version:expectedVersion,items:selection,expectedTotal:amount,note:note.optional()}).strict().parse(req.body);
    return lockedOrder(pool,req,id,async (client,order,group) => {
      openPackage(group);
      await checkVersion(client,order,body.version);
      if (!['payment_review','paid'].includes(order.status)) throw new ApiError(409,'invalid_order_state','Reviewed changes require submitted evidence or a paid order.');
      if ((await client.query("SELECT 1 FROM change_requests WHERE order_id=$1 AND state='pending'",[id])).rowCount)
        throw new ApiError(409,'change_pending','Withdraw or resolve the existing change request first.');
      const old = await linesFor(client,order.current_revision);
      const products = await productsFor(client,body.items,old,false);
      const proposed = quote(body.items,old,products);
      acceptedTotal(proposed.total,body.expectedTotal,proposed.lines);
      await client.query(`INSERT INTO change_requests(id,order_id,base_revision,selection,requested_total,note)
        VALUES($1,$2,$3,$4::jsonb,$5,$6)`,[randomUUID(),id,order.current_revision,JSON.stringify(body.items),proposed.total,body.note ?? '']);
      await client.query('UPDATE orders SET version=version+1 WHERE id=$1',[id]);
      await bumpGroup(client,group.id);
      return readOrder(client,id);
    });
  });

  app.post('/api/orders/:id/changes/:changeId/withdraw',async req => {
    const {id,changeId} = changeParams.parse(req.params);
    const body = z.object({version:expectedVersion}).strict().parse(req.body);
    return lockedOrder(pool,req,id,async (client,order,group) => {
      const change = await requestedChange(client,id,changeId);
      if (change.state==='withdrawn') return readOrder(client,id);
      openPackage(group);
      await checkVersion(client,order,body.version);
      if (change.state!=='pending') throw new ApiError(409,'change_resolved','This change request is already resolved.');
      await client.query("UPDATE change_requests SET state='withdrawn',resolved_at=clock_timestamp() WHERE id=$1",[changeId]);
      await client.query('UPDATE orders SET version=version+1 WHERE id=$1',[id]);
      await bumpGroup(client,group.id);
      return readOrder(client,id);
    });
  });

  app.post('/api/seller/orders/:id/changes/:changeId/resolve',async req => {
    seller(req);
    const {id,changeId} = changeParams.parse(req.params);
    const body = z.object({version:expectedVersion,decision:z.enum(['approved','rejected']),
      settlementNote:note.optional(),reason:note.optional()}).strict().parse(req.body);
    return lockedOrder(pool,req,id,async (client,order,group) => {
      const change = await requestedChange(client,id,changeId);
      if (change.state===body.decision) return readOrder(client,id);
      openPackage(group);
      await checkVersion(client,order,body.version);
      if (change.state!=='pending') throw new ApiError(409,'change_resolved','This change request is already resolved.');
      if (body.decision==='rejected') {
        await client.query(`UPDATE change_requests SET state='rejected',seller_id=$2,reason=$3,
          resolved_at=clock_timestamp() WHERE id=$1`,[changeId,req.user.id,body.reason ?? '']);
      } else {
        if (!['payment_review','paid'].includes(order.status)) throw new ApiError(409,'invalid_order_state','This order no longer permits correction approval. Reject the request instead.');
        if (change.base_revision!==order.current_revision) throw new ApiError(409,'stale_change','The accepted selection changed since this request was made.');
        const old = await linesFor(client,order.current_revision);
        const items = selection.parse(change.selection);
        const products = await productsFor(client,items,old,true);
        const now = await databaseTime(client);
        const proposed = quote(items,old,products);
        acceptedTotal(proposed.total,change.requested_total,proposed.lines,'requested_price_changed');
        const previousTotal = (await client.query<{total:number}>('SELECT total FROM order_revisions WHERE id=$1',[order.current_revision])).rows[0]!.total;
        const difference = proposed.total-previousTotal;
        if (difference!==0 && !body.settlementNote) throw new ApiError(409,'settlement_required',
          'Record the externally settled additional payment or refund before approving.',{difference});
        await checkStock(client,products,proposed.lines,old,id,order.status==='paid',now);
        if (order.status==='paid') await adjustPaidStock(client,products,old,proposed.lines);
        const revision = await appendRevision(client,id,req.user.id,proposed.lines,proposed.total);
        await client.query('UPDATE orders SET current_revision=$2 WHERE id=$1',[id,revision]);
        await client.query(`UPDATE change_requests SET state='approved',resolved_revision=$2,seller_id=$3,
          difference=$4,settlement_note=$5,reason=$6,resolved_at=clock_timestamp() WHERE id=$1`,
          [changeId,revision,req.user.id,difference,body.settlementNote ?? '',body.reason ?? '']);
      }
      await client.query('UPDATE orders SET version=version+1 WHERE id=$1',[id]);
      await bumpGroup(client,group.id);
      return readOrder(client,id);
    });
  });
}

export async function expireOrders(pool:Pool):Promise<number> {
  let total = 0;
  for (;;) {
    const expired = await transaction(pool,async client => {
      const candidates = await client.query<{id:string;group_id:string}>(`SELECT id,group_id FROM orders
        WHERE status='awaiting_payment' AND deadline<=clock_timestamp() ORDER BY id LIMIT 100`);
      if (!candidates.rows.length) return null;
      const groups = [...new Set(candidates.rows.map(order => order.group_id))].sort();
      await client.query('SELECT id FROM fulfillment_groups WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[groups]);
      const orders = await client.query<LockedOrder>(`SELECT * FROM orders
        WHERE id=ANY($1::uuid[]) AND group_id=ANY($2::uuid[]) AND status='awaiting_payment'
        ORDER BY id FOR UPDATE`,[candidates.rows.map(order => order.id),groups]);
      const productIds = (await client.query<{product_id:string}>(`SELECT DISTINCT l.product_id FROM order_lines l
        JOIN orders o ON o.current_revision=l.revision_id WHERE o.id=ANY($1::uuid[]) ORDER BY l.product_id`,
        [orders.rows.map(order => order.id)])).rows.map(line => line.product_id);
      if (productIds.length) await client.query('SELECT id FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[productIds]);
      const now = await databaseTime(client);
      const result = await client.query<{group_id:string}>(`UPDATE orders SET status='expired',version=version+1
        WHERE id=ANY($1::uuid[]) AND status='awaiting_payment' AND deadline<=$2 RETURNING group_id`,
        [orders.rows.map(order => order.id),now]);
      for (const groupId of [...new Set(result.rows.map(order => order.group_id))].sort()) await bumpGroup(client,groupId);
      return result.rowCount ?? 0;
    });
    if (expired===null) return total;
    total += expired;
  }
}
