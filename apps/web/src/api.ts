export interface User { id: string; first_name: string; username?: string; isSeller: boolean }
export interface Session { token: string; user: User; currency: string; paymentInstructions: string; holdMinutes: number }
export interface Product { id: string; name: string; comment: string | null; price: number; remaining_unsold: number; published: boolean; version: number; images: string[]; reserved: number; available: number; bought: number }
export interface Line { product_id: string; name: string; unit_price: number; quantity: number }
export interface Revision { id: string; number: number; total: number; created_at: string; lines: Line[] }
export interface Evidence { id: string; media_id: string; revision_id: string; created_at: string }
export interface Change { id: string; order_id: string; base_revision: string; selection: Selection; requested_total: number; note: string | null; state: 'pending' | 'approved' | 'rejected' | 'withdrawn'; difference: number | null; settlement_note: string | null; reason: string | null; created_at?: string; resolved_at?: string }
export type Status = 'awaiting_payment' | 'payment_review' | 'paid' | 'expired' | 'cancelled' | 'payment_rejected';
export type Method = 'delivery' | 'in_person';
export interface Order { id: string; reference: string; user_id: string; group_id: string; status: Status; deadline: string; current_revision: string; version: number; currency: string; created_at: string; total: number; lines: Line[]; revisions: Revision[]; evidence: Evidence[]; decision: null | { decision: string; reason?: string; created_at?: string }; changes: Change[]; customer: { first_name: string; username?: string }; group: Pick<Group, 'id' | 'method' | 'state' | 'delivery_code'> }
export type GroupOrder = Pick<Order, 'id' | 'reference' | 'status' | 'total' | 'currency' | 'lines' | 'changes' | 'version'> & { created_at?: string };
export interface Group { id: string; user_id: string; method: Method; delivery_code: string | null; state: 'open' | 'packing' | 'completed'; version: number; completion_kind: 'sent' | 'handed_over' | null; completed_at: string | null; created_at: string; customer: { first_name: string; username?: string | null }; orders: GroupOrder[]; packing_lines: Line[] }
export type Selection = { productId: string; quantity: number }[];
export interface Preview { lines: Line[]; total: number }
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export async function request<T>(path: string, token?: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), signal });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const fields = error.error === 'invalid_input' && Array.isArray(error.details)
      ? error.details.map((issue: { field: string; message: string }) => `${issue.field || 'Selection'}: ${issue.message}`).join(' ')
      : '';
    throw new ApiError(response.status, error.error || 'request_failed', `${error.message || `Request failed (${response.status}).`}${fields ? ` ${fields}` : ''}`, error.details);
  }
  return response.json() as Promise<T>;
}
export async function upload(token: string, file: File, kind: 'product' | 'evidence'): Promise<string> {
  const data = new FormData();
  data.append('kind', kind);
  data.append('file', file);
  return (await request<{ id: string }>('/media', token, data)).id;
}
export function money(amount: number, currency: string): string {
  const formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(amount / 10 ** digits);
}
export function toMinor(value: string, currency: string): number {
  const digits = new Intl.NumberFormat(undefined, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  if (!/^\d+(\.\d+)?$/.test(value) || (value.split('.')[1]?.length ?? 0) > digits) throw new Error(`Enter a nonnegative price with at most ${digits} decimal places.`);
  const parts = value.split('.');
  const amount = Number(parts[0]) * 10 ** digits + Number((parts[1] ?? '').padEnd(digits, '0'));
  if (!Number.isSafeInteger(amount)) throw new Error('Price is too large.');
  return amount;
}
export function priceInput(amount: number, currency: string): string {
  const digits = new Intl.NumberFormat(undefined, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return (amount / 10 ** digits).toFixed(digits);
}
export function date(value?: string | null): string { return value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
export const statusLabels: Record<Status, string> = { awaiting_payment: 'Awaiting payment', payment_review: 'Payment under review', paid: 'Paid', expired: 'Hold expired', cancelled: 'Cancelled', payment_rejected: 'Payment rejected' };
export const methodLabel = (method: Method) => method === 'delivery' ? 'Delivery' : 'In-person handover';
export const aggregate = (lines: Line[]): Selection => Object.entries(lines.reduce<Record<string, number>>((result, line) => { result[line.product_id] = (result[line.product_id] ?? 0) + line.quantity; return result; }, {})).map(([productId, quantity]) => ({ productId, quantity }));
