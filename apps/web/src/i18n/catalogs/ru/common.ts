import en from '../en/common';
import { assertCatalogCovers } from '../parity';

const common = {
  primary: {
    working: 'Выполняется…',
  },
  lines: {
    empty: 'В этой версии нет товаров.',
  },
  order: {
    heading: 'Заказ {{reference}}',
    noItems: 'Нет актуальных товаров',
  },
  media: {
    privateLoadFailed: 'Не удалось загрузить это личное изображение.',
    loadFailed: 'Не удалось загрузить изображение.',
    retry: 'Повторить загрузку',
    open: 'Открыть: {{alt}}',
    loading: 'Загрузка: {{alt}}',
  },
  gallery: {
    previous: 'Предыдущее изображение',
    next: 'Следующее изображение',
    counter: '{{current}} / {{total}}',
    alternative: '{{name}}, изображение {{number}}',
  },
  quantity: {
    removeOne: 'Убрать одну единицу: {{name}}',
    quantityOf: 'Количество: {{name}}',
    addOne: 'Добавить одну единицу: {{name}}',
  },
};

assertCatalogCovers<typeof en, typeof common>();

export default common;
