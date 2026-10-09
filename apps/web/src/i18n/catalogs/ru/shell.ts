import en from '../en/shell';
import { assertCatalogCovers } from '../parity';

const shell = {
  header: {
    cart: 'Корзина',
    cartLabel_one: 'Корзина, {{count}} товар',
    cartLabel_few: 'Корзина, {{count}} товара',
    cartLabel_many: 'Корзина, {{count}} товаров',
    cartLabel_other: 'Корзина, {{count}} товара',
    manage: 'Управление',
    shopView: 'Витрина',
    refresh: 'Обновить',
    sellerWorkspace: 'Кабинет продавца',
    hello: 'Здравствуйте, {{name}}',
    shopNavigation: 'Навигация по магазину',
    managementNavigation: 'Навигация по управлению',
  },
  tabs: {
    catalog: 'Магазин',
    orders: 'Заказы',
    packages: 'Посылки',
    products: 'Товары',
    review: 'Оплаты',
    changes: 'Запросы',
    shipments: 'Отправки',
  },
  back: '← Назад',
  notice: {
    errorTitle: 'Требуется внимание',
    dismiss: 'Скрыть',
    dismissMessage: 'Скрыть сообщение',
  },
  loading: 'Загружаем магазин…',
  run: {
    staleData: 'Действие завершено, но последние данные загрузить не удалось. Обновите, чтобы увидеть сохранённый результат.',
  },
  launch: {
    eyebrow: 'Little Shop',
    loadingTitle: 'Открываем ваш магазин…',
    expiredTitle: 'Сеанс завершён',
    deniedTitle: 'Не удалось проверить запуск',
    welcomeTitle: 'Маленький магазин внутри Telegram',
    loadingBody: 'Проверяем безопасный запуск из Telegram.',
    outsideBody: 'Откройте магазин из мини-приложения бота или кнопки меню в Telegram. Запуск из Telegram нужен, чтобы безопасно просматривать покупки и управлять ими.',
    expiredBody: 'Закройте это мини-приложение и снова откройте его из бота в Telegram, чтобы начать новый безопасный сеанс.',
    deniedBody: 'Закройте это окно и снова откройте магазин из бота в Telegram. Не используйте старую ссылку запуска.',
    privacy: 'Без пароля. Платёжные данные не публикуются.',
  },
  pages: {
    ordersEyebrow: 'Ваши покупки',
    ordersTitle: 'Заказы и история',
    ordersBody: 'У каждого заказа своя оплата и согласованные цены.',
    ordersEmpty: 'Заказов пока нет',
    ordersEmptyBody: 'Загляните в магазин и оформите первый заказ. Товары в корзине ничего не резервируют.',
    productEmpty: 'Товар недоступен',
    productEmptyBody: 'Этот товар больше не отображается. Вернитесь в магазин, чтобы увидеть актуальное наличие.',
    orderEmpty: 'Заказ недоступен',
    orderEmptyBody: 'Обновите страницу или вернитесь к списку заказов.',
    packageEmpty: 'Посылка недоступна',
    packageEmptyBody: 'Обновите страницу или вернитесь к посылкам.',
  },
  footer: {
    updated: 'Обновлено {{time}} · Обновляется при активности',
    secure: 'Защищённый магазин в Telegram',
    payments: 'Ручная оплата · Автоматические посылки',
  },
};

assertCatalogCovers<typeof en, typeof shell>();

export default shell;
