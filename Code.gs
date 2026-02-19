// Code.gs - чистый backend для заявок + Telegram кнопок

const BUILD_VERSION = '2026-02-19-button-rewrite-v2';

const PROP = PropertiesService.getScriptProperties();
const SHEET_NAME = 'Заявки';
const WEBAPP_EXEC_URL_PROPERTY = 'WEBAPP_EXEC_URL';
const WEBHOOK_LAST_SYNC_TS_PROPERTY = 'WEBHOOK_LAST_SYNC_TS';

const CALLBACK_CACHE_TTL_SECONDS = 600;
const ORDER_DM_SENT_PREFIX = 'ORDER_DM_SENT_';
const ORDER_DM_META_PREFIX = 'ORDER_DM_META_';

const CALLBACK_ACTIONS = {
  TAKE: 'take',
  ARRIVE: 'arrive',
  DONE: 'done',
  CANCEL: 'cancel'
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
  'Напоминание 24ч',
  'Напоминание 2ч',
  'Статус выполнения'
];

/* ---------- Entry points ---------- */

function doGet(e) {
  try {
    const isHealth = e && e.parameter && String(e.parameter.health || '') === '1';
    if (isHealth) {
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
    try { Logger.log('doPost body: ' + JSON.stringify(body)); } catch (logErr) {}

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
      keys: Object.keys(body || {})
    });
  } catch (err) {
    Logger.log('doPost error: ' + err.message + '\n' + (err.stack || ''));
    return jsonResponse({ ok: false, error: err.message, buildVersion: BUILD_VERSION });
  }
}

/* ---------- Incoming body ---------- */

function parseIncomingBody(event) {
  const param = event.parameter || {};
  const params = flattenParameters(event.parameters || {});
  const raw = event.postData && event.postData.contents ? String(event.postData.contents) : '';

  let body = {};

  if (raw) {
    const parsedRaw = tryParseJson(raw);
    if (parsedRaw && typeof parsedRaw === 'object') {
      body = parsedRaw;
    } else {
      body = parseFormEncoded(raw);
    }
  } else {
    body = Object.keys(param).length ? param : params;
  }

  if (!body || !Object.keys(body).length) {
    body = Object.keys(param).length ? param : params;
  }

  body = unwrapBodyPayload(body);

  const action = String(body.action || '').trim().toLowerCase();
  if (action) body.action = action;
  if (!action && looksLikeCreateOrderPayload(body)) body.action = 'create';

  return (body && typeof body === 'object') ? body : {};
}

function flattenParameters(parameters) {
  const out = {};
  const keys = Object.keys(parameters || {});
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = parameters[key];
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
    const p = pairs[i];
    if (!p) continue;

    const eq = p.indexOf('=');
    const key = eq >= 0 ? p.slice(0, eq) : p;
    const val = eq >= 0 ? p.slice(eq + 1) : '';
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
    if (parsedJson && typeof parsedJson === 'object') {
      current = parsedJson;
      continue;
    }

    const parsedPayload = tryParseJson(current.payload);
    if (parsedPayload && typeof parsedPayload === 'object') {
      current = parsedPayload;
      continue;
    }

    const parsedData = tryParseJson(current.data);
    if (parsedData && typeof parsedData === 'object') {
      current = parsedData;
      continue;
    }

    break;
  }

  return (current && typeof current === 'object') ? current : {};
}

function looksLikeCreateOrderPayload(body) {
  if (!body || typeof body !== 'object') return false;

  const keys = Object.keys(body);
  if (!keys.length) return false;

  const hints = [
    'manager',
    'customerName',
    'customerPhone',
    'customerAddress',
    'customerCity',
    'cleaningType',
    'orderTotal',
    'masterPay'
  ];

  for (let i = 0; i < hints.length; i++) {
    if (Object.prototype.hasOwnProperty.call(body, hints[i])) return true;
  }

  return false;
}

/* ---------- Bot health ---------- */

function checkTelegramBotStatus() {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!token) {
    return jsonResponse({ ok: false, error: 'TELEGRAM_BOT_TOKEN не задан', buildVersion: BUILD_VERSION });
  }

  const resp = urlFetchJson(`https://api.telegram.org/bot${token}/getMe`, { method: 'get' });
  if (!resp || resp.ok !== true || !resp.result) {
    return jsonResponse({
      ok: false,
      error: (resp && (resp.description || resp.error || resp.note)) || 'Ошибка проверки бота',
      telegram: resp || null,
      buildVersion: BUILD_VERSION
    });
  }

  return jsonResponse({
    ok: true,
    bot: { id: resp.result.id, username: resp.result.username || '', first_name: resp.result.first_name || '' },
    buildVersion: BUILD_VERSION
  });
}

/* ---------- Spreadsheet ---------- */

function getSheet() {
  const spreadsheetId = String(PROP.getProperty('SPREADSHEET_ID') || '').trim();

  let ss = null;
  if (spreadsheetId) {
    try {
      ss = SpreadsheetApp.openById(spreadsheetId);
    } catch (err) {
      ss = null;
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
    throw new Error(
      'Не удалось открыть таблицу. Укажите Script Property SPREADSHEET_ID или запустите bound-скрипт.'
    );
  }

  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }

  ensureSheetHeaders(sheet);
  return sheet;
}

function ensureSheetHeaders(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, REQUIRED_HEADERS.length).setValues([REQUIRED_HEADERS]);
    return;
  }

  const width = Math.max(sheet.getLastColumn(), REQUIRED_HEADERS.length);
  if (sheet.getMaxColumns() < width) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  }

  const currentHeaders = sheet.getRange(1, 1, 1, width).getValues()[0].map(function(v) {
    return String(v || '').trim();
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
    const h = String(headers[i] || '').trim();
    if (h) map[h] = i + 1;
  }

  return map;
}

function appendOrderRow(sheet, rowData) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function(h) {
    return String(h || '').trim();
  });

  const row = headers.map(function(h) {
    return Object.prototype.hasOwnProperty.call(rowData, h) ? rowData[h] : '';
  });

  sheet.appendRow(row);
}

function setCellByHeader(sheet, rowNum, headerMap, headerName, value) {
  const col = headerMap[headerName];
  if (!col) return;
  sheet.getRange(rowNum, col).setValue(value);
}

function getCellFromRowByHeader(rowValues, headerMap, headerName) {
  const col = headerMap[headerName];
  if (!col) return '';
  return rowValues[col - 1];
}

function findOrderRowById(orderId) {
  const target = normalizeOrderId(orderId);
  if (!target) return null;

  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const col = map['Номер заявки'];
  const lastRow = sheet.getLastRow();
  if (!col || lastRow < 2) return null;

  const values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    const candidate = normalizeOrderId(values[i][0]);
    if (candidate && candidate === target) return i + 2;
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
  const msgDigits = normalizeNumericString(msg);

  for (let i = 0; i < chatValues.length; i++) {
    const c = String(chatValues[i][0] || '').trim();
    const m = String(msgValues[i][0] || '').trim();
    if (c !== chat) continue;
    if (m === msg) return i + 2;
    if (msgDigits && normalizeNumericString(m) === msgDigits) return i + 2;
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
    if (id !== target) continue;
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

/* ---------- Create/Update order ---------- */

function createOrUpdateOrder(payload, action) {
  const orderId = normalizeOrderId(payload.orderId) || ('CLN-' + Date.now().toString().slice(-8));

  const order = {
    orderId: orderId,
    createdAt: normalizeCreatedAtValue(payload.createdAt || payload._ts || new Date()),
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
      return jsonResponse({ ok: true, updated: true, orderId: orderId, buildVersion: BUILD_VERSION });
    }
  }

  appendOrderRow(sheet, buildOrderRowData(order, 'Опубликована'));
  clearOrderDmSent(orderId);

  // Держим webhook на актуальном /exec, чтобы кнопка не отваливалась.
  ensureWebhookBoundToCurrentExec(false);

  const publish = sendOrderToGroup(order, payload.telegramChannel);
  if (!publish.ok) {
    const rowNum = findOrderRowById(orderId);
    if (rowNum) {
      const map = getHeaderMap(sheet);
      setCellByHeader(sheet, rowNum, map, 'Статус', 'Ошибка публикации');
      setCellByHeader(sheet, rowNum, map, 'Статус выполнения', String(publish.reason || 'telegram_error'));
    }
    return jsonResponse({
      ok: false,
      error: publish.error || publish.reason || 'telegram_error',
      orderId: orderId,
      savedInSheet: true,
      telegram: publish.telegram || null,
      buildVersion: BUILD_VERSION
    });
  }

  setTelegramIdsForOrder(orderId, publish.chatId, publish.messageId);

  return jsonResponse({
    ok: true,
    orderId: orderId,
    chat: publish.chatId,
    messageId: publish.messageId,
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
  const map = getHeaderMap(sheet);

  const payload = buildOrderRowData(order, '');
  setCellByHeader(sheet, rowNum, map, 'Номер заявки', payload['Номер заявки']);
  setCellByHeader(sheet, rowNum, map, 'Дата создания', payload['Дата создания']);
  setCellByHeader(sheet, rowNum, map, 'Менеджер', payload['Менеджер']);
  setCellByHeader(sheet, rowNum, map, 'Имя клиента', payload['Имя клиента']);
  setCellByHeader(sheet, rowNum, map, 'Телефон клиента', payload['Телефон клиента']);
  setCellByHeader(sheet, rowNum, map, 'Город', payload['Город']);
  setCellByHeader(sheet, rowNum, map, 'Улица и дом', payload['Улица и дом']);
  setCellByHeader(sheet, rowNum, map, 'Квартира/офис', payload['Квартира/офис']);
  setCellByHeader(sheet, rowNum, map, 'Дата уборки', payload['Дата уборки']);
  setCellByHeader(sheet, rowNum, map, 'Время уборки', payload['Время уборки']);
  setCellByHeader(sheet, rowNum, map, 'Сумма заказа', payload['Сумма заказа']);
  setCellByHeader(sheet, rowNum, map, 'Зарплата мастерам', payload['Зарплата мастерам']);
  setCellByHeader(sheet, rowNum, map, 'Тип уборки', payload['Тип уборки']);
  setCellByHeader(sheet, rowNum, map, 'Площадь (м²)', payload['Площадь (м²)']);
  setCellByHeader(sheet, rowNum, map, 'Химия', payload['Химия']);
  setCellByHeader(sheet, rowNum, map, 'Оборудование', payload['Оборудование']);
  setCellByHeader(sheet, rowNum, map, 'Описание работ', payload['Описание работ']);
}

function setTelegramIdsForOrder(orderId, chatId, messageId) {
  const rowNum = findOrderRowById(orderId);
  if (!rowNum) return;
  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  setCellByHeader(sheet, rowNum, map, 'Telegram Chat ID', String(chatId || '').trim());
  setCellByHeader(sheet, rowNum, map, 'Telegram Message ID', String(messageId || '').trim());
}

/* ---------- Telegram publish ---------- */

function sendOrderToGroup(order, fallbackTelegramChannel) {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!token) return { ok: false, reason: 'token_not_set', error: 'TELEGRAM_BOT_TOKEN не задан' };

  const chatId = resolveTelegramChat(order.customerCity, fallbackTelegramChannel);
  if (!chatId) return { ok: false, reason: 'chat_not_set', error: 'TELEGRAM_CHAT_ID не задан' };

  const briefText = generateBriefText(order);
  const callbackData = makeCallbackData(CALLBACK_ACTIONS.TAKE, order.orderId);

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ ВЫХОЖУ НА ЗАЯВКУ', callback_data: callbackData }
    ]]
  };

  const resp = urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: chatId,
      text: briefText,
      parse_mode: 'HTML',
      reply_markup: keyboard,
      disable_web_page_preview: true
    })
  });

  if (!resp || resp.ok !== true || !resp.result) {
    Logger.log('sendOrderToGroup failed: ' + JSON.stringify(resp || null));
    return {
      ok: false,
      reason: 'telegram_error',
      error: (resp && (resp.description || resp.error || resp.note)) || 'Telegram sendMessage failed',
      telegram: resp || null
    };
  }

  return {
    ok: true,
    chatId: String(chatId),
    messageId: String(resp.result.message_id || '').trim(),
    telegram: resp
  };
}

/* ---------- Telegram updates ---------- */

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
      if (!saved) PROP.setProperty('TELEGRAM_CHAT_ID', String(body.message.chat.id));
    }

    return jsonResponse({ ok: true, buildVersion: BUILD_VERSION });
  } catch (err) {
    Logger.log('handleTelegramUpdate error: ' + err.message + '\n' + (err.stack || ''));
    return jsonResponse({ ok: false, error: err.message, buildVersion: BUILD_VERSION });
  }
}

function handleCallbackQuery(cb, token) {
  const callbackId = String(cb.id || '').trim();
  const rawData = String(cb.data || '').trim();
  const from = cb.from || {};
  const message = cb.message || cb.inaccessible_message || {};

  const cbChatId = message.chat ? String(message.chat.id || '').trim() : '';
  const cbMessageId = String(message.message_id || '').trim();

  if (isDuplicateCallback(callbackId)) {
    answerCallback(token, callbackId, 'ℹ️ Нажатие уже обработано');
    return jsonResponse({ ok: true, duplicate: true, buildVersion: BUILD_VERSION });
  }

  let parsed = parseCallbackActionData(rawData);
  if (!parsed) {
    const fallbackId = extractOrderIdFromTelegramMessage(message);
    if (fallbackId) parsed = { action: CALLBACK_ACTIONS.TAKE, orderId: fallbackId };
  }

  try { Logger.log('callback_query raw=' + rawData + ' parsed=' + JSON.stringify(parsed || null)); } catch (err) {}

  if (!parsed) {
    answerCallback(token, callbackId, 'Неизвестное действие');
    return jsonResponse({ ok: true, ignored: true, buildVersion: BUILD_VERSION });
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    answerCallback(token, callbackId, '⏳ Сервер занят, нажмите кнопку еще раз');
    return jsonResponse({ ok: true, busy: true, buildVersion: BUILD_VERSION });
  }

  try {
    const rowNum = resolveRowForCallback(parsed, message, cbChatId, cbMessageId);
    if (!rowNum) {
      answerCallback(token, callbackId, '❌ Заявка не найдена');
      return jsonResponse({ ok: false, error: 'Order not found', buildVersion: BUILD_VERSION });
    }

    const order = getOrderByRow(rowNum);
    const orderId = normalizeOrderId(order['Номер заявки'] || parsed.orderId);
    const statusLower = String(order['Статус'] || '').toLowerCase().trim();
    const currentMasterId = String(order['Master ID'] || '').trim();

    const masterId = String(from.id || '').trim();
    const masterName = buildMasterName(from);

    if (!masterId || !orderId) {
      answerCallback(token, callbackId, '❌ Ошибка данных заявки');
      return jsonResponse({ ok: false, error: 'Bad callback payload', buildVersion: BUILD_VERSION });
    }

    if (parsed.action === CALLBACK_ACTIONS.TAKE) {
      return handleTakeAction({
        token: token,
        callbackId: callbackId,
        cbChatId: cbChatId,
        cbMessageId: cbMessageId,
        rowNum: rowNum,
        order: order,
        orderId: orderId,
        statusLower: statusLower,
        currentMasterId: currentMasterId,
        masterId: masterId,
        masterName: masterName
      });
    }

    if (parsed.action === CALLBACK_ACTIONS.ARRIVE) {
      return handleArriveAction({
        token: token,
        callbackId: callbackId,
        cbChatId: cbChatId,
        cbMessageId: cbMessageId,
        rowNum: rowNum,
        order: order,
        orderId: orderId,
        statusLower: statusLower,
        currentMasterId: currentMasterId,
        masterId: masterId,
        masterName: masterName
      });
    }

    if (parsed.action === CALLBACK_ACTIONS.DONE) {
      return handleDoneAction({
        token: token,
        callbackId: callbackId,
        cbChatId: cbChatId,
        cbMessageId: cbMessageId,
        rowNum: rowNum,
        order: order,
        orderId: orderId,
        statusLower: statusLower,
        currentMasterId: currentMasterId,
        masterId: masterId,
        masterName: masterName
      });
    }

    if (parsed.action === CALLBACK_ACTIONS.CANCEL) {
      return handleCancelAction({
        token: token,
        callbackId: callbackId,
        cbChatId: cbChatId,
        cbMessageId: cbMessageId,
        rowNum: rowNum,
        order: order,
        orderId: orderId,
        statusLower: statusLower,
        currentMasterId: currentMasterId,
        masterId: masterId,
        masterName: masterName
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

function handleTakeAction(ctx) {
  const orderId = ctx.orderId;
  const statusLower = String(ctx.statusLower || '').toLowerCase();
  const currentMasterId = String(ctx.currentMasterId || '').trim();
  const masterId = String(ctx.masterId || '').trim();

  if (statusLower.indexOf('заверш') !== -1) {
    answerCallback(ctx.token, ctx.callbackId, '❌ Заявка уже завершена');
    return jsonResponse({ ok: true, alreadyDone: true, buildVersion: BUILD_VERSION });
  }

  if (statusLower.indexOf('взята') !== -1 || statusLower.indexOf('на объекте') !== -1) {
    if (currentMasterId && currentMasterId === masterId) {
      answerCallback(ctx.token, ctx.callbackId, 'ℹ️ Вы уже приняли эту заявку');
      return jsonResponse({ ok: true, alreadyTakenBySameMaster: true, buildVersion: BUILD_VERSION });
    }
    answerCallback(ctx.token, ctx.callbackId, '❌ Заявка уже принята другим мастером');
    return jsonResponse({ ok: true, alreadyTaken: true, buildVersion: BUILD_VERSION });
  }

  const takenAt = formatDateTime(new Date());
  updateOrderTakenByRow(ctx.rowNum, masterId, ctx.masterName, takenAt);

  const updatedOrder = getOrderByRow(ctx.rowNum);

  answerCallback(ctx.token, ctx.callbackId, '✅ Заявка принята. Отправляю детали в личные сообщения.');
  sendMasterOrderPackage(ctx.token, masterId, orderId, updatedOrder);
  clearGroupTakeButton(ctx.token, updatedOrder, ctx.cbChatId, ctx.cbMessageId);

  return jsonResponse({ ok: true, action: CALLBACK_ACTIONS.TAKE, orderId: orderId, buildVersion: BUILD_VERSION });
}

function handleArriveAction(ctx) {
  if (!isOrderAssignedToMaster(ctx.statusLower, ctx.currentMasterId, ctx.masterId)) {
    answerCallback(ctx.token, ctx.callbackId, '❌ Только назначенный мастер может отметить прибытие');
    return jsonResponse({ ok: true, denied: true, action: CALLBACK_ACTIONS.ARRIVE, buildVersion: BUILD_VERSION });
  }

  const arrivedAt = formatDateTime(new Date());
  updateOrderArrivedByRow(ctx.rowNum, arrivedAt);
  const updatedOrder = getOrderByRow(ctx.rowNum);

  answerCallback(ctx.token, ctx.callbackId, '✅ Время прибытия сохранено');
  updateMasterActionMessageAfterArrive(ctx.token, ctx.cbChatId, ctx.cbMessageId, ctx.orderId);
  notifyManagerNeedInvoice(updatedOrder, ctx.masterName, arrivedAt);

  return jsonResponse({ ok: true, action: CALLBACK_ACTIONS.ARRIVE, orderId: ctx.orderId, buildVersion: BUILD_VERSION });
}

function handleDoneAction(ctx) {
  if (!isOrderAssignedToMaster(ctx.statusLower, ctx.currentMasterId, ctx.masterId)) {
    answerCallback(ctx.token, ctx.callbackId, '❌ Только назначенный мастер может завершить заявку');
    return jsonResponse({ ok: true, denied: true, action: CALLBACK_ACTIONS.DONE, buildVersion: BUILD_VERSION });
  }

  const doneAt = formatDateTime(new Date());
  updateOrderDoneByRow(ctx.rowNum, doneAt);
  const updatedOrder = getOrderByRow(ctx.rowNum);

  answerCallback(ctx.token, ctx.callbackId, '✅ Заявка завершена');
  clearMasterActionMessage(ctx.token, ctx.cbChatId, ctx.cbMessageId);
  notifyManagerOrderDone(updatedOrder, ctx.masterName, doneAt);

  return jsonResponse({ ok: true, action: CALLBACK_ACTIONS.DONE, orderId: ctx.orderId, buildVersion: BUILD_VERSION });
}

function handleCancelAction(ctx) {
  if (!ctx.currentMasterId || String(ctx.currentMasterId).trim() !== String(ctx.masterId).trim()) {
    answerCallback(ctx.token, ctx.callbackId, '❌ Только назначенный мастер может отменить заявку');
    return jsonResponse({ ok: true, denied: true, action: CALLBACK_ACTIONS.CANCEL, buildVersion: BUILD_VERSION });
  }

  const cancelledAt = formatDateTime(new Date());
  updateOrderCancelledByRow(ctx.rowNum, ctx.masterName, cancelledAt);
  deleteMasterActionMessage(ctx.token, ctx.cbChatId, ctx.cbMessageId);

  clearOrderDmSent(ctx.orderId);
  const republish = republishOrderToGroupByRow(ctx.rowNum);
  const updatedOrder = getOrderByRow(ctx.rowNum);
  notifyManagerOrderCancelled(updatedOrder, ctx.masterName, cancelledAt, republish);

  answerCallback(ctx.token, ctx.callbackId, republish.ok ? '✅ Заявка отменена и возвращена в группу' : '⚠️ Заявка отменена, но не удалось вернуть в группу');
  return jsonResponse({
    ok: true,
    action: CALLBACK_ACTIONS.CANCEL,
    orderId: ctx.orderId,
    republish: republish,
    buildVersion: BUILD_VERSION
  });
}

function sendMasterOrderPackage(token, masterId, orderId, orderRow) {
  if (isOrderDmAlreadySent(orderId, masterId)) return;

  const fullText = generateFullText(orderRow);
  const resp = urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: masterId,
      text: fullText,
      parse_mode: 'HTML',
      reply_markup: buildMasterActionKeyboard(orderId),
      disable_web_page_preview: true
    })
  });

  if (!resp || resp.ok !== true || !resp.result) {
    Logger.log('sendMasterOrderPackage failed for ' + orderId + ': ' + JSON.stringify(resp || null));
    return;
  }

  markOrderDmSent(orderId, masterId, [String(resp.result.message_id || '')]);
}

function clearGroupTakeButton(token, orderRow, fallbackChatId, fallbackMessageId) {
  const chatId = String(orderRow['Telegram Chat ID'] || fallbackChatId || '').trim();
  const messageId = String(orderRow['Telegram Message ID'] || fallbackMessageId || '').trim();
  if (!chatId || !messageId) return;

  urlFetchJson(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: chatId,
      message_id: Number(messageId),
      reply_markup: { inline_keyboard: [] }
    })
  });
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

/* ---------- Callback parse / resolve ---------- */

function makeCallbackData(action, orderId) {
  const a = String(action || '').trim().toLowerCase();
  const id = normalizeOrderId(orderId);
  if (!a || !id) return '';
  return a + ':' + id;
}

function parseCallbackActionData(data) {
  const raw = normalizeCallbackRawData(data);
  if (!raw) return null;

  // Новый строгий формат: action:ORDER_ID
  const strict = raw.match(/^(take|arrive|done|cancel):(.+)$/i);
  if (strict) {
    const action = String(strict[1] || '').trim().toLowerCase();
    const orderId = normalizeOrderId(strict[2]);
    return (action && orderId) ? { action: action, orderId: orderId } : null;
  }

  // Совместимость: action|ORDER_ID
  const vPipe = raw.match(/^(take|arrive|done|cancel)\|(.+)$/i);
  if (vPipe) {
    const action = String(vPipe[1] || '').trim().toLowerCase();
    const orderId = normalizeOrderId(vPipe[2]);
    return (action && orderId) ? { action: action, orderId: orderId } : null;
  }

  // Совместимость: action_ORDER_ID
  const vUnderscore = raw.match(/^(take|arrive|done|cancel)_(.+)$/i);
  if (vUnderscore) {
    const action = String(vUnderscore[1] || '').trim().toLowerCase();
    const orderId = normalizeOrderId(vUnderscore[2]);
    return (action && orderId) ? { action: action, orderId: orderId } : null;
  }

  // Совместимость: просто "take" (без id)
  const onlyAction = raw.match(/^(take|arrive|done|cancel)$/i);
  if (onlyAction) {
    return { action: String(onlyAction[1] || '').toLowerCase(), orderId: '' };
  }

  return null;
}

function normalizeCallbackRawData(data) {
  const raw = String(data || '').trim();
  if (!raw) return '';

  // JSON callback_data
  if (raw[0] === '{' && raw[raw.length - 1] === '}') {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        const action = String(obj.action || obj.a || '').trim().toLowerCase();
        const orderId = normalizeOrderId(obj.orderId || obj.id || '');
        if (action && orderId) return action + ':' + orderId;
      }
    } catch (err) {}
  }

  // URL-encoded callback_data
  if (raw.indexOf('%') !== -1) {
    try {
      const decoded = decodeURIComponent(raw);
      if (decoded && decoded !== raw) return String(decoded).trim();
    } catch (err) {}
  }

  return raw;
}

function normalizeOrderId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const match = raw.match(/([A-Za-z]{2,8}-\d{5,})/i);
  if (match && match[1]) return String(match[1]).toUpperCase();

  const cleaned = raw.split('|')[0].split(',')[0].split(' ')[0].trim();
  return cleaned.toUpperCase();
}

function extractOrderIdFromTelegramMessage(message) {
  const text = String((message && (message.text || message.caption)) || '').trim();
  if (!text) return '';

  const m = text.match(/(?:№|#)\s*([A-Za-z]{2,8}-\d{5,})/i);
  if (m && m[1]) return String(m[1]).toUpperCase();

  const any = text.match(/([A-Za-z]{2,8}-\d{5,})/i);
  return any && any[1] ? String(any[1]).toUpperCase() : '';
}

function normalizeNumericString(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function resolveRowForCallback(parsed, message, chatId, messageId) {
  const byParsedId = normalizeOrderId(parsed && parsed.orderId);
  if (byParsedId) {
    const row1 = findOrderRowById(byParsedId);
    if (row1) return row1;
  }

  const byTextId = extractOrderIdFromTelegramMessage(message);
  if (byTextId) {
    const row2 = findOrderRowById(byTextId);
    if (row2) return row2;
  }

  const row3 = findOrderRowByTelegramMessage(chatId, messageId);
  if (row3) return row3;

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

function isOrderDmAlreadySent(orderId, masterId) {
  const id = normalizeOrderId(orderId);
  const m = String(masterId || '').trim();
  if (!id || !m) return false;
  return String(PROP.getProperty(ORDER_DM_SENT_PREFIX + id) || '').trim() === m;
}

function markOrderDmSent(orderId, masterId, messageIds) {
  const id = normalizeOrderId(orderId);
  const m = String(masterId || '').trim();
  if (!id || !m) return;

  PROP.setProperty(ORDER_DM_SENT_PREFIX + id, m);
  PROP.setProperty(ORDER_DM_META_PREFIX + id, JSON.stringify({
    masterId: m,
    messageIds: Array.isArray(messageIds) ? messageIds : [],
    ts: Date.now()
  }));
}

function clearOrderDmSent(orderId) {
  const id = normalizeOrderId(orderId);
  if (!id) return;
  PROP.deleteProperty(ORDER_DM_SENT_PREFIX + id);
  PROP.deleteProperty(ORDER_DM_META_PREFIX + id);
}

/* ---------- Message text/photo ---------- */

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
    if (result.handled) {
      return jsonResponse({ ok: true, managerCommand: result, buildVersion: BUILD_VERSION });
    }
  }

  return jsonResponse({ ok: true, buildVersion: BUILD_VERSION });
}

function processManagerPaymentCommand(text, token) {
  // /pay CLN-12345678 https://...
  const parts = String(text || '').trim().split(/\s+/);
  if (!parts.length || String(parts[0]).toLowerCase() !== '/pay') {
    return { handled: false };
  }

  if (parts.length < 3) {
    return { handled: true, ok: false, error: 'Используйте: /pay НОМЕР_ЗАЯВКИ ССЫЛКА' };
  }

  const orderId = normalizeOrderId(parts[1]);
  const payLink = String(parts.slice(2).join(' ') || '').trim();
  if (!orderId || !payLink) {
    return { handled: true, ok: false, error: 'Неверный формат команды' };
  }

  const rowNum = findOrderRowById(orderId);
  if (!rowNum) return { handled: true, ok: false, error: 'Заявка не найдена' };

  const order = getOrderByRow(rowNum);
  const masterId = String(order['Master ID'] || '').trim();
  if (!masterId) return { handled: true, ok: false, error: 'У заявки нет назначенного мастера' };

  const textToMaster = [
    `💳 Ссылка на оплату по заявке <code>${escapeTelegramHtml(orderId)}</code>:`,
    escapeTelegramHtml(payLink)
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

/* ---------- Order status update helpers ---------- */

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
  setCellByHeader(sheet, rowNum, map, 'Статус выполнения', 'Заявка принята: ' + String(takenAt || '').trim());
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
  setCellByHeader(sheet, rowNum, map, 'Статус выполнения', 'Отменена мастером ' + cleanMasterName + ': ' + cleanCancelledAt);
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

  const publish = sendOrderToGroup(orderModel, '');
  if (publish.ok) {
    setTelegramIdsForOrder(orderModel.orderId, publish.chatId, publish.messageId);
  }

  return publish;
}

function mapSheetOrderToOrderModel(order) {
  return {
    orderId: normalizeOrderId(order['Номер заявки']),
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

/* ---------- Telegram keyboards/text ---------- */

function buildMasterActionKeyboard(orderId) {
  return {
    inline_keyboard: [
      [{ text: '📍 ПРИЕХАЛ НА ОБЪЕКТ', callback_data: makeCallbackData(CALLBACK_ACTIONS.ARRIVE, orderId) }],
      [{ text: '✅ ЗАВЕРШИЛ ЗАЯВКУ', callback_data: makeCallbackData(CALLBACK_ACTIONS.DONE, orderId) }],
      [{ text: '❌ ОТМЕНИТЬ ЗАЯВКУ', callback_data: makeCallbackData(CALLBACK_ACTIONS.CANCEL, orderId) }]
    ]
  };
}

function buildMasterActionKeyboardAfterArrive(orderId) {
  return {
    inline_keyboard: [
      [{ text: '✅ ЗАВЕРШИЛ ЗАЯВКУ', callback_data: makeCallbackData(CALLBACK_ACTIONS.DONE, orderId) }],
      [{ text: '❌ ОТМЕНИТЬ ЗАЯВКУ', callback_data: makeCallbackData(CALLBACK_ACTIONS.CANCEL, orderId) }]
    ]
  };
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

  let text = `🧹 <b>ПОЛНАЯ ИНФОРМАЦИЯ О ЗАЯВКЕ №${orderId}</b>\n`;
  text += '────────────────────────────────────\n\n';

  text += '<b>📋 ОСНОВНАЯ ИНФОРМАЦИЯ</b>\n';
  text += `🏙 Город: ${city}\n`;
  text += `🧽 Вид уборки: ${cleaningType}\n`;
  text += `📐 Площадь: ${area} м²\n`;
  text += `🗓 Дата и время: ${dateTime}\n`;
  text += `📍 Адрес: ${escapeTelegramHtml(fullAddress || 'не указан')}\n\n`;

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
  text += '1️⃣ Подтвердите клиенту время и адрес.\n\n';
  text += '2️⃣ Подготовьте нужное оборудование и химию заранее.\n\n';
  text += '3️⃣ На объекте нажмите кнопку «ПРИЕХАЛ НА ОБЪЕКТ» и отправьте фото.\n\n';
  text += '4️⃣ После работ отправьте фото результата.\n\n';
  text += '5️⃣ Отправьте фото подписанного акта.\n\n';
  text += '6️⃣ Подтвердите оплату от клиента.';

  return text;
}

function extractStreetOnly(address) {
  const raw = String(address || '').trim();
  if (!raw) return '';
  return String(raw.split(',')[0] || '').trim();
}

function buildPhoneLink(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return '';
  const normalized = raw.replace(/[^\d+]/g, '');
  if (!normalized) return '';
  return 'tel:' + normalized;
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
    const header = String(sheet.getRange(1, col).getValue() || '').trim();
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

  const masterName = buildMasterName(from);
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

/* ---------- Reminders ---------- */

function sendReminders() {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!token) return;

  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const now = new Date();

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const rowNum = i + 2;

    const status = String(getCellFromRowByHeader(row, map, 'Статус') || '').toLowerCase();
    const orderId = String(getCellFromRowByHeader(row, map, 'Номер заявки') || '').trim();
    const masterId = String(getCellFromRowByHeader(row, map, 'Master ID') || '').trim();
    const dateValue = getCellFromRowByHeader(row, map, 'Дата уборки');
    const timeValue = getCellFromRowByHeader(row, map, 'Время уборки');
    const sent24 = String(getCellFromRowByHeader(row, map, 'Напоминание 24ч') || '').trim();
    const sent2 = String(getCellFromRowByHeader(row, map, 'Напоминание 2ч') || '').trim();

    if (!masterId) continue;
    if (status.indexOf('взята') === -1 && status.indexOf('на объекте') === -1) continue;

    const dt = parseOrderDateTime(dateValue, timeValue);
    if (!dt) continue;

    const diff = dt.getTime() - now.getTime();
    const dayMs = 24 * 60 * 60 * 1000;
    const twoMs = 2 * 60 * 60 * 1000;

    if (!sent24 && diff <= dayMs && diff > dayMs - (60 * 60 * 1000)) {
      const text24 = `⏰ Напоминание за 24 часа\nЗаявка <code>${escapeTelegramHtml(orderId)}</code> завтра.`;
      urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'post',
        payload: JSON.stringify({ chat_id: masterId, text: text24, parse_mode: 'HTML' })
      });
      setCellByHeader(sheet, rowNum, map, 'Напоминание 24ч', 'Отправлено ' + formatDateTime(new Date()));
    }

    if (!sent2 && diff <= twoMs && diff > twoMs - (30 * 60 * 1000)) {
      const text2 = `🚨 Напоминание за 2 часа\nЗаявка <code>${escapeTelegramHtml(orderId)}</code> через 2 часа.`;
      urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'post',
        payload: JSON.stringify({ chat_id: masterId, text: text2, parse_mode: 'HTML' })
      });
      setCellByHeader(sheet, rowNum, map, 'Напоминание 2ч', 'Отправлено ' + formatDateTime(new Date()));
    }
  }
}

/* ---------- Notifications to manager ---------- */

function getManagerChatId() {
  return String(PROP.getProperty('TELEGRAM_MANAGER_CHAT_ID') || '').trim();
}

function notifyManagerNeedInvoice(order, masterName, arrivedAt) {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  const managerId = getManagerChatId();
  if (!token || !managerId) return;

  const orderId = escapeTelegramHtml(order['Номер заявки'] || '');
  const text = [
    '💳 <b>Нужно сформировать ссылку на оплату</b>',
    `Заявка: <code>${orderId}</code>`,
    `Мастер: ${escapeTelegramHtml(masterName || 'Мастер')}`,
    `Время прибытия: ${escapeTelegramHtml(arrivedAt || '')}`,
    '',
    'Отправьте команду:',
    `<code>/pay ${orderId} https://ваша-ссылка</code>`
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

/* ---------- Date/time normalize ---------- */

function normalizeCreatedAtValue(value) {
  const dt = parseDateTimeLoose(value);
  if (!dt) return formatDateTime(new Date());
  return formatDateTime(dt);
}

function normalizeOrderDateValue(value) {
  if (value instanceof Date) {
    return formatDate(value);
  }

  const raw = String(value || '').trim();
  if (!raw) return '';

  const ddmmyyyy = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (ddmmyyyy) return `${ddmmyyyy[1]}.${ddmmyyyy[2]}.${ddmmyyyy[3]}`;

  const ddmm = raw.match(/^(\d{2})\.(\d{2})$/);
  if (ddmm) {
    const year = new Date().getFullYear();
    return `${ddmm[1]}.${ddmm[2]}.${year}`;
  }

  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) return `${ymd[3]}.${ymd[2]}.${ymd[1]}`;

  const dt = parseDateTimeLoose(raw);
  if (dt) return formatDate(dt);

  return raw;
}

function normalizeOrderTimeValue(value) {
  if (value instanceof Date) {
    return formatTime(value);
  }

  const raw = String(value || '').trim();
  if (!raw) return '';

  const hhmm = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmm) {
    const hh = ('0' + Number(hhmm[1])).slice(-2);
    const mm = ('0' + Number(hhmm[2])).slice(-2);
    return hh + ':' + mm;
  }

  const dt = parseDateTimeLoose(raw);
  if (dt) return formatTime(dt);

  return raw;
}

function formatDateTimeForDisplay(dateValue, timeValue) {
  const d = formatDateForDisplay(dateValue);
  const t = formatTimeForDisplay(timeValue);
  if (d && t) return d + ' в ' + t;
  if (d) return d;
  if (t) return t;
  return 'не указаны';
}

function formatDateForDisplay(value) {
  if (value instanceof Date) return formatDate(value);

  const raw = String(value || '').trim();
  if (!raw) return '';

  const ddmmyyyy = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (ddmmyyyy) return raw;

  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) return `${ymd[3]}.${ymd[2]}.${ymd[1]}`;

  const dt = parseDateTimeLoose(raw);
  return dt ? formatDate(dt) : raw;
}

function formatTimeForDisplay(value) {
  if (value instanceof Date) return formatTime(value);

  const raw = String(value || '').trim();
  if (!raw) return '';

  const hhmm = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmm) {
    const hh = ('0' + Number(hhmm[1])).slice(-2);
    const mm = ('0' + Number(hhmm[2])).slice(-2);
    return hh + ':' + mm;
  }

  const dt = parseDateTimeLoose(raw);
  return dt ? formatTime(dt) : raw;
}

function parseOrderDateTime(dateValue, timeValue) {
  let baseDate = null;

  if (dateValue instanceof Date) {
    baseDate = new Date(dateValue.getFullYear(), dateValue.getMonth(), dateValue.getDate());
  } else {
    const dateRaw = String(dateValue || '').trim();
    if (!dateRaw) return null;

    let m = dateRaw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (m) {
      baseDate = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    } else {
      m = dateRaw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) {
        baseDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      } else {
        const dt = parseDateTimeLoose(dateRaw);
        if (dt) baseDate = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
      }
    }
  }

  if (!baseDate || isNaN(baseDate.getTime())) return null;

  let hour = 0;
  let minute = 0;

  if (timeValue instanceof Date) {
    hour = timeValue.getHours();
    minute = timeValue.getMinutes();
  } else {
    const timeRaw = String(timeValue || '').trim();
    if (timeRaw) {
      const tm = timeRaw.match(/^(\d{1,2}):(\d{2})$/);
      if (tm) {
        hour = Number(tm[1]);
        minute = Number(tm[2]);
      } else {
        const dt = parseDateTimeLoose(timeRaw);
        if (dt) {
          hour = dt.getHours();
          minute = dt.getMinutes();
        }
      }
    }
  }

  baseDate.setHours(hour, minute, 0, 0);
  return baseDate;
}

function parseDateTimeLoose(value) {
  if (value instanceof Date) {
    const d = new Date(value.getTime());
    return isNaN(d.getTime()) ? null : d;
  }

  const raw = String(value || '').trim();
  if (!raw) return null;

  // ISO
  const iso = new Date(raw);
  if (!isNaN(iso.getTime())) return iso;

  // dd.MM.yyyy HH:mm:ss or dd.MM.yyyy HH:mm
  const m1 = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m1) {
    const day = Number(m1[1]);
    const month = Number(m1[2]) - 1;
    const year = Number(m1[3]);
    const h = Number(m1[4] || 0);
    const m = Number(m1[5] || 0);
    const s = Number(m1[6] || 0);
    const d = new Date(year, month, day, h, m, s, 0);
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
}

function formatDateTime(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm:ss');
}

function formatDate(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd.MM.yyyy');
}

function formatTime(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'HH:mm');
}

/* ---------- Webhook routing ---------- */

function normalizeWebhookUrlToExec(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (value.indexOf('/exec') !== -1) return value;
  if (value.indexOf('/dev') !== -1) return value.replace(/\/dev(?:$|\?)/, '/exec');
  return value;
}

function getCurrentServiceExecUrl() {
  try {
    return normalizeWebhookUrlToExec(ScriptApp.getService().getUrl());
  } catch (err) {
    return '';
  }
}

function resolveWebhookExecUrl(preferredUrl) {
  const preferred = normalizeWebhookUrlToExec(preferredUrl);
  if (preferred) return preferred;

  const stored = normalizeWebhookUrlToExec(PROP.getProperty(WEBAPP_EXEC_URL_PROPERTY));
  if (stored) return stored;

  const service = normalizeWebhookUrlToExec(getCurrentServiceExecUrl());
  if (service) return service;

  return '';
}

function ensureWebhookBoundToCurrentExec(force) {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!token) return { ok: false, reason: 'token_not_set' };

  const targetUrl = resolveWebhookExecUrl('');
  if (!targetUrl) return { ok: false, reason: 'exec_url_not_set' };

  const now = Date.now();
  const lastSync = Number(PROP.getProperty(WEBHOOK_LAST_SYNC_TS_PROPERTY) || '0');
  if (!force && lastSync > 0 && (now - lastSync) < 3 * 60 * 1000) {
    return { ok: true, skipped: true, targetUrl: targetUrl };
  }

  const info = urlFetchJson(`https://api.telegram.org/bot${token}/getWebhookInfo`, { method: 'get' });
  const currentUrl = info && info.result && info.result.url
    ? normalizeWebhookUrlToExec(info.result.url)
    : '';

  if (currentUrl !== targetUrl) {
    const setResp = urlFetchJson(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'post',
      payload: JSON.stringify({
        url: targetUrl,
        allowed_updates: ['message', 'edited_message', 'callback_query']
      })
    });

    if (!setResp || setResp.ok !== true) {
      return { ok: false, reason: 'set_webhook_failed', telegram: setResp || null, targetUrl: targetUrl };
    }
  }

  PROP.setProperty(WEBAPP_EXEC_URL_PROPERTY, targetUrl);
  PROP.setProperty(WEBHOOK_LAST_SYNC_TS_PROPERTY, String(now));

  return { ok: true, targetUrl: targetUrl, currentWebhookUrl: currentUrl, changed: currentUrl !== targetUrl };
}

/* ---------- City/chat resolve ---------- */

function normalizeCityKey(city) {
  return String(city || '').trim().toLowerCase();
}

function resolveTelegramChat(city, fallbackTelegramChannel) {
  const cityKey = normalizeCityKey(city);
  const map = {
    'новосибирск': String(PROP.getProperty('TELEGRAM_CHAT_NOVOSIBIRSK') || '').trim()
  };

  const cityChat = String(map[cityKey] || '').trim();
  const fallback = String(fallbackTelegramChannel || PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim();
  return String(cityChat || fallback || '').trim();
}

/* ---------- Misc helpers ---------- */

function buildMasterName(from) {
  const first = String(from && from.first_name || '').trim();
  const last = String(from && from.last_name || '').trim();
  const username = String(from && from.username || '').trim();

  const full = (first + ' ' + last).trim();
  if (full) return full;
  if (username) return '@' + username;
  return 'Мастер';
}

function normalizeCustomerName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.split(/\s+/)[0];
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

function tryParseJson(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function urlFetchJson(url, options) {
  const params = {
    method: options && options.method ? options.method : 'get',
    contentType: 'application/json',
    payload: options && options.payload ? options.payload : null,
    muteHttpExceptions: true
  };

  const resp = UrlFetchApp.fetch(url, params);
  const text = resp.getContentText();
  try {
    return JSON.parse(text);
  } catch (err) {
    return { ok: false, raw: text };
  }
}

function answerCallback(token, callbackId, text) {
  if (!callbackId) return;
  urlFetchJson(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'post',
    payload: JSON.stringify({
      callback_query_id: callbackId,
      text: String(text || '').slice(0, 200),
      show_alert: false
    })
  });
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj || {}))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------- Diagnostics & setup ---------- */

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
  const out = { ok: missing.length === 0, missing: missing, sheetName: sheet.getName(), buildVersion: BUILD_VERSION };
  Logger.log(JSON.stringify(out));
  return out;
}

function __setSpreadsheetId(spreadsheetId) {
  const id = String(spreadsheetId || '').trim();
  if (!id) throw new Error('Передайте spreadsheetId');
  PROP.setProperty('SPREADSHEET_ID', id);
  const sheet = getSheet();
  const out = { ok: true, spreadsheetId: id, sheetName: sheet.getName(), buildVersion: BUILD_VERSION };
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

function __setWebAppExecUrl(url) {
  const normalized = normalizeWebhookUrlToExec(url) || normalizeWebhookUrlToExec(getCurrentServiceExecUrl());
  if (!normalized) throw new Error('Передайте корректный URL Web App (/exec)');
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

function __setWebhookProd() {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в Script Properties');

  const url = resolveWebhookExecUrl('');
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

function __hardResetBotRouting() {
  return __setWebhookProd();
}

function __getTelegramWebhookInfo() {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в Script Properties');
  const info = urlFetchJson(`https://api.telegram.org/bot${token}/getWebhookInfo`, { method: 'get' });
  const out = { ok: true, buildVersion: BUILD_VERSION, webhookInfo: info };
  Logger.log(JSON.stringify(out));
  return out;
}

function __checkAllButtonReasons(targetUrl) {
  const out = {
    ok: true,
    buildVersion: BUILD_VERSION,
    checkedAt: formatDateTime(new Date()),
    checks: {},
    failures: [],
    warnings: [],
    advice: []
  };

  const pushFailure = function(message, advice) {
    out.ok = false;
    out.failures.push(message);
    if (advice) out.advice.push(advice);
  };
  const pushWarning = function(message, advice) {
    out.warnings.push(message);
    if (advice) out.advice.push(advice);
  };

  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  const spreadsheetId = String(PROP.getProperty('SPREADSHEET_ID') || '').trim();
  const chatNovosibirsk = String(PROP.getProperty('TELEGRAM_CHAT_NOVOSIBIRSK') || '').trim();
  const chatFallback = String(PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim();
  const managerChatId = String(PROP.getProperty('TELEGRAM_MANAGER_CHAT_ID') || '').trim();

  const serviceExecUrl = normalizeWebhookUrlToExec(getCurrentServiceExecUrl());
  const storedExecUrl = normalizeWebhookUrlToExec(PROP.getProperty(WEBAPP_EXEC_URL_PROPERTY));
  const resolvedExecUrl = normalizeWebhookUrlToExec(resolveWebhookExecUrl(targetUrl || ''));

  out.checks.properties = {
    tokenSet: !!token,
    spreadsheetIdSet: !!spreadsheetId,
    telegramChatNovosibirskSet: !!chatNovosibirsk,
    telegramChatFallbackSet: !!chatFallback,
    managerChatIdSet: !!managerChatId
  };
  out.checks.urls = {
    serviceExecUrl: serviceExecUrl || '',
    storedExecUrl: storedExecUrl || '',
    resolvedExecUrl: resolvedExecUrl || ''
  };

  if (!token) {
    pushFailure('TELEGRAM_BOT_TOKEN не задан.', 'Добавьте TELEGRAM_BOT_TOKEN в Script Properties.');
  }
  if (!spreadsheetId) {
    pushFailure('SPREADSHEET_ID не задан.', 'Добавьте SPREADSHEET_ID в Script Properties.');
  }
  if (!chatNovosibirsk && !chatFallback) {
    pushFailure('Не задан chat id для публикации заявок.', 'Добавьте TELEGRAM_CHAT_NOVOSIBIRSK или TELEGRAM_CHAT_ID.');
  }
  if (!resolvedExecUrl) {
    pushFailure('Не удалось определить Web App URL (/exec).', 'Запустите __setWebAppExecUrl("ВАШ_/exec_URL"), затем __setWebhookProd().');
  }
  if (storedExecUrl && serviceExecUrl && storedExecUrl !== serviceExecUrl) {
    pushWarning('stored WEBAPP_EXEC_URL не совпадает с ScriptApp.getService().getUrl().', 'Если кнопка не работает, запустите __setWebhookProd() после правильного деплоя.');
  }

  if (token) {
    const me = urlFetchJson(`https://api.telegram.org/bot${token}/getMe`, { method: 'get' });
    out.checks.telegramGetMe = me;
    if (!me || me.ok !== true || !me.result) {
      pushFailure('Telegram getMe вернул ошибку (токен/бот недоступен).', 'Проверьте TELEGRAM_BOT_TOKEN и запустите __checkAllButtonReasons снова.');
    }

    const webhookInfo = urlFetchJson(`https://api.telegram.org/bot${token}/getWebhookInfo`, { method: 'get' });
    out.checks.webhookInfo = webhookInfo;
    if (!webhookInfo || webhookInfo.ok !== true || !webhookInfo.result) {
      pushFailure('Не удалось получить getWebhookInfo.', 'Проверьте токен и доступность Telegram API.');
    } else {
      const currentWebhookUrl = normalizeWebhookUrlToExec(webhookInfo.result.url);
      const pending = Number(webhookInfo.result.pending_update_count || 0);
      const allowed = webhookInfo.result.allowed_updates || [];
      const hasCallback = Array.isArray(allowed)
        ? allowed.indexOf('callback_query') !== -1
        : String(allowed || '').indexOf('callback_query') !== -1;
      const lastError = String(webhookInfo.result.last_error_message || '').trim();
      const lastErrorDate = Number(webhookInfo.result.last_error_date || 0);

      out.checks.webhookNormalized = {
        currentWebhookUrl: currentWebhookUrl || '',
        expectedWebhookUrl: resolvedExecUrl || '',
        pendingUpdateCount: pending,
        allowedUpdates: allowed,
        hasCallbackQuery: hasCallback,
        lastErrorMessage: lastError || '',
        lastErrorDate: lastErrorDate || 0
      };

      if (!currentWebhookUrl) {
        pushFailure('Webhook в Telegram не установлен.', 'Запустите __setWebhookProd().');
      } else if (resolvedExecUrl && currentWebhookUrl !== resolvedExecUrl) {
        pushFailure('Webhook указывает не на этот /exec URL.', 'Запустите __setWebhookProd() в текущем проекте.');
      }

      if (!hasCallback) {
        pushFailure('В webhook не включен callback_query.', 'Запустите __setWebhookProd(), он задаст allowed_updates корректно.');
      }

      if (pending > 0) {
        pushWarning('У webhook есть pending updates: ' + pending + '.', 'Обычно это временно. Если долго не уходит, запустите __setWebhookProd().');
      }

      if (lastError) {
        pushWarning('Telegram сообщает last_error_message: ' + lastError, 'После исправлений нажмите кнопку и снова запустите __checkAllButtonReasons().');
      }
    }
  }

  if (resolvedExecUrl) {
    const health = checkWebAppPublicHealth(resolvedExecUrl);
    out.checks.webAppHealth = health;
    if (!health.ok || health.statusCode !== 200 || health.bodyJsonOk !== true) {
      pushFailure(
        'Web App health-check неуспешен (внешний GET /?health=1).',
        'Переразверните Web App: "Выполнять от моего имени", "Доступ: Все".'
      );
    }

    const probe = __probeWebhookDoPostVersion(resolvedExecUrl);
    out.checks.doPostProbe = probe;
    if (!probe || probe.ok !== true) {
      pushFailure(
        'Внешний POST до doPost неуспешен.',
        'Проверьте публичность Web App и что используется URL именно с /exec.'
      );
    } else {
      const body = probe.bodyJson || {};
      const action = String(body.action || '').trim();
      const probeBuild = String(body.buildVersion || '').trim();
      const probeError = String(body.error || '').trim();

      if (action !== 'probe_version' || body.ok !== true) {
        pushFailure(
          'doPost ответил не на probe_version (возможен старый код/другой деплой).',
          'Проверьте, что frontend и webhook смотрят на один и тот же /exec URL.'
        );
      }
      if (probeBuild && probeBuild !== BUILD_VERSION) {
        pushFailure(
          'doPost вернул другой buildVersion: ' + probeBuild,
          'Вызывается не текущая версия скрипта. Переразверните Web App и заново запустите __setWebhookProd().'
        );
      }
      if (probeError && probeError.toLowerCase().indexOf('unknown action') !== -1) {
        pushFailure(
          'doPost вернул unknown action на probe_version.',
          'Это почти всегда признак старого/чужого backend URL.'
        );
      }
    }
  }

  const parserSamples = [
    'take:CLN-12345678',
    'take_CLN-12345678',
    'take|CLN-12345678',
    '{"action":"take","orderId":"CLN-12345678"}'
  ];
  const parserChecks = [];
  for (let i = 0; i < parserSamples.length; i++) {
    const sample = parserSamples[i];
    const parsed = parseCallbackActionData(sample);
    parserChecks.push({ sample: sample, parsed: parsed });
    if (!parsed || parsed.action !== CALLBACK_ACTIONS.TAKE || parsed.orderId !== 'CLN-12345678') {
      pushFailure('parseCallbackActionData не проходит self-test для: ' + sample, 'Проверьте parseCallbackActionData в текущей версии кода.');
    }
  }
  out.checks.callbackParser = parserChecks;

  if (!out.failures.length) {
    out.advice.push('Критических проблем не найдено. Если кнопка не реагирует, нажмите кнопку и сразу запустите __getTelegramWebhookInfo() и __checkAllButtonReasons() повторно.');
  }

  Logger.log(JSON.stringify(out));
  return out;
}

function checkWebAppPublicHealth(execUrl) {
  const url = normalizeWebhookUrlToExec(execUrl);
  if (!url) {
    return { ok: false, statusCode: 0, bodyJsonOk: false, error: 'empty url', url: '' };
  }

  const healthUrl = url + (url.indexOf('?') === -1 ? '?health=1' : '&health=1');
  try {
    const resp = UrlFetchApp.fetch(healthUrl, {
      method: 'get',
      muteHttpExceptions: true,
      followRedirects: true
    });
    const statusCode = resp.getResponseCode();
    const text = String(resp.getContentText() || '');
    let bodyJson = null;
    try { bodyJson = JSON.parse(text); } catch (err) {}

    return {
      ok: statusCode >= 200 && statusCode < 300,
      url: healthUrl,
      statusCode: statusCode,
      bodyJsonOk: !!(bodyJson && bodyJson.ok === true),
      bodyJson: bodyJson,
      bodySnippet: text.slice(0, 300)
    };
  } catch (err) {
    return {
      ok: false,
      url: healthUrl,
      statusCode: 0,
      bodyJsonOk: false,
      error: err.message
    };
  }
}

function __deleteTelegramWebhook() {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в Script Properties');
  const resp = urlFetchJson(`https://api.telegram.org/bot${token}/deleteWebhook`, {
    method: 'post',
    payload: JSON.stringify({ drop_pending_updates: true })
  });
  Logger.log(JSON.stringify(resp));
  return resp;
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

    const code = resp.getResponseCode();
    const bodyText = resp.getContentText() || '';
    let bodyJson = null;
    try { bodyJson = JSON.parse(bodyText); } catch (err) {}

    const out = {
      ok: code >= 200 && code < 300,
      statusCode: code,
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
  const chat = String(PROP.getProperty('TELEGRAM_CHAT_NOVOSIBIRSK') || PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан');
  if (!chat) throw new Error('TELEGRAM_CHAT_NOVOSIBIRSK/TELEGRAM_CHAT_ID не задан');

  const resp = urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify({ chat_id: chat, text: '✅ Тест Telegram из Apps Script' })
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
    customerFlat: '1',
    orderDate: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM.yyyy'),
    orderTime: '12:00',
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
