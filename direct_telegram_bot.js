#!/usr/bin/env node
/*
  Direct Telegram bot (no Apps Script, no Google Sheets).
  Features:
  - HTTP API: create orders (/order)
  - Telegram group publish with inline button "ВЫХОЖУ НА ЗАЯВКУ"
  - Master flow: take -> arrive -> done -> paid -> cancel
  - Manager flow: panel, active/planned orders, send payment link/QR to master
  - Event notifications to separate events chat
  - Local JSON state persistence
*/

const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');

const BUILD_VERSION = 'direct-bot-v2';
const PORT = Number(process.env.PORT || 8080);
const STATE_FILE = path.resolve(process.env.STATE_FILE || './direct_bot_state.json');
const TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : '';

if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

const DEFAULT_GROUP_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '').trim();
const DEFAULT_NSK_CHAT_ID = String(process.env.TELEGRAM_CHAT_NOVOSIBIRSK || '').trim();
const DEFAULT_MANAGER_CHAT_ID = String(process.env.TELEGRAM_MANAGER_CHAT_ID || '').trim();
const DEFAULT_EVENTS_CHAT_ID = String(process.env.TELEGRAM_EVENTS_CHAT_ID || '').trim();

const LONG_POLL_TIMEOUT_SEC = 25;
const CALLBACK_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const MANAGER_PENDING_PAY_TTL_MS = 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function nowRu() {
  return new Date().toLocaleString('ru-RU');
}

function safe(v) {
  return String(v || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeId(v) {
  return String(v || '').trim();
}

function cityKey(v) {
  return String(v || '').trim().toLowerCase();
}

function normalizeOrderId(v) {
  const raw = String(v || '').trim();
  if (!raw) return '';
  if (/^cln-/i.test(raw)) return `CLN-${raw.slice(4).replace(/[^\w-]/g, '')}`;
  return raw.replace(/[^\w-]/g, '');
}

function parseRuDateTime(dateStr, timeStr) {
  const d = String(dateStr || '').trim();
  const t = String(timeStr || '').trim();
  if (!d && !t) return '';

  if (/^\d{2}\.\d{2}\.\d{4}$/.test(d)) {
    return t ? `${d} в ${t}` : d;
  }

  if (/^\d{2}\.\d{2}$/.test(d)) {
    const y = new Date().getFullYear();
    const full = `${d}.${y}`;
    return t ? `${full} в ${t}` : full;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [y, m, day] = d.split('-');
    const full = `${day}.${m}.${y}`;
    return t ? `${full} в ${t}` : full;
  }

  return [d, t].filter(Boolean).join(' ');
}

function streetOnly(address) {
  const s = String(address || '').trim();
  if (!s) return '';
  return s.split(',')[0].trim();
}

function build2gisUrl(city, address, flat) {
  const q = [city, address, flat].map((x) => String(x || '').trim()).filter(Boolean).join(', ');
  if (!q) return '';
  return `https://2gis.ru/search/${encodeURIComponent(q)}`;
}

function phoneForTel(phone) {
  const n = String(phone || '').replace(/[^\d+]/g, '');
  return n || '';
}

function parsePayPayload(textRaw) {
  const text = String(textRaw || '').trim();
  const urls = text.match(/https?:\/\/\S+/gi) || [];
  let link = '';
  let qr = '';

  const mLink = text.match(/(?:ссылка|link)\s*:\s*(https?:\/\/\S+)/i);
  const mQr = text.match(/(?:qr|куар|кьюар)\s*:\s*([^\n]+)/i);

  if (mLink && mLink[1]) link = mLink[1].trim();
  if (!link && urls.length > 0) link = urls[0].trim();

  if (mQr && mQr[1]) qr = mQr[1].trim();
  if (!qr && urls.length > 1) qr = urls[1].trim();

  return { link, qr };
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid state');
    return parsed;
  } catch (e) {
    return {
      buildVersion: BUILD_VERSION,
      offset: 0,
      callbackDone: {},
      managerPendingPay: {},
      orders: {},
      config: {
        managerChatId: DEFAULT_MANAGER_CHAT_ID,
        eventsChatId: DEFAULT_EVENTS_CHAT_ID,
        defaultGroupChatId: DEFAULT_GROUP_CHAT_ID,
        cityChats: {
          'новосибирск': DEFAULT_NSK_CHAT_ID || DEFAULT_GROUP_CHAT_ID
        }
      }
    };
  }
}

let state = loadState();

function saveState() {
  state.buildVersion = BUILD_VERSION;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function cleanupCallbackDone() {
  const now = Date.now();
  for (const [k, ts] of Object.entries(state.callbackDone || {})) {
    if (now - Number(ts || 0) > CALLBACK_DEDUP_TTL_MS) {
      delete state.callbackDone[k];
    }
  }
}

function setManagerPendingPay(chatId, orderId) {
  state.managerPendingPay[String(chatId)] = { orderId, ts: Date.now() };
  saveState();
}

function getManagerPendingPay(chatId) {
  const key = String(chatId || '');
  const item = state.managerPendingPay[key];
  if (!item) return null;
  if (Date.now() - Number(item.ts || 0) > MANAGER_PENDING_PAY_TTL_MS) {
    delete state.managerPendingPay[key];
    saveState();
    return null;
  }
  return item;
}

function clearManagerPendingPay(chatId) {
  delete state.managerPendingPay[String(chatId || '')];
  saveState();
}

async function tg(method, payload = null, httpMethod = 'POST', timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const options = {
      method: httpMethod,
      signal: controller.signal,
      headers: {}
    };

    if (payload && httpMethod !== 'GET') {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(payload);
    }

    const resp = await fetch(`${API}/${method}`, options);
    const raw = await resp.text();
    let body = null;
    try { body = JSON.parse(raw); } catch (e) {}

    return {
      ok: resp.ok,
      status: resp.status,
      body,
      raw
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      body: null,
      raw: String(e && e.message || e)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function answerCallbackQuery(callbackId, text) {
  if (!callbackId) return { ok: false, status: 0, raw: 'no callback id' };
  return tg('answerCallbackQuery', {
    callback_query_id: String(callbackId),
    text: String(text || ''),
    show_alert: false
  });
}

async function sendText(chatId, text, parseHtml = false, replyMarkup = null) {
  const payload = {
    chat_id: String(chatId),
    text: String(text || ''),
    disable_web_page_preview: true
  };
  if (parseHtml) payload.parse_mode = 'HTML';
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return tg('sendMessage', payload);
}

async function sendPhoto(chatId, fileId, caption = '') {
  return tg('sendPhoto', {
    chat_id: String(chatId),
    photo: String(fileId),
    caption: String(caption || '')
  });
}

async function sendDocument(chatId, fileId, caption = '') {
  return tg('sendDocument', {
    chat_id: String(chatId),
    document: String(fileId),
    caption: String(caption || '')
  });
}

async function editMessageReplyMarkup(chatId, messageId, replyMarkup) {
  return tg('editMessageReplyMarkup', {
    chat_id: String(chatId),
    message_id: Number(messageId),
    reply_markup: replyMarkup || { inline_keyboard: [] }
  });
}

async function setBotCommands() {
  const commands = [
    { command: 'panel', description: 'Показать панель' },
    { command: 'myorder', description: 'Моя текущая заявка' },
    { command: 'arrived', description: 'Мастер: прибыл на объект' },
    { command: 'done', description: 'Мастер: завершил заявку' },
    { command: 'paid', description: 'Мастер: оплата получена' },
    { command: 'cancel', description: 'Мастер: отменить заявку' },
    { command: 'active', description: 'Менеджер: заявки в работе' },
    { command: 'planned', description: 'Менеджер: запланированные заявки' },
    { command: 'pay', description: 'Менеджер: отправить оплату мастеру' },
    { command: 'setmanager', description: 'Сделать чат менеджерским' },
    { command: 'setevents', description: 'Сделать чат событий' },
    { command: 'setgroup', description: 'Сделать чат общим по заявкам' },
    { command: 'setnsk', description: 'Назначить чат Новосибирска' },
    { command: 'myid', description: 'Показать user_id/chat_id' },
    { command: 'diag', description: 'Диагностика бота' }
  ];
  return tg('setMyCommands', { commands });
}

function resolveGroupChatId(city) {
  const key = cityKey(city);
  const mapped = key && state.config.cityChats && state.config.cityChats[key]
    ? String(state.config.cityChats[key])
    : '';
  if (mapped) return mapped;
  return String(state.config.defaultGroupChatId || '');
}

function isManager(msg) {
  const managerChatId = normalizeId(state.config.managerChatId);
  if (!managerChatId) return false;
  const userId = normalizeId(msg && msg.from && msg.from.id);
  const chatId = normalizeId(msg && msg.chat && msg.chat.id);
  return userId === managerChatId || chatId === managerChatId;
}

function findMasterActiveOrder(masterId) {
  const m = String(masterId || '');
  for (const order of Object.values(state.orders || {})) {
    if (String(order.masterId || '') !== m) continue;
    if (['taken', 'arrived', 'done_wait_payment'].includes(String(order.status || ''))) {
      return order;
    }
  }
  return null;
}

function getOrderAddress(order) {
  return [order.customerAddress, order.customerFlat].filter(Boolean).join(', ');
}

function orderBriefText(order) {
  const city = order.city || 'не указан';
  const cleaningType = order.cleaningType || 'не указан';
  const area = order.area || 'не указана';
  const dt = parseRuDateTime(order.orderDate, order.orderTime) || 'не указаны';
  const pay = order.masterPay || order.orderTotal || '0';
  const street = streetOnly(order.customerAddress) || 'не указана';
  const equipment = order.equipment || 'Не указано';
  const chemistry = order.chemistry || 'Не указано';
  const desc = String(order.worksDescription || '').trim();

  let t = `🧹 <b>ЗАЯВКА №${safe(order.id)}</b>\n`;
  t += '───────────────────\n';
  t += `📍 Город: ${safe(city)}\n`;
  t += `🧽 Вид уборки: ${safe(cleaningType)}\n`;
  t += `📐 Площадь: ${safe(area)} м²\n`;
  t += `🗓 Дата и время: ${safe(dt)}\n`;
  t += `💰 Оплата мастеру: ${safe(pay)} руб\n`;
  t += `📍 Улица: ${safe(street)}\n`;
  t += `🧰 Оборудование: ${safe(equipment)}\n`;
  t += `🧪 Химия: ${safe(chemistry)}\n`;
  if (desc) t += `\n📝 Дополнительное описание: ${safe(desc)}\n`;
  return t;
}

function orderFullText(order) {
  const city = order.city || 'не указан';
  const cleaningType = order.cleaningType || 'не указан';
  const area = order.area || 'не указана';
  const dt = parseRuDateTime(order.orderDate, order.orderTime) || 'не указаны';
  const address = getOrderAddress(order) || 'не указан';
  const twoGis = build2gisUrl(order.city, order.customerAddress, order.customerFlat);
  const customerName = order.customerName || 'не указано';
  const phone = String(order.customerPhone || '').trim() || 'не указан';
  const phoneTel = phoneForTel(phone);
  const equipment = order.equipment || 'Не указано';
  const chemistry = order.chemistry || 'Не указано';
  const total = order.orderTotal || '0';
  const masterPay = order.masterPay || order.orderTotal || '0';
  const extra = String(order.worksDescription || '').trim();

  let t = `🧹 <b>ПОЛНАЯ ИНФОРМАЦИЯ О ЗАЯВКЕ №${safe(order.id)}</b>\n`;
  t += '────────────────────────────────────\n\n';
  t += '<b>📋 ОСНОВНАЯ ИНФОРМАЦИЯ</b>\n';
  t += `🏙 Город: ${safe(city)}\n`;
  t += `🧽 Вид уборки: ${safe(cleaningType)}\n`;
  t += `📐 Площадь: ${safe(area)} м²\n`;
  t += `🗓 Дата и время: ${safe(dt)}\n`;
  t += `📍 Адрес: ${safe(address)}\n`;
  if (twoGis) t += `🗺 2ГИС: <a href="${safe(twoGis)}">Открыть адрес</a>\n`;

  t += '\n<b>👤 ДАННЫЕ КЛИЕНТА</b>\n';
  t += `Имя: ${safe(customerName)}\n`;
  t += `Телефон: <code>${safe(phone)}</code>\n`;
  if (phoneTel) t += `Позвонить: <a href="tel:${safe(phoneTel)}">${safe(phone)}</a>\n`;

  t += '\n<b>🧰 ЧТО ВЗЯТЬ С СОБОЙ</b>\n';
  t += `Оборудование: ${safe(equipment)}\n`;
  t += `Химия: ${safe(chemistry)}\n`;

  t += '\n<b>💰 ФИНАНСЫ</b>\n';
  t += `Сумма заказа: ${safe(total)} руб\n`;
  t += `Ваша оплата: ${safe(masterPay)} руб\n`;

  if (extra) {
    t += '\n<b>📝 ДОПОЛНИТЕЛЬНОЕ ОПИСАНИЕ</b>\n';
    t += `${safe(extra)}\n`;
  }

  t += '\n<b>✅ ЧТО НУЖНО СДЕЛАТЬ</b>\n';
  t += '1️⃣ Подтвердите клиенту время и адрес.\n\n';
  t += '2️⃣ Подготовьте заранее оборудование и химию, спланируйте дорогу без опозданий.\n\n';
  t += '3️⃣ По прибытию нажмите «ПРИЕХАЛ НА ОБЪЕКТ» и отправьте фото оборудования/химии.\n\n';
  t += '4️⃣ После выполнения отправьте фото результата.\n\n';
  t += '5️⃣ Отправьте фото подписанного акта выполненных работ.\n\n';
  t += '6️⃣ Подтвердите получение оплаты от клиента.';

  return t;
}

function groupTakeKeyboard(orderId) {
  return {
    inline_keyboard: [
      [{ text: '✅ ВЫХОЖУ НА ЗАЯВКУ', callback_data: `take:${orderId}` }]
    ]
  };
}

function masterKeyboard(orderId, status) {
  if (status === 'arrived') {
    return {
      inline_keyboard: [
        [{ text: '✅ ЗАВЕРШИЛ ЗАЯВКУ', callback_data: `done:${orderId}` }],
        [{ text: '❌ ОТМЕНИТЬ ЗАЯВКУ', callback_data: `cancel:${orderId}` }]
      ]
    };
  }

  if (status === 'done_wait_payment') {
    return {
      inline_keyboard: [
        [{ text: '💳 ОПЛАТА ПОЛУЧЕНА', callback_data: `paid:${orderId}` }],
        [{ text: '❌ ОТМЕНИТЬ ЗАЯВКУ', callback_data: `cancel:${orderId}` }]
      ]
    };
  }

  return {
    inline_keyboard: [
      [{ text: '📍 ПРИЕХАЛ НА ОБЪЕКТ', callback_data: `arrive:${orderId}` }],
      [{ text: '✅ ЗАВЕРШИЛ ЗАЯВКУ', callback_data: `done:${orderId}` }],
      [{ text: '❌ ОТМЕНИТЬ ЗАЯВКУ', callback_data: `cancel:${orderId}` }]
    ]
  };
}

function managerPanelKeyboard() {
  return {
    keyboard: [
      ['/active', '/planned'],
      ['/pay', '/panel'],
      ['/setmanager', '/setevents'],
      ['/setgroup', '/setnsk'],
      ['/myid', '/diag']
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

function masterPanelKeyboard() {
  return {
    keyboard: [
      ['/myorder', '/arrived'],
      ['/done', '/paid'],
      ['/cancel', '/panel']
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

function parseCallbackData(rawData) {
  const s = String(rawData || '').trim();
  const m = s.match(/^(take|arrive|done|paid|cancel|managerpay)[:|_]?(.+)?$/i);
  if (!m) return { action: '', orderId: '' };
  return {
    action: String(m[1] || '').toLowerCase(),
    orderId: normalizeOrderId(m[2] || '')
  };
}

async function notifyEvents(text, parseHtml = false, replyMarkup = null) {
  const chatId = normalizeId(state.config.eventsChatId);
  if (!chatId) return;
  await sendText(chatId, text, parseHtml, replyMarkup);
}

function buildOrderFromPayload(payload) {
  const orderId = normalizeOrderId(payload.orderId) || `CLN-${Date.now().toString().slice(-8)}`;
  return {
    id: orderId,
    status: 'published',
    createdAt: nowIso(),
    manager: String(payload.manager || '').trim(),
    customerName: String(payload.customerName || '').trim(),
    customerPhone: String(payload.customerPhone || '').trim(),
    city: String(payload.customerCity || payload.city || '').trim(),
    customerAddress: String(payload.customerAddress || payload.address || '').trim(),
    customerFlat: String(payload.customerFlat || payload.flat || '').trim(),
    orderDate: String(payload.orderDate || '').trim(),
    orderTime: String(payload.orderTime || '').trim(),
    orderTotal: String(payload.orderTotal || payload.total || '0').trim(),
    masterPay: String(payload.masterPay || payload.orderTotal || payload.total || '0').trim(),
    cleaningType: String(payload.cleaningType || '').trim(),
    area: String(payload.area || '').trim(),
    equipment: String(payload.equipment || 'Не указано').trim() || 'Не указано',
    chemistry: String(payload.chemistry || 'Не указано').trim() || 'Не указано',
    worksDescription: String(payload.worksDescription || payload.description || '').trim(),
    masterId: '',
    masterName: '',
    takenAt: '',
    arrivedAt: '',
    doneAt: '',
    paidAt: '',
    cancelledAt: '',
    telegram: {
      groupChatId: '',
      groupMessageId: 0,
      masterChatId: '',
      masterMessageId: 0
    },
    photos: []
  };
}

async function createOrder(payload) {
  const order = buildOrderFromPayload(payload || {});
  const groupChatId = resolveGroupChatId(order.city);
  if (!groupChatId) {
    return { ok: false, error: 'group_chat_not_configured' };
  }

  const sent = await sendText(groupChatId, orderBriefText(order), true, groupTakeKeyboard(order.id));
  if (!sent.ok || !sent.body || !sent.body.ok) {
    return {
      ok: false,
      error: 'telegram_send_failed',
      telegram: sent
    };
  }

  order.telegram.groupChatId = String(groupChatId);
  order.telegram.groupMessageId = Number(sent.body.result.message_id || 0);
  state.orders[order.id] = order;
  saveState();

  return {
    ok: true,
    orderId: order.id,
    chat: order.telegram.groupChatId,
    messageId: order.telegram.groupMessageId,
    buildVersion: BUILD_VERSION
  };
}

function requireOrder(orderId) {
  const id = normalizeOrderId(orderId);
  if (!id) return null;
  return state.orders[id] || null;
}

async function doTakeOrder(order, actor) {
  if (!order) return { ok: false, message: '❌ Заявка не найдена' };
  if (order.status !== 'published') return { ok: false, message: '❌ Заявка уже взята' };

  const masterId = String(actor.id || '');
  const masterName = [actor.first_name || '', actor.last_name || ''].join(' ').trim() || actor.username || 'Мастер';

  order.status = 'taking';
  order.masterId = masterId;
  order.masterName = masterName;
  order.takenAt = nowRu();
  saveState();

  const dm = await sendText(masterId, orderFullText(order), true, masterKeyboard(order.id, 'taken'));
  if (!dm.ok || !dm.body || !dm.body.ok) {
    order.status = 'published';
    order.masterId = '';
    order.masterName = '';
    order.takenAt = '';
    saveState();
    return { ok: false, message: '⚠️ Не могу написать в ЛС. Откройте чат с ботом и нажмите /start' };
  }

  order.status = 'taken';
  order.telegram.masterChatId = masterId;
  order.telegram.masterMessageId = Number(dm.body.result.message_id || 0);
  saveState();

  if (order.telegram.groupChatId && order.telegram.groupMessageId) {
    await editMessageReplyMarkup(order.telegram.groupChatId, order.telegram.groupMessageId, { inline_keyboard: [] });
  }

  await notifyEvents(
    `✅ <b>Заявка взята</b>\n` +
    `Заявка: <code>${safe(order.id)}</code>\n` +
    `Мастер: ${safe(order.masterName)}\n` +
    `Время: ${safe(order.takenAt)}`,
    true
  );

  return { ok: true, message: '✅ Заявка принята' };
}

async function doArriveOrder(order, actor) {
  if (!order) return { ok: false, message: '❌ Заявка не найдена' };
  if (String(order.masterId || '') !== String(actor.id || '')) return { ok: false, message: '❌ Только назначенный мастер' };
  if (!['taken', 'arrived'].includes(order.status)) return { ok: false, message: '❌ Неверный статус заявки' };

  order.status = 'arrived';
  order.arrivedAt = nowRu();
  saveState();

  if (order.telegram.masterChatId && order.telegram.masterMessageId) {
    await editMessageReplyMarkup(order.telegram.masterChatId, order.telegram.masterMessageId, masterKeyboard(order.id, 'arrived'));
  }

  const payButton = {
    inline_keyboard: [[{ text: '💳 Отправить оплату мастеру', callback_data: `managerpay:${order.id}` }]]
  };

  await notifyEvents(
    `📍 <b>Мастер приехал на объект</b>\n` +
    `Заявка: <code>${safe(order.id)}</code>\n` +
    `Мастер: ${safe(order.masterName || '—')}\n` +
    `Время: ${safe(order.arrivedAt)}\n\n` +
    `Напоминание: сформируйте счет/ссылку на оплату.`,
    true,
    payButton
  );

  return { ok: true, message: '✅ Прибытие сохранено' };
}

async function doDoneOrder(order, actor) {
  if (!order) return { ok: false, message: '❌ Заявка не найдена' };
  if (String(order.masterId || '') !== String(actor.id || '')) return { ok: false, message: '❌ Только назначенный мастер' };
  if (!['taken', 'arrived', 'done_wait_payment'].includes(order.status)) return { ok: false, message: '❌ Неверный статус заявки' };

  order.status = 'done_wait_payment';
  order.doneAt = nowRu();
  saveState();

  if (order.telegram.masterChatId && order.telegram.masterMessageId) {
    await editMessageReplyMarkup(order.telegram.masterChatId, order.telegram.masterMessageId, masterKeyboard(order.id, 'done_wait_payment'));
  }

  await notifyEvents(
    `✅ <b>Мастер завершил заявку</b>\n` +
    `Заявка: <code>${safe(order.id)}</code>\n` +
    `Мастер: ${safe(order.masterName || '—')}\n` +
    `Время: ${safe(order.doneAt)}`,
    true
  );

  return { ok: true, message: '✅ Завершение сохранено' };
}

async function doPaidOrder(order, actor) {
  if (!order) return { ok: false, message: '❌ Заявка не найдена' };
  if (String(order.masterId || '') !== String(actor.id || '')) return { ok: false, message: '❌ Только назначенный мастер' };
  if (order.status === 'completed') return { ok: true, message: '✅ Уже подтверждено' };

  order.status = 'completed';
  order.paidAt = nowRu();
  saveState();

  if (order.telegram.masterChatId && order.telegram.masterMessageId) {
    await editMessageReplyMarkup(order.telegram.masterChatId, order.telegram.masterMessageId, { inline_keyboard: [] });
  }

  await notifyEvents(
    `💳 <b>Оплата подтверждена</b>\n` +
    `Заявка: <code>${safe(order.id)}</code>\n` +
    `Мастер: ${safe(order.masterName || '—')}\n` +
    `Время: ${safe(order.paidAt)}`,
    true
  );

  return { ok: true, message: '✅ Оплата подтверждена' };
}

async function doCancelOrder(order, actor) {
  if (!order) return { ok: false, message: '❌ Заявка не найдена' };
  if (String(order.masterId || '') !== String(actor.id || '')) return { ok: false, message: '❌ Только назначенный мастер' };

  order.status = 'published';
  order.cancelledAt = nowRu();
  order.masterId = '';
  order.masterName = '';
  order.takenAt = '';
  order.arrivedAt = '';
  order.doneAt = '';
  order.paidAt = '';

  const groupChat = resolveGroupChatId(order.city);
  const republish = await sendText(groupChat, orderBriefText(order), true, groupTakeKeyboard(order.id));
  if (republish.ok && republish.body && republish.body.ok) {
    order.telegram.groupChatId = String(groupChat);
    order.telegram.groupMessageId = Number(republish.body.result.message_id || 0);
  }

  if (order.telegram.masterChatId && order.telegram.masterMessageId) {
    await editMessageReplyMarkup(order.telegram.masterChatId, order.telegram.masterMessageId, { inline_keyboard: [] });
  }

  saveState();

  await notifyEvents(
    `❌ <b>Мастер отменил заявку</b>\n` +
    `Заявка: <code>${safe(order.id)}</code>\n` +
    `Время: ${safe(order.cancelledAt)}\n` +
    `Заявка снова опубликована в группу.`,
    true
  );

  return { ok: true, message: '✅ Заявка отменена и возвращена в группу' };
}

async function doManagerPaySelect(order, managerChatId) {
  if (!order) return { ok: false, message: '❌ Заявка не найдена' };
  if (!order.masterId) return { ok: false, message: '❌ У заявки нет назначенного мастера' };

  setManagerPendingPay(managerChatId, order.id);
  return {
    ok: true,
    message:
      `🧾 Заявка <code>${safe(order.id)}</code> выбрана.\n` +
      'Отправьте следующим сообщением:\n' +
      'Ссылка: https://...\n' +
      'QR: https://...\n\n' +
      'Можно отправить текст, фото или документ.'
  };
}

async function sendOrderPaymentToMaster(order, payload, managerChatId) {
  if (!order || !order.masterId) {
    return { ok: false, message: '❌ Заявка не найдена или мастер не назначен' };
  }

  if (!payload.link && !payload.qr) {
    return { ok: false, message: '❌ Не найдена ссылка/QR. Пример: Ссылка: https://... QR: https://...' };
  }

  let text = `💳 Оплата по заявке <code>${safe(order.id)}</code>\n`;
  if (payload.link) text += `Ссылка: ${safe(payload.link)}\n`;
  if (payload.qr) text += `QR: ${safe(payload.qr)}\n`;

  const sent = await sendText(order.masterId, text, true);
  if (!sent.ok || !sent.body || !sent.body.ok) {
    return { ok: false, message: '❌ Не удалось отправить оплату мастеру' };
  }

  clearManagerPendingPay(managerChatId);
  return { ok: true, message: `✅ Оплата отправлена мастеру по заявке ${order.id}` };
}

function callbackResponseMessage(result) {
  if (!result || !result.message) return 'Готово';
  return String(result.message).replace(/<[^>]+>/g, '');
}

async function handleCallback(update) {
  const cb = update.callback_query;
  if (!cb || !cb.id) return;

  cleanupCallbackDone();
  if (state.callbackDone[cb.id]) {
    await answerCallbackQuery(cb.id, '✅ Уже обработано');
    return;
  }
  state.callbackDone[cb.id] = Date.now();
  saveState();

  const parsed = parseCallbackData(cb.data);
  if (!parsed.action || !parsed.orderId) {
    await answerCallbackQuery(cb.id, '❌ Неверные данные кнопки');
    return;
  }

  const order = requireOrder(parsed.orderId);
  let result = { ok: false, message: '❌ Неизвестное действие' };

  if (parsed.action === 'take') result = await doTakeOrder(order, cb.from || {});
  if (parsed.action === 'arrive') result = await doArriveOrder(order, cb.from || {});
  if (parsed.action === 'done') result = await doDoneOrder(order, cb.from || {});
  if (parsed.action === 'paid') result = await doPaidOrder(order, cb.from || {});
  if (parsed.action === 'cancel') result = await doCancelOrder(order, cb.from || {});

  if (parsed.action === 'managerpay') {
    const fakeMsg = { from: cb.from, chat: cb.message && cb.message.chat };
    if (!isManager(fakeMsg)) {
      result = { ok: false, message: '❌ Только менеджер' };
    } else {
      result = await doManagerPaySelect(order, String(cb.message && cb.message.chat && cb.message.chat.id || cb.from.id || ''));
      if (result.ok && cb.message && cb.message.chat) {
        await sendText(String(cb.message.chat.id), result.message, true, managerPanelKeyboard());
      }
    }
  }

  await answerCallbackQuery(cb.id, callbackResponseMessage(result));
}

async function managerActivePlanned(chatId, mode) {
  const rows = [];
  for (const order of Object.values(state.orders || {})) {
    const status = String(order.status || '');
    const isActive = status === 'arrived' || status === 'done_wait_payment';
    const isPlanned = status === 'taken';
    if (mode === 'active' && !isActive) continue;
    if (mode === 'planned' && !isPlanned) continue;

    const dt = parseRuDateTime(order.orderDate, order.orderTime);
    const link = build2gisUrl(order.city, order.customerAddress, order.customerFlat);
    let line = `• <code>${safe(order.id)}</code> — ${safe(order.masterName || '—')}`;
    if (dt) line += `\n  ${safe(dt)}`;
    if (link) line += `\n  <a href="${safe(link)}">2ГИС</a>`;
    rows.push(line);
  }

  if (!rows.length) {
    return sendText(chatId, mode === 'active' ? 'Сейчас нет заявок в работе.' : 'Сейчас нет запланированных заявок.');
  }

  const title = mode === 'active' ? '🟢 <b>Заявки в работе сейчас</b>' : '🗓 <b>Запланированные заявки</b>';
  return sendText(chatId, `${title}\n\n${rows.join('\n\n')}`, true);
}

function buildPayPickerKeyboard() {
  const rows = [];
  for (const order of Object.values(state.orders || {})) {
    if (!order.masterId) continue;
    if (!['taken', 'arrived', 'done_wait_payment'].includes(order.status)) continue;
    rows.push([{ text: `${order.id} · ${order.masterName || 'Мастер'}`, callback_data: `managerpay:${order.id}` }]);
    if (rows.length >= 30) break;
  }
  return rows.length ? { inline_keyboard: rows } : null;
}

async function handleManagerPendingMessage(msg) {
  const chatId = String(msg.chat.id || '');
  const pending = getManagerPendingPay(chatId);
  if (!pending || !pending.orderId) return false;

  const order = requireOrder(pending.orderId);
  if (!order || !order.masterId) {
    clearManagerPendingPay(chatId);
    await sendText(chatId, '❌ Заявка недоступна. Введите /pay снова.');
    return true;
  }

  if (msg.photo && msg.photo.length) {
    const photo = msg.photo[msg.photo.length - 1];
    await sendPhoto(order.masterId, String(photo.file_id), `💳 QR/фото оплаты по заявке ${order.id}`);
    clearManagerPendingPay(chatId);
    await sendText(chatId, `✅ QR/фото отправлено мастеру по заявке ${order.id}`);
    return true;
  }

  if (msg.document && msg.document.file_id) {
    await sendDocument(order.masterId, String(msg.document.file_id), `💳 Документ оплаты по заявке ${order.id}`);
    clearManagerPendingPay(chatId);
    await sendText(chatId, `✅ Документ отправлен мастеру по заявке ${order.id}`);
    return true;
  }

  if (msg.text) {
    const parsed = parsePayPayload(msg.text);
    const out = await sendOrderPaymentToMaster(order, parsed, chatId);
    await sendText(chatId, out.message, false, managerPanelKeyboard());
    return true;
  }

  return false;
}

function buildDiagnostic() {
  const managerChatId = normalizeId(state.config.managerChatId);
  const eventsChatId = normalizeId(state.config.eventsChatId);
  const defaultGroup = normalizeId(state.config.defaultGroupChatId);
  const nsk = normalizeId(state.config.cityChats && state.config.cityChats['новосибирск']);

  return {
    ok: true,
    buildVersion: BUILD_VERSION,
    stateFile: STATE_FILE,
    counts: {
      orders: Object.keys(state.orders || {}).length,
      callbackDone: Object.keys(state.callbackDone || {}).length,
      managerPendingPay: Object.keys(state.managerPendingPay || {}).length
    },
    config: {
      managerChatId: managerChatId || 'NOT_SET',
      eventsChatId: eventsChatId || 'NOT_SET',
      defaultGroupChatId: defaultGroup || 'NOT_SET',
      nskGroupChatId: nsk || 'NOT_SET'
    }
  };
}

async function handleMessage(update) {
  const msg = update.message;
  if (!msg || !msg.chat || !msg.from) return;

  const chatId = String(msg.chat.id);
  const userId = String(msg.from.id);
  const text = String(msg.text || '').trim();

  if (await handleManagerPendingMessage(msg)) return;

  if (msg.photo && msg.photo.length) {
    const active = findMasterActiveOrder(userId);
    if (!active) return;
    const photo = msg.photo[msg.photo.length - 1];
    const caption = [
      `📸 Фото от мастера`,
      `Заявка: ${active.id}`,
      `Мастер: ${active.masterName || '—'}`,
      `Статус: ${active.status}`
    ].join('\n');
    const eventsChat = normalizeId(state.config.eventsChatId);
    if (eventsChat) {
      await notifyEvents(caption, false);
      await sendPhoto(eventsChat, String(photo.file_id), caption);
    }
    return;
  }

  if (!text) return;

  const parts = text.split(/\s+/);
  const cmd = String((parts[0] || '').split('@')[0]).toLowerCase();

  if (cmd === '/start' || cmd === '/help' || cmd === '/panel') {
    if (isManager(msg)) {
      await sendText(chatId, 'Панель менеджера активирована.', false, managerPanelKeyboard());
    } else {
      await sendText(chatId, 'Панель мастера активирована.', false, masterPanelKeyboard());
    }
    return;
  }

  if (cmd === '/myid') {
    await sendText(chatId, `user_id: <code>${safe(userId)}</code>\nchat_id: <code>${safe(chatId)}</code>`, true);
    return;
  }

  if (cmd === '/diag') {
    const d = buildDiagnostic();
    await sendText(chatId, `<pre>${safe(JSON.stringify(d, null, 2))}</pre>`, true);
    return;
  }

  if (cmd === '/setmanager') {
    state.config.managerChatId = chatId;
    saveState();
    await sendText(chatId, `✅ managerChatId = ${chatId}`);
    return;
  }

  if (cmd === '/setevents') {
    state.config.eventsChatId = chatId;
    saveState();
    await sendText(chatId, `✅ eventsChatId = ${chatId}`);
    return;
  }

  if (cmd === '/setgroup') {
    state.config.defaultGroupChatId = chatId;
    saveState();
    await sendText(chatId, `✅ defaultGroupChatId = ${chatId}`);
    return;
  }

  if (cmd === '/setnsk') {
    state.config.cityChats['новосибирск'] = chatId;
    saveState();
    await sendText(chatId, `✅ cityChats[новосибирск] = ${chatId}`);
    return;
  }

  if (isManager(msg)) {
    if (cmd === '/active') {
      await managerActivePlanned(chatId, 'active');
      return;
    }

    if (cmd === '/planned') {
      await managerActivePlanned(chatId, 'planned');
      return;
    }

    if (cmd === '/pay') {
      if (parts.length === 1) {
        const kb = buildPayPickerKeyboard();
        if (!kb) {
          await sendText(chatId, 'Сейчас нет заявок для отправки оплаты.');
          return;
        }
        await sendText(chatId, 'Выберите заявку кнопкой ниже:', false, kb);
        return;
      }

      const order = requireOrder(parts[1]);
      if (!order || !order.masterId) {
        await sendText(chatId, '❌ Заявка не найдена или мастер не назначен');
        return;
      }

      if (parts.length < 3) {
        const picked = await doManagerPaySelect(order, chatId);
        await sendText(chatId, picked.message, true, managerPanelKeyboard());
        return;
      }

      const payload = parsePayPayload(parts.slice(2).join(' '));
      const out = await sendOrderPaymentToMaster(order, payload, chatId);
      await sendText(chatId, out.message, false, managerPanelKeyboard());
      return;
    }
  }

  const active = findMasterActiveOrder(userId);

  if (cmd === '/myorder') {
    if (!active) {
      await sendText(chatId, 'У вас нет активной заявки.');
      return;
    }

    const dt = parseRuDateTime(active.orderDate, active.orderTime) || '—';
    const address = getOrderAddress(active) || '—';
    const link = build2gisUrl(active.city, active.customerAddress, active.customerFlat);

    const t = [
      `Заявка: ${active.id}`,
      `Статус: ${active.status}`,
      `Дата и время: ${dt}`,
      `Адрес: ${address}`,
      link ? `2ГИС: ${link}` : ''
    ].filter(Boolean).join('\n');

    await sendText(chatId, t);
    return;
  }

  if (!active) return;

  if (cmd === '/arrived') {
    const out = await doArriveOrder(active, msg.from);
    await sendText(chatId, out.message, false, masterPanelKeyboard());
    return;
  }

  if (cmd === '/done') {
    const out = await doDoneOrder(active, msg.from);
    await sendText(chatId, out.message, false, masterPanelKeyboard());
    return;
  }

  if (cmd === '/paid') {
    const out = await doPaidOrder(active, msg.from);
    await sendText(chatId, out.message, false, masterPanelKeyboard());
    return;
  }

  if (cmd === '/cancel') {
    const out = await doCancelOrder(active, msg.from);
    await sendText(chatId, out.message, false, masterPanelKeyboard());
    return;
  }
}

async function processUpdate(update) {
  if (!update) return;
  if (update.callback_query) {
    await handleCallback(update);
    return;
  }
  if (update.message) {
    await handleMessage(update);
    return;
  }
}

async function pollingLoop() {
  while (true) {
    try {
      const allowed = encodeURIComponent(JSON.stringify(['message', 'callback_query']));
      const offset = Number(state.offset || 0);
      const method = `getUpdates?offset=${offset}&timeout=${LONG_POLL_TIMEOUT_SEC}&allowed_updates=${allowed}`;

      const resp = await tg(method, null, 'GET', (LONG_POLL_TIMEOUT_SEC + 10) * 1000);
      const body = resp.body;
      if (!resp.ok || !body || !body.ok || !Array.isArray(body.result)) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }

      for (const upd of body.result) {
        state.offset = Number(upd.update_id || 0) + 1;
        saveState();
        await processUpdate(upd);
      }
    } catch (e) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

function readRawBody(req) {
  return new Promise((resolve) => {
    let out = '';
    req.on('data', (chunk) => { out += chunk.toString(); });
    req.on('end', () => resolve(out));
  });
}

function parseBody(req, raw) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();

  if (contentType.includes('application/json')) {
    try { return JSON.parse(raw || '{}'); } catch (e) { return {}; }
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const out = {};
    for (const pair of String(raw || '').split('&')) {
      if (!pair) continue;
      const i = pair.indexOf('=');
      const k = decodeURIComponent((i >= 0 ? pair.slice(0, i) : pair).replace(/\+/g, ' '));
      const v = decodeURIComponent((i >= 0 ? pair.slice(i + 1) : '').replace(/\+/g, ' '));
      out[k] = v;
    }
    if (out.json) {
      try { return JSON.parse(out.json); } catch (e) {}
    }
    return out;
  }

  try { return JSON.parse(raw || '{}'); } catch (e) { return {}; }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj || {});
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && u.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      mode: 'direct-telegram-bot',
      buildVersion: BUILD_VERSION,
      ordersCount: Object.keys(state.orders || {}).length,
      managerChatIdSet: !!normalizeId(state.config.managerChatId),
      eventsChatIdSet: !!normalizeId(state.config.eventsChatId)
    });
  }

  if (req.method === 'GET' && u.pathname === '/orders') {
    const status = String(u.searchParams.get('status') || '').trim();
    const rows = Object.values(state.orders || {}).filter((o) => !status || String(o.status || '') === status);
    return sendJson(res, 200, {
      ok: true,
      buildVersion: BUILD_VERSION,
      count: rows.length,
      orders: rows
    });
  }

  if (req.method === 'POST' && u.pathname === '/order') {
    const raw = await readRawBody(req);
    const payload = parseBody(req, raw);
    const out = await createOrder(payload || {});
    return sendJson(res, out.ok ? 200 : 400, out);
  }

  if (req.method === 'POST' && u.pathname === '/manager/pay') {
    const raw = await readRawBody(req);
    const payload = parseBody(req, raw);

    const order = requireOrder(payload.orderId || '');
    const parsed = parsePayPayload(
      [
        payload.link ? `Ссылка: ${payload.link}` : '',
        payload.qr ? `QR: ${payload.qr}` : '',
        payload.text || ''
      ].filter(Boolean).join('\n')
    );

    const out = await sendOrderPaymentToMaster(order, parsed, '__api__');
    return sendJson(res, out.ok ? 200 : 400, {
      ok: out.ok,
      message: out.message,
      orderId: order ? order.id : ''
    });
  }

  if (req.method === 'POST' && u.pathname === '/diag') {
    return sendJson(res, 200, buildDiagnostic());
  }

  return sendJson(res, 404, { ok: false, error: 'not_found' });
});

async function start() {
  cleanupCallbackDone();
  saveState();

  const cmd = await setBotCommands();
  if (!cmd.ok) {
    console.log('setMyCommands failed:', cmd.raw);
  }

  server.listen(PORT, () => {
    console.log(`Direct bot API listening on :${PORT}`);
    console.log(`Build: ${BUILD_VERSION}`);
    console.log(`State file: ${STATE_FILE}`);
    if (!resolveGroupChatId('новосибирск')) {
      console.log('WARNING: group chat is not set. Use /setgroup or /setnsk in Telegram.');
    }
    pollingLoop();
  });
}

start().catch((e) => {
  console.error('Fatal start error:', e && e.message ? e.message : e);
  process.exit(1);
});
