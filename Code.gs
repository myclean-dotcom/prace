// Code.gs - стабильный backend для заявок + Telegram кнопок

const BUILD_VERSION = '2026-02-19-clean-rewrite-v2';

const PROP = PropertiesService.getScriptProperties();
const SHEET_NAME = 'Заявки';
const WEBAPP_EXEC_URL_PROPERTY = 'WEBAPP_EXEC_URL';
const WEBHOOK_LAST_SYNC_TS_PROPERTY = 'WEBHOOK_LAST_SYNC_TS';

const CALLBACK_CACHE_TTL_SECONDS = 600;
const ORDER_DM_SENT_PREFIX = 'ORDER_DM_SENT_';
const ORDER_DM_META_PREFIX = 'ORDER_DM_META_';

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
  'Напоминание 24ч',
  'Напоминание 2ч',
  'Статус выполнения'
];

/* ---------- Entry points ---------- */

function doGet(e) {
  try {
    const health = e && e.parameter && String(e.parameter.health || '') === '1';
    if (health) {
      return jsonResponse({
        ok: true,
        info: 'webapp active',
        buildVersion: BUILD_VERSION,
        execUrl: resolveWebhookExecUrl('')
      });
    }

    const html = HtmlService.createHtmlOutput(
      '<!doctype html><html><head><meta charset="utf-8"><title>WebApp Active</title></head>' +
      '<body style="font-family:Arial,sans-serif;padding:24px;">' +
      '<h2>Web App развернут</h2>' +
      '<p>Этот URL используется как backend endpoint (webhook/API).</p>' +
      '<p>Проверка: добавьте <code>?health=1</code> к URL.</p>' +
      '<p>buildVersion: <code>' + escapeHtml(BUILD_VERSION) + '</code></p>' +
      '</body></html>'
    );

    return html.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message, buildVersion: BUILD_VERSION });
  }
}

function doPost(e) {
  try {
    const body = parseIncomingBody(e || {});
    try { Logger.log('doPost body: ' + JSON.stringify(body)); } catch (err) {}

    if (body.callback_query || body.message || body.edited_message) {
      return handleTelegramUpdate(body);
    }

    const action = String(body.action || '').trim().toLowerCase();

    if (action === 'probe_version') {
      return jsonResponse({ ok: true, action: 'probe_version', buildVersion: BUILD_VERSION });
    }

    if (action === 'check_bot') {
      return checkTelegramBotStatus();
    }

    if (action === 'create' || action === 'update' || looksLikeCreateOrderPayload(body)) {
      return createOrUpdateOrder(body, action || 'create');
    }

    return jsonResponse({
      ok: false,
      error: 'unknown action',
      buildVersion: BUILD_VERSION,
      details: { keys: Object.keys(body || {}) }
    });
  } catch (err) {
    Logger.log('doPost error: ' + err.message + '\n' + (err.stack || ''));
    return jsonResponse({ ok: false, error: err.message, buildVersion: BUILD_VERSION });
  }
}

/* ---------- Incoming body parsing ---------- */

function parseIncomingBody(event) {
  const param = event.parameter || {};
  const flat = flattenParameters(event.parameters || {});
  const raw = event.postData && event.postData.contents ? String(event.postData.contents) : '';

  let body = {};

  if (raw) {
    const parsedJson = tryParseJson(raw);
    if (parsedJson && typeof parsedJson === 'object') {
      body = parsedJson;
    } else {
      body = parseFormEncoded(raw);
      if (!body || !Object.keys(body).length) {
        body = Object.keys(param).length ? param : flat;
      }
    }
  } else {
    body = Object.keys(param).length ? param : flat;
  }

  body = unwrapBodyPayload(body);

  const action = body && body.action !== undefined && body.action !== null
    ? String(body.action).trim().toLowerCase()
    : '';
  if (action) body.action = action;

  if (!action && looksLikeCreateOrderPayload(body)) {
    body.action = 'create';
  }

  return (body && typeof body === 'object') ? body : {};
}

function flattenParameters(parameters) {
  const out = {};
  const src = parameters || {};
  const keys = Object.keys(src);

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = src[key];
    out[key] = Array.isArray(value) ? value[0] : value;
  }

  return out;
}

function parseFormEncoded(raw) {
  const text = String(raw || '');
  if (!text || text.indexOf('=') === -1) return {};

  const out = {};
  const pairs = text.split('&');

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (!pair) continue;

    const idx = pair.indexOf('=');
    const key = idx >= 0 ? pair.slice(0, idx) : pair;
    const val = idx >= 0 ? pair.slice(idx + 1) : '';

    const decodedKey = decodeURIComponent(String(key || '').replace(/\+/g, ' '));
    const decodedVal = decodeURIComponent(String(val || '').replace(/\+/g, ' '));

    if (!decodedKey) continue;
    out[decodedKey] = decodedVal;
  }

  return out;
}

function unwrapBodyPayload(body) {
  let current = body || {};

  for (let i = 0; i < 6; i++) {
    if (typeof current === 'string') {
      const parsed = tryParseJson(current);
      if (parsed && typeof parsed === 'object') {
        current = parsed;
        continue;
      }
      break;
    }

    if (!current || typeof current !== 'object') break;

    const parsedJson = tryParseJson(current.json);
    if (parsedJson) {
      current = parsedJson;
      continue;
    }

    const parsedPayload = tryParseJson(current.payload);
    if (parsedPayload) {
      current = parsedPayload;
      continue;
    }

    const parsedData = tryParseJson(current.data);
    if (parsedData) {
      current = parsedData;
      continue;
    }

    break;
  }

  return (current && typeof current === 'object') ? current : {};
}

function tryParseJson(value) {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}

function looksLikeCreateOrderPayload(body) {
  if (!body || typeof body !== 'object') return false;

  return !!(
    body.customerName ||
    body.customerPhone ||
    body.customerAddress ||
    body.customerCity ||
    body.cleaningType ||
    body.orderDate ||
    body.orderTime ||
    body.orderTotal
  );
}

/* ---------- Sheet ---------- */

function getSheet() {
  const ssId = String(PROP.getProperty('SPREADSHEET_ID') || '').trim();
  let ss = null;

  if (ssId) {
    try {
      ss = SpreadsheetApp.openById(ssId);
    } catch (err) {
      throw new Error('Не удалось открыть таблицу по SPREADSHEET_ID: ' + err.message);
    }
  }

  if (!ss) {
    try {
      ss = SpreadsheetApp.getActiveSpreadsheet();
    } catch (err) {
      ss = null;
    }
  }

  if (!ss) {
    throw new Error('Таблица недоступна. Укажите SPREADSHEET_ID в Script Properties.');
  }

  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);

  ensureSheetHeaders(sheet);
  return sheet;
}

function ensureSheetHeaders(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow === 0) {
    sheet.getRange(1, 1, 1, REQUIRED_HEADERS.length).setValues([REQUIRED_HEADERS]);
    return;
  }

  const width = Math.max(sheet.getLastColumn(), REQUIRED_HEADERS.length);
  if (sheet.getMaxColumns() < width) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  }

  const currentHeaders = sheet.getRange(1, 1, 1, width).getValues()[0].map(function(h) {
    return String(h || '').trim();
  });

  const missing = REQUIRED_HEADERS.filter(function(h) {
    return currentHeaders.indexOf(h) === -1;
  });

  if (!missing.length) return;

  let lastFilled = 0;
  for (let i = 0; i < currentHeaders.length; i++) {
    if (currentHeaders[i]) lastFilled = i + 1;
  }

  const startCol = Math.max(1, lastFilled + 1);
  const endCol = startCol + missing.length - 1;

  if (sheet.getMaxColumns() < endCol) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), endCol - sheet.getMaxColumns());
  }

  sheet.getRange(1, startCol, 1, missing.length).setValues([missing]);
}

function getHeaderMap(sheet) {
  ensureSheetHeaders(sheet);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const map = {};

  for (let i = 0; i < headers.length; i++) {
    const header = String(headers[i] || '').trim();
    if (header) map[header] = i + 1;
  }

  return map;
}

function appendOrderRow(sheet, rowData) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function(h) {
    return String(h || '').trim();
  });

  const row = headers.map(function(header) {
    return Object.prototype.hasOwnProperty.call(rowData, header) ? rowData[header] : '';
  });

  sheet.appendRow(row);
}

function setCellByHeader(sheet, row, headerMap, headerName, value) {
  const col = headerMap[headerName];
  if (!col) return;
  sheet.getRange(row, col).setValue(value);
}

function getCellFromRowByHeader(rowValues, headerMap, headerName) {
  const col = headerMap[headerName];
  if (!col) return '';
  return rowValues[col - 1];
}

function findOrderRowById(orderId) {
  const target = normalizeOrderIdLoose(orderId);
  if (!target) return null;

  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const col = map['Номер заявки'];
  const lastRow = sheet.getLastRow();

  if (!col || lastRow < 2) return null;

  const values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    const candidate = normalizeOrderIdLoose(values[i][0]);
    if (candidate && candidate === target) {
      return i + 2;
    }
  }

  return null;
}

function findOrderRowByTelegramMessage(chatId, messageId) {
  const chat = String(chatId || '').trim();
  const msg = String(messageId || '').trim();
  if (!chat || !msg) return null;

  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const chatCol = map['Telegram Chat ID'];
  const msgCol = map['Telegram Message ID'];
  const lastRow = sheet.getLastRow();

  if (!chatCol || !msgCol || lastRow < 2) return null;

  const chatValues = sheet.getRange(2, chatCol, lastRow - 1, 1).getValues();
  const msgValues = sheet.getRange(2, msgCol, lastRow - 1, 1).getValues();

  const msgNum = normalizeNumericString(msg);

  for (let i = 0; i < chatValues.length; i++) {
    const chatCandidate = String(chatValues[i][0] || '').trim();
    const msgCandidate = String(msgValues[i][0] || '').trim();

    if (chatCandidate !== chat) continue;

    if (msgCandidate === msg) {
      return i + 2;
    }

    if (msgNum && normalizeNumericString(msgCandidate) === msgNum) {
      return i + 2;
    }
  }

  return null;
}

function findActiveOrderRowByMasterId(masterId) {
  const target = String(masterId || '').trim();
  if (!target) return null;

  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const idCol = map['Master ID'];
  const statusCol = map['Статус'];
  const lastRow = sheet.getLastRow();

  if (!idCol || !statusCol || lastRow < 2) return null;

  const idValues = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
  const statusValues = sheet.getRange(2, statusCol, lastRow - 1, 1).getValues();

  for (let i = idValues.length - 1; i >= 0; i--) {
    const id = String(idValues[i][0] || '').trim();
    const status = String(statusValues[i][0] || '').toLowerCase().trim();
    if (!id || id !== target) continue;

    if (status.indexOf('взята') === -1 && status.indexOf('на объекте') === -1) continue;
    return i + 2;
  }

  return null;
}

function getOrderByRow(rowNum) {
  const sheet = getSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function(h) {
    return String(h || '').trim();
  });
  const values = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];

  const out = {};
  for (let i = 0; i < headers.length; i++) {
    if (headers[i]) out[headers[i]] = values[i];
  }
  return out;
}

/* ---------- Order create/update ---------- */

function createOrUpdateOrder(payload, action) {
  const orderId = String(payload.orderId || '').trim() || ('CLN-' + Date.now().toString().slice(-8));

  const order = {
    orderId: orderId,
    createdAt: normalizeCreatedAtValue(payload.createdAt || payload._ts),
    manager: String(payload.manager || '').trim(),
    customerName: normalizeCustomerName(payload.customerName),
    customerPhone: String(payload.customerPhone || '').trim(),
    customerCity: String(payload.customerCity || '').trim(),
    customerAddress: String(payload.customerAddress || '').trim(),
    customerFlat: String(payload.customerFlat || '').trim(),
    orderDate: normalizeOrderDateValue(payload.orderDate),
    orderTime: normalizeOrderTimeValue(payload.orderTime),
    orderTotal: String(payload.orderTotal || '0').trim(),
    masterPay: String(payload.masterPay || '0').trim(),
    cleaningType: String(payload.cleaningType || '').trim(),
    area: String(payload.area || '').trim(),
    chemistry: String(payload.chemistry || '—').trim(),
    equipment: String(payload.equipment || '—').trim(),
    worksDescription: String(payload.worksDescription || '').trim()
  };

  const sheet = getSheet();

  if (String(action || '').trim() === 'update') {
    const rowNum = findOrderRowById(orderId);
    if (rowNum) {
      updateOrderRow(rowNum, order);
      return jsonResponse({ ok: true, orderId: orderId, updated: true, buildVersion: BUILD_VERSION });
    }
  }

  appendOrderRow(sheet, buildOrderRowData(order, 'Опубликована'));

  // Самовосстановление webhook: чтобы кнопка не отваливалась после смены деплоя.
  ensureWebhookBoundToCurrentExec(false);

  const publishResult = sendOrderToGroup(order, payload.telegramChannel);
  if (!publishResult.ok) {
    const note = publishResult.reason === 'token_not_set'
      ? 'saved, token not set'
      : publishResult.reason === 'chat_not_set'
        ? 'saved, chat id not set'
        : 'saved, telegram error';

    return jsonResponse({
      ok: true,
      orderId: orderId,
      note: note,
      telegram: publishResult.telegram || null,
      buildVersion: BUILD_VERSION
    });
  }

  setTelegramIdsForOrder(orderId, publishResult.chatId, publishResult.messageId);

  return jsonResponse({
    ok: true,
    orderId: orderId,
    chat: String(publishResult.chatId),
    messageId: publishResult.messageId,
    buildVersion: BUILD_VERSION
  });
}

function buildOrderRowData(order, status) {
  return {
    'Номер заявки': String(order.orderId || '').trim(),
    'Дата создания': normalizeCreatedAtValue(order.createdAt),
    'Менеджер': String(order.manager || '').trim(),
    'Имя клиента': normalizeCustomerName(order.customerName),
    'Телефон клиента': String(order.customerPhone || '').trim(),
    'Город': String(order.customerCity || '').trim(),
    'Улица и дом': String(order.customerAddress || '').trim(),
    'Квартира/офис': String(order.customerFlat || '').trim(),
    'Дата уборки': normalizeOrderDateValue(order.orderDate),
    'Время уборки': normalizeOrderTimeValue(order.orderTime),
    'Сумма заказа': String(order.orderTotal || '').trim(),
    'Зарплата мастерам': String(order.masterPay || '').trim(),
    'Тип уборки': String(order.cleaningType || '').trim(),
    'Площадь (м²)': String(order.area || '').trim(),
    'Химия': String(order.chemistry || '—').trim(),
    'Оборудование': String(order.equipment || '—').trim(),
    'Описание работ': String(order.worksDescription || '').trim(),
    'Статус': String(status || '').trim(),
    'Telegram Chat ID': '',
    'Telegram Message ID': '',
    'Master ID': '',
    'Master Name': '',
    'Дата принятия': '',
    'Дата прибытия': '',
    'Дата завершения': '',
    'Напоминание 24ч': '',
    'Напоминание 2ч': '',
    'Статус выполнения': ''
  };
}

function updateOrderRow(rowNum, order) {
  const sheet = getSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function(h) {
    return String(h || '').trim();
  });
  const row = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];

  const map = {
    'Номер заявки': String(order.orderId || '').trim(),
    'Дата создания': normalizeCreatedAtValue(order.createdAt),
    'Менеджер': String(order.manager || '').trim(),
    'Имя клиента': normalizeCustomerName(order.customerName),
    'Телефон клиента': String(order.customerPhone || '').trim(),
    'Город': String(order.customerCity || '').trim(),
    'Улица и дом': String(order.customerAddress || '').trim(),
    'Квартира/офис': String(order.customerFlat || '').trim(),
    'Дата уборки': normalizeOrderDateValue(order.orderDate),
    'Время уборки': normalizeOrderTimeValue(order.orderTime),
    'Сумма заказа': String(order.orderTotal || '').trim(),
    'Зарплата мастерам': String(order.masterPay || '').trim(),
    'Тип уборки': String(order.cleaningType || '').trim(),
    'Площадь (м²)': String(order.area || '').trim(),
    'Химия': String(order.chemistry || '—').trim(),
    'Оборудование': String(order.equipment || '—').trim(),
    'Описание работ': String(order.worksDescription || '').trim()
  };

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (Object.prototype.hasOwnProperty.call(map, h)) row[i] = map[h];
  }

  sheet.getRange(rowNum, 1, 1, row.length).setValues([row]);
}

function setTelegramIdsForOrder(orderId, chatId, messageId) {
  const rowNum = findOrderRowById(orderId);
  if (!rowNum) return;

  const sheet = getSheet();
  const map = getHeaderMap(sheet);

  setCellByHeader(sheet, rowNum, map, 'Telegram Chat ID', String(chatId || '').trim());
  setCellByHeader(sheet, rowNum, map, 'Telegram Message ID', String(messageId || '').trim());
}

function mapSheetOrderToOrderModel(order) {
  return {
    orderId: String(order['Номер заявки'] || '').trim(),
    customerCity: String(order['Город'] || '').trim(),
    cleaningType: String(order['Тип уборки'] || '').trim(),
    area: String(order['Площадь (м²)'] || '').trim(),
    orderDate: String(order['Дата уборки'] || '').trim(),
    orderTime: String(order['Время уборки'] || '').trim(),
    masterPay: String(order['Зарплата мастерам'] || '').trim(),
    orderTotal: String(order['Сумма заказа'] || '').trim(),
    customerAddress: String(order['Улица и дом'] || '').trim(),
    customerFlat: String(order['Квартира/офис'] || '').trim(),
    customerName: String(order['Имя клиента'] || '').trim(),
    customerPhone: String(order['Телефон клиента'] || '').trim(),
    worksDescription: String(order['Описание работ'] || '').trim(),
    equipment: String(order['Оборудование'] || '').trim(),
    chemistry: String(order['Химия'] || '').trim()
  };
}

/* ---------- Telegram: group publish ---------- */

function sendOrderToGroup(order, fallbackTelegramChannel) {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!token) return { ok: false, reason: 'token_not_set' };

  const chatId = resolveTelegramChat(order.customerCity, fallbackTelegramChannel);
  if (!chatId) return { ok: false, reason: 'chat_not_set' };

  const briefText = generateBriefText(order);
  const callbackData = makeCallbackData('take', order.orderId);

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ ВЫХОЖУ НА ЗАЯВКУ', callback_data: callbackData }
    ]]
  };

  const sendResp = urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: chatId,
      text: briefText,
      parse_mode: 'HTML',
      reply_markup: keyboard,
      disable_web_page_preview: true
    })
  });

  if (!sendResp || sendResp.ok !== true || !sendResp.result) {
    Logger.log('Telegram sendMessage failed: ' + JSON.stringify(sendResp));
    return { ok: false, reason: 'telegram_error', telegram: sendResp || null };
  }

  forceTakeButtonOnGroupMessage(token, chatId, sendResp.result.message_id, keyboard);

  return {
    ok: true,
    chatId: String(chatId),
    messageId: String(sendResp.result.message_id || '').trim(),
    telegram: sendResp
  };
}

function forceTakeButtonOnGroupMessage(token, chatId, messageId, keyboard) {
  const botToken = String(token || '').trim();
  const chat = String(chatId || '').trim();
  const msg = String(messageId || '').trim();
  if (!botToken || !chat || !msg) return false;

  const resp = urlFetchJson(`https://api.telegram.org/bot${botToken}/editMessageReplyMarkup`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: chat,
      message_id: Number(msg),
      reply_markup: keyboard || { inline_keyboard: [] }
    })
  });

  return !!(resp && resp.ok === true);
}

/* ---------- Telegram update handler ---------- */

function handleTelegramUpdate(body) {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!token) return jsonResponse({ ok: false, error: 'Token not set', buildVersion: BUILD_VERSION });

  try {
    if (body.callback_query) {
      return handleCallbackQuery(body.callback_query, token);
    }

    if (body.message && body.message.photo && body.message.from) {
      return handleMasterPhotoMessage(body.message, token);
    }

    if (body.message && body.message.text) {
      return handleTextMessage(body.message, token);
    }

    if (body.message && body.message.chat && body.message.chat.id) {
      const saved = String(PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim();
      if (!saved) {
        PROP.setProperty('TELEGRAM_CHAT_ID', String(body.message.chat.id));
      }
    }

    return jsonResponse({ ok: true, buildVersion: BUILD_VERSION });
  } catch (err) {
    Logger.log('handleTelegramUpdate error: ' + err.message + '\n' + (err.stack || ''));
    return jsonResponse({ ok: false, error: err.message, buildVersion: BUILD_VERSION });
  }
}

function handleCallbackQuery(cb, token) {
  const callbackId = String(cb.id || '').trim();
  const data = String(cb.data || '').trim();
  const from = cb.from || {};
  const message = cb.message || cb.inaccessible_message || {};

  const cbChatId = message.chat ? String(message.chat.id || '') : '';
  const cbMessageId = String(message.message_id || '');

  if (isDuplicateCallback(callbackId)) {
    answerCallback(token, callbackId, 'ℹ️ Нажатие уже обработано');
    return jsonResponse({ ok: true, duplicate: true, buildVersion: BUILD_VERSION });
  }

  let parsed = parseCallbackActionData(data);
  const orderIdFromMessageText = extractOrderIdFromTelegramMessage(message);
  if (parsed && !String(parsed.orderId || '').trim() && orderIdFromMessageText) {
    parsed.orderId = orderIdFromMessageText;
  }

  if (!parsed && orderIdFromMessageText) {
    // Совместимость со старыми сообщениями, где callback_data был без id.
    parsed = { action: 'take', orderId: orderIdFromMessageText };
  }

  try { Logger.log('callback_query raw=' + data + ' parsed=' + JSON.stringify(parsed || null)); } catch (err) {}

  if (!parsed) {
    answerCallback(token, callbackId, 'Неизвестное действие');
    return jsonResponse({ ok: true, ignored: true, buildVersion: BUILD_VERSION });
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) {
    answerCallback(token, callbackId, '⏳ Попробуйте снова через пару секунд');
    return jsonResponse({ ok: true, busy: true, buildVersion: BUILD_VERSION });
  }

  try {
    let rowNum = resolveRowForCallback(parsed, message, cbChatId, cbMessageId);

    if (!rowNum) {
      answerCallback(token, callbackId, '❌ Заявка не найдена');
      return jsonResponse({ ok: false, error: 'Order not found', buildVersion: BUILD_VERSION });
    }

    const order = getOrderByRow(rowNum);
    const orderId = String(order['Номер заявки'] || parsed.orderId || '').trim();
    const status = String(order['Статус'] || '').toLowerCase().trim();
    const currentMasterId = String(order['Master ID'] || '').trim();

    const masterId = String(from.id || '').trim();
    let masterName = `${from.first_name || ''} ${from.last_name || ''}`.trim();
    if (!masterName && from.username) masterName = '@' + from.username;
    if (!masterName) masterName = 'Мастер';

    if (!masterId || !orderId) {
      answerCallback(token, callbackId, '❌ Не удалось обработать заявку');
      return jsonResponse({ ok: false, error: 'Bad callback payload', buildVersion: BUILD_VERSION });
    }

    if (parsed.action === 'take') {
      if (status.indexOf('взята') !== -1 || status.indexOf('на объекте') !== -1) {
        if (currentMasterId && currentMasterId === masterId) {
          answerCallback(token, callbackId, 'ℹ️ Вы уже приняли эту заявку');
          return jsonResponse({ ok: true, alreadyTakenBySameMaster: true, buildVersion: BUILD_VERSION });
        }
        answerCallback(token, callbackId, '❌ Заявка уже принята другим мастером');
        return jsonResponse({ ok: true, alreadyTaken: true, buildVersion: BUILD_VERSION });
      }

      if (status.indexOf('заверш') !== -1) {
        answerCallback(token, callbackId, '❌ Заявка уже завершена');
        return jsonResponse({ ok: true, alreadyDone: true, buildVersion: BUILD_VERSION });
      }

      const takenAt = formatDateTime(new Date());
      updateOrderTakenByRow(rowNum, masterId, masterName, takenAt);
      answerCallback(token, callbackId, '✅ Заявка принята. Отправляю детали в личные сообщения.');

      const updatedOrder = getOrderByRow(rowNum);

      if (!isMasterDmAlreadySent(orderId)) {
        const dmMessageIds = [];

        const fullText = generateFullText(updatedOrder);
        const dm1 = urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'post',
          payload: JSON.stringify({
            chat_id: masterId,
            text: fullText,
            parse_mode: 'HTML',
            reply_markup: buildMasterActionKeyboard(orderId)
          })
        });

        if (dm1 && dm1.ok === true && dm1.result && dm1.result.message_id !== undefined) {
          dmMessageIds.push(String(dm1.result.message_id));

          const clientMessage = buildClientReadyMessage(updatedOrder);
          const shareUrl = buildTelegramShareUrl(clientMessage);
          const dm2Payload = {
            chat_id: masterId,
            text: `<code>${escapeTelegramHtml(clientMessage)}</code>`,
            parse_mode: 'HTML'
          };

          if (shareUrl) {
            dm2Payload.reply_markup = {
              inline_keyboard: [[
                { text: '📤 ОТКРЫТЬ ТЕКСТ ДЛЯ КЛИЕНТА', url: shareUrl }
              ]]
            };
          }

          const dm2 = urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'post',
            payload: JSON.stringify(dm2Payload)
          });

          if (dm2 && dm2.ok === true && dm2.result && dm2.result.message_id !== undefined) {
            dmMessageIds.push(String(dm2.result.message_id));
          }

          markMasterDmSent(orderId, masterId, dmMessageIds);
        } else {
          Logger.log('DM send failed for order ' + orderId + ': ' + JSON.stringify(dm1));
        }
      }

      try {
        const chatId = String(updatedOrder['Telegram Chat ID'] || cbChatId || '').trim();
        const messageId = String(updatedOrder['Telegram Message ID'] || cbMessageId || '').trim();
        if (chatId && messageId) {
          urlFetchJson(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
            method: 'post',
            payload: JSON.stringify({
              chat_id: chatId,
              message_id: Number(messageId),
              reply_markup: { inline_keyboard: [] }
            })
          });
        }
      } catch (err) {
        Logger.log('editMessageReplyMarkup failed: ' + err.message);
      }

      return jsonResponse({ ok: true, orderId: orderId, action: 'take', buildVersion: BUILD_VERSION });
    }

    if (parsed.action === 'arrive') {
      if (!isOrderAssignedToMaster(status, currentMasterId, masterId)) {
        answerCallback(token, callbackId, '❌ Только назначенный мастер может отметить прибытие');
        return jsonResponse({ ok: true, denied: true, action: 'arrive', buildVersion: BUILD_VERSION });
      }

      const arrivedAt = formatDateTime(new Date());
      updateOrderArrivedByRow(rowNum, arrivedAt);
      const updatedOrder = getOrderByRow(rowNum);

      answerCallback(token, callbackId, '✅ Отметка о прибытии сохранена');
      updateMasterActionMessageAfterArrive(token, cbChatId, cbMessageId, orderId);
      notifyManagerNeedInvoice(updatedOrder, masterName, arrivedAt);
      return jsonResponse({ ok: true, orderId: orderId, action: 'arrive', buildVersion: BUILD_VERSION });
    }

    if (parsed.action === 'done') {
      if (!isOrderAssignedToMaster(status, currentMasterId, masterId)) {
        answerCallback(token, callbackId, '❌ Только назначенный мастер может завершить заявку');
        return jsonResponse({ ok: true, denied: true, action: 'done', buildVersion: BUILD_VERSION });
      }

      const doneAt = formatDateTime(new Date());
      updateOrderDoneByRow(rowNum, doneAt);
      const updatedOrder = getOrderByRow(rowNum);

      answerCallback(token, callbackId, '✅ Заявка отмечена как завершенная');
      clearMasterActionMessage(token, cbChatId, cbMessageId);
      notifyManagerOrderDone(updatedOrder, masterName, doneAt);
      return jsonResponse({ ok: true, orderId: orderId, action: 'done', buildVersion: BUILD_VERSION });
    }

    if (parsed.action === 'cancel') {
      if (!currentMasterId || currentMasterId !== masterId) {
        answerCallback(token, callbackId, '❌ Только назначенный мастер может отменить заявку');
        return jsonResponse({ ok: true, denied: true, action: 'cancel', buildVersion: BUILD_VERSION });
      }

      const cancelledAt = formatDateTime(new Date());
      updateOrderCancelledByRow(rowNum, masterName, cancelledAt);
      deleteMasterDmMessages(token, orderId);
      clearMasterDmSent(orderId);

      answerCallback(token, callbackId, '⏳ Отмена принята, возвращаю заявку в группу');
      const republish = republishOrderToGroupByRow(rowNum);
      const updatedOrder = getOrderByRow(rowNum);

      deleteMasterActionMessage(token, cbChatId, cbMessageId);
      notifyManagerOrderCancelled(updatedOrder, masterName, cancelledAt, republish);

      return jsonResponse({
        ok: true,
        orderId: orderId,
        action: 'cancel',
        republish: republish,
        buildVersion: BUILD_VERSION
      });
    }

    answerCallback(token, callbackId, 'Неизвестное действие');
    return jsonResponse({ ok: true, ignored: true, buildVersion: BUILD_VERSION });
  } catch (err) {
    Logger.log('callback error: ' + err.message + '\n' + (err.stack || ''));
    answerCallback(token, callbackId, '❌ Ошибка обработки кнопки. Нажмите еще раз.');
    return jsonResponse({ ok: false, error: err.message, buildVersion: BUILD_VERSION });
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}

function handleMasterPhotoMessage(message, token) {
  const userId = String((message.from && message.from.id) || '').trim();
  const photos = message.photo || [];
  const lastPhoto = photos.length ? photos[photos.length - 1] : null;
  const fileId = lastPhoto ? String(lastPhoto.file_id || '').trim() : '';
  const caption = String(message.caption || '').trim();

  let saved = null;
  if (userId && fileId) {
    const rowNum = findActiveOrderRowByMasterId(userId);
    if (rowNum) {
      saved = appendPhotoToOrder(rowNum, fileId, caption, message.date);
    }
  }

  forwardMasterPhotoToManager(token, message, saved);

  urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: userId,
      text: '✅ Фото получено, спасибо!'
    })
  });

  return jsonResponse({ ok: true, buildVersion: BUILD_VERSION });
}

function handleTextMessage(message, token) {
  const chatId = String((message.chat && message.chat.id) || '').trim();
  const userId = String((message.from && message.from.id) || '').trim();
  const text = String(message.text || '').trim();

  if (!text) return jsonResponse({ ok: true, buildVersion: BUILD_VERSION });

  if (!String(PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim() && chatId) {
    PROP.setProperty('TELEGRAM_CHAT_ID', chatId);
  }

  const managerId = getManagerChatId();
  if (managerId && userId === managerId) {
    const result = processManagerPaymentCommand(text, token);
    if (result.handled) return jsonResponse({ ok: true, managerCommand: result, buildVersion: BUILD_VERSION });
  }

  return jsonResponse({ ok: true, buildVersion: BUILD_VERSION });
}

function processManagerPaymentCommand(text, token) {
  // Команда в ЛС менеджера:
  // /pay CLN-12345678 https://...ссылка-на-оплату
  const parts = String(text || '').trim().split(/\s+/);
  if (!parts.length || String(parts[0]).toLowerCase() !== '/pay') {
    return { handled: false };
  }

  if (parts.length < 3) {
    return { handled: true, ok: false, error: 'Используйте: /pay НОМЕР_ЗАЯВКИ ССЫЛКА' };
  }

  const orderId = String(parts[1] || '').trim();
  const payLink = String(parts.slice(2).join(' ') || '').trim();
  if (!orderId || !payLink) {
    return { handled: true, ok: false, error: 'Неверный формат команды' };
  }

  const rowNum = findOrderRowById(orderId);
  if (!rowNum) {
    return { handled: true, ok: false, error: 'Заявка не найдена' };
  }

  const order = getOrderByRow(rowNum);
  const masterId = String(order['Master ID'] || '').trim();
  if (!masterId) {
    return { handled: true, ok: false, error: 'У заявки нет назначенного мастера' };
  }

  const textToMaster = [
    `💳 Ссылка на оплату по заявке <code>${escapeTelegramHtml(orderId)}</code>:`,
    `${escapeTelegramHtml(payLink)}`
  ].join('\n');

  const resp = urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: masterId,
      text: textToMaster,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });

  if (!resp || resp.ok !== true) {
    return { handled: true, ok: false, error: 'Не удалось отправить ссылку мастеру', telegram: resp || null };
  }

  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  setCellByHeader(sheet, rowNum, map, 'Статус выполнения', 'Ссылка на оплату отправлена ' + formatDateTime(new Date()));

  return { handled: true, ok: true, orderId: orderId, masterId: masterId };
}

/* ---------- Order state updates ---------- */

function updateOrderTakenByRow(rowNum, masterId, masterName, takenAt) {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);

  setCellByHeader(sheet, rowNum, map, 'Статус', 'Взята');
  setCellByHeader(sheet, rowNum, map, 'Master ID', String(masterId || '').trim());
  setCellByHeader(sheet, rowNum, map, 'Master Name', String(masterName || '').trim());
  setCellByHeader(sheet, rowNum, map, 'Дата принятия', String(takenAt || '').trim());
  setCellByHeader(sheet, rowNum, map, 'Дата прибытия', '');
  setCellByHeader(sheet, rowNum, map, 'Дата завершения', '');
  setCellByHeader(sheet, rowNum, map, 'Напоминание 24ч', '');
  setCellByHeader(sheet, rowNum, map, 'Напоминание 2ч', '');
  setCellByHeader(sheet, rowNum, map, 'Статус выполнения', '');
}

function updateOrderArrivedByRow(rowNum, arrivedAt) {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);

  setCellByHeader(sheet, rowNum, map, 'Статус', 'На объекте');
  setCellByHeader(sheet, rowNum, map, 'Дата прибытия', String(arrivedAt || '').trim());
  setCellByHeader(sheet, rowNum, map, 'Статус выполнения', 'Прибыл на объект: ' + String(arrivedAt || '').trim());
}

function updateOrderDoneByRow(rowNum, doneAt) {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);

  setCellByHeader(sheet, rowNum, map, 'Статус', 'Завершена');
  setCellByHeader(sheet, rowNum, map, 'Дата завершения', String(doneAt || '').trim());
  setCellByHeader(sheet, rowNum, map, 'Статус выполнения', 'Работы завершены: ' + String(doneAt || '').trim());
}

function updateOrderCancelledByRow(rowNum, masterName, cancelledAt) {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);

  const cleanMasterName = String(masterName || '').trim() || 'Мастер';
  const cleanCancelledAt = String(cancelledAt || '').trim();

  setCellByHeader(sheet, rowNum, map, 'Статус', 'Опубликована');
  setCellByHeader(sheet, rowNum, map, 'Master ID', '');
  setCellByHeader(sheet, rowNum, map, 'Master Name', '');
  setCellByHeader(sheet, rowNum, map, 'Дата принятия', '');
  setCellByHeader(sheet, rowNum, map, 'Дата прибытия', '');
  setCellByHeader(sheet, rowNum, map, 'Дата завершения', '');
  setCellByHeader(sheet, rowNum, map, 'Напоминание 24ч', '');
  setCellByHeader(sheet, rowNum, map, 'Напоминание 2ч', '');
  setCellByHeader(
    sheet,
    rowNum,
    map,
    'Статус выполнения',
    'Отменена мастером ' + cleanMasterName + ': ' + cleanCancelledAt
  );
}

function isOrderAssignedToMaster(statusLower, currentMasterId, masterId) {
  const status = String(statusLower || '').toLowerCase();
  const current = String(currentMasterId || '').trim();
  const master = String(masterId || '').trim();

  if (!current || !master) return false;
  if (current !== master) return false;

  return status.indexOf('взята') !== -1 || status.indexOf('на объекте') !== -1;
}

function republishOrderToGroupByRow(rowNum) {
  const orderRow = getOrderByRow(rowNum);
  const orderModel = mapSheetOrderToOrderModel(orderRow);

  if (!orderModel.orderId) {
    return { ok: false, reason: 'order_id_missing' };
  }

  const publishResult = sendOrderToGroup(orderModel, '');
  if (publishResult.ok) {
    setTelegramIdsForOrder(orderModel.orderId, publishResult.chatId, publishResult.messageId);
  }

  return publishResult;
}

/* ---------- Telegram keyboards & messages ---------- */

function buildMasterActionKeyboard(orderId) {
  return {
    inline_keyboard: [
      [{ text: '📍 ПРИЕХАЛ НА ОБЪЕКТ', callback_data: makeCallbackData('arrive', orderId) }],
      [{ text: '✅ ЗАВЕРШИЛ ЗАЯВКУ', callback_data: makeCallbackData('done', orderId) }],
      [{ text: '❌ ОТМЕНИТЬ ЗАЯВКУ', callback_data: makeCallbackData('cancel', orderId) }]
    ]
  };
}

function buildMasterActionKeyboardAfterArrive(orderId) {
  return {
    inline_keyboard: [
      [{ text: '✅ ЗАВЕРШИЛ ЗАЯВКУ', callback_data: makeCallbackData('done', orderId) }],
      [{ text: '❌ ОТМЕНИТЬ ЗАЯВКУ', callback_data: makeCallbackData('cancel', orderId) }]
    ]
  };
}

function updateMasterActionMessageAfterArrive(token, chatId, messageId, orderId) {
  const chat = String(chatId || '').trim();
  const msg = String(messageId || '').trim();
  if (!chat || !msg) return;

  urlFetchJson(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: chat,
      message_id: Number(msg),
      reply_markup: buildMasterActionKeyboardAfterArrive(orderId)
    })
  });
}

function clearMasterActionMessage(token, chatId, messageId) {
  const chat = String(chatId || '').trim();
  const msg = String(messageId || '').trim();
  if (!chat || !msg) return;

  urlFetchJson(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: chat,
      message_id: Number(msg),
      reply_markup: { inline_keyboard: [] }
    })
  });
}

function deleteMasterActionMessage(token, chatId, messageId) {
  const chat = String(chatId || '').trim();
  const msg = String(messageId || '').trim();
  if (!chat || !msg) return;

  const del = urlFetchJson(`https://api.telegram.org/bot${token}/deleteMessage`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: chat,
      message_id: Number(msg)
    })
  });

  if (!del || del.ok !== true) {
    clearMasterActionMessage(token, chat, msg);
  }
}

function generateBriefText(order) {
  const city = escapeTelegramHtml(order.customerCity || 'не указан');
  const type = escapeTelegramHtml(order.cleaningType || 'не указан');
  const area = escapeTelegramHtml(order.area || 'не указана');
  const dateTime = escapeTelegramHtml(formatDateTimeForDisplay(order.orderDate, order.orderTime));
  const pay = escapeTelegramHtml(order.masterPay || order.orderTotal || '0');
  const streetOnly = escapeTelegramHtml(extractStreetOnly(order.customerAddress) || 'не указана');

  let text = `🧹 <b>ЗАЯВКА №${escapeTelegramHtml(order.orderId || '')}</b>\n`;
  text += '───────────────────\n';
  text += `📍 Город: ${city}\n`;
  text += `🧽 Вид уборки: ${type}\n`;
  text += `📐 Площадь: ${area} м²\n`;
  text += `🗓 Дата и время: ${dateTime}\n`;
  text += `💰 Оплата мастеру: ${pay} руб\n`;
  text += `📍 Улица: ${streetOnly}\n`;

  if (String(order.worksDescription || '').trim()) {
    text += `\n📝 Дополнительное описание: ${escapeTelegramHtml(order.worksDescription)}\n`;
  }

  return text;
}

function generateFullText(order) {
  const orderId = escapeTelegramHtml(order['Номер заявки'] || '');
  const city = escapeTelegramHtml(order['Город'] || 'не указан');
  const cleaningType = escapeTelegramHtml(order['Тип уборки'] || 'не указан');
  const area = escapeTelegramHtml(order['Площадь (м²)'] || 'не указана');
  const dateTime = escapeTelegramHtml(formatDateTimeForDisplay(order['Дата уборки'], order['Время уборки']));

  const clientName = escapeTelegramHtml(order['Имя клиента'] || 'не указано');
  const rawClientPhone = String(order['Телефон клиента'] || '').trim();
  const clientPhone = escapeTelegramHtml(rawClientPhone || 'не указан');
  const phoneLink = buildPhoneLink(rawClientPhone);

  const orderTotal = escapeTelegramHtml(order['Сумма заказа'] || '0');
  const masterPay = escapeTelegramHtml(order['Зарплата мастерам'] || '0');

  const fullAddress = [
    String(order['Улица и дом'] || '').trim(),
    String(order['Квартира/офис'] || '').trim()
  ].filter(Boolean).join(', ');

  const equipment = String(order['Оборудование'] || '').trim() || '—';
  const chemistry = String(order['Химия'] || '').trim() || '—';
  const description = String(order['Описание работ'] || '').trim();

  const mapLink = build2gisSearchLink(String(order['Город'] || '').trim(), fullAddress);

  let text = `🧹 <b>ПОЛНАЯ ИНФОРМАЦИЯ О ЗАЯВКЕ №${orderId}</b>\n`;
  text += '────────────────────────────────────\n\n';

  text += '<b>📋 ОСНОВНАЯ ИНФОРМАЦИЯ</b>\n';
  text += `🏙 Город: ${city}\n`;
  text += `🧽 Вид уборки: ${cleaningType}\n`;
  text += `📐 Площадь: ${area} м²\n`;
  text += `🗓 Дата и время: ${dateTime}\n`;
  text += `📍 Адрес: ${escapeTelegramHtml(fullAddress || 'не указан')}\n\n`;

  if (mapLink) {
    text += `🗺 2ГИС: ${escapeTelegramHtml(mapLink)}\n\n`;
  }

  text += '<b>👤 ДАННЫЕ КЛИЕНТА</b>\n';
  text += `Имя: ${clientName}\n`;
  text += `Телефон: <code>${clientPhone}</code>\n`;
  if (phoneLink) {
    text += `Позвонить: <a href="${escapeTelegramHtml(phoneLink)}">${clientPhone}</a>\n`;
  }
  text += '\n';

  text += '<b>🧰 ЧТО ВЗЯТЬ С СОБОЙ</b>\n';
  text += `Оборудование: ${escapeTelegramHtml(equipment)}\n`;
  text += `Химия: ${escapeTelegramHtml(chemistry)}\n\n`;

  if (description) {
    text += '<b>📝 ДОПОЛНИТЕЛЬНОЕ ОПИСАНИЕ</b>\n';
    text += `${escapeTelegramHtml(description)}\n\n`;
  }

  text += '<b>💰 ФИНАНСЫ</b>\n';
  text += `Сумма заказа: ${orderTotal} руб\n`;
  text += `Ваша оплата: ${masterPay} руб\n\n`;

  text += '<b>✅ ЧТО НУЖНО СДЕЛАТЬ</b>\n';
  text += '1️⃣ Откройте следующее сообщение и отправьте его клиенту.\n\n';
  text += '2️⃣ Подготовьтесь ответственно к заявке: заранее возьмите нужное оборудование, спланируйте, как добраться, и приезжайте без опозданий.\n\n';
  text += '3️⃣ Отправьте фотографии химии и оборудования, когда прибудете на объект.\n\n';
  text += '4️⃣ После работы отправьте фотографии выполненных работ.\n\n';
  text += '5️⃣ Отправьте фото подписанного акта выполненных работ.\n\n';
  text += '6️⃣ Подтвердите оплату от клиента.';

  return text;
}

function buildClientReadyMessage(order) {
  const date = formatDateForDisplay(order['Дата уборки']);
  const time = formatTimeForDisplay(order['Время уборки']);

  const fullAddress = [
    String(order['Улица и дом'] || '').trim(),
    String(order['Квартира/офис'] || '').trim()
  ].filter(Boolean).join(', ');

  let msg = 'Здравствуйте! Я мастер по клинингу.';

  if (date && time) msg += ` Приеду к вам ${date} в ${time}.`;
  else if (date) msg += ` Приеду к вам ${date}.`;
  else if (time) msg += ` Приеду к вам в ${time}.`;
  else msg += ' Время и дату уточню дополнительно.';

  if (fullAddress) msg += ` Адрес: ${fullAddress}.`;
  msg += ' До встречи!';

  return msg;
}

function extractStreetOnly(address) {
  const raw = String(address || '').trim();
  if (!raw) return '';
  const firstChunk = raw.split(',')[0];
  return String(firstChunk || '').trim();
}

function build2gisSearchLink(city, fullAddress) {
  const query = [String(city || '').trim(), String(fullAddress || '').trim()].filter(Boolean).join(', ');
  if (!query) return '';
  return 'https://2gis.ru/search/' + encodeURIComponent(query);
}

function buildPhoneLink(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return '';

  const digits = raw.replace(/[^\d+]/g, '');
  if (!digits) return '';
  return 'tel:' + digits;
}

function buildTelegramShareUrl(text) {
  const clean = String(text || '').trim();
  if (!clean) return '';
  return 'https://t.me/share/url?url=&text=' + encodeURIComponent(clean);
}

/* ---------- Photo handling ---------- */

function appendPhotoToOrder(rowNum, fileId, caption, unixTs) {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);

  const statusCol = map['Статус выполнения'] || REQUIRED_HEADERS.length;
  const firstPhotoCol = statusCol + 1;
  const lastCol = sheet.getLastColumn();

  let photoCol = null;
  for (let col = firstPhotoCol; col <= lastCol; col++) {
    const val = sheet.getRange(1, col).getValue();
    const header = String(val || '').trim();

    if (!header) {
      sheet.getRange(1, col).setValue('Фото ' + (col - firstPhotoCol + 1));
      photoCol = col;
      break;
    }

    const cellValue = sheet.getRange(rowNum, col).getValue();
    if (!cellValue) {
      photoCol = col;
      break;
    }
  }

  if (!photoCol) {
    photoCol = lastCol + 1;
    sheet.getRange(1, photoCol).setValue('Фото ' + (photoCol - firstPhotoCol + 1));
  }

  const dt = unixTs ? formatDateTime(new Date(Number(unixTs) * 1000)) : formatDateTime(new Date());
  const info = [String(fileId || '').trim(), String(caption || '').trim(), dt].filter(Boolean).join(' | ');
  sheet.getRange(rowNum, photoCol).setValue(info);

  return { rowNum: rowNum, col: photoCol, info: info };
}

function forwardMasterPhotoToManager(token, message, savedInfo) {
  const managerId = getManagerChatId();
  if (!managerId) return;

  const from = message.from || {};
  const photos = message.photo || [];
  const lastPhoto = photos.length ? photos[photos.length - 1] : null;
  if (!lastPhoto || !lastPhoto.file_id) return;

  const masterName = `${from.first_name || ''} ${from.last_name || ''}`.trim() || (from.username ? '@' + from.username : 'Мастер');
  const caption = String(message.caption || '').trim();

  let text = `📸 Фото от мастера: ${escapeTelegramHtml(masterName)}`;
  if (savedInfo && savedInfo.info) {
    text += `\nСохранено в таблицу: ${escapeTelegramHtml(savedInfo.info)}`;
  }
  if (caption) {
    text += `\nКомментарий: ${escapeTelegramHtml(caption)}`;
  }

  urlFetchJson(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: managerId,
      photo: lastPhoto.file_id,
      caption: text,
      parse_mode: 'HTML'
    })
  });
}

/* ---------- Manager notifications ---------- */

function getManagerChatId() {
  return String(PROP.getProperty('TELEGRAM_MANAGER_CHAT_ID') || '').trim();
}

function notifyManagerNeedInvoice(order, masterName, arrivedAt) {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  const managerId = getManagerChatId();
  if (!token || !managerId) return;

  const orderId = escapeTelegramHtml(order['Номер заявки'] || '');
  const city = escapeTelegramHtml(order['Город'] || '');
  const type = escapeTelegramHtml(order['Тип уборки'] || '');
  const total = escapeTelegramHtml(order['Сумма заказа'] || '0');
  const addr = escapeTelegramHtml(String(order['Улица и дом'] || '').trim());

  const text = [
    '🔔 <b>Мастер прибыл на объект</b>',
    `Заявка: <code>${orderId}</code>`,
    `Мастер: ${escapeTelegramHtml(masterName || 'Мастер')}`,
    `Время прибытия: ${escapeTelegramHtml(arrivedAt || '')}`,
    `Город: ${city}`,
    `Вид уборки: ${type}`,
    `Сумма заказа: ${total} руб`,
    `Адрес: ${addr}`,
    '',
    'Сформируйте и отправьте ссылку на оплату через команду:',
    `<code>/pay ${orderId} https://...</code>`
  ].join('\n');

  urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: managerId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });
}

function notifyManagerOrderDone(order, masterName, doneAt) {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  const managerId = getManagerChatId();
  if (!token || !managerId) return;

  const orderId = escapeTelegramHtml(order['Номер заявки'] || '');
  const text = [
    '✅ <b>Заявка завершена</b>',
    `Заявка: <code>${orderId}</code>`,
    `Мастер: ${escapeTelegramHtml(masterName || 'Мастер')}`,
    `Время завершения: ${escapeTelegramHtml(doneAt || '')}`
  ].join('\n');

  urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: managerId,
      text: text,
      parse_mode: 'HTML'
    })
  });
}

function notifyManagerOrderCancelled(order, masterName, cancelledAt, republish) {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  const managerId = getManagerChatId();
  if (!token || !managerId) return;

  const orderId = escapeTelegramHtml(order['Номер заявки'] || '');
  const republishState = republish && republish.ok ? 'Да' : 'Нет';

  const text = [
    '⚠️ <b>Заявка отменена мастером</b>',
    `Заявка: <code>${orderId}</code>`,
    `Мастер: ${escapeTelegramHtml(masterName || 'Мастер')}`,
    `Время отмены: ${escapeTelegramHtml(cancelledAt || '')}`,
    `Возвращена в группу: ${republishState}`
  ].join('\n');

  urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: managerId,
      text: text,
      parse_mode: 'HTML'
    })
  });
}

/* ---------- Callback parsing + dedupe ---------- */

function makeCallbackData(action, orderId) {
  const actionName = String(action || '').trim().toLowerCase();
  const id = String(orderId || '').trim();
  if (!actionName || !id) return '';
  return `${actionName}|${id}`;
}

function parseCallbackActionData(data) {
  const raw = normalizeCallbackRawData(data);
  if (!raw) return null;

  const v2 = raw.match(/^(take|arrive|done|cancel)\|(.+)$/);
  if (v2) {
    const action = String(v2[1] || '').trim();
    const id = normalizeOrderIdLoose(v2[2]);
    return (action && id) ? { action: action, orderId: id } : null;
  }

  const v1 = raw.match(/^(take|arrive|done|cancel)_(.+)$/);
  if (v1) {
    const action = String(v1[1] || '').trim();
    const id = normalizeOrderIdLoose(v1[2]);
    return (action && id) ? { action: action, orderId: id } : null;
  }

  const legacy = raw.match(/^takev2\|(.+)$/);
  if (legacy) {
    const id = normalizeOrderIdLoose(legacy[1]);
    return id ? { action: 'take', orderId: id } : null;
  }

  const loose = raw.match(/^(take|arrive|done|cancel)[^A-Za-z0-9]+(.+)$/);
  if (loose) {
    const action = String(loose[1] || '').trim();
    const id = normalizeOrderIdLoose(loose[2]);
    return (action && id) ? { action: action, orderId: id } : null;
  }

  // Старые/битые данные вида "take", "take_" и т.п.
  if (/^(take|arrive|done|cancel)\b/.test(raw)) {
    const action = String(raw.match(/^(take|arrive|done|cancel)\b/)[1] || '').trim();
    const id = normalizeOrderIdLoose(raw.replace(/^(take|arrive|done|cancel)\b/, ''));
    return { action: action, orderId: id || '' };
  }

  return null;
}

function normalizeCallbackRawData(data) {
  const raw = String(data || '').trim();
  if (!raw) return '';

  if (raw[0] === '{' && raw[raw.length - 1] === '}') {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        const action = String(obj.action || obj.a || '').trim().toLowerCase();
        const orderId = normalizeOrderIdLoose(obj.orderId || obj.id || '');
        if (action && orderId) return action + '|' + orderId;
      }
    } catch (err) {}
  }

  if (raw.indexOf('%') !== -1) {
    try {
      const decoded = decodeURIComponent(raw);
      if (decoded && decoded !== raw) return String(decoded).trim();
    } catch (err) {}
  }

  return raw;
}

function normalizeOrderIdLoose(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  // Частый формат: "CLN-12345678|v7" -> берем только id.
  const cleaned = raw.split('|')[0].split(',')[0].split(' ')[0].trim();
  const strict = cleaned.match(/^([A-Za-z]{2,8}-\d{5,})$/i);
  if (strict) return strict[1].toUpperCase();

  // Поиск id внутри произвольного текста.
  const inside = raw.match(/([A-Za-z]{2,8}-\d{5,})/i);
  if (inside) return String(inside[1] || '').toUpperCase();

  return cleaned.toUpperCase();
}

function extractOrderIdFromTelegramMessage(message) {
  const text = String((message && (message.text || message.caption)) || '').trim();
  if (!text) return '';

  // Пример: "ЗАЯВКА №CLN-12345678"
  const m = text.match(/(?:№|#)\s*([A-Za-z]{2,8}-\d{5,})/i);
  if (m && m[1]) return String(m[1]).trim().toUpperCase();

  const any = text.match(/([A-Za-z]{2,8}-\d{5,})/i);
  return any && any[1] ? String(any[1]).trim().toUpperCase() : '';
}

function normalizeNumericString(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const onlyDigits = raw.replace(/[^\d]/g, '');
  return onlyDigits || '';
}

function resolveRowForCallback(parsed, message, cbChatId, cbMessageId) {
  const parsedOrderId = normalizeOrderIdLoose(parsed && parsed.orderId);
  if (parsedOrderId) {
    const byId = findOrderRowById(parsedOrderId);
    if (byId) return byId;
  }

  const fromMessage = extractOrderIdFromTelegramMessage(message);
  if (fromMessage) {
    const byTextId = findOrderRowById(fromMessage);
    if (byTextId) return byTextId;
  }

  const byMsg = findOrderRowByTelegramMessage(cbChatId, cbMessageId);
  if (byMsg) return byMsg;

  return null;
}

function isDuplicateCallback(callbackId) {
  const id = String(callbackId || '').trim();
  if (!id) return false;

  const cache = CacheService.getScriptCache();
  const key = 'cbq_' + id;
  const exists = cache.get(key);
  if (exists) return true;

  cache.put(key, '1', CALLBACK_CACHE_TTL_SECONDS);
  return false;
}

function isMasterDmAlreadySent(orderId) {
  const id = String(orderId || '').trim();
  if (!id) return false;
  return String(PROP.getProperty(ORDER_DM_SENT_PREFIX + id) || '').trim() !== '';
}

function markMasterDmSent(orderId, masterId, messageIds) {
  const id = String(orderId || '').trim();
  if (!id) return;

  const by = String(masterId || '').trim() || 'unknown';
  const ids = Array.isArray(messageIds)
    ? messageIds.map(function(v) { return String(v || '').trim(); }).filter(Boolean)
    : [];

  PROP.setProperty(ORDER_DM_SENT_PREFIX + id, by + '|' + formatDateTime(new Date()));
  PROP.setProperty(ORDER_DM_META_PREFIX + id, JSON.stringify({
    chatId: by,
    messageIds: ids,
    ts: formatDateTime(new Date())
  }));
}

function clearMasterDmSent(orderId) {
  const id = String(orderId || '').trim();
  if (!id) return;
  PROP.deleteProperty(ORDER_DM_SENT_PREFIX + id);
  PROP.deleteProperty(ORDER_DM_META_PREFIX + id);
}

function deleteMasterDmMessages(token, orderId) {
  const id = String(orderId || '').trim();
  if (!id) return;

  const rawMeta = String(PROP.getProperty(ORDER_DM_META_PREFIX + id) || '').trim();
  if (!rawMeta) return;

  const meta = tryParseJson(rawMeta);
  if (!meta || typeof meta !== 'object') return;

  const chatId = String(meta.chatId || '').trim();
  const messageIds = Array.isArray(meta.messageIds) ? meta.messageIds : [];
  if (!chatId || !messageIds.length) return;

  for (let i = 0; i < messageIds.length; i++) {
    const msg = String(messageIds[i] || '').trim();
    if (!msg) continue;

    urlFetchJson(`https://api.telegram.org/bot${token}/deleteMessage`, {
      method: 'post',
      payload: JSON.stringify({
        chat_id: chatId,
        message_id: Number(msg)
      })
    });
  }
}

/* ---------- Telegram API helpers ---------- */

function checkTelegramBotStatus() {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!token) {
    return jsonResponse({
      ok: false,
      error: 'TELEGRAM_BOT_TOKEN не задан в Script Properties',
      buildVersion: BUILD_VERSION
    });
  }

  ensureWebhookBoundToCurrentExec(false);

  const me = urlFetchJson(`https://api.telegram.org/bot${token}/getMe`, { method: 'get' });
  if (!me || me.ok !== true || !me.result) {
    return jsonResponse({
      ok: false,
      error: 'Ошибка Telegram API',
      telegram: me || null,
      buildVersion: BUILD_VERSION
    });
  }

  const webhookInfo = urlFetchJson(`https://api.telegram.org/bot${token}/getWebhookInfo`, { method: 'get' });

  return jsonResponse({
    ok: true,
    bot: {
      id: me.result.id,
      username: me.result.username,
      first_name: me.result.first_name
    },
    webhookInfo: webhookInfo || null,
    buildVersion: BUILD_VERSION
  });
}

function answerCallback(token, callbackId, text) {
  if (!callbackId) return;

  try {
    urlFetchJson(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'post',
      payload: JSON.stringify({
        callback_query_id: callbackId,
        text: String(text || ''),
        show_alert: false
      })
    });
  } catch (err) {
    Logger.log('answerCallback error: ' + err.message);
  }
}

function urlFetchJson(url, options) {
  const params = {
    method: options && options.method ? options.method : 'get',
    contentType: 'application/json',
    payload: options && options.payload ? options.payload : null,
    muteHttpExceptions: true,
    followRedirects: true
  };

  const resp = UrlFetchApp.fetch(url, params);
  const text = resp.getContentText();

  try {
    return JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      raw: text,
      statusCode: resp.getResponseCode()
    };
  }
}

/* ---------- Reminders ---------- */

function sendReminders() {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!token) return;

  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const rows = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const now = new Date();

  const dayMs = 24 * 60 * 60 * 1000;
  const twoHoursMs = 2 * 60 * 60 * 1000;
  const reminderWindowMs = 20 * 60 * 1000;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    const status = String(getCellFromRowByHeader(row, map, 'Статус') || '').toLowerCase();
    if (status.indexOf('взята') === -1 && status.indexOf('на объекте') === -1) continue;

    const masterId = String(getCellFromRowByHeader(row, map, 'Master ID') || '').trim();
    if (!masterId) continue;

    const orderId = String(getCellFromRowByHeader(row, map, 'Номер заявки') || '').trim();
    const dateValue = getCellFromRowByHeader(row, map, 'Дата уборки');
    const timeValue = getCellFromRowByHeader(row, map, 'Время уборки');

    const dt = parseOrderDateTime(dateValue, timeValue);
    if (!dt) continue;

    const diff = dt.getTime() - now.getTime();

    const sent24h = String(getCellFromRowByHeader(row, map, 'Напоминание 24ч') || '').trim();
    const sent2h = String(getCellFromRowByHeader(row, map, 'Напоминание 2ч') || '').trim();

    if (!sent24h && diff <= dayMs && diff > dayMs - reminderWindowMs) {
      const text = [
        '⏰ <b>Напоминание за 24 часа</b>',
        `Заявка: <code>${escapeTelegramHtml(orderId)}</code>`,
        `Дата и время: ${escapeTelegramHtml(formatDateTimeForDisplay(dateValue, timeValue))}`
      ].join('\n');

      urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'post',
        payload: JSON.stringify({
          chat_id: masterId,
          text: text,
          parse_mode: 'HTML'
        })
      });

      setCellByHeader(sheet, i + 2, map, 'Напоминание 24ч', 'Отправлено ' + formatDateTime(new Date()));
    }

    if (!sent2h && diff <= twoHoursMs && diff > twoHoursMs - reminderWindowMs) {
      const text2 = [
        '🚨 <b>Напоминание за 2 часа</b>',
        `Заявка: <code>${escapeTelegramHtml(orderId)}</code>`,
        `Дата и время: ${escapeTelegramHtml(formatDateTimeForDisplay(dateValue, timeValue))}`
      ].join('\n');

      urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'post',
        payload: JSON.stringify({
          chat_id: masterId,
          text: text2,
          parse_mode: 'HTML'
        })
      });

      setCellByHeader(sheet, i + 2, map, 'Напоминание 2ч', 'Отправлено ' + formatDateTime(new Date()));
    }
  }
}

/* ---------- Date/time normalization ---------- */

function pad2(v) {
  return String(v).padStart(2, '0');
}

function formatDate(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd.MM.yyyy');
}

function formatTime(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'HH:mm');
}

function formatDateTime(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm:ss');
}

function spreadsheetSerialToDate(value) {
  const n = Number(value);
  if (!isFinite(n) || n <= 0) return null;

  const millisPerDay = 24 * 60 * 60 * 1000;
  const excelEpochUtc = Date.UTC(1899, 11, 30);
  const ms = excelEpochUtc + Math.round(n * millisPerDay);
  const dt = new Date(ms);
  return isNaN(dt.getTime()) ? null : dt;
}

function normalizeCreatedAtValue(value) {
  if (value === null || value === undefined || value === '') return formatDateTime(new Date());

  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return formatDateTime(value);
  }

  const raw = String(value).trim();
  if (!raw) return formatDateTime(new Date());

  const dt = new Date(raw);
  if (!isNaN(dt.getTime())) return formatDateTime(dt);

  return raw;
}

function normalizeOrderDateValue(value) {
  if (value === null || value === undefined || value === '') return '';
  return formatDateForDisplay(value);
}

function normalizeOrderTimeValue(value) {
  if (value === null || value === undefined || value === '') return '';
  return formatTimeForDisplay(value);
}

function formatDateForDisplay(value) {
  if (value === null || value === undefined || value === '') return '';

  if (typeof value === 'number') {
    const serialDate = spreadsheetSerialToDate(value);
    if (serialDate) return formatDate(serialDate);
  }

  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return formatDate(value);
  }

  const raw = String(value).trim();
  if (!raw) return '';

  if (/^\d+([.,]\d+)?$/.test(raw)) {
    const serialDate = spreadsheetSerialToDate(raw.replace(',', '.'));
    if (serialDate) return formatDate(serialDate);
  }

  const dmY = raw.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/);
  if (dmY) {
    const day = pad2(dmY[1]);
    const month = pad2(dmY[2]);
    const year = dmY[3] || String(new Date().getFullYear());
    return `${day}.${month}.${year}`;
  }

  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) return `${ymd[3]}.${ymd[2]}.${ymd[1]}`;

  const englishDate = raw.match(/^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})\b/);
  if (englishDate) {
    const monthMap = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
    };
    const month = monthMap[String(englishDate[1] || '').toLowerCase()] || '';
    if (month) return `${pad2(englishDate[2])}.${month}.${englishDate[3]}`;
  }

  const noTzLabel = raw.replace(/\s+\([^)]+\)\s*$/, '');
  const parsed = new Date(noTzLabel);
  if (!isNaN(parsed.getTime())) return formatDate(parsed);

  return raw;
}

function formatTimeForDisplay(value) {
  if (value === null || value === undefined || value === '') return '';

  if (typeof value === 'number') {
    const serialDate = spreadsheetSerialToDate(value);
    if (serialDate) return formatTime(serialDate);
  }

  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return formatTime(value);
  }

  const raw = String(value).trim();
  if (!raw) return '';

  if (/^\d+([.,]\d+)?$/.test(raw)) {
    const serialDate = spreadsheetSerialToDate(raw.replace(',', '.'));
    if (serialDate) return formatTime(serialDate);
  }

  const hhmmInside = raw.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\b/);
  if (hhmmInside) {
    return `${pad2(hhmmInside[1])}:${hhmmInside[2]}`;
  }

  const parsed = new Date(raw.replace(/\s+\([^)]+\)\s*$/, ''));
  if (!isNaN(parsed.getTime())) return formatTime(parsed);

  return raw;
}

function formatDateTimeForDisplay(dateValue, timeValue) {
  const d = formatDateForDisplay(dateValue);
  const t = formatTimeForDisplay(timeValue);

  if (d && t) return `${d} в ${t}`;
  if (d) return d;
  if (t) return t;
  return 'не указаны';
}

function parseOrderDateTime(dateValue, timeValue) {
  const d = formatDateForDisplay(dateValue);
  const t = formatTimeForDisplay(timeValue);
  if (!d) return null;

  const dmY = d.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!dmY) return null;

  const day = Number(dmY[1]);
  const month = Number(dmY[2]) - 1;
  const year = Number(dmY[3]);

  let hour = 0;
  let minute = 0;

  if (t) {
    const tm = t.match(/^(\d{2}):(\d{2})$/);
    if (tm) {
      hour = Number(tm[1]);
      minute = Number(tm[2]);
    }
  }

  const dt = new Date(year, month, day, hour, minute, 0, 0);
  return isNaN(dt.getTime()) ? null : dt;
}

function normalizeCustomerName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.split(/\s+/)[0];
}

/* ---------- Chat resolve ---------- */

function normalizeCityKey(city) {
  return String(city || '').trim().toLowerCase();
}

function resolveTelegramChat(city, fallbackTelegramChannel) {
  const cityKey = normalizeCityKey(city);

  const cityMap = {
    'новосибирск': String(PROP.getProperty('TELEGRAM_CHAT_NOVOSIBIRSK') || '').trim()
  };

  const cityChat = cityMap[cityKey] || '';
  const fallback = String(fallbackTelegramChannel || PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim();

  return String(cityChat || fallback || '').trim();
}

/* ---------- Webhook resolve ---------- */

function getCurrentServiceExecUrl() {
  try {
    const url = ScriptApp.getService().getUrl();
    return normalizeWebhookUrlToExec(url);
  } catch (err) {
    return '';
  }
}

function normalizeWebhookUrlToExec(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (value.indexOf('/exec') !== -1) return value;
  if (value.indexOf('/dev') !== -1) return value.replace(/\/dev(?:$|\?)/, '/exec');
  return value;
}

function resolveWebhookExecUrl(preferredUrl) {
  const preferred = normalizeWebhookUrlToExec(preferredUrl);
  if (preferred) return preferred;

  const service = normalizeWebhookUrlToExec(getCurrentServiceExecUrl());
  if (service) return service;

  const stored = normalizeWebhookUrlToExec(PROP.getProperty(WEBAPP_EXEC_URL_PROPERTY));
  if (stored) return stored;

  return '';
}

function ensureWebhookBoundToCurrentExec(force) {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!token) return { ok: false, reason: 'token_not_set' };

  const targetUrl = normalizeWebhookUrlToExec(getCurrentServiceExecUrl()) || resolveWebhookExecUrl('');
  if (!targetUrl) return { ok: false, reason: 'exec_url_not_set' };

  const nowTs = Date.now();
  const lastTs = Number(PROP.getProperty(WEBHOOK_LAST_SYNC_TS_PROPERTY) || '0');
  const tooSoon = !force && lastTs > 0 && (nowTs - lastTs) < 3 * 60 * 1000;

  if (tooSoon) {
    return { ok: true, skipped: true, reason: 'recently_checked', targetUrl: targetUrl };
  }

  const info = urlFetchJson(`https://api.telegram.org/bot${token}/getWebhookInfo`, { method: 'get' });
  const currentWebhookUrl = info && info.result && info.result.url
    ? normalizeWebhookUrlToExec(info.result.url)
    : '';

  if (currentWebhookUrl !== targetUrl) {
    const setResp = urlFetchJson(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'post',
      payload: JSON.stringify({
        url: targetUrl,
        allowed_updates: ['message', 'edited_message', 'callback_query']
      })
    });

    if (!setResp || setResp.ok !== true) {
      Logger.log('ensureWebhookBoundToCurrentExec setWebhook failed: ' + JSON.stringify(setResp || null));
      return { ok: false, reason: 'set_webhook_failed', targetUrl: targetUrl, telegram: setResp || null };
    }
  }

  PROP.setProperty(WEBAPP_EXEC_URL_PROPERTY, targetUrl);
  PROP.setProperty(WEBHOOK_LAST_SYNC_TS_PROPERTY, String(nowTs));

  return {
    ok: true,
    changed: currentWebhookUrl !== targetUrl,
    targetUrl: targetUrl,
    webhookUrl: currentWebhookUrl
  };
}

/* ---------- Diagnostics & setup ---------- */

function __setSpreadsheetId(spreadsheetId) {
  const id = String(spreadsheetId || '').trim();
  if (!id) throw new Error('Передайте spreadsheetId');

  PROP.setProperty('SPREADSHEET_ID', id);
  const sheet = getSheet();

  const out = {
    ok: true,
    spreadsheetId: id,
    sheetName: sheet.getName(),
    buildVersion: BUILD_VERSION
  };
  Logger.log(JSON.stringify(out));
  return out;
}

function __setManagerChatId(chatId) {
  const id = String(chatId || '').trim();
  if (!id) throw new Error('Передайте chatId');

  PROP.setProperty('TELEGRAM_MANAGER_CHAT_ID', id);

  const out = { ok: true, telegramManagerChatId: id, buildVersion: BUILD_VERSION };
  Logger.log(JSON.stringify(out));
  return out;
}

function __checkConfiguration() {
  const out = {
    buildVersion: BUILD_VERSION,
    spreadsheetId: String(PROP.getProperty('SPREADSHEET_ID') || '').trim() || 'NOT_SET',
    botTokenSet: !!String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim(),
    telegramChatId: String(PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim() || 'NOT_SET',
    telegramChatNovosibirsk: String(PROP.getProperty('TELEGRAM_CHAT_NOVOSIBIRSK') || '').trim() || 'NOT_SET',
    telegramManagerChatId: getManagerChatId() || 'NOT_SET',
    storedWebAppExecUrl: String(PROP.getProperty(WEBAPP_EXEC_URL_PROPERTY) || '').trim() || 'NOT_SET',
    serviceExecUrl: getCurrentServiceExecUrl(),
    resolvedWebhookExecUrl: resolveWebhookExecUrl('')
  };

  Logger.log(JSON.stringify(out));
  return out;
}

function __checkSheetHeaders() {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const missing = REQUIRED_HEADERS.filter(function(h) { return !map[h]; });

  const out = {
    ok: missing.length === 0,
    missing: missing,
    sheetName: sheet.getName(),
    buildVersion: BUILD_VERSION
  };

  Logger.log(JSON.stringify(out));
  return out;
}

function __normalizeCreatedAtColumn() {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const col = map['Дата создания'];
  const lastRow = sheet.getLastRow();

  if (!col || lastRow < 2) {
    const out = { ok: true, updated: 0, buildVersion: BUILD_VERSION };
    Logger.log(JSON.stringify(out));
    return out;
  }

  const values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  let updated = 0;

  for (let i = 0; i < values.length; i++) {
    const prev = values[i][0];
    const norm = normalizeCreatedAtValue(prev);

    if (String(prev || '') !== String(norm || '')) {
      sheet.getRange(i + 2, col).setValue(norm);
      updated++;
    }
  }

  const out = { ok: true, updated: updated, buildVersion: BUILD_VERSION };
  Logger.log(JSON.stringify(out));
  return out;
}

function __setupReminderTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendReminders') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  const trigger = ScriptApp.newTrigger('sendReminders')
    .timeBased()
    .everyMinutes(5)
    .create();

  const out = {
    ok: true,
    triggerId: trigger && trigger.getUniqueId ? trigger.getUniqueId() : '',
    buildVersion: BUILD_VERSION
  };

  Logger.log(JSON.stringify(out));
  return out;
}

function __removeReminderTrigger() {
  let removed = 0;
  const triggers = ScriptApp.getProjectTriggers();

  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendReminders') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }

  const out = { ok: true, removed: removed, buildVersion: BUILD_VERSION };
  Logger.log(JSON.stringify(out));
  return out;
}

function __setWebhookProd() {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в Script Properties');

  const url = normalizeWebhookUrlToExec(getCurrentServiceExecUrl()) || resolveWebhookExecUrl('');
  if (!url) throw new Error('Не удалось определить URL Web App');

  const del = urlFetchJson(`https://api.telegram.org/bot${token}/deleteWebhook`, {
    method: 'post',
    payload: JSON.stringify({ drop_pending_updates: true })
  });

  const set = urlFetchJson(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'post',
    payload: JSON.stringify({
      url: url,
      allowed_updates: ['message', 'edited_message', 'callback_query']
    })
  });

  const info = urlFetchJson(`https://api.telegram.org/bot${token}/getWebhookInfo`, { method: 'get' });

  PROP.setProperty(WEBAPP_EXEC_URL_PROPERTY, url);
  PROP.setProperty(WEBHOOK_LAST_SYNC_TS_PROPERTY, String(Date.now()));

  const out = {
    ok: true,
    buildVersion: BUILD_VERSION,
    targetUrl: url,
    deleteWebhook: del,
    setWebhook: set,
    webhookInfo: info
  };

  Logger.log(JSON.stringify(out));
  return out;
}

function __setWebAppExecUrl(url) {
  const normalized = normalizeWebhookUrlToExec(url) || normalizeWebhookUrlToExec(getCurrentServiceExecUrl());
  if (!normalized) {
    throw new Error('Не удалось определить URL Web App. Укажите /exec URL вручную.');
  }

  PROP.setProperty(WEBAPP_EXEC_URL_PROPERTY, normalized);

  const out = {
    ok: true,
    storedWebAppExecUrl: normalized,
    resolvedWebhookExecUrl: resolveWebhookExecUrl(''),
    buildVersion: BUILD_VERSION
  };

  Logger.log(JSON.stringify(out));
  return out;
}

function __getTelegramWebhookInfo() {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в Script Properties');

  const info = urlFetchJson(`https://api.telegram.org/bot${token}/getWebhookInfo`, { method: 'get' });

  const out = { buildVersion: BUILD_VERSION, webhookInfo: info };
  Logger.log(JSON.stringify(out));
  return out;
}

function __hardResetBotRouting() {
  return __setWebhookProd();
}

function __probeWebhookDoPostVersion(targetUrl) {
  const url = resolveWebhookExecUrl(targetUrl || '');
  if (!url) return { ok: false, error: 'webhook url not available', buildVersion: BUILD_VERSION };

  try {
    const resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      payload: 'action=probe_version',
      muteHttpExceptions: true,
      followRedirects: true
    });

    const statusCode = resp.getResponseCode();
    const bodyText = resp.getContentText() || '';
    let bodyJson = null;
    try { bodyJson = JSON.parse(bodyText); } catch (err) {}

    const out = {
      ok: statusCode >= 200 && statusCode < 300,
      statusCode: statusCode,
      url: url,
      bodyJson: bodyJson,
      bodySnippet: bodyText.slice(0, 300),
      buildVersion: BUILD_VERSION
    };

    Logger.log(JSON.stringify(out));
    return out;
  } catch (err) {
    const out = { ok: false, error: err.message, url: url, buildVersion: BUILD_VERSION };
    Logger.log(JSON.stringify(out));
    return out;
  }
}

function __testTelegramSend() {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  const chat = String(
    PROP.getProperty('TELEGRAM_CHAT_NOVOSIBIRSK') ||
    PROP.getProperty('TELEGRAM_CHAT_ID') ||
    ''
  ).trim();

  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в Script Properties');
  if (!chat) throw new Error('TELEGRAM_CHAT_NOVOSIBIRSK/TELEGRAM_CHAT_ID не задан в Script Properties');

  const resp = urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: chat,
      text: '✅ Тест Telegram из Apps Script. build=' + BUILD_VERSION
    })
  });

  Logger.log(JSON.stringify(resp));
  return resp;
}

function __testCreateOrder() {
  const payload = {
    action: 'create',
    orderId: 'TEST-' + Date.now().toString().slice(-8),
    manager: 'Тест',
    customerName: 'Тест',
    customerPhone: '+79990000000',
    customerCity: 'Новосибирск',
    customerAddress: 'Тестовая улица, 1',
    customerFlat: '',
    orderDate: formatDate(new Date()),
    orderTime: formatTime(new Date(new Date().getTime() + 2 * 60 * 60 * 1000)),
    orderTotal: '1000',
    masterPay: '600',
    cleaningType: 'Тест',
    area: '10',
    chemistry: '—',
    equipment: '—',
    worksDescription: 'Тестовая заявка'
  };

  const resp = createOrUpdateOrder(payload, 'create');
  Logger.log(resp.getContent());
  return resp;
}

/* ---------- Utils ---------- */

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj || {}))
    .setMimeType(ContentService.MimeType.JSON);
}

function escapeTelegramHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
