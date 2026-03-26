// Code.gs - чистый backend для заявок + Telegram кнопок

const BUILD_VERSION = '2026-02-25-group-test-v2';
const BACKEND_API_SIGNATURE = 'apex-backend-v2';
const DEFAULT_PROD_EXEC_URL = 'https://script.google.com/macros/s/AKfycbxNNiA-5F13rR2X3yr16Uv0ao1UTVRpg4gS86a63AY/exec';

const PROP = PropertiesService.getScriptProperties();
const SHEET_NAME = 'Заявки';
const WEBAPP_EXEC_URL_PROPERTY = 'WEBAPP_EXEC_URL';
const WEBHOOK_LAST_SYNC_TS_PROPERTY = 'WEBHOOK_LAST_SYNC_TS';
const TELEGRAM_RUNTIME_MODE_PROPERTY = 'TELEGRAM_RUNTIME_MODE';
const MESSENGER_PROVIDER_PROPERTY = 'MESSENGER_PROVIDER';

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
  MANAGER_PAY: 'managerpay',
  TEST: 'test'
};

function getTelegramRuntimeMode() {
  const raw = String(PROP.getProperty(TELEGRAM_RUNTIME_MODE_PROPERTY) || '').trim().toLowerCase();
  if (raw === 'direct') return 'direct';
  return 'apps_script';
}

function isDirectTelegramRuntime() {
  return getTelegramRuntimeMode() === 'direct';
}

function getMessengerProvider() {
  const raw = String(PROP.getProperty(MESSENGER_PROVIDER_PROPERTY) || '').trim().toLowerCase();
  if (raw === 'vk' || raw === 'vkontakte') return 'vk';
  if (raw === 'telegram' || raw === 'tg') return 'telegram';
  return 'vk';
}

function isVkProvider() {
  return getMessengerProvider() === 'vk';
}

function getBotApiToken() {
  if (isVkProvider()) {
    return String(PROP.getProperty('VK_BOT_TOKEN') || PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  }
  return String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
}

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
