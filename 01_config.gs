// Code.gs - чистый backend для заявок + Telegram кнопок

const BUILD_VERSION = '2026-02-24-bot-module-v1';
const DEFAULT_PROD_EXEC_URL = 'https://script.google.com/macros/s/AKfycbxNNiA-5F13rR2X3yr16Uv0ao1UTVRpg4gS86a63AY/exec';

const PROP = PropertiesService.getScriptProperties();
const SHEET_NAME = 'Заявки';
const WEBAPP_EXEC_URL_PROPERTY = 'WEBAPP_EXEC_URL';
const WEBHOOK_LAST_SYNC_TS_PROPERTY = 'WEBHOOK_LAST_SYNC_TS';

const CALLBACK_CACHE_TTL_SECONDS = 600;
const ORDER_DM_SENT_PREFIX = 'ORDER_DM_SENT_';
const ORDER_DM_META_PREFIX = 'ORDER_DM_META_';
const MANAGER_PENDING_PAY_PREFIX = 'MANAGER_PENDING_PAY_';
const MANAGER_PENDING_PAY_TTL_MS = 60 * 60 * 1000;

const CALLBACK_ACTIONS = {
  TAKE: 'take',
  ARRIVE: 'arrive',
  DONE: 'done',
  PAID: 'paid',
  CANCEL: 'cancel',
  MANAGER_PAY: 'managerpay'
};

const REQUIRED_HEADERS = [
  'Номер заявки',
  'Дата создания',
  'Менеджер',
  'Имя клиента',
  'Телефон клиента',
  'Город',
  'Улица и дом',
  'Квартира/офис',
  'Дата уборки',
  'Время уборки',
  'Сумма заказа',
  'Зарплата мастерам',
  'Тип уборки',
  'Площадь (м²)',
  'Химия',
  'Оборудование',
  'Описание работ',
  'Статус',
  'Telegram Chat ID',
  'Telegram Message ID',
  'Master ID',
  'Master Name',
  'Дата принятия',
  'Дата прибытия',
  'Дата завершения',
  'Дата оплаты',
  'Напоминание 24ч',
  'Напоминание 2ч',
  'Статус выполнения'
];
