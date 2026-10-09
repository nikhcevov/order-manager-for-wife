import type { Method, Status } from '../api';
import i18next from './index';

const STATUS_KEYS = {
  awaiting_payment: 'base.status.awaiting_payment',
  payment_review: 'base.status.payment_review',
  paid: 'base.status.paid',
  expired: 'base.status.expired',
  cancelled: 'base.status.cancelled',
  payment_rejected: 'base.status.payment_rejected',
} as const satisfies Record<Status, string>;

const METHOD_KEYS = {
  delivery: 'base.method.delivery',
  in_person: 'base.method.in_person',
} as const satisfies Record<Method, string>;

export function statusLabel(status: Status): string {
  return i18next.t(STATUS_KEYS[status]);
}

export function methodLabel(method: Method | null): string {
  return method ? i18next.t(METHOD_KEYS[method]) : i18next.t('base.method.package');
}
