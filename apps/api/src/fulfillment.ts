import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { transaction } from './db.js';
import { ApiError, owner, seller, version } from './http.js';

const expectedVersion = z.number().int().positive().max(2147483647);
const params = z.object({ id: z.uuid() });
const actionBody = z.object({ version: expectedVersion }).strict();
const completeBody = z.object({ version: expectedVersion, allowMissingCode: z.boolean().optional() }).strict();
const editBody = z.object({
  version: expectedVersion,
  method: z.enum(['delivery', 'in_person']),
  deliveryCode: z.string().trim().max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Use a single-line delivery code.').nullable().optional(),
}).strict();
interface GroupRow { id: string; user_id: string; method: 'delivery' | 'in_person'; delivery_code: string | null; state: 'open' | 'packing' | 'completed'; version: number; completion_kind: 'sent' | 'handed_over' | null; completed_at: Date | null; created_at: Date }
interface Line { product_id: string; name: string; unit_price: number; quantity: number }
interface ShallowOrder { id: string; reference: string; user_id: string; group_id: string; status: string; total: number; currency: string; deadline: string; current_revision: string; version: number; lines: Line[]; changes: Record<string, unknown>[] }
interface Group extends GroupRow { customer: { first_name: string; username: string | null }; orders: ShallowOrder[]; packing_lines: Line[] }
const groupSelect = `SELECT g.*,jsonb_build_object('first_name',c.first_name,'username',c.username) AS customer,
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id',o.id,'reference',o.reference,'user_id',o.user_id,'group_id',o.group_id,
    'status',CASE WHEN o.status='awaiting_payment' AND o.deadline<=clock_timestamp() THEN 'expired' ELSE o.status END,
    'total',r.total,'currency',o.currency,'deadline',o.deadline,'current_revision',o.current_revision,
    'version',o.version,'created_at',o.created_at,
    'lines',COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id',l.product_id,'name',l.name,'unit_price',l.unit_price,'quantity',l.quantity) ORDER BY l.position)
                    FROM order_lines l WHERE l.revision_id=o.current_revision),'[]'::jsonb),
    'changes',COALESCE((SELECT jsonb_agg(to_jsonb(cr) ORDER BY cr.created_at,cr.id) FROM change_requests cr WHERE cr.order_id=o.id),'[]'::jsonb)
  ) ORDER BY o.created_at,o.id) FROM orders o JOIN order_revisions r ON r.id=o.current_revision WHERE o.group_id=g.id),'[]'::jsonb) AS orders,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id',pl.product_id,'name',pl.name,'unit_price',pl.unit_price,'quantity',pl.quantity)
                             ORDER BY pl.product_id,pl.name,pl.unit_price) FROM (
    SELECT l.product_id,l.name,l.unit_price,SUM(l.quantity)::bigint AS quantity
    FROM orders o JOIN order_lines l ON l.revision_id=o.current_revision WHERE o.group_id=g.id AND o.status='paid'
    GROUP BY l.product_id,l.name,l.unit_price
  ) pl),'[]'::jsonb) AS packing_lines
  FROM fulfillment_groups g JOIN customers c ON c.id=g.user_id`;

async function readGroups(db: Pool | PoolClient, filter: { id?: string; userId?: string } = {}): Promise<Group[]> {
  const values: string[] = [];
  const conditions: string[] = [];
  if (filter.id) { values.push(filter.id); conditions.push(`g.id=$${values.length}`); }
  if (filter.userId) { values.push(filter.userId); conditions.push(`g.user_id=$${values.length}`); }
  const result = await db.query<Group>(`${groupSelect}${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY g.created_at,g.id`, values);
  return result.rows;
}

async function lockGroup(client: PoolClient, id: string): Promise<GroupRow> {
  const group = (await client.query<GroupRow>('SELECT * FROM fulfillment_groups WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!group) throw new ApiError(404, 'not_found', 'Fulfillment group not found');
  return group;
}

async function lockOrders(client: PoolClient, id: string): Promise<{ id: string; status: string }[]> {
  const result = await client.query<{ id: string; status: string }>('SELECT id,status FROM orders WHERE group_id=$1 ORDER BY id FOR UPDATE', [id]);
  return result.rows;
}

async function requireReady(client: PoolClient, groupId: string, requireAllPaid: boolean): Promise<void> {
  if ((await client.query(`SELECT 1 FROM change_requests cr JOIN orders o ON o.id=cr.order_id WHERE o.group_id=$1 AND cr.state='pending' LIMIT 1`, [groupId])).rowCount) {
    throw new ApiError(409, 'pending_changes', 'Resolve or withdraw all pending item-change requests before packing or completion.');
  }
  if (requireAllPaid && (await client.query(`SELECT 1 FROM orders WHERE group_id=$1 AND status<>'paid' LIMIT 1`, [groupId])).rowCount) {
    throw new ApiError(409, 'unpaid_orders', 'Only paid orders may be included in completed fulfillment.');
  }
  if (!(await client.query(`SELECT 1 FROM orders o JOIN order_lines l ON l.revision_id=o.current_revision WHERE o.group_id=$1 AND o.status='paid' LIMIT 1`, [groupId])).rowCount) {
    throw new ApiError(409, 'no_paid_items', 'At least one paid item is required for packing or completion.');
  }
}

export async function registerFulfillment(app: FastifyInstance, pool: Pool, _config: Config): Promise<void> {
  app.get('/api/groups', async req => readGroups(pool, { userId: req.user.id }));
  app.get('/api/seller/groups', async req => { seller(req); return readGroups(pool); });
  app.get('/api/groups/:id', async req => {
    const { id } = params.parse(req.params);
    const group = (await readGroups(pool, { id }))[0];
    if (!group) throw new ApiError(404, 'not_found', 'Fulfillment group not found');
    owner(req, group.user_id);
    return group;
  });
  app.patch('/api/groups/:id', async req => {
    const { id } = params.parse(req.params);
    const body = editBody.parse(req.body);
    return transaction(pool, async client => {
      const group = await lockGroup(client, id);
      if (group.user_id !== req.user.id) throw new ApiError(404, 'not_found', 'Fulfillment group not found');
      if (group.state !== 'open') throw new ApiError(409, 'group_frozen', 'The seller must reopen this group before its method or code can change.');
      version(group.version, body.version);
      const code = body.method === 'in_person' ? null : body.deliveryCode !== undefined
        ? body.deliveryCode || null : group.method === 'delivery' ? group.delivery_code : null;
      if (group.method !== body.method || group.delivery_code !== code) {
        await client.query('UPDATE fulfillment_groups SET method=$2,delivery_code=$3,version=version+1 WHERE id=$1', [id, body.method, code]);
      }
      return (await readGroups(client, { id }))[0]!;
    });
  });
  app.post('/api/seller/groups/:id/pack', async req => {
    seller(req);
    const { id } = params.parse(req.params);
    const body = actionBody.parse(req.body);
    return transaction(pool, async client => {
      const group = await lockGroup(client, id);
      if (group.state === 'packing' || group.state === 'completed') return (await readGroups(client, { id }))[0]!;
      version(group.version, body.version);
      const orders = await lockOrders(client, id);
      await requireReady(client, id, false);
      if (orders.some(order => order.status !== 'paid')) {
        const remainingId = randomUUID();
        await client.query(`INSERT INTO fulfillment_groups(id,user_id,method) VALUES($1,$2,$3)`, [remainingId, group.user_id, group.method]);
        await client.query(`UPDATE orders SET group_id=$2,version=version+1 WHERE group_id=$1 AND status<>'paid'`, [id, remainingId]);
      }
      await client.query(`UPDATE fulfillment_groups SET state='packing',version=version+1 WHERE id=$1`, [id]);
      return (await readGroups(client, { id }))[0]!;
    });
  });
  app.post('/api/seller/groups/:id/reopen', async req => {
    seller(req);
    const { id } = params.parse(req.params);
    const body = actionBody.parse(req.body);
    return transaction(pool, async client => {
      const group = await lockGroup(client, id);
      if (group.state === 'open') return (await readGroups(client, { id }))[0]!;
      if (group.state !== 'packing') throw new ApiError(409, 'invalid_group_state', 'Completed fulfillment cannot be reopened.');
      version(group.version, body.version);
      await client.query(`UPDATE fulfillment_groups SET state='open',version=version+1 WHERE id=$1`, [id]);
      return (await readGroups(client, { id }))[0]!;
    });
  });
  app.post('/api/seller/groups/:id/complete', async req => {
    seller(req);
    const { id } = params.parse(req.params);
    const body = completeBody.parse(req.body);
    return transaction(pool, async client => {
      const group = await lockGroup(client, id);
      if (group.state === 'completed') return (await readGroups(client, { id }))[0]!;
      if (group.state !== 'packing') throw new ApiError(409, 'invalid_group_state', 'Start packing before completing fulfillment.');
      version(group.version, body.version);
      await lockOrders(client, id);
      await requireReady(client, id, true);
      if (group.method === 'delivery' && !group.delivery_code && body.allowMissingCode !== true) {
        throw new ApiError(409, 'missing_delivery_code', 'No delivery code was supplied. Confirm explicitly to complete without a code.', { allowMissingCode: true });
      }
      await client.query(`UPDATE fulfillment_groups SET state='completed',completion_kind=$2,completed_at=clock_timestamp(),version=version+1 WHERE id=$1`, [id, group.method === 'delivery' ? 'sent' : 'handed_over']);
      return (await readGroups(client, { id }))[0]!;
    });
  });
}
