import en from '../en/base';
import { assertCatalogCovers } from '../parity';

const base = {
  status: {
    awaiting_payment: 'Ожидает оплаты',
    payment_review: 'Оплата на проверке',
    paid: 'Оплачено',
    expired: 'Срок брони истёк',
    cancelled: 'Отменён',
    payment_rejected: 'Оплата отклонена',
  },
  method: {
    delivery: 'Доставка',
    in_person: 'Личная передача',
    package: 'Посылка',
  },
  priceDecimals: 'Введите неотрицательную цену не более чем с {{digits}} знаками после запятой.',
  priceTooLarge: 'Цена слишком велика.',
};

assertCatalogCovers<typeof en, typeof base>();

export default base;
