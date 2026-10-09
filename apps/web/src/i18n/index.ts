import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { telegram } from '../telegram';
import baseEn from './catalogs/en/base';
import commonEn from './catalogs/en/common';
import customerEn from './catalogs/en/customer';
import errorsEn from './catalogs/en/errors';
import sellerEn from './catalogs/en/seller';
import shellEn from './catalogs/en/shell';
import baseRu from './catalogs/ru/base';
import commonRu from './catalogs/ru/common';
import customerRu from './catalogs/ru/customer';
import errorsRu from './catalogs/ru/errors';
import sellerRu from './catalogs/ru/seller';
import shellRu from './catalogs/ru/shell';

/** Primary language subtags presented in Russian. */
const RUSSIAN_LANGUAGES = new Set(['ru', 'uk', 'be', 'kk', 'ky', 'uz', 'tg']);

export type Language = 'ru' | 'en';

export function resolveLanguage(languageCode?: string | null): Language {
  const primary = (languageCode ?? '').toLowerCase().split('-')[0] ?? '';
  return RUSSIAN_LANGUAGES.has(primary) ? 'ru' : 'en';
}

const en = {
  base: baseEn,
  common: commonEn,
  customer: customerEn,
  errors: errorsEn,
  seller: sellerEn,
  shell: shellEn,
};
const ru = {
  base: baseRu,
  common: commonRu,
  customer: customerRu,
  errors: errorsRu,
  seller: sellerRu,
  shell: shellRu,
};

export type Catalog = typeof en;

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: Catalog };
  }
}

const language = resolveLanguage(telegram?.initDataUnsafe?.user?.language_code);

void i18next.use(initReactI18next).init({
  lng: language,
  fallbackLng: 'en',
  resources: { en: { translation: en }, ru: { translation: ru } },
  initAsync: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

document.documentElement.lang = language;

export default i18next;
