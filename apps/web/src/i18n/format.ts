import i18next from './index';

/** Presentation locales follow the interface language, never the device locale. */
const LOCALES: Record<string, string> = { ru: 'ru-RU', en: 'en-US' };
/** Minor units are a property of the shop currency, so digit counts stay locale-independent. */
const MINOR_UNIT_LOCALE = 'en-US';

function locale(): string {
  return LOCALES[i18next.resolvedLanguage ?? ''] ?? 'en-US';
}

const formatters = new Map<string, Intl.NumberFormat>();

function currencyFormatter(currency: string): Intl.NumberFormat {
  const key = `${locale()}|${currency}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale(), { style: 'currency', currency });
    formatters.set(key, formatter);
  }
  return formatter;
}

function minorUnitDigits(currency: string): number {
  return new Intl.NumberFormat(MINOR_UNIT_LOCALE, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

export function money(amount: number, currency: string): string {
  const digits = minorUnitDigits(currency);
  return currencyFormatter(currency).format(amount / 10 ** digits);
}

export function toMinor(value: string, currency: string): number {
  const digits = minorUnitDigits(currency);
  if (!/^\d+(\.\d+)?$/.test(value) || (value.split('.')[1]?.length ?? 0) > digits) throw new Error(i18next.t('base.priceDecimals', { digits }));
  const parts = value.split('.');
  const amount = Number(parts[0]) * 10 ** digits + Number((parts[1] ?? '').padEnd(digits, '0'));
  if (!Number.isSafeInteger(amount)) throw new Error(i18next.t('base.priceTooLarge'));
  return amount;
}

export function priceInput(amount: number, currency: string): string {
  const digits = minorUnitDigits(currency);
  return (amount / 10 ** digits).toFixed(digits);
}

export function date(value?: string | null): string {
  return value ? new Date(value).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}
