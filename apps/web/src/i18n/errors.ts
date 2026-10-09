import { ApiError } from '../api';
import i18next from './index';

const knownCodes = {
  invalid_launch: 'errors.invalid_launch',
  unauthorized: 'errors.unauthorized',
  session_expired: 'errors.session_expired',
  forbidden: 'errors.forbidden',
  invalid_image: 'errors.invalid_image',
  invalid_upload: 'errors.invalid_upload',
  file_too_large: 'errors.file_too_large',
  not_found: 'errors.not_found',
  stock_reserved: 'errors.stock_reserved',
  invalid_product: 'errors.invalid_product',
  stale_version: 'errors.stale_version',
  pending_changes: 'errors.pending_changes',
  no_paid_items: 'errors.no_paid_items',
  package_completed: 'errors.package_completed',
  missing_delivery_code: 'errors.missing_delivery_code',
  group_changed: 'errors.group_changed',
  product_unavailable: 'errors.product_unavailable',
  invalid_total: 'errors.invalid_total',
  order_expired: 'errors.order_expired',
  invalid_order_state: 'errors.invalid_order_state',
  stock_limit: 'errors.stock_limit',
  stock_conflict: 'errors.stock_conflict',
  idempotency_conflict: 'errors.idempotency_conflict',
  price_changed: 'errors.price_changed',
  requested_price_changed: 'errors.requested_price_changed',
  invalid_evidence: 'errors.invalid_evidence',
  evidence_used: 'errors.evidence_used',
  payment_already_decided: 'errors.payment_already_decided',
  change_pending: 'errors.change_pending',
  change_resolved: 'errors.change_resolved',
  stale_change: 'errors.stale_change',
  settlement_required: 'errors.settlement_required',
  invalid_input: 'errors.invalid_input',
  invalid_request: 'errors.invalid_request',
  conflict: 'errors.conflict',
  internal_error: 'errors.internal_error',
  network: 'errors.network',
  request_failed: 'errors.generic',
} as const satisfies Record<string, string>;

const fieldKeys = {
  initData: 'errors.fields.initData',
  name: 'errors.fields.name',
  comment: 'errors.fields.comment',
  price: 'errors.fields.price',
  stock: 'errors.fields.stock',
  imageIds: 'errors.fields.imageIds',
  version: 'errors.fields.version',
  ids: 'errors.fields.ids',
  items: 'errors.fields.items',
  productId: 'errors.fields.productId',
  expectedTotal: 'errors.fields.expectedTotal',
  key: 'errors.fields.key',
  mediaIds: 'errors.fields.mediaIds',
  decision: 'errors.fields.decision',
  reason: 'errors.fields.reason',
  note: 'errors.fields.note',
  deliveryCode: 'errors.fields.deliveryCode',
  method: 'errors.fields.method',
  allowMissingCode: 'errors.fields.allowMissingCode',
} as const satisfies Record<string, string>;

const problemKeys = {
  initData: 'errors.problem.initData',
  name: 'errors.problem.name',
  comment: 'errors.problem.comment',
  price: 'errors.problem.price',
  stock: 'errors.problem.stock',
  imageIds: 'errors.problem.imageIds',
  version: 'errors.problem.version',
  ids: 'errors.problem.ids',
  items: 'errors.problem.items',
  productId: 'errors.problem.productId',
  expectedTotal: 'errors.problem.expectedTotal',
  key: 'errors.problem.key',
  mediaIds: 'errors.problem.mediaIds',
  decision: 'errors.problem.decision',
  reason: 'errors.problem.reason',
  note: 'errors.problem.note',
  deliveryCode: 'errors.problem.deliveryCode',
  method: 'errors.problem.method',
  allowMissingCode: 'errors.problem.allowMissingCode',
} as const satisfies Record<string, string>;

const CHECK_PRODUCT_CODES = ['product_unavailable', 'stock_limit', 'invalid_product'];

export function describeError(error: unknown, productName?: (id: string) => string | undefined): string {
  if (error instanceof ApiError) {
    const details: unknown = error.details;
    let message: string;
    if (error.code === 'invalid_input') {
      const issues = Array.isArray(details) ? details as { field?: string }[] : [];
      const parts = [i18next.t('errors.invalid_input')];
      for (const issue of issues) {
        const path = typeof issue.field === 'string' ? issue.field : '';
        const base = path.split('.').filter(segment => !/^\d+$/.test(segment))[0] ?? '';
        const fieldKey = fieldKeys[base as keyof typeof fieldKeys];
        const problemKey = problemKeys[base as keyof typeof problemKeys];
        const problem = problemKey ? i18next.t(problemKey) : i18next.t('errors.problem.generic');
        parts.push(fieldKey ? `${i18next.t(fieldKey)} ${problem}` : problem);
      }
      message = parts.join(' ');
    } else if (error.code === 'stock_conflict') {
      const shortages = (details as { shortages?: { productId: string; requested: number; available: number }[] } | undefined)?.shortages ?? [];
      const parts = [i18next.t('errors.stock_conflict')];
      for (const item of shortages) {
        const name = productName?.(item.productId) ?? i18next.t('errors.unknownProduct');
        parts.push(i18next.t('errors.shortageItem', { name, requested: item.requested, available: item.available }));
      }
      message = parts.join(' ');
    } else {
      const codeKey = knownCodes[error.code as keyof typeof knownCodes];
      if (codeKey) {
        message = i18next.t(codeKey);
        if (CHECK_PRODUCT_CODES.includes(error.code)) {
          const productId = (details as { productId?: string } | undefined)?.productId;
          const name = productId ? productName?.(productId) : undefined;
          if (name) message = `${message} ${i18next.t('errors.checkProduct', { name })}`;
        }
      } else {
        message = error.message || i18next.t('errors.generic');
      }
    }
    return error.status === 409 ? `${message} ${i18next.t('errors.conflictSuffix')}` : message;
  }
  if (error instanceof Error) return error.message;
  return i18next.t('errors.network');
}
