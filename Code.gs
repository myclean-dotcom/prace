// Apex Clean - clean Google Apps Script backend
// Authoritative source file for Apps Script.

const BUILD_VERSION = '2026-04-23-gas-clean-v2';
const BACKEND_API_SIGNATURE = 'apex-clean-gas-clean-v2';

const PROP = PropertiesService.getScriptProperties();
const SHEET_NAME = 'Заявки';

const WEBAPP_EXEC_URL_PROPERTY = 'WEBAPP_EXEC_URL';
const TELEGRAM_RUNTIME_MODE_PROPERTY = 'TELEGRAM_RUNTIME_MODE';
const WEBHOOK_LAST_SYNC_TS_PROPERTY = 'WEBHOOK_LAST_SYNC_TS';

const CALLBACK_CACHE_TTL_SECONDS = 600;
const MANAGER_PENDING_PAY_PREFIX = 'MANAGER_PENDING_PAY_';
const MANAGER_PENDING_PAY_TTL_MS = 60 * 60 * 1000;
const ORDER_DM_SENT_PREFIX = 'ORDER_DM_SENT_';
const ORDER_DM_META_PREFIX = 'ORDER_DM_META_';

const CALLBACK_ACTIONS = {
  TAKE: 'take',
  ARRIVE: 'arrive',
  DONE: 'done',
  PAID: 'paid',
  CANCEL: 'cancel',
  MANAGER_PAY: 'managerpay',
  TEST: 'test'
};

const ORDER_STATUSES = {
  PUBLISHED: 'Опубликована',
  TAKEN: 'Взята',
  ARRIVED: 'На объекте',
  WAITING_PAYMENT: 'Ожидает оплаты',
  DONE: 'Завершена'
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

function getTelegramRuntimeMode() {
  const raw = String(PROP.getProperty(TELEGRAM_RUNTIME_MODE_PROPERTY) || '').trim().toLowerCase();
  if (raw === 'direct') return 'direct';
  return 'apps_script';
}

function isDirectTelegramRuntime() {
  return getTelegramRuntimeMode() === 'direct';
}

function getManagerChatId() {
  return String(PROP.getProperty('TELEGRAM_MANAGER_CHAT_ID') || '').trim();
}

function getEventsChatId() {
  return String(PROP.getProperty('TELEGRAM_EVENTS_CHAT_ID') || getManagerChatId() || '').trim();
}

function getTelegramBotToken() {
  return String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
}

function scriptTimeZone() {
  try {
    return Session.getScriptTimeZone() || 'Asia/Novosibirsk';
  } catch (err) {
    return 'Asia/Novosibirsk';
  }
}

/* ---------- Entry points ---------- */

function doGet(e) {
  try {
    const isHealth = e && e.parameter && String(e.parameter.health || '') === '1';
    if (isHealth) {
      return jsonResponse({
        ok: true,
        info: 'webapp active',
        buildVersion: BUILD_VERSION,
        apiSignature: BACKEND_API_SIGNATURE,
        execUrl: resolveWebhookExecUrl(''),
        runtimeMode: getTelegramRuntimeMode()
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
    return jsonResponse({
      ok: false,
      error: err.message,
      buildVersion: BUILD_VERSION,
      apiSignature: BACKEND_API_SIGNATURE
    });
  }
}

function doPost(e) {
  try {
    const body = parseIncomingBody(e || {});
    try { Logger.log('doPost body: ' + JSON.stringify(body)); } catch (logErr) {}

    if (body.callback_query || body.message || body.edited_message) {
      if (isDirectTelegramRuntime()) {
        return jsonResponse({
          ok: true,
          ignored: true,
          reason: 'direct_telegram_runtime_enabled',
          buildVersion: BUILD_VERSION,
          apiSignature: BACKEND_API_SIGNATURE
        });
      }
      return handleTelegramUpdate(body);
    }

    const action = String(body.action || '').trim().toLowerCase();

    if (action === 'probe_version') {
      return jsonResponse({
        ok: true,
        action: 'probe_version',
        buildVersion: BUILD_VERSION,
        apiSignature: BACKEND_API_SIGNATURE
      });
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
      keys: Object.keys(body || {}),
      buildVersion: BUILD_VERSION,
      apiSignature: BACKEND_API_SIGNATURE
    });
  } catch (err) {
    Logger.log('doPost error: ' + err.message + '\n' + (err.stack || ''));
    return jsonResponse({
      ok: false,
      error: err.message,
      buildVersion: BUILD_VERSION,
      apiSignature: BACKEND_API_SIGNATURE
    });
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
    const pair = pairs[i];
    if (!pair) continue;

    const eq = pair.indexOf('=');
    const key = eq >= 0 ? pair.slice(0, eq) : pair;
    const val = eq >= 0 ? pair.slice(eq + 1) : '';
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

function pickPayloadValue(payload, keys, fallback) {
  const source = payload || {};
  const list = Array.isArray(keys) ? keys : [keys];

  for (let i = 0; i < list.length; i++) {
    const key = String(list[i] || '').trim();
    if (!key) continue;
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;

    const value = source[key];
    if (value === null || value === undefined) continue;

    if (Array.isArray(value)) {
      const joined = value.map(function(item) {
        return String(item || '').trim();
      }).filter(Boolean).join(', ');
      if (joined) return joined;
      continue;
    }

    const text = String(value).trim();
    if (text) return text;
  }

  return String(fallback || '').trim();
}

/* ---------- Bot health ---------- */

function checkTelegramBotStatus() {
  const runtimeMode = getTelegramRuntimeMode();
  const token = getTelegramBotToken();
  if (!token) {
    return jsonResponse({
      ok: false,
      error: 'TELEGRAM_BOT_TOKEN не задан',
      buildVersion: BUILD_VERSION,
      apiSignature: BACKEND_API_SIGNATURE,
      runtimeMode: runtimeMode
    });
  }

  const resp = urlFetchJson('https://api.telegram.org/bot' + token + '/getMe', { method: 'get' });
  if (!resp || resp.ok !== true || !resp.result) {
    return jsonResponse({
      ok: false,
      error: (resp && (resp.description || resp.error || resp.note)) || 'Ошибка проверки бота',
      telegram: resp || null,
      buildVersion: BUILD_VERSION,
      apiSignature: BACKEND_API_SIGNATURE,
      runtimeMode: runtimeMode
    });
  }

  return jsonResponse({
    ok: true,
    bot: {
      id: resp.result.id,
      username: resp.result.username || '',
      first_name: resp.result.first_name || ''
    },
    buildVersion: BUILD_VERSION,
    apiSignature: BACKEND_API_SIGNATURE,
    runtimeMode: runtimeMode,
    capabilities: {
      briefEquipmentInGroup: true,
      managerBotCommands: runtimeMode !== 'direct'
    }
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
    throw new Error('Не удалось открыть таблицу. Укажите Script Property SPREADSHEET_ID или используйте bound-скрипт.');
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

  const currentHeaders = sheet.getRange(1, 1, 1, width).getValues()[0].map(function(value) {
    return String(value || '').trim();
  });

  const missing = REQUIRED_HEADERS.filter(function(header) {
    return currentHeaders.indexOf(header) === -1;
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
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function(header) {
    return String(header || '').trim();
  });

  const row = headers.map(function(header) {
    return Object.prototype.hasOwnProperty.call(rowData, header) ? rowData[header] : '';
  });

  sheet.appendRow(row);
}

function setCellByHeader(sheet, rowNum, headerMap, headerName, value) {
  const col = headerMap[headerName];
  if (!col) return;
  sheet.getRange(rowNum, col).setValue(value);
}

function patchRowByHeaders(sheet, rowNum, headerMap, patch) {
  const width = sheet.getLastColumn();
  const row = sheet.getRange(rowNum, 1, 1, width).getValues()[0];
  const keys = Object.keys(patch || {});

  for (let i = 0; i < keys.length; i++) {
    const header = keys[i];
    const col = headerMap[header];
    if (!col) continue;
    row[col - 1] = patch[header];
  }

  sheet.getRange(rowNum, 1, 1, width).setValues([row]);
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
    const currentId = String(idValues[i][0] || '').trim();
    const status = String(statusValues[i][0] || '').toLowerCase().trim();
    if (currentId !== target) continue;
    if (
      status.indexOf('взята') === -1 &&
      status.indexOf('на объекте') === -1 &&
      status.indexOf('ожидает оплат') === -1
    ) continue;
    return i + 2;
  }

  return null;
}

function getOrderByRow(rowNum) {
  const sheet = getSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function(header) {
    return String(header || '').trim();
  });
  const values = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];

  const out = {};
  for (let i = 0; i < headers.length; i++) {
    if (headers[i]) out[headers[i]] = values[i];
  }
  return out;
}

/* ---------- Create/update order ---------- */

function createOrUpdateOrder(payload, action) {
  const orderId = normalizeOrderId(payload.orderId) || ('CLN-' + Date.now().toString().slice(-8));

  const order = {
    orderId: orderId,
    createdAt: normalizeCreatedAtValue(pickPayloadValue(payload, ['createdAt', '_ts', 'Дата создания'], new Date())),
    manager: pickPayloadValue(payload, ['manager', 'Менеджер'], ''),
    customerName: normalizeCustomerName(pickPayloadValue(payload, ['customerName', 'Имя клиента'], '')),
    customerPhone: pickPayloadValue(payload, ['customerPhone', 'Телефон клиента'], ''),
    customerCity: pickPayloadValue(payload, ['customerCity', 'Город'], ''),
    customerAddress: pickPayloadValue(payload, ['customerAddress', 'Улица и дом'], ''),
    customerFlat: pickPayloadValue(payload, ['customerFlat', 'Квартира/офис'], ''),
    orderDate: normalizeOrderDateValue(pickPayloadValue(payload, ['orderDate', 'Дата уборки'], '')),
    orderTime: normalizeOrderTimeValue(pickPayloadValue(payload, ['orderTime', 'Время уборки'], '')),
    orderTotal: pickPayloadValue(payload, ['orderTotal', 'Сумма заказа'], '0'),
    masterPay: pickPayloadValue(payload, ['masterPay', 'Зарплата мастерам'], '0'),
    cleaningType: pickPayloadValue(payload, ['cleaningType', 'Тип уборки'], ''),
    area: pickPayloadValue(payload, ['area', 'Площадь (м²)'], ''),
    chemistry: pickPayloadValue(payload, ['chemistry', 'Химия', 'chemistry[]'], 'Не указано'),
    equipment: pickPayloadValue(payload, ['equipment', 'Оборудование', 'equipment[]'], 'Не указано'),
    worksDescription: pickPayloadValue(payload, ['worksDescription', 'Описание работ'], '')
  };

  const sheet = getSheet();

  if (String(action || '').trim() === 'update') {
    const existingRow = findOrderRowById(orderId);
    if (existingRow) {
      updateOrderRow(existingRow, order);
      return jsonResponse({ ok: true, updated: true, orderId: orderId, buildVersion: BUILD_VERSION });
    }
  }

  appendOrderRow(sheet, buildOrderRowData(order, ORDER_STATUSES.PUBLISHED));
  clearOrderDmSent(orderId);

  try {
    ensureWebhookBoundToCurrentExec(false);
  } catch (err) {
    Logger.log('ensureWebhookBoundToCurrentExec failed: ' + err.message);
  }

  const appendedRow = findOrderRowById(orderId);
  const orderForPublish = appendedRow ? mapSheetOrderToOrderModel(getOrderByRow(appendedRow)) : order;
  const publish = sendOrderToGroup(orderForPublish, payload.telegramChannel);

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
    'Химия': String(order.chemistry || 'Не указано').trim(),
    'Оборудование': String(order.equipment || 'Не указано').trim(),
    'Описание работ': String(order.worksDescription || '').trim(),
    'Статус': String(status || '').trim(),
    'Telegram Chat ID': '',
    'Telegram Message ID': '',
    'Master ID': '',
    'Master Name': '',
    'Дата принятия': '',
    'Дата прибытия': '',
    'Дата завершения': '',
    'Дата оплаты': '',
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
  const token = getTelegramBotToken();
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

  const resp = urlFetchJson('https://api.telegram.org/bot' + token + '/sendMessage', {
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
    chatId: String(chatId || '').trim(),
    messageId: String(resp.result.message_id || '').trim(),
    telegram: resp
  };
}

/* ---------- Telegram updates & callbacks ---------- */

function handleTelegramUpdate(body) {
  const token = getTelegramBotToken();
  if (!token) return jsonResponse({ ok: false, error: 'Token not set', buildVersion: BUILD_VERSION });

  try {
    if (body.callback_query) {
      return handleCallbackQuery(body.callback_query, token);
    }

    if (body.message && body.message.from && (body.message.photo || body.message.document)) {
      const managerAttachment = handleManagerPaymentAttachmentMessage(body.message, token);
      if (managerAttachment && managerAttachment.handled) {
        return jsonResponse({ ok: true, managerAttachment: managerAttachment, buildVersion: BUILD_VERSION });
      }
    }

    if (body.message && body.message.photo && body.message.from) {
      return handleMasterPhotoMessage(body.message, token);
    }

    if (body.message && body.message.text) {
      return handleTextMessage(body.message, token);
    }

    if (body.message && body.message.chat && body.message.chat.id) {
      const chatType = String(body.message.chat.type || '').trim();
      if ((chatType === 'group' || chatType === 'supergroup') && !String(PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim()) {
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

  if (parsed.action === CALLBACK_ACTIONS.TEST) {
    answerCallback(token, callbackId, '✅ Callback работает');
    return jsonResponse({
      ok: true,
      action: CALLBACK_ACTIONS.TEST,
      orderId: normalizeOrderId(parsed.orderId || ''),
      buildVersion: BUILD_VERSION
    });
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(700)) {
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

    if (parsed.action === CALLBACK_ACTIONS.MANAGER_PAY) {
      return handleManagerPayAction({
        token: token,
        callbackId: callbackId,
        cbChatId: cbChatId,
        rowNum: rowNum,
        order: order,
        orderId: orderId,
        managerId: masterId
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

    if (parsed.action === CALLBACK_ACTIONS.PAID) {
      return handlePaidAction({
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
  const statusLower = String(ctx.statusLower || '').toLowerCase();
  const currentMasterId = String(ctx.currentMasterId || '').trim();
  const masterId = String(ctx.masterId || '').trim();

  if (statusLower.indexOf('заверш') !== -1) {
    answerCallback(ctx.token, ctx.callbackId, '❌ Заявка уже завершена');
    return jsonResponse({ ok: true, alreadyDone: true, buildVersion: BUILD_VERSION });
  }

  if (statusLower.indexOf('взята') !== -1 || statusLower.indexOf('на объекте') !== -1 || statusLower.indexOf('ожидает оплат') !== -1) {
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

  const dm = sendMasterOrderPackage(ctx.token, masterId, ctx.orderId, updatedOrder);
  if (!dm.ok) {
    resetOrderToPublishedByRow(ctx.rowNum, 'Не удалось отправить мастеру в ЛС');
    clearOrderDmSent(ctx.orderId);
    answerCallback(ctx.token, ctx.callbackId, '❌ Откройте личный чат с ботом и нажмите /start');
    return jsonResponse({
      ok: false,
      error: 'master_dm_failed',
      orderId: ctx.orderId,
      telegram: dm.telegram || null,
      buildVersion: BUILD_VERSION
    });
  }

  answerCallback(ctx.token, ctx.callbackId, '✅ Заявка принята. Подробности отправлены в личные сообщения.');
  clearGroupTakeButton(ctx.token, updatedOrder, ctx.cbChatId, ctx.cbMessageId);
  notifyManagerOrderTaken(updatedOrder, ctx.masterName, takenAt);

  return jsonResponse({
    ok: true,
    action: CALLBACK_ACTIONS.TAKE,
    orderId: ctx.orderId,
    buildVersion: BUILD_VERSION
  });
}

function handleManagerPayAction(ctx) {
  const managerId = String(ctx.managerId || ctx.cbChatId || '').trim();
  const orderId = normalizeOrderId(ctx.orderId);
  if (!managerId || !orderId) {
    answerCallback(ctx.token, ctx.callbackId, '❌ Не удалось определить заявку');
    return jsonResponse({ ok: false, error: 'manager pay context invalid', buildVersion: BUILD_VERSION });
  }

  if (!isManagerContext(managerId, ctx.cbChatId)) {
    answerCallback(ctx.token, ctx.callbackId, '❌ Только менеджер может использовать эту кнопку');
    return jsonResponse({ ok: true, denied: true, action: CALLBACK_ACTIONS.MANAGER_PAY, buildVersion: BUILD_VERSION });
  }

  setManagerPendingPaymentInput(managerId, orderId);
  answerCallback(ctx.token, ctx.callbackId, '✅ Отправьте ссылку и QR следующим сообщением');
  sendBotTextMessage(
    ctx.token,
    ctx.cbChatId,
    [
      '🧾 Заявка: ' + orderId,
      'Отправьте одним сообщением:',
      '',
      'Ссылка: https://ваша-ссылка',
      'QR: https://ссылка-на-qr-или-текст'
    ].join('\n'),
    false,
    buildManagerPanelKeyboard()
  );

  return jsonResponse({
    ok: true,
    action: CALLBACK_ACTIONS.MANAGER_PAY,
    orderId: orderId,
    buildVersion: BUILD_VERSION
  });
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

  return jsonResponse({
    ok: true,
    action: CALLBACK_ACTIONS.ARRIVE,
    orderId: ctx.orderId,
    buildVersion: BUILD_VERSION
  });
}

function handleDoneAction(ctx) {
  if (!isOrderAssignedToMaster(ctx.statusLower, ctx.currentMasterId, ctx.masterId)) {
    answerCallback(ctx.token, ctx.callbackId, '❌ Только назначенный мастер может завершить заявку');
    return jsonResponse({ ok: true, denied: true, action: CALLBACK_ACTIONS.DONE, buildVersion: BUILD_VERSION });
  }

  const doneAt = formatDateTime(new Date());
  updateOrderDoneByRow(ctx.rowNum, doneAt);
  const updatedOrder = getOrderByRow(ctx.rowNum);

  answerCallback(ctx.token, ctx.callbackId, '✅ Работы завершены. Подтвердите оплату кнопкой.');
  updateMasterActionMessageAfterDone(ctx.token, ctx.cbChatId, ctx.cbMessageId, ctx.orderId);
  notifyManagerOrderDone(updatedOrder, ctx.masterName, doneAt);

  return jsonResponse({
    ok: true,
    action: CALLBACK_ACTIONS.DONE,
    orderId: ctx.orderId,
    buildVersion: BUILD_VERSION
  });
}

function handlePaidAction(ctx) {
  if (!ctx.currentMasterId || String(ctx.currentMasterId).trim() !== String(ctx.masterId).trim()) {
    answerCallback(ctx.token, ctx.callbackId, '❌ Только назначенный мастер может подтвердить оплату');
    return jsonResponse({ ok: true, denied: true, action: CALLBACK_ACTIONS.PAID, buildVersion: BUILD_VERSION });
  }

  const statusLower = String(ctx.statusLower || '').toLowerCase();
  if (statusLower.indexOf('ожидает оплат') === -1 && statusLower.indexOf('на объекте') === -1 && statusLower.indexOf('взята') === -1) {
    answerCallback(ctx.token, ctx.callbackId, 'ℹ️ Для этой заявки оплата уже подтверждена');
    return jsonResponse({ ok: true, alreadyPaid: true, action: CALLBACK_ACTIONS.PAID, buildVersion: BUILD_VERSION });
  }

  const paidAt = formatDateTime(new Date());
  updateOrderPaidByRow(ctx.rowNum, paidAt);
  const updatedOrder = getOrderByRow(ctx.rowNum);

  answerCallback(ctx.token, ctx.callbackId, '✅ Оплата подтверждена');
  clearMasterActionMessage(ctx.token, ctx.cbChatId, ctx.cbMessageId);
  notifyManagerPaymentConfirmed(updatedOrder, ctx.masterName, paidAt);

  return jsonResponse({
    ok: true,
    action: CALLBACK_ACTIONS.PAID,
    orderId: ctx.orderId,
    buildVersion: BUILD_VERSION
  });
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
  if (isOrderDmAlreadySent(orderId, masterId)) {
    return { ok: true, already: true };
  }

  const fullText = generateFullText(orderRow);
  const resp = urlFetchJson('https://api.telegram.org/bot' + token + '/sendMessage', {
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
    return { ok: false, telegram: resp || null };
  }

  markOrderDmSent(orderId, masterId, [String(resp.result.message_id || '')]);
  return { ok: true, messageId: String(resp.result.message_id || '') };
}

function clearGroupTakeButton(token, orderRow, fallbackChatId, fallbackMessageId) {
  const chatId = String(orderRow['Telegram Chat ID'] || fallbackChatId || '').trim();
  const messageId = String(orderRow['Telegram Message ID'] || fallbackMessageId || '').trim();
  if (!chatId || !messageId) return;

  urlFetchJson('https://api.telegram.org/bot' + token + '/editMessageReplyMarkup', {
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

  urlFetchJson('https://api.telegram.org/bot' + token + '/editMessageReplyMarkup', {
    method: 'post',
    payload: JSON.stringify({
      chat_id: chat,
      message_id: Number(msg),
      reply_markup: buildMasterActionKeyboardAfterArrive(orderId)
    })
  });
}

function updateMasterActionMessageAfterDone(token, chatId, messageId, orderId) {
  const chat = String(chatId || '').trim();
  const msg = String(messageId || '').trim();
  if (!chat || !msg) return;

  urlFetchJson('https://api.telegram.org/bot' + token + '/editMessageReplyMarkup', {
    method: 'post',
    payload: JSON.stringify({
      chat_id: chat,
      message_id: Number(msg),
      reply_markup: buildMasterActionKeyboardAfterDone(orderId)
    })
  });
}

function clearMasterActionMessage(token, chatId, messageId) {
  const chat = String(chatId || '').trim();
  const msg = String(messageId || '').trim();
  if (!chat || !msg) return;

  urlFetchJson('https://api.telegram.org/bot' + token + '/editMessageReplyMarkup', {
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

  const del = urlFetchJson('https://api.telegram.org/bot' + token + '/deleteMessage', {
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

function makeCallbackData(action, orderId) {
  const normalizedAction = String(action || '').trim().toLowerCase();
  const normalizedOrderId = normalizeOrderId(orderId);
  if (!normalizedAction || !normalizedOrderId) return '';
  return normalizedAction + ':' + normalizedOrderId;
}

function parseCallbackActionData(data) {
  const raw = normalizeCallbackRawData(data);
  if (!raw) return null;

  const strict = raw.match(/^(take|arrive|done|paid|cancel|managerpay|test):(.+)$/i);
  if (strict) {
    const action = String(strict[1] || '').trim().toLowerCase();
    const orderId = normalizeOrderId(strict[2]);
    return (action && orderId) ? { action: action, orderId: orderId } : null;
  }

  const vPipe = raw.match(/^(take|arrive|done|paid|cancel|managerpay|test)\|(.+)$/i);
  if (vPipe) {
    const action = String(vPipe[1] || '').trim().toLowerCase();
    const orderId = normalizeOrderId(vPipe[2]);
    return (action && orderId) ? { action: action, orderId: orderId } : null;
  }

  const vUnderscore = raw.match(/^(take|arrive|done|paid|cancel|managerpay|test)_(.+)$/i);
  if (vUnderscore) {
    const action = String(vUnderscore[1] || '').trim().toLowerCase();
    const orderId = normalizeOrderId(vUnderscore[2]);
    return (action && orderId) ? { action: action, orderId: orderId } : null;
  }

  const onlyAction = raw.match(/^(take|arrive|done|paid|cancel|managerpay|test)$/i);
  if (onlyAction) {
    return { action: String(onlyAction[1] || '').toLowerCase(), orderId: '' };
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
        const orderId = normalizeOrderId(obj.orderId || obj.id || '');
        if (action && orderId) return action + ':' + orderId;
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

  const found = text.match(/(?:№|#)\s*([A-Za-z]{2,8}-\d{5,})/i);
  if (found && found[1]) return String(found[1]).toUpperCase();

  const any = text.match(/([A-Za-z]{2,8}-\d{5,})/i);
  return any && any[1] ? String(any[1]).toUpperCase() : '';
}

function normalizeNumericString(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function resolveRowForCallback(parsed, message, chatId, messageId) {
  const parsedId = normalizeOrderId(parsed && parsed.orderId);
  if (parsedId) {
    const rowByParsedId = findOrderRowById(parsedId);
    if (rowByParsedId) return rowByParsedId;
  }

  const textId = extractOrderIdFromTelegramMessage(message);
  if (textId) {
    const rowByTextId = findOrderRowById(textId);
    if (rowByTextId) return rowByTextId;
  }

  const rowByTelegram = findOrderRowByTelegramMessage(chatId, messageId);
  if (rowByTelegram) return rowByTelegram;

  return null;
}

function isDuplicateCallback(callbackId) {
  const id = String(callbackId || '').trim();
  if (!id) return false;

  const cache = CacheService.getScriptCache();
  const key = 'cbq_' + id;
  if (cache.get(key)) return true;

  cache.put(key, '1', CALLBACK_CACHE_TTL_SECONDS);
  return false;
}

function isOrderDmAlreadySent(orderId, masterId) {
  const id = normalizeOrderId(orderId);
  const master = String(masterId || '').trim();
  if (!id || !master) return false;
  return String(PROP.getProperty(ORDER_DM_SENT_PREFIX + id) || '').trim() === master;
}

function markOrderDmSent(orderId, masterId, messageIds) {
  const id = normalizeOrderId(orderId);
  const master = String(masterId || '').trim();
  if (!id || !master) return;

  PROP.setProperty(ORDER_DM_SENT_PREFIX + id, master);
  PROP.setProperty(ORDER_DM_META_PREFIX + id, JSON.stringify({
    masterId: master,
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

function setManagerPendingPaymentInput(managerId, orderId) {
  const mid = String(managerId || '').trim();
  const oid = normalizeOrderId(orderId);
  if (!mid || !oid) return;
  PROP.setProperty(MANAGER_PENDING_PAY_PREFIX + mid, JSON.stringify({
    orderId: oid,
    ts: Date.now()
  }));
}

function getManagerPendingPaymentInput(managerId) {
  const mid = String(managerId || '').trim();
  if (!mid) return null;
  const raw = String(PROP.getProperty(MANAGER_PENDING_PAY_PREFIX + mid) || '').trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    const ts = Number(parsed.ts || 0);
    const orderId = normalizeOrderId(parsed.orderId || '');
    if (!orderId) return null;
    if (!ts || (Date.now() - ts) > MANAGER_PENDING_PAY_TTL_MS) {
      clearManagerPendingPaymentInput(mid);
      return null;
    }
    return { orderId: orderId, ts: ts };
  } catch (err) {
    clearManagerPendingPaymentInput(mid);
    return null;
  }
}

function clearManagerPendingPaymentInput(managerId) {
  const mid = String(managerId || '').trim();
  if (!mid) return;
  PROP.deleteProperty(MANAGER_PENDING_PAY_PREFIX + mid);
}

/* ---------- Status helpers ---------- */

function updateOrderTakenByRow(rowNum, masterId, masterName, takenAt) {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  patchRowByHeaders(sheet, rowNum, map, {
    'Статус': ORDER_STATUSES.TAKEN,
    'Master ID': String(masterId || '').trim(),
    'Master Name': String(masterName || '').trim(),
    'Дата принятия': String(takenAt || '').trim(),
    'Дата прибытия': '',
    'Дата завершения': '',
    'Дата оплаты': '',
    'Напоминание 24ч': '',
    'Напоминание 2ч': '',
    'Статус выполнения': 'Заявка принята: ' + String(takenAt || '').trim()
  });
}

function resetOrderToPublishedByRow(rowNum, note) {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  patchRowByHeaders(sheet, rowNum, map, {
    'Статус': ORDER_STATUSES.PUBLISHED,
    'Master ID': '',
    'Master Name': '',
    'Дата принятия': '',
    'Дата прибытия': '',
    'Дата завершения': '',
    'Дата оплаты': '',
    'Напоминание 24ч': '',
    'Напоминание 2ч': '',
    'Статус выполнения': String(note || 'Заявка возвращена в публикацию')
  });
}

function updateOrderArrivedByRow(rowNum, arrivedAt) {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  patchRowByHeaders(sheet, rowNum, map, {
    'Статус': ORDER_STATUSES.ARRIVED,
    'Дата прибытия': String(arrivedAt || '').trim(),
    'Статус выполнения': 'Прибыл на объект: ' + String(arrivedAt || '').trim()
  });
}

function updateOrderDoneByRow(rowNum, doneAt) {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  patchRowByHeaders(sheet, rowNum, map, {
    'Статус': ORDER_STATUSES.WAITING_PAYMENT,
    'Дата завершения': String(doneAt || '').trim(),
    'Статус выполнения': 'Работы завершены: ' + String(doneAt || '').trim()
  });
}

function updateOrderPaidByRow(rowNum, paidAt) {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  patchRowByHeaders(sheet, rowNum, map, {
    'Статус': ORDER_STATUSES.DONE,
    'Дата оплаты': String(paidAt || '').trim(),
    'Статус выполнения': 'Оплата подтверждена: ' + String(paidAt || '').trim()
  });
}

function updateOrderCancelledByRow(rowNum, masterName, cancelledAt) {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const cleanMasterName = String(masterName || '').trim() || 'Мастер';
  const cleanCancelledAt = String(cancelledAt || '').trim();

  patchRowByHeaders(sheet, rowNum, map, {
    'Статус': ORDER_STATUSES.PUBLISHED,
    'Master ID': '',
    'Master Name': '',
    'Дата принятия': '',
    'Дата прибытия': '',
    'Дата завершения': '',
    'Дата оплаты': '',
    'Напоминание 24ч': '',
    'Напоминание 2ч': '',
    'Статус выполнения': 'Отменена мастером ' + cleanMasterName + ': ' + cleanCancelledAt
  });
}

function isOrderAssignedToMaster(statusLower, currentMasterId, masterId) {
  const status = String(statusLower || '').toLowerCase();
  const current = String(currentMasterId || '').trim();
  const master = String(masterId || '').trim();
  if (!current || !master) return false;
  if (current !== master) return false;
  return (
    status.indexOf('взята') !== -1 ||
    status.indexOf('на объекте') !== -1 ||
    status.indexOf('ожидает оплат') !== -1
  );
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

/* ---------- Telegram texts ---------- */

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

function buildMasterActionKeyboardAfterDone(orderId) {
  return {
    inline_keyboard: [
      [{ text: '💳 ОПЛАТА ПОЛУЧЕНА', callback_data: makeCallbackData(CALLBACK_ACTIONS.PAID, orderId) }]
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
  const equipment = escapeTelegramHtml(String(order.equipment || '').trim() || 'Не указано');
  const chemistry = escapeTelegramHtml(String(order.chemistry || '').trim() || 'Не указано');

  let text = '🧹 <b>ЗАЯВКА №' + escapeTelegramHtml(order.orderId || '') + '</b>\n';
  text += '───────────────────\n';
  text += '📍 Город: ' + city + '\n';
  text += '🧽 Вид уборки: ' + type + '\n';
  text += '📐 Площадь: ' + area + ' м²\n';
  text += '🗓 Дата и время: ' + dateTime + '\n';
  text += '💰 Оплата мастеру: ' + pay + ' руб\n';
  text += '📍 Улица: ' + streetOnly + '\n';
  text += '🧰 Оборудование: ' + equipment + '\n';
  text += '🧪 Химия: ' + chemistry + '\n';

  if (String(order.worksDescription || '').trim()) {
    text += '\n📝 Дополнительное описание: ' + escapeTelegramHtml(order.worksDescription) + '\n';
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
  const twoGisLink = build2GisLink(order['Город'], fullAddress);
  const equipment = String(order['Оборудование'] || '').trim() || '—';
  const chemistry = String(order['Химия'] || '').trim() || '—';
  const description = String(order['Описание работ'] || '').trim();

  let text = '🧹 <b>ПОЛНАЯ ИНФОРМАЦИЯ О ЗАЯВКЕ №' + orderId + '</b>\n';
  text += '────────────────────────────────────\n\n';
  text += '<b>📋 ОСНОВНАЯ ИНФОРМАЦИЯ</b>\n';
  text += '🏙 Город: ' + city + '\n';
  text += '🧽 Вид уборки: ' + cleaningType + '\n';
  text += '📐 Площадь: ' + area + ' м²\n';
  text += '🗓 Дата и время: ' + dateTime + '\n';
  text += '📍 Адрес: ' + escapeTelegramHtml(fullAddress || 'не указан') + '\n\n';
  if (twoGisLink) {
    text += '🗺 2ГИС: <a href="' + escapeTelegramHtml(twoGisLink) + '">Открыть адрес</a>\n\n';
  }

  text += '<b>👤 ДАННЫЕ КЛИЕНТА</b>\n';
  text += 'Имя: ' + clientName + '\n';
  text += 'Телефон: <code>' + clientPhone + '</code>\n';
  if (phoneLink) {
    text += 'Позвонить: <a href="' + escapeTelegramHtml(phoneLink) + '">' + clientPhone + '</a>\n';
  }
  text += '\n';

  text += '<b>🧰 ЧТО ВЗЯТЬ С СОБОЙ</b>\n';
  text += 'Оборудование: ' + escapeTelegramHtml(equipment) + '\n';
  text += 'Химия: ' + escapeTelegramHtml(chemistry) + '\n\n';

  if (description) {
    text += '<b>📝 ДОПОЛНИТЕЛЬНОЕ ОПИСАНИЕ</b>\n';
    text += escapeTelegramHtml(description) + '\n\n';
  }

  text += '<b>💰 ФИНАНСЫ</b>\n';
  text += 'Сумма заказа: ' + orderTotal + ' руб\n';
  text += 'Ваша оплата: ' + masterPay + ' руб\n\n';

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

function build2GisLink(city, address) {
  const c = String(city || '').trim();
  const a = String(address || '').trim();
  const query = [c, a].filter(Boolean).join(', ').trim();
  if (!query) return '';
  return 'https://2gis.ru/search/' + encodeURIComponent(query);
}

function buildSheetRowLink(rowNum) {
  const spreadsheetId = String(PROP.getProperty('SPREADSHEET_ID') || '').trim();
  const row = Number(rowNum || 0);
  if (!spreadsheetId || !row) return '';

  try {
    const sheet = getSheet();
    const gid = sheet.getSheetId();
    return 'https://docs.google.com/spreadsheets/d/' + spreadsheetId + '/edit#gid=' + gid + '&range=A' + row;
  } catch (err) {
    return '';
  }
}

function buildPhoneLink(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return '';
  const normalized = raw.replace(/[^\d+]/g, '');
  if (!normalized) return '';
  return 'tel:' + normalized;
}

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
  const eventsChatId = getEventsChatId();
  if (!eventsChatId) return;

  const from = message.from || {};
  const photos = message.photo || [];
  const lastPhoto = photos.length ? photos[photos.length - 1] : null;
  if (!lastPhoto || !lastPhoto.file_id) return;

  const masterName = buildMasterName(from);
  const caption = String(message.caption || '').trim();
  let orderId = '';
  if (savedInfo && savedInfo.rowNum) {
    try {
      const rowOrder = getOrderByRow(savedInfo.rowNum);
      orderId = normalizeOrderId(rowOrder['Номер заявки'] || '');
    } catch (err) {
      orderId = '';
    }
  }

  let text = '📸 Фото от мастера: ' + escapeTelegramHtml(masterName);
  if (orderId) text += '\nЗаявка: <code>' + escapeTelegramHtml(orderId) + '</code>';
  if (savedInfo && savedInfo.info) text += '\nСохранено в таблицу: ' + escapeTelegramHtml(savedInfo.info);
  if (caption) text += '\nКомментарий: ' + escapeTelegramHtml(caption);

  urlFetchJson('https://api.telegram.org/bot' + token + '/sendPhoto', {
    method: 'post',
    payload: JSON.stringify({
      chat_id: eventsChatId,
      photo: lastPhoto.file_id,
      caption: text,
      parse_mode: 'HTML'
    })
  });
}

/* ---------- Text commands ---------- */

function handleTextMessage(message, token) {
  const chatId = String((message.chat && message.chat.id) || '').trim();
  const userId = String((message.from && message.from.id) || '').trim();
  const text = String(message.text || '').trim();
  if (!text) return jsonResponse({ ok: true, buildVersion: BUILD_VERSION });

  const chatType = String((message.chat && message.chat.type) || '').trim();
  if ((chatType === 'group' || chatType === 'supergroup') && !String(PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim() && chatId) {
    PROP.setProperty('TELEGRAM_CHAT_ID', chatId);
  }

  const managerMode = isManagerContext(userId, chatId);
  const managerResult = processManagerCommand(text, token, chatId, userId, managerMode);
  if (managerResult.handled) {
    return jsonResponse({ ok: true, managerCommand: managerResult, buildVersion: BUILD_VERSION });
  }

  const masterResult = processMasterCommand(text, token, userId, chatId);
  if (masterResult.handled) {
    return jsonResponse({ ok: true, masterCommand: masterResult, buildVersion: BUILD_VERSION });
  }

  return jsonResponse({ ok: true, buildVersion: BUILD_VERSION });
}

function isManagerContext(userId, chatId) {
  const managerId = getManagerChatId();
  const eventsChatId = getEventsChatId();
  const uid = String(userId || '').trim();
  const cid = String(chatId || '').trim();

  if (managerId && (uid === managerId || cid === managerId)) return true;
  if (eventsChatId && (uid === eventsChatId || cid === eventsChatId)) return true;
  return false;
}

function normalizeBotCommandToken(token) {
  const raw = String(token || '').trim().toLowerCase();
  if (!raw) return '';
  const slash = raw[0] === '/' ? raw : ('/' + raw);
  return slash.split('@')[0];
}

function mapManagerPanelTextToCommand(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return '';
  if (t === '/myid') return '/myid';
  if (t === '/setmanager') return '/setmanager';
  if (t === '/setevents') return '/setevents';
  if (t === '/setgroup') return '/setgroup';
  if (t === '/setnsk') return '/setnsk';
  if (t === '/testgroup') return '/testgroup';
  if (t === '/active') return '/active';
  if (t === '/planned') return '/planned';
  if (t === '/pay') return '/pay';
  if (t === '/panel') return '/panel';
  if (t === '/menu') return '/menu';
  if (t === '/commands') return '/commands';
  if (t === '/help') return '/help';
  if (t === '/hidepanel') return '/hidepanel';
  if (t === '📋 активные заявки' || t === 'активные заявки') return '/active';
  if (t === '📅 запланированные' || t === 'запланированные') return '/planned';
  if (t === '💳 отправить оплату' || t === 'отправить оплату') return '/pay';
  if (t === '🧪 тест группы' || t === 'тест группы') return '/testgroup';
  if (t === '🧭 панель' || t === 'панель') return '/panel';
  if (t === '📚 команды' || t === 'команды') return '/menu';
  if (t === '❓ помощь' || t === 'помощь') return '/help';
  if (t === '⌨️ скрыть панель' || t === 'скрыть панель') return '/hidepanel';
  return '';
}

function mapMasterPanelTextToCommand(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return '';
  if (t === '/myorder') return '/myorder';
  if (t === '/arrived') return '/arrived';
  if (t === '/done') return '/done';
  if (t === '/paid') return '/paid';
  if (t === '/cancel') return '/cancel';
  if (t === '/panel') return '/panel';
  if (t === '/menu') return '/menu';
  if (t === '/commands') return '/commands';
  if (t === '/help') return '/help';
  if (t === '/hidepanel') return '/hidepanel';
  if (t === '🧾 моя заявка' || t === 'моя заявка') return '/myorder';
  if (t === '📍 я приехал' || t === 'я приехал') return '/arrived';
  if (t === '✅ я завершил' || t === 'я завершил') return '/done';
  if (t === '💳 оплата получена' || t === 'оплата получена') return '/paid';
  if (t === '❌ отменить заявку' || t === 'отменить заявку') return '/cancel';
  if (t === '🧭 панель' || t === 'панель') return '/panel';
  if (t === '📚 команды' || t === 'команды') return '/menu';
  if (t === '❓ помощь' || t === 'помощь') return '/help';
  if (t === '⌨️ скрыть панель' || t === 'скрыть панель') return '/hidepanel';
  return '';
}

function buildButtonsScenarioHelpText(role) {
  const kind = String(role || '').trim().toLowerCase();
  const lines = [];
  lines.push('📚 Сценарии кнопок');
  lines.push('');
  lines.push('1) В группе: кнопка «✅ ВЫХОЖУ НА ЗАЯВКУ»');
  lines.push('Статус в таблице: «Взята», заполняются Master ID, Master Name, Дата принятия.');
  lines.push('');
  lines.push('2) У мастера: кнопка «📍 ПРИЕХАЛ НА ОБЪЕКТ»');
  lines.push('Статус в таблице: «На объекте», заполняется Дата прибытия, менеджеру уходит уведомление.');
  lines.push('');
  lines.push('3) У мастера: кнопка «✅ ЗАВЕРШИЛ ЗАЯВКУ»');
  lines.push('Статус в таблице: «Ожидает оплаты», заполняется Дата завершения.');
  lines.push('');
  lines.push('4) У мастера: кнопка «💳 ОПЛАТА ПОЛУЧЕНА»');
  lines.push('Статус в таблице: «Завершена», заполняется Дата оплаты.');
  lines.push('');
  lines.push('5) У мастера: кнопка «❌ ОТМЕНИТЬ ЗАЯВКУ»');
  lines.push('Статус в таблице: «Опубликована», мастер очищается, заявка возвращается в группу с кнопкой.');
  if (kind === 'manager') {
    lines.push('');
    lines.push('6) У менеджера: кнопка «💳 Отправить оплату мастеру»');
    lines.push('Бот попросит следующим сообщением отправить ссылку/QR и перешлет мастеру.');
  }
  return lines.join('\n');
}

function processManagerCommand(text, token, replyChatId, userId, managerMode) {
  const rawText = String(text || '').trim();
  if (!rawText) return { handled: false };

  const mapped = mapManagerPanelTextToCommand(rawText);
  const normalizedText = mapped || rawText;
  const isCommandText = normalizedText[0] === '/';
  const pendingKey = String(userId || replyChatId || '').trim();
  const pending = getManagerPendingPaymentInput(pendingKey);

  if (!isCommandText && pending && pending.orderId) {
    return processManagerPaymentByOrderAndText(pending.orderId, normalizedText, token, replyChatId, pendingKey);
  }

  const parts = normalizedText.split(/\s+/);
  if (!parts.length) return { handled: false };

  const command = normalizeBotCommandToken(parts[0]);
  if (!command) return { handled: false };

  if (command === '/myid') {
    const uid = String(userId || '').trim() || '—';
    const cid = String(replyChatId || '').trim() || '—';
    const textInfo = [
      'Ваш user_id: <code>' + escapeTelegramHtml(uid) + '</code>',
      'Текущий chat_id: <code>' + escapeTelegramHtml(cid) + '</code>'
    ].join('\n');
    sendManagerCommandReply(token, replyChatId, textInfo, 'HTML', buildManagerPanelKeyboard());
    return { handled: true, ok: true, command: command, userId: uid, chatId: cid };
  }

  if (command === '/setmanager') {
    const id = String(userId || replyChatId || '').trim();
    if (!id) return { handled: true, ok: false, error: 'manager_id_empty' };
    PROP.setProperty('TELEGRAM_MANAGER_CHAT_ID', id);
    sendManagerCommandReply(token, replyChatId, '✅ TELEGRAM_MANAGER_CHAT_ID = ' + id, null, buildManagerPanelKeyboard());
    return { handled: true, ok: true, command: command, chatId: id };
  }

  if (!managerMode) return { handled: false };

  if (command === '/setevents') {
    const cid = String(replyChatId || '').trim();
    if (!cid) return { handled: true, ok: false, error: 'chat_id_empty' };
    PROP.setProperty('TELEGRAM_EVENTS_CHAT_ID', cid);
    sendManagerCommandReply(token, replyChatId, '✅ TELEGRAM_EVENTS_CHAT_ID = ' + cid, null, buildManagerPanelKeyboard());
    return { handled: true, ok: true, command: command, chatId: cid };
  }

  if (command === '/setgroup') {
    const cid = String(replyChatId || '').trim();
    if (!cid) return { handled: true, ok: false, error: 'chat_id_empty' };
    PROP.setProperty('TELEGRAM_CHAT_ID', cid);
    sendManagerCommandReply(token, replyChatId, '✅ TELEGRAM_CHAT_ID = ' + cid, null, buildManagerPanelKeyboard());
    return { handled: true, ok: true, command: command, chatId: cid };
  }

  if (command === '/setnsk') {
    const cid = String(replyChatId || '').trim();
    if (!cid) return { handled: true, ok: false, error: 'chat_id_empty' };
    PROP.setProperty('TELEGRAM_CHAT_NOVOSIBIRSK', cid);
    sendManagerCommandReply(token, replyChatId, '✅ TELEGRAM_CHAT_NOVOSIBIRSK = ' + cid, null, buildManagerPanelKeyboard());
    return { handled: true, ok: true, command: command, chatId: cid };
  }

  if (command === '/pay') {
    if (parts.length === 1) {
      return sendManagerPaymentPicker(token, replyChatId);
    }
    return processManagerPaymentCommand(parts, token, replyChatId, pendingKey);
  }

  if (command === '/testgroup') {
    return sendGroupCallbackTestMessage(token, replyChatId, userId);
  }

  if (command === '/active') {
    return sendOrdersDigestToChat(token, replyChatId, 'active');
  }

  if (command === '/planned') {
    return sendOrdersDigestToChat(token, replyChatId, 'planned');
  }

  if (command === '/hidepanel') {
    sendManagerCommandReply(token, replyChatId, 'Панель скрыта. Для возврата: /panel', null, { remove_keyboard: true });
    return { handled: true, ok: true, command: command };
  }

  if (command === '/panel' || command === '/help' || command === '/start') {
    const help = [
      'Команды менеджера:',
      '<code>/active</code> — заявки в работе сейчас',
      '<code>/planned</code> — запланированные заявки с назначенным мастером',
      '<code>/pay НОМЕР_ЗАЯВКИ ССЫЛКА [QR: ...]</code> — отправить мастеру оплату',
      '<code>/testgroup</code> — отправить тест кнопки в общую группу',
      '<code>/setevents</code> — назначить текущий чат как чат событий',
      '<code>/setgroup</code> — назначить текущий чат как общий чат заявок',
      '<code>/setnsk</code> — назначить текущий чат Новосибирска',
      '<code>/myid</code> — показать user_id/chat_id',
      '',
      'Можно пользоваться кнопками панели ниже.'
    ].join('\n');
    sendManagerCommandReply(token, replyChatId, help, 'HTML', buildManagerPanelKeyboard());
    return { handled: true, ok: true, command: command };
  }

  if (command === '/menu' || command === '/commands') {
    sendManagerCommandReply(token, replyChatId, buildButtonsScenarioHelpText('manager'), null, buildManagerPanelKeyboard());
    return { handled: true, ok: true, command: command };
  }

  return { handled: false };
}

function processMasterCommand(text, token, userId, chatId) {
  const mapped = mapMasterPanelTextToCommand(text);
  const normalizedText = mapped || String(text || '').trim();
  const parts = normalizedText.split(/\s+/);
  if (!parts.length) return { handled: false };

  const command = normalizeBotCommandToken(parts[0]);
  if (!command) return { handled: false };

  const allowed = ['/myorder', '/arrived', '/done', '/paid', '/cancel', '/help', '/start', '/panel', '/hidepanel', '/menu', '/commands'];
  if (allowed.indexOf(command) === -1) return { handled: false };

  if (command === '/hidepanel') {
    sendBotTextMessage(token, chatId, 'Панель скрыта. Для возврата: /panel', false, { remove_keyboard: true });
    return { handled: true, ok: true, command: command };
  }

  if (command === '/help' || command === '/start' || command === '/panel') {
    const help = [
      'Команды мастера:',
      '/myorder — моя текущая заявка',
      '/arrived — приехал на объект',
      '/done — работы завершены',
      '/paid — оплата от клиента получена',
      '/cancel — отменить заявку',
      '',
      'Можно пользоваться кнопками панели ниже.'
    ].join('\n');
    sendBotTextMessage(token, chatId, help, false, buildMasterPanelKeyboard());
    return { handled: true, ok: true, command: command };
  }

  if (command === '/menu' || command === '/commands') {
    sendBotTextMessage(token, chatId, buildButtonsScenarioHelpText('master'), false, buildMasterPanelKeyboard());
    return { handled: true, ok: true, command: command };
  }

  const rowNum = findActiveOrderRowByMasterId(userId);
  if (!rowNum) {
    sendBotTextMessage(token, chatId, 'У вас нет активной заявки.', false);
    return { handled: true, ok: false, error: 'no_active_order', command: command };
  }

  const order = getOrderByRow(rowNum);
  const orderId = normalizeOrderId(order['Номер заявки']);
  const statusLower = String(order['Статус'] || '').toLowerCase().trim();
  const currentMasterId = String(order['Master ID'] || '').trim();
  const masterId = String(userId || '').trim();
  const masterName = String(order['Master Name'] || buildMasterName({}) || 'Мастер').trim();

  if (command === '/myorder') {
    const city = String(order['Город'] || '').trim();
    const address = [String(order['Улица и дом'] || '').trim(), String(order['Квартира/офис'] || '').trim()].filter(Boolean).join(', ');
    const dateTime = formatDateTimeForDisplay(order['Дата уборки'], order['Время уборки']);
    const link = build2GisLink(city, address);
    const txt = [
      'Текущая заявка: ' + (orderId || '—'),
      'Статус: ' + (String(order['Статус'] || '').trim() || '—'),
      'Дата и время: ' + dateTime,
      'Адрес: ' + (address || '—'),
      link ? ('2ГИС: ' + link) : ''
    ].filter(Boolean).join('\n');
    sendBotTextMessage(token, chatId, txt, false);
    return { handled: true, ok: true, command: command, orderId: orderId };
  }

  if (command === '/arrived') {
    if (!isOrderAssignedToMaster(statusLower, currentMasterId, masterId)) {
      sendBotTextMessage(token, chatId, 'Только назначенный мастер может отметить прибытие.', false);
      return { handled: true, ok: false, denied: true, command: command, orderId: orderId };
    }
    if (statusLower.indexOf('на объекте') !== -1) {
      sendBotTextMessage(token, chatId, 'Прибытие уже отмечено.', false);
      return { handled: true, ok: true, already: true, command: command, orderId: orderId };
    }
    const arrivedAt = formatDateTime(new Date());
    updateOrderArrivedByRow(rowNum, arrivedAt);
    const updatedOrder = getOrderByRow(rowNum);
    notifyManagerNeedInvoice(updatedOrder, masterName, arrivedAt);
    sendBotTextMessage(token, chatId, '✅ Время прибытия сохранено.', false, buildMasterPanelKeyboard());
    return { handled: true, ok: true, command: command, orderId: orderId };
  }

  if (command === '/done') {
    if (!isOrderAssignedToMaster(statusLower, currentMasterId, masterId)) {
      sendBotTextMessage(token, chatId, 'Только назначенный мастер может завершить заявку.', false);
      return { handled: true, ok: false, denied: true, command: command, orderId: orderId };
    }
    const doneAt = formatDateTime(new Date());
    updateOrderDoneByRow(rowNum, doneAt);
    const updatedOrder = getOrderByRow(rowNum);
    notifyManagerOrderDone(updatedOrder, masterName, doneAt);
    sendBotTextMessage(token, chatId, '✅ Работы завершены. После оплаты выполните /paid.', false, buildMasterPanelKeyboard());
    return { handled: true, ok: true, command: command, orderId: orderId };
  }

  if (command === '/paid') {
    if (!currentMasterId || currentMasterId !== masterId) {
      sendBotTextMessage(token, chatId, 'Только назначенный мастер может подтвердить оплату.', false);
      return { handled: true, ok: false, denied: true, command: command, orderId: orderId };
    }
    if (statusLower.indexOf('заверш') !== -1 && statusLower.indexOf('ожидает оплат') === -1) {
      sendBotTextMessage(token, chatId, 'Оплата уже подтверждена.', false);
      return { handled: true, ok: true, already: true, command: command, orderId: orderId };
    }
    const paidAt = formatDateTime(new Date());
    updateOrderPaidByRow(rowNum, paidAt);
    const updatedOrder = getOrderByRow(rowNum);
    notifyManagerPaymentConfirmed(updatedOrder, masterName, paidAt);
    sendBotTextMessage(token, chatId, '✅ Оплата подтверждена.', false, buildMasterPanelKeyboard());
    return { handled: true, ok: true, command: command, orderId: orderId };
  }

  if (command === '/cancel') {
    if (!currentMasterId || currentMasterId !== masterId) {
      sendBotTextMessage(token, chatId, 'Только назначенный мастер может отменить заявку.', false);
      return { handled: true, ok: false, denied: true, command: command, orderId: orderId };
    }
    const cancelledAt = formatDateTime(new Date());
    updateOrderCancelledByRow(rowNum, masterName, cancelledAt);
    clearOrderDmSent(orderId);
    const republish = republishOrderToGroupByRow(rowNum);
    const updatedOrder = getOrderByRow(rowNum);
    notifyManagerOrderCancelled(updatedOrder, masterName, cancelledAt, republish);
    sendBotTextMessage(token, chatId, republish.ok ? '✅ Заявка отменена и возвращена в группу.' : '⚠️ Заявка отменена, но вернуть в группу не удалось.', false, buildMasterPanelKeyboard());
    return { handled: true, ok: true, command: command, orderId: orderId, republish: republish };
  }

  return { handled: false };
}

function sendManagerPaymentPicker(token, chatId) {
  const cid = String(chatId || '').trim();
  if (!cid) return { handled: true, ok: false, error: 'chat_id_not_set' };

  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    sendManagerCommandReply(token, cid, 'Сейчас нет заявок для отправки оплаты.', null, buildManagerPanelKeyboard());
    return { handled: true, ok: true, count: 0 };
  }

  const rows = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const buttons = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const status = String(getCellFromRowByHeader(row, map, 'Статус') || '').toLowerCase().trim();
    const masterId = String(getCellFromRowByHeader(row, map, 'Master ID') || '').trim();
    const orderId = normalizeOrderId(getCellFromRowByHeader(row, map, 'Номер заявки'));
    if (!orderId || !masterId) continue;

    const canPay =
      status.indexOf('взята') !== -1 ||
      status.indexOf('на объекте') !== -1 ||
      status.indexOf('ожидает оплат') !== -1;
    if (!canPay) continue;

    const masterName = String(getCellFromRowByHeader(row, map, 'Master Name') || '').trim() || 'Мастер';
    buttons.push([{ text: orderId + ' · ' + masterName, callback_data: makeCallbackData(CALLBACK_ACTIONS.MANAGER_PAY, orderId) }]);
    if (buttons.length >= 20) break;
  }

  if (!buttons.length) {
    sendManagerCommandReply(token, cid, 'Сейчас нет заявок для отправки оплаты.', null, buildManagerPanelKeyboard());
    return { handled: true, ok: true, count: 0 };
  }

  sendManagerCommandReply(
    token,
    cid,
    'Выберите заявку, по которой нужно отправить ссылку/QR мастеру:',
    null,
    { inline_keyboard: buttons }
  );

  return { handled: true, ok: true, count: buttons.length };
}

function processManagerPaymentCommand(parts, token, replyChatId, userId) {
  if (!parts || parts.length < 2) {
    sendManagerCommandReply(token, replyChatId, '❌ Используйте: /pay НОМЕР_ЗАЯВКИ ССЫЛКА [QR: ...]');
    return { handled: true, ok: false, error: 'usage' };
  }

  const orderId = normalizeOrderId(parts[1]);
  if (!orderId) {
    sendManagerCommandReply(token, replyChatId, '❌ Укажите корректный номер заявки');
    return { handled: true, ok: false, error: 'bad_order_id' };
  }

  if (parts.length < 3) {
    setManagerPendingPaymentInput(userId, orderId);
    sendManagerCommandReply(
      token,
      replyChatId,
      [
        '🧾 Заявка ' + orderId + ' выбрана.',
        'Отправьте следующим сообщением:',
        'Ссылка: https://ваша-ссылка',
        'QR: https://ссылка-на-qr-или-текст'
      ].join('\n'),
      null,
      buildManagerPanelKeyboard()
    );
    return { handled: true, ok: true, waitingInput: true, orderId: orderId };
  }

  const payloadText = String(parts.slice(2).join(' ') || '').trim();
  return processManagerPaymentByOrderAndText(orderId, payloadText, token, replyChatId, userId);
}

function processManagerPaymentByOrderAndText(orderId, payloadText, token, replyChatId, userId) {
  const parsed = parsePaymentPayloadText(payloadText);
  if (!parsed.payLink && !parsed.qrValue) {
    sendManagerCommandReply(token, replyChatId, '❌ Не нашел ссылку оплаты. Пример: Ссылка: https://... QR: https://...');
    return { handled: true, ok: false, error: 'payment_link_not_found' };
  }

  const rowNum = findOrderRowById(orderId);
  if (!rowNum) {
    sendManagerCommandReply(token, replyChatId, '❌ Заявка ' + orderId + ' не найдена');
    return { handled: true, ok: false, error: 'order_not_found' };
  }

  const order = getOrderByRow(rowNum);
  const masterId = String(order['Master ID'] || '').trim();
  if (!masterId) {
    sendManagerCommandReply(token, replyChatId, '❌ У заявки ' + orderId + ' нет назначенного мастера');
    return { handled: true, ok: false, error: 'master_not_assigned' };
  }

  const textLines = ['💳 Оплата по заявке <code>' + escapeTelegramHtml(orderId) + '</code>'];
  if (parsed.payLink) textLines.push('Ссылка: ' + escapeTelegramHtml(parsed.payLink));
  if (parsed.qrValue) textLines.push('QR: ' + escapeTelegramHtml(parsed.qrValue));

  const resp = urlFetchJson('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    payload: JSON.stringify({
      chat_id: masterId,
      text: textLines.join('\n'),
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });

  if (!resp || resp.ok !== true) {
    sendManagerCommandReply(token, replyChatId, '❌ Не удалось отправить ссылку мастеру по заявке ' + orderId);
    return { handled: true, ok: false, error: 'send_failed', telegram: resp || null };
  }

  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  setCellByHeader(sheet, rowNum, map, 'Статус выполнения', 'Ссылка/QR отправлены ' + formatDateTime(new Date()));
  clearManagerPendingPaymentInput(userId);
  sendManagerCommandReply(token, replyChatId, '✅ Данные оплаты отправлены мастеру по заявке ' + orderId);

  return { handled: true, ok: true, orderId: orderId, masterId: masterId };
}

function parsePaymentPayloadText(text) {
  const raw = String(text || '').trim();
  if (!raw) return { payLink: '', qrValue: '' };

  const urls = raw.match(/https?:\/\/\S+/gi) || [];
  let payLink = '';
  let qrValue = '';

  const linkMatch = raw.match(/(?:ссылка|link)\s*:\s*(https?:\/\/\S+)/i);
  if (linkMatch && linkMatch[1]) payLink = String(linkMatch[1]).trim();
  if (!payLink && urls.length) payLink = String(urls[0]).trim();

  const qrMatch = raw.match(/(?:qr|куар|кьюар)\s*:\s*([^\n]+)/i);
  if (qrMatch && qrMatch[1]) qrValue = String(qrMatch[1]).trim();
  if (!qrValue && urls.length > 1) qrValue = String(urls[1]).trim();

  return { payLink: payLink, qrValue: qrValue };
}

function sendManagerCommandReply(token, chatId, text, parseMode, replyMarkup) {
  const cid = String(chatId || '').trim();
  if (!cid) return;
  sendBotTextMessage(token, cid, text, parseMode === 'HTML', replyMarkup);
}

function sendBotTextMessage(token, chatId, text, useHtml, replyMarkup) {
  const cid = String(chatId || '').trim();
  if (!cid) return null;

  const payload = {
    chat_id: cid,
    text: String(text || ''),
    disable_web_page_preview: true
  };
  if (useHtml) payload.parse_mode = 'HTML';
  if (replyMarkup) payload.reply_markup = replyMarkup;

  return urlFetchJson('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    payload: JSON.stringify(payload)
  });
}

function sendGroupCallbackTestMessage(token, replyChatId, userId) {
  const fallbackChat = String(PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim();
  const nskChat = String(PROP.getProperty('TELEGRAM_CHAT_NOVOSIBIRSK') || '').trim();
  const targetChatId = String(nskChat || fallbackChat || '').trim();

  if (!targetChatId) {
    sendManagerCommandReply(token, replyChatId, '❌ Не задан TELEGRAM_CHAT_ID/TELEGRAM_CHAT_NOVOSIBIRSK');
    return { handled: true, ok: false, error: 'group_chat_not_set' };
  }

  const testId = 'TST-' + Utilities.formatDate(new Date(), scriptTimeZone(), 'MMddHHmmss');
  const callbackData = makeCallbackData(CALLBACK_ACTIONS.TEST, testId);
  const keyboard = {
    inline_keyboard: [[
      { text: '🧪 ПРОВЕРИТЬ CALLBACK', callback_data: callbackData }
    ]]
  };

  const lines = [
    '🧪 ТЕСТ КНОПКИ ГРУППЫ',
    'buildVersion: ' + BUILD_VERSION,
    'testId: ' + testId,
    '',
    'Нажмите кнопку ниже. Если callback работает, бот покажет всплывающее подтверждение.'
  ];

  const sendResp = sendBotTextMessage(token, targetChatId, lines.join('\n'), false, keyboard);
  const ok = !!(sendResp && sendResp.ok === true && sendResp.result);

  if (ok) {
    sendManagerCommandReply(
      token,
      replyChatId,
      '✅ Тест отправлен в группу <code>' + escapeTelegramHtml(targetChatId) + '</code>.\nНажмите кнопку в группе.',
      'HTML',
      buildManagerPanelKeyboard()
    );
  } else {
    sendManagerCommandReply(token, replyChatId, '❌ Не удалось отправить тест в группу. Проверьте права бота и chat_id.');
  }

  return {
    handled: true,
    ok: ok,
    command: '/testgroup',
    requestedByUserId: String(userId || '').trim(),
    requestedByChatId: String(replyChatId || '').trim(),
    targetChatId: targetChatId,
    testId: testId,
    callbackData: callbackData,
    telegram: sendResp || null
  };
}

function buildManagerPanelKeyboard() {
  return {
    keyboard: [
      ['/active', '/planned'],
      ['/pay', '/panel'],
      ['/setevents', '/setgroup'],
      ['/setnsk', '/testgroup'],
      ['/myid', '/menu'],
      ['/help'],
      ['/hidepanel']
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

function buildMasterPanelKeyboard() {
  return {
    keyboard: [
      ['/myorder', '/arrived'],
      ['/done', '/paid'],
      ['/cancel', '/panel'],
      ['/help', '/hidepanel']
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

function sendOrdersDigestToChat(token, chatId, mode) {
  const targetChatId = String(chatId || '').trim();
  if (!targetChatId) return { handled: true, ok: false, error: 'chat_id_not_set' };

  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    const emptyText = mode === 'active' ? 'Сейчас нет заявок в работе.' : 'Нет запланированных заявок.';
    urlFetchJson('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post',
      payload: JSON.stringify({ chat_id: targetChatId, text: emptyText })
    });
    return { handled: true, ok: true, count: 0, mode: mode };
  }

  const rows = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const items = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;
    const status = String(getCellFromRowByHeader(row, map, 'Статус') || '').toLowerCase().trim();
    const orderId = normalizeOrderId(getCellFromRowByHeader(row, map, 'Номер заявки'));
    const masterName = String(getCellFromRowByHeader(row, map, 'Master Name') || '').trim() || '—';
    const date = formatDateForDisplay(getCellFromRowByHeader(row, map, 'Дата уборки'));
    const time = formatTimeForDisplay(getCellFromRowByHeader(row, map, 'Время уборки'));
    const dateTime = [date, time].filter(Boolean).join(' ');
    const city = String(getCellFromRowByHeader(row, map, 'Город') || '').trim();
    const address = [
      String(getCellFromRowByHeader(row, map, 'Улица и дом') || '').trim(),
      String(getCellFromRowByHeader(row, map, 'Квартира/офис') || '').trim()
    ].filter(Boolean).join(', ');
    const link2gis = build2GisLink(city, address);
    const rowLink = buildSheetRowLink(rowNum);

    const isActive = status.indexOf('на объекте') !== -1 || status.indexOf('ожидает оплат') !== -1;
    const isPlanned = status.indexOf('взята') !== -1;
    if (mode === 'active' && !isActive) continue;
    if (mode === 'planned' && !isPlanned) continue;
    if (!orderId) continue;

    let item = '• <code>' + escapeTelegramHtml(orderId) + '</code> — ' + escapeTelegramHtml(masterName);
    if (dateTime) item += '\n  ' + escapeTelegramHtml(dateTime);
    if (link2gis) item += '\n  <a href="' + escapeTelegramHtml(link2gis) + '">2ГИС</a>';
    if (rowLink) item += ' | <a href="' + escapeTelegramHtml(rowLink) + '">Таблица</a>';
    items.push(item);
  }

  const title = mode === 'active' ? '🟢 <b>Заявки в работе сейчас</b>' : '🗓 <b>Запланированные заявки</b>';
  if (!items.length) {
    const empty = mode === 'active' ? 'Сейчас нет заявок в работе.' : 'Нет запланированных заявок.';
    urlFetchJson('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post',
      payload: JSON.stringify({ chat_id: targetChatId, text: empty })
    });
    return { handled: true, ok: true, count: 0, mode: mode };
  }

  const maxItems = 25;
  const lines = items.slice(0, maxItems);
  let text = title + '\n\n' + lines.join('\n\n');
  if (items.length > maxItems) {
    text += '\n\n…и еще ' + (items.length - maxItems);
  }

  const resp = urlFetchJson('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    payload: JSON.stringify({
      chat_id: targetChatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });

  return { handled: true, ok: !!(resp && resp.ok === true), count: items.length, mode: mode, telegram: resp || null };
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
  urlFetchJson('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    payload: JSON.stringify({
      chat_id: userId,
      text: '✅ Фото получено, спасибо!'
    })
  });

  return jsonResponse({ ok: true, buildVersion: BUILD_VERSION });
}

function handleManagerPaymentAttachmentMessage(message, token) {
  const userId = String((message.from && message.from.id) || '').trim();
  const chatId = String((message.chat && message.chat.id) || '').trim();
  if (!isManagerContext(userId, chatId)) return { handled: false };

  const pendingKey = String(userId || chatId || '').trim();
  const pending = getManagerPendingPaymentInput(pendingKey);
  if (!pending || !pending.orderId) return { handled: false };

  const orderId = normalizeOrderId(pending.orderId);
  const rowNum = findOrderRowById(orderId);
  if (!rowNum) {
    clearManagerPendingPaymentInput(pendingKey);
    sendBotTextMessage(token, chatId, '❌ Заявка ' + orderId + ' не найдена. Введите /pay снова.', false, buildManagerPanelKeyboard());
    return { handled: true, ok: false, error: 'order_not_found' };
  }

  const order = getOrderByRow(rowNum);
  const masterId = String(order['Master ID'] || '').trim();
  if (!masterId) {
    clearManagerPendingPaymentInput(pendingKey);
    sendBotTextMessage(token, chatId, '❌ У заявки ' + orderId + ' нет назначенного мастера.', false, buildManagerPanelKeyboard());
    return { handled: true, ok: false, error: 'master_not_assigned' };
  }

  let resp = null;
  const caption = '💳 QR/документ оплаты по заявке ' + orderId;

  if (message.photo && message.photo.length) {
    const photo = message.photo[message.photo.length - 1];
    const fileId = String((photo && photo.file_id) || '').trim();
    if (fileId) {
      resp = urlFetchJson('https://api.telegram.org/bot' + token + '/sendPhoto', {
        method: 'post',
        payload: JSON.stringify({
          chat_id: masterId,
          photo: fileId,
          caption: caption
        })
      });
    }
  } else if (message.document) {
    const fileId = String((message.document && message.document.file_id) || '').trim();
    if (fileId) {
      resp = urlFetchJson('https://api.telegram.org/bot' + token + '/sendDocument', {
        method: 'post',
        payload: JSON.stringify({
          chat_id: masterId,
          document: fileId,
          caption: caption
        })
      });
    }
  }

  if (!resp || resp.ok !== true) {
    sendBotTextMessage(token, chatId, '❌ Не удалось отправить файл мастеру по заявке ' + orderId + '.', false, buildManagerPanelKeyboard());
    return { handled: true, ok: false, error: 'telegram_send_failed', telegram: resp || null };
  }

  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  setCellByHeader(sheet, rowNum, map, 'Статус выполнения', 'QR/документ оплаты отправлен ' + formatDateTime(new Date()));
  clearManagerPendingPaymentInput(pendingKey);
  sendBotTextMessage(token, chatId, '✅ QR/документ отправлен мастеру по заявке ' + orderId + '.', false, buildManagerPanelKeyboard());

  return { handled: true, ok: true, orderId: orderId };
}

/* ---------- Notifications ---------- */

function notifyManagerNeedInvoice(order, masterName, arrivedAt) {
  const token = getTelegramBotToken();
  const eventsChatId = getEventsChatId();
  if (!token || !eventsChatId) return;

  const orderId = escapeTelegramHtml(order['Номер заявки'] || '');
  const callbackData = makeCallbackData(CALLBACK_ACTIONS.MANAGER_PAY, order['Номер заявки'] || '');
  const text = [
    '💳 <b>Нужно сформировать ссылку на оплату</b>',
    'Заявка: <code>' + orderId + '</code>',
    'Мастер: ' + escapeTelegramHtml(masterName || 'Мастер'),
    'Время прибытия: ' + escapeTelegramHtml(arrivedAt || ''),
    '',
    'Нажмите кнопку ниже или отправьте команду:',
    '<code>/pay ' + orderId + ' https://ваша-ссылка QR: https://qr</code>'
  ].join('\n');

  const keyboard = callbackData
    ? { inline_keyboard: [[{ text: '💳 Отправить ссылку/QR мастеру', callback_data: callbackData }]] }
    : null;

  const payload = {
    chat_id: eventsChatId,
    text: text,
    parse_mode: 'HTML'
  };
  if (keyboard) payload.reply_markup = keyboard;

  urlFetchJson('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    payload: JSON.stringify(payload)
  });
}

function notifyManagerOrderDone(order, masterName, doneAt) {
  const token = getTelegramBotToken();
  const eventsChatId = getEventsChatId();
  if (!token || !eventsChatId) return;

  const orderId = escapeTelegramHtml(order['Номер заявки'] || '');
  const text = [
    '✅ <b>Заявка завершена</b>',
    'Заявка: <code>' + orderId + '</code>',
    'Мастер: ' + escapeTelegramHtml(masterName || 'Мастер'),
    'Время завершения: ' + escapeTelegramHtml(doneAt || '')
  ].join('\n');

  urlFetchJson('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    payload: JSON.stringify({
      chat_id: eventsChatId,
      text: text,
      parse_mode: 'HTML'
    })
  });
}

function notifyManagerOrderCancelled(order, masterName, cancelledAt, republish) {
  const token = getTelegramBotToken();
  const eventsChatId = getEventsChatId();
  if (!token || !eventsChatId) return;

  const orderId = escapeTelegramHtml(order['Номер заявки'] || '');
  const republishState = republish && republish.ok ? 'Да' : 'Нет';
  const text = [
    '⚠️ <b>Заявка отменена мастером</b>',
    'Заявка: <code>' + orderId + '</code>',
    'Мастер: ' + escapeTelegramHtml(masterName || 'Мастер'),
    'Время отмены: ' + escapeTelegramHtml(cancelledAt || ''),
    'Возвращена в группу: ' + republishState
  ].join('\n');

  urlFetchJson('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    payload: JSON.stringify({
      chat_id: eventsChatId,
      text: text,
      parse_mode: 'HTML'
    })
  });
}

function notifyManagerOrderTaken(order, masterName, takenAt) {
  const token = getTelegramBotToken();
  const eventsChatId = getEventsChatId();
  if (!token || !eventsChatId) return;

  const orderId = escapeTelegramHtml(order['Номер заявки'] || '');
  const text = [
    '📌 <b>Мастер взял заявку</b>',
    'Заявка: <code>' + orderId + '</code>',
    'Мастер: ' + escapeTelegramHtml(masterName || 'Мастер'),
    'Время принятия: ' + escapeTelegramHtml(takenAt || '')
  ].join('\n');

  urlFetchJson('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    payload: JSON.stringify({
      chat_id: eventsChatId,
      text: text,
      parse_mode: 'HTML'
    })
  });
}

function notifyManagerPaymentConfirmed(order, masterName, paidAt) {
  const token = getTelegramBotToken();
  const eventsChatId = getEventsChatId();
  if (!token || !eventsChatId) return;

  const orderId = escapeTelegramHtml(order['Номер заявки'] || '');
  const text = [
    '💵 <b>Оплата подтверждена мастером</b>',
    'Заявка: <code>' + orderId + '</code>',
    'Мастер: ' + escapeTelegramHtml(masterName || 'Мастер'),
    'Время подтверждения: ' + escapeTelegramHtml(paidAt || '')
  ].join('\n');

  urlFetchJson('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    payload: JSON.stringify({
      chat_id: eventsChatId,
      text: text,
      parse_mode: 'HTML'
    })
  });
}

/* ---------- Date/time ---------- */

function normalizeCreatedAtValue(value) {
  const dt = parseDateTimeLoose(value);
  if (!dt) return formatDateTime(new Date());
  return formatDateTime(dt);
}

function normalizeOrderDateValue(value) {
  if (value instanceof Date) return formatDate(value);

  const raw = String(value || '').trim();
  if (!raw) return '';

  const ddmmyyyy = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (ddmmyyyy) return ddmmyyyy[1] + '.' + ddmmyyyy[2] + '.' + ddmmyyyy[3];

  const ddmm = raw.match(/^(\d{2})\.(\d{2})$/);
  if (ddmm) {
    return ddmm[1] + '.' + ddmm[2] + '.' + new Date().getFullYear();
  }

  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) return ymd[3] + '.' + ymd[2] + '.' + ymd[1];

  const dt = parseDateTimeLoose(raw);
  if (dt) return formatDate(dt);
  return raw;
}

function normalizeOrderTimeValue(value) {
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
  if (ymd) return ymd[3] + '.' + ymd[2] + '.' + ymd[1];

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

function formatDateTime(date) {
  const dt = date instanceof Date ? date : new Date(date);
  return Utilities.formatDate(dt, scriptTimeZone(), 'dd.MM.yyyy HH:mm:ss');
}

function formatDate(date) {
  const dt = date instanceof Date ? date : new Date(date);
  return Utilities.formatDate(dt, scriptTimeZone(), 'dd.MM.yyyy');
}

function formatTime(date) {
  const dt = date instanceof Date ? date : new Date(date);
  return Utilities.formatDate(dt, scriptTimeZone(), 'HH:mm');
}

function parseDateTimeLoose(value) {
  if (value instanceof Date) return value;

  const raw = String(value || '').trim();
  if (!raw) return null;

  let m = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    return new Date(
      Number(m[3]),
      Number(m[2]) - 1,
      Number(m[1]),
      Number(m[4] || 0),
      Number(m[5] || 0),
      Number(m[6] || 0)
    );
  }

  m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    return new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4] || 0),
      Number(m[5] || 0),
      Number(m[6] || 0)
    );
  }

  const parsed = new Date(raw);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function sendReminders() {
  const out = { ok: true, skipped: true, buildVersion: BUILD_VERSION };
  Logger.log(JSON.stringify(out));
  return out;
}

/* ---------- Webhook/misc ---------- */

function normalizeWebhookUrlToExec(url) {
  const value = String(url || '').trim();
  if (!value) return '';

  if (value.indexOf('script.googleusercontent.com/macros/echo') !== -1) {
    return value;
  }

  const clean = value.replace(/\/$/, '');
  if (clean.indexOf('/exec') !== -1) return clean.replace(/\/exec(?:[?#].*)?$/, '/exec');
  if (clean.indexOf('/dev') !== -1) return clean.replace(/\/dev(?:[?#].*)?$/, '/exec');
  return clean;
}

function isGoogleLoginUrl(url) {
  const value = String(url || '').trim().toLowerCase();
  if (!value) return false;
  return (
    value.indexOf('https://accounts.google.com/') === 0 ||
    value.indexOf('accounts.google.com/servicelogin') !== -1 ||
    value.indexOf('accounts.google.com/v3/signin') !== -1
  );
}

function isUsableWebhookTarget(url) {
  const value = normalizeWebhookUrlToExec(url);
  if (!value) return false;
  if (isGoogleLoginUrl(value)) return false;
  return /^https:\/\//i.test(value);
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
  if (preferred && isUsableWebhookTarget(preferred)) return preferred;

  const stored = normalizeWebhookUrlToExec(PROP.getProperty(WEBAPP_EXEC_URL_PROPERTY));
  if (stored && isUsableWebhookTarget(stored)) return stored;

  const service = normalizeWebhookUrlToExec(getCurrentServiceExecUrl());
  if (service && isUsableWebhookTarget(service)) return service;

  return '';
}

function getHeaderValue(headers, name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!headers || !wanted) return '';

  const keys = Object.keys(headers || {});
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (String(key || '').toLowerCase() !== wanted) continue;
    const value = headers[key];
    if (Array.isArray(value)) return String(value.length ? value[0] : '').trim();
    return String(value || '').trim();
  }
  return '';
}

function probeWebhookRedirectTarget(url, method) {
  const targetUrl = normalizeWebhookUrlToExec(url);
  if (!targetUrl) {
    return { ok: false, url: '', method: 'get', statusCode: 0, redirectUrl: '', error: 'empty_url' };
  }

  const httpMethod = String(method || 'get').toLowerCase() === 'post' ? 'post' : 'get';
  const params = {
    method: httpMethod,
    muteHttpExceptions: true,
    followRedirects: false
  };

  if (httpMethod === 'post') {
    params.contentType = 'application/x-www-form-urlencoded; charset=UTF-8';
    params.payload = 'action=probe_version';
  }

  try {
    const resp = UrlFetchApp.fetch(targetUrl, params);
    const headers = resp.getAllHeaders ? resp.getAllHeaders() : {};
    const location = getHeaderValue(headers, 'location');
    return {
      ok: true,
      url: targetUrl,
      method: httpMethod,
      statusCode: resp.getResponseCode(),
      redirectUrl: location
    };
  } catch (err) {
    return {
      ok: false,
      url: targetUrl,
      method: httpMethod,
      statusCode: 0,
      redirectUrl: '',
      error: err.message
    };
  }
}

function resolveTelegramWebhookTarget(execUrl) {
  const baseExecUrl = normalizeWebhookUrlToExec(execUrl);
  if (!baseExecUrl) return { targetUrl: '', redirectProbe: null, redirectProbeGet: null };

  const postProbe = probeWebhookRedirectTarget(baseExecUrl, 'post');
  const postTargetRaw = normalizeWebhookUrlToExec(postProbe && postProbe.redirectUrl ? postProbe.redirectUrl : '');
  const postTarget = isUsableWebhookTarget(postTargetRaw) ? postTargetRaw : '';

  let getProbe = null;
  let getTargetRaw = '';
  let getTarget = '';
  if (!postTarget) {
    getProbe = probeWebhookRedirectTarget(baseExecUrl, 'get');
    getTargetRaw = normalizeWebhookUrlToExec(getProbe && getProbe.redirectUrl ? getProbe.redirectUrl : '');
    getTarget = isUsableWebhookTarget(getTargetRaw) ? getTargetRaw : '';
  }

  const authBlocked =
    isGoogleLoginUrl(postTargetRaw) ||
    isGoogleLoginUrl(getTargetRaw) ||
    (postProbe && (Number(postProbe.statusCode || 0) === 401 || Number(postProbe.statusCode || 0) === 403)) ||
    (getProbe && (Number(getProbe.statusCode || 0) === 401 || Number(getProbe.statusCode || 0) === 403));

  return {
    targetUrl: postTarget || getTarget || baseExecUrl,
    redirectProbe: postProbe,
    redirectProbeGet: getProbe,
    rejectedPostTarget: postTargetRaw && !postTarget ? postTargetRaw : '',
    rejectedGetTarget: getTargetRaw && !getTarget ? getTargetRaw : '',
    authBlocked: authBlocked
  };
}

function webhookUrlsEquivalent(currentUrl, expectedUrl) {
  const current = normalizeWebhookUrlToExec(currentUrl);
  const expected = normalizeWebhookUrlToExec(expectedUrl);
  if (!current || !expected) return current === expected;
  if (current === expected) return true;

  if (
    current.indexOf('script.googleusercontent.com/macros/echo') !== -1 &&
    expected.indexOf('script.googleusercontent.com/macros/echo') !== -1
  ) {
    try {
      const currentParsed = new URL(current);
      const expectedParsed = new URL(expected);
      return (
        currentParsed.origin === expectedParsed.origin &&
        currentParsed.pathname === expectedParsed.pathname &&
        String(currentParsed.searchParams.get('lib') || '') === String(expectedParsed.searchParams.get('lib') || '')
      );
    } catch (err) {
      return current === expected;
    }
  }

  return false;
}

function ensureWebhookBoundToCurrentExec(force) {
  const token = getTelegramBotToken();
  if (!token) return { ok: false, reason: 'token_not_set' };

  const baseExecUrl = resolveWebhookExecUrl('');
  if (!baseExecUrl) return { ok: false, reason: 'exec_url_not_set' };

  const targetInfo = resolveTelegramWebhookTarget(baseExecUrl);
  const targetUrl = targetInfo && targetInfo.targetUrl ? targetInfo.targetUrl : baseExecUrl;
  if (!isUsableWebhookTarget(targetUrl)) {
    return { ok: false, reason: 'invalid_webhook_target', baseExecUrl: baseExecUrl, targetUrl: targetUrl };
  }

  if (targetInfo && targetInfo.authBlocked) {
    return {
      ok: false,
      reason: 'webapp_requires_auth',
      baseExecUrl: baseExecUrl,
      targetUrl: targetUrl,
      redirectProbe: targetInfo.redirectProbe || null,
      redirectProbeGet: targetInfo.redirectProbeGet || null
    };
  }

  const now = Date.now();
  const lastSync = Number(PROP.getProperty(WEBHOOK_LAST_SYNC_TS_PROPERTY) || '0');
  if (!force && lastSync > 0 && (now - lastSync) < 3 * 60 * 1000) {
    return { ok: true, skipped: true, baseExecUrl: baseExecUrl, targetUrl: targetUrl };
  }

  const info = urlFetchJson('https://api.telegram.org/bot' + token + '/getWebhookInfo', { method: 'get' });
  const currentUrl = info && info.result && info.result.url ? normalizeWebhookUrlToExec(info.result.url) : '';

  if (!webhookUrlsEquivalent(currentUrl, targetUrl)) {
    const setResp = urlFetchJson('https://api.telegram.org/bot' + token + '/setWebhook', {
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

  PROP.setProperty(WEBAPP_EXEC_URL_PROPERTY, baseExecUrl);
  PROP.setProperty(WEBHOOK_LAST_SYNC_TS_PROPERTY, String(now));

  return {
    ok: true,
    baseExecUrl: baseExecUrl,
    targetUrl: targetUrl,
    redirectProbe: targetInfo ? targetInfo.redirectProbe : null,
    redirectProbeGet: targetInfo ? targetInfo.redirectProbeGet : null,
    currentWebhookUrl: currentUrl,
    changed: !webhookUrlsEquivalent(currentUrl, targetUrl)
  };
}

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

function buildMasterName(from) {
  const first = String((from && from.first_name) || '').trim();
  const last = String((from && from.last_name) || '').trim();
  const username = String((from && from.username) || '').trim();

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
    muteHttpExceptions: true,
    followRedirects: options && Object.prototype.hasOwnProperty.call(options, 'followRedirects') ? !!options.followRedirects : true
  };

  if (options && Object.prototype.hasOwnProperty.call(options, 'contentType')) {
    params.contentType = options.contentType;
  } else {
    params.contentType = 'application/json';
  }

  if (options && options.payload !== undefined && options.payload !== null) {
    params.payload = options.payload;
  }

  if (options && options.headers) {
    params.headers = options.headers;
  }

  const resp = UrlFetchApp.fetch(url, params);
  const code = resp.getResponseCode();
  const text = String(resp.getContentText() || '');
  const parsed = tryParseJson(text);
  if (parsed && typeof parsed === 'object') {
    if (!Object.prototype.hasOwnProperty.call(parsed, 'statusCode')) parsed.statusCode = code;
    return parsed;
  }

  return {
    ok: code >= 200 && code < 300,
    statusCode: code,
    raw: text
  };
}

function answerCallback(token, callbackId, text) {
  if (!callbackId) return;
  urlFetchJson('https://api.telegram.org/bot' + token + '/answerCallbackQuery', {
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

/* ---------- Diagnostics ---------- */

function __checkConfiguration() {
  const out = {
    buildVersion: BUILD_VERSION,
    telegramRuntimeMode: getTelegramRuntimeMode(),
    spreadsheetId: String(PROP.getProperty('SPREADSHEET_ID') || '').trim() || 'NOT_SET',
    botTokenSet: !!getTelegramBotToken(),
    telegramChatId: String(PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim() || 'NOT_SET',
    telegramChatNovosibirsk: String(PROP.getProperty('TELEGRAM_CHAT_NOVOSIBIRSK') || '').trim() || 'NOT_SET',
    telegramManagerChatId: getManagerChatId() || 'NOT_SET',
    telegramEventsChatId: getEventsChatId() || 'NOT_SET',
    storedWebAppExecUrl: String(PROP.getProperty(WEBAPP_EXEC_URL_PROPERTY) || '').trim() || 'NOT_SET',
    serviceExecUrl: getCurrentServiceExecUrl(),
    resolvedWebhookExecUrl: resolveWebhookExecUrl('')
  };
  Logger.log(JSON.stringify(out));
  return out;
}

function __setTelegramRuntimeMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  if (normalized !== 'direct' && normalized !== 'apps_script') {
    throw new Error('Передайте mode: direct или apps_script');
  }
  PROP.setProperty(TELEGRAM_RUNTIME_MODE_PROPERTY, normalized);
  const out = { ok: true, telegramRuntimeMode: normalized, buildVersion: BUILD_VERSION };
  Logger.log(JSON.stringify(out));
  return out;
}

function __switchToDirectTelegramMode() {
  const token = getTelegramBotToken();
  PROP.setProperty(TELEGRAM_RUNTIME_MODE_PROPERTY, 'direct');
  let deleteWebhook = { ok: false, skipped: true, reason: 'token_not_set' };
  if (token) {
    deleteWebhook = urlFetchJson('https://api.telegram.org/bot' + token + '/deleteWebhook', {
      method: 'post',
      payload: JSON.stringify({ drop_pending_updates: true })
    });
  }

  const out = {
    ok: true,
    telegramRuntimeMode: 'direct',
    deleteWebhook: deleteWebhook,
    note: 'Apps Script больше не обрабатывает Telegram callbacks/commands',
    buildVersion: BUILD_VERSION
  };
  Logger.log(JSON.stringify(out));
  return out;
}

function __switchToAppsScriptTelegramMode() {
  PROP.setProperty(TELEGRAM_RUNTIME_MODE_PROPERTY, 'apps_script');
  const out = {
    ok: true,
    telegramRuntimeMode: 'apps_script',
    note: 'Для активации webhook запустите __setWebhookProd()',
    buildVersion: BUILD_VERSION
  };
  Logger.log(JSON.stringify(out));
  return out;
}

function __enableTelegramBotWithSheets(webAppExecUrl) {
  const mode = __switchToAppsScriptTelegramMode();
  let setUrl = null;
  const incomingUrl = String(webAppExecUrl || '').trim();
  if (incomingUrl) setUrl = __setWebAppExecUrl(incomingUrl);
  const webhook = __setWebhookProd();
  const commands = __setTelegramBotCommands();
  const scenarios = __checkButtonScenariosAndSheet();
  const out = {
    ok: true,
    buildVersion: BUILD_VERSION,
    mode: mode,
    setUrl: setUrl,
    webhook: webhook,
    commands: commands,
    scenarios: scenarios
  };
  Logger.log(JSON.stringify(out));
  return out;
}

function __checkSheetHeaders() {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const missing = REQUIRED_HEADERS.filter(function(header) { return !map[header]; });
  const out = {
    ok: missing.length === 0,
    missing: missing,
    sheetName: sheet.getName(),
    buildVersion: BUILD_VERSION
  };
  Logger.log(JSON.stringify(out));
  return out;
}

function __checkButtonScenariosAndSheet() {
  const cfg = __checkConfiguration();
  const headers = __checkSheetHeaders();
  const mode = getTelegramRuntimeMode();

  const scenarios = [
    { step: 'Группа: ВЫХОЖУ НА ЗАЯВКУ', expectedStatus: ORDER_STATUSES.TAKEN, expectedColumns: ['Master ID', 'Master Name', 'Дата принятия'] },
    { step: 'Мастер: ПРИЕХАЛ НА ОБЪЕКТ', expectedStatus: ORDER_STATUSES.ARRIVED, expectedColumns: ['Дата прибытия'] },
    { step: 'Мастер: ЗАВЕРШИЛ ЗАЯВКУ', expectedStatus: ORDER_STATUSES.WAITING_PAYMENT, expectedColumns: ['Дата завершения'] },
    { step: 'Мастер: ОПЛАТА ПОЛУЧЕНА', expectedStatus: ORDER_STATUSES.DONE, expectedColumns: ['Дата оплаты'] },
    { step: 'Мастер: ОТМЕНИТЬ ЗАЯВКУ', expectedStatus: ORDER_STATUSES.PUBLISHED, expectedColumns: ['Master ID', 'Master Name', 'Дата принятия'] }
  ];

  const out = {
    ok: headers.ok,
    buildVersion: BUILD_VERSION,
    telegramRuntimeMode: mode,
    configuration: cfg,
    headers: headers,
    scenarios: scenarios,
    note: mode === 'direct'
      ? 'Apps Script Telegram callbacks отключены (direct mode).'
      : 'Сценарии активны в Apps Script режиме.'
  };
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

function __setEventsChatId(chatId) {
  const id = String(chatId || '').trim();
  if (!id) throw new Error('Передайте chatId');
  PROP.setProperty('TELEGRAM_EVENTS_CHAT_ID', id);
  const out = { ok: true, telegramEventsChatId: id, buildVersion: BUILD_VERSION };
  Logger.log(JSON.stringify(out));
  return out;
}

function __setWebAppExecUrl(url) {
  let normalized = normalizeWebhookUrlToExec(url);
  if (normalized && !isUsableWebhookTarget(normalized)) normalized = '';
  if (!normalized) normalized = normalizeWebhookUrlToExec(getCurrentServiceExecUrl());
  if (normalized && !isUsableWebhookTarget(normalized)) normalized = '';
  if (!normalized) normalized = normalizeWebhookUrlToExec(PROP.getProperty(WEBAPP_EXEC_URL_PROPERTY));
  if (normalized && !isUsableWebhookTarget(normalized)) normalized = '';

  if (!normalized) {
    const token = getTelegramBotToken();
    if (token) {
      const info = urlFetchJson('https://api.telegram.org/bot' + token + '/getWebhookInfo', { method: 'get' });
      if (info && info.ok === true && info.result && info.result.url) {
        const webhookUrl = normalizeWebhookUrlToExec(info.result.url);
        if (isUsableWebhookTarget(webhookUrl)) normalized = webhookUrl;
      }
    }
  }

  if (!normalized) throw new Error('Не удалось автоматически определить URL Web App (/exec). Передайте URL вручную.');

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
  const token = getTelegramBotToken();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в Script Properties');

  if (isDirectTelegramRuntime()) {
    const delDirect = urlFetchJson('https://api.telegram.org/bot' + token + '/deleteWebhook', {
      method: 'post',
      payload: JSON.stringify({ drop_pending_updates: true })
    });
    const outDirect = {
      ok: true,
      skipped: true,
      reason: 'direct_telegram_runtime_enabled',
      deleteWebhook: delDirect,
      note: 'Webhook для Apps Script отключен, обработка в direct mode',
      buildVersion: BUILD_VERSION
    };
    Logger.log(JSON.stringify(outDirect));
    return outDirect;
  }

  const baseExecUrl = resolveWebhookExecUrl('');
  if (!baseExecUrl) throw new Error('Не удалось определить URL Web App');
  const targetInfo = resolveTelegramWebhookTarget(baseExecUrl);
  const targetUrl = targetInfo && targetInfo.targetUrl ? targetInfo.targetUrl : baseExecUrl;
  if (!isUsableWebhookTarget(targetUrl)) {
    throw new Error('Некорректный URL webhook target. Убедитесь, что используется публичный /exec URL.');
  }
  if (targetInfo && targetInfo.authBlocked) {
    throw new Error('Web App требует авторизацию Google. Переразверните Web App: Execute as me, Who has access: Anyone.');
  }

  const del = urlFetchJson('https://api.telegram.org/bot' + token + '/deleteWebhook', {
    method: 'post',
    payload: JSON.stringify({ drop_pending_updates: true })
  });

  const set = urlFetchJson('https://api.telegram.org/bot' + token + '/setWebhook', {
    method: 'post',
    payload: JSON.stringify({
      url: targetUrl,
      allowed_updates: ['message', 'edited_message', 'callback_query']
    })
  });

  const info = urlFetchJson('https://api.telegram.org/bot' + token + '/getWebhookInfo', { method: 'get' });
  PROP.setProperty(WEBAPP_EXEC_URL_PROPERTY, baseExecUrl);
  PROP.setProperty(WEBHOOK_LAST_SYNC_TS_PROPERTY, String(Date.now()));

  const out = {
    ok: !!(set && set.ok === true),
    buildVersion: BUILD_VERSION,
    baseExecUrl: baseExecUrl,
    targetUrl: targetUrl,
    redirectProbe: targetInfo ? targetInfo.redirectProbe : null,
    redirectProbeGet: targetInfo ? targetInfo.redirectProbeGet : null,
    authBlocked: !!(targetInfo && targetInfo.authBlocked),
    deleteWebhook: del,
    setWebhook: set,
    webhookInfo: info
  };
  Logger.log(JSON.stringify(out));
  return out;
}

function __setTelegramBotCommands() {
  const token = getTelegramBotToken();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в Script Properties');

  if (isDirectTelegramRuntime()) {
    const outSkip = {
      ok: true,
      skipped: true,
      reason: 'direct_telegram_runtime_enabled',
      note: 'Команды выставляет внешний direct bot',
      buildVersion: BUILD_VERSION
    };
    Logger.log(JSON.stringify(outSkip));
    return outSkip;
  }

  const privateCommands = [
    { command: 'myid', description: 'Показать user_id и chat_id' },
    { command: 'setmanager', description: 'Назначить этого пользователя менеджером' },
    { command: 'setevents', description: 'Назначить этот чат чатом событий' },
    { command: 'setgroup', description: 'Назначить этот чат группой заявок' },
    { command: 'setnsk', description: 'Назначить этот чат Новосибирском' },
    { command: 'testgroup', description: 'Отправить тест кнопки в группу' },
    { command: 'myorder', description: 'Моя текущая заявка' },
    { command: 'arrived', description: 'Я приехал на объект' },
    { command: 'done', description: 'Работы завершены' },
    { command: 'paid', description: 'Оплата от клиента получена' },
    { command: 'cancel', description: 'Отменить текущую заявку' },
    { command: 'menu', description: 'Сценарии кнопок и команды' },
    { command: 'panel', description: 'Показать панель кнопок' },
    { command: 'hidepanel', description: 'Скрыть панель кнопок' },
    { command: 'active', description: 'Заявки в работе (менеджер)' },
    { command: 'planned', description: 'Запланированные заявки (менеджер)' },
    { command: 'pay', description: 'Выбрать заявку и отправить оплату' },
    { command: 'help', description: 'Справка по командам' }
  ];

  const groupCommands = [
    { command: 'myid', description: 'Показать user_id и chat_id' },
    { command: 'setmanager', description: 'Назначить этого пользователя менеджером' },
    { command: 'setevents', description: 'Назначить этот чат чатом событий' },
    { command: 'setgroup', description: 'Назначить этот чат группой заявок' },
    { command: 'setnsk', description: 'Назначить этот чат Новосибирском' },
    { command: 'testgroup', description: 'Отправить тест кнопки в группу' },
    { command: 'menu', description: 'Сценарии кнопок и команды' },
    { command: 'panel', description: 'Показать панель кнопок' },
    { command: 'hidepanel', description: 'Скрыть панель кнопок' },
    { command: 'active', description: 'Заявки в работе сейчас' },
    { command: 'planned', description: 'Запланированные заявки' },
    { command: 'pay', description: 'Выбрать заявку и отправить оплату' },
    { command: 'help', description: 'Справка по командам' }
  ];

  const defaultResp = urlFetchJson('https://api.telegram.org/bot' + token + '/setMyCommands', {
    method: 'post',
    payload: JSON.stringify({ commands: privateCommands, scope: { type: 'default' } })
  });

  const privateResp = urlFetchJson('https://api.telegram.org/bot' + token + '/setMyCommands', {
    method: 'post',
    payload: JSON.stringify({ commands: privateCommands, scope: { type: 'all_private_chats' } })
  });

  const groupResp = urlFetchJson('https://api.telegram.org/bot' + token + '/setMyCommands', {
    method: 'post',
    payload: JSON.stringify({ commands: groupCommands, scope: { type: 'all_group_chats' } })
  });

  const out = {
    ok: !!(
      defaultResp && defaultResp.ok === true &&
      privateResp && privateResp.ok === true &&
      groupResp && groupResp.ok === true
    ),
    buildVersion: BUILD_VERSION,
    defaultSet: defaultResp,
    privateSet: privateResp,
    groupSet: groupResp
  };
  Logger.log(JSON.stringify(out));
  return out;
}

function __hardResetBotRouting() {
  if (isDirectTelegramRuntime()) return __switchToDirectTelegramMode();
  return __setWebhookProd();
}

function __setProdUrlAndCheckButton(url) {
  const target = normalizeWebhookUrlToExec(url) || normalizeWebhookUrlToExec(getCurrentServiceExecUrl());
  if (!target) throw new Error('Не удалось определить целевой /exec URL');

  const setUrl = __setWebAppExecUrl(target);
  const setWebhook = __setWebhookProd();
  const check = __checkAllButtonReasons(target);

  const out = {
    ok: !!(check && check.ok),
    buildVersion: BUILD_VERSION,
    targetUrl: target,
    setUrl: setUrl,
    setWebhook: setWebhook,
    check: check
  };
  Logger.log(JSON.stringify(out));
  return out;
}

function __getTelegramWebhookInfo() {
  const token = getTelegramBotToken();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в Script Properties');
  const info = urlFetchJson('https://api.telegram.org/bot' + token + '/getWebhookInfo', { method: 'get' });
  const out = { ok: true, buildVersion: BUILD_VERSION, webhookInfo: info };
  Logger.log(JSON.stringify(out));
  return out;
}

function __checkButtonEndToEnd(targetUrl) {
  return __checkAllButtonReasons(targetUrl || '');
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

  const token = getTelegramBotToken();
  const spreadsheetId = String(PROP.getProperty('SPREADSHEET_ID') || '').trim();
  const chatNovosibirsk = String(PROP.getProperty('TELEGRAM_CHAT_NOVOSIBIRSK') || '').trim();
  const chatFallback = String(PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim();
  const managerChatId = getManagerChatId();
  const eventsChatId = getEventsChatId();

  const serviceExecUrl = normalizeWebhookUrlToExec(getCurrentServiceExecUrl());
  const storedExecUrl = normalizeWebhookUrlToExec(PROP.getProperty(WEBAPP_EXEC_URL_PROPERTY));
  const resolvedExecUrl = normalizeWebhookUrlToExec(resolveWebhookExecUrl(targetUrl || ''));

  out.checks.properties = {
    runtimeMode: getTelegramRuntimeMode(),
    tokenSet: !!token,
    spreadsheetIdSet: !!spreadsheetId,
    telegramChatNovosibirskSet: !!chatNovosibirsk,
    telegramChatFallbackSet: !!chatFallback,
    managerChatIdSet: !!managerChatId,
    eventsChatIdSet: !!eventsChatId
  };

  out.checks.urls = {
    serviceExecUrl: serviceExecUrl || '',
    storedExecUrl: storedExecUrl || '',
    resolvedExecUrl: resolvedExecUrl || ''
  };

  if (isDirectTelegramRuntime()) {
    out.warnings.push('Apps Script Telegram routing отключен (direct mode).');
    out.advice.push('Кнопки/команды обрабатывает внешний direct bot.');
    Logger.log(JSON.stringify(out));
    return out;
  }

  if (!token) pushFailure('TELEGRAM_BOT_TOKEN не задан.', 'Добавьте TELEGRAM_BOT_TOKEN в Script Properties.');
  if (!spreadsheetId) pushFailure('SPREADSHEET_ID не задан.', 'Добавьте SPREADSHEET_ID в Script Properties.');
  if (!chatNovosibirsk && !chatFallback) pushFailure('Не задан chat id для публикации заявок.', 'Добавьте TELEGRAM_CHAT_NOVOSIBIRSK или TELEGRAM_CHAT_ID.');
  if (!eventsChatId) pushWarning('TELEGRAM_EVENTS_CHAT_ID не задан.', 'Задайте TELEGRAM_EVENTS_CHAT_ID для отдельной группы уведомлений менеджера.');
  if (!resolvedExecUrl) pushFailure('Не удалось определить Web App URL (/exec).', 'Запустите __setWebAppExecUrl("ВАШ_/exec_URL"), затем __setWebhookProd().');
  if (storedExecUrl && serviceExecUrl && storedExecUrl !== serviceExecUrl) {
    pushWarning('stored WEBAPP_EXEC_URL не совпадает с ScriptApp.getService().getUrl().', 'Обычно это значит, что вы смотрите на старый деплой.');
  }

  if (token) {
    const me = urlFetchJson('https://api.telegram.org/bot' + token + '/getMe', { method: 'get' });
    out.checks.telegramGetMe = me;
    if (!me || me.ok !== true || !me.result) {
      pushFailure('Telegram getMe вернул ошибку (токен/бот недоступен).', 'Проверьте TELEGRAM_BOT_TOKEN и запустите проверку снова.');
    }

    const webhookInfo = urlFetchJson('https://api.telegram.org/bot' + token + '/getWebhookInfo', { method: 'get' });
    out.checks.webhookInfo = webhookInfo;
    if (!webhookInfo || webhookInfo.ok !== true || !webhookInfo.result) {
      pushFailure('Не удалось получить getWebhookInfo.', 'Проверьте токен и доступность Telegram API.');
    } else {
      const currentWebhookUrl = normalizeWebhookUrlToExec(webhookInfo.result.url);
      const targetInfo = resolveTelegramWebhookTarget(resolvedExecUrl || '');
      const expectedWebhookTargetUrl = targetInfo.targetUrl || (resolvedExecUrl || '');
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
        expectedWebhookTargetUrl: expectedWebhookTargetUrl || '',
        authBlocked: !!(targetInfo && targetInfo.authBlocked),
        pendingUpdateCount: pending,
        allowedUpdates: allowed,
        hasCallbackQuery: hasCallback,
        lastErrorMessage: lastError || '',
        lastErrorDate: lastErrorDate || 0
      };

      if (!currentWebhookUrl) {
        pushFailure('Webhook в Telegram не установлен.', 'Запустите __setWebhookProd().');
      } else if (isGoogleLoginUrl(currentWebhookUrl)) {
        pushFailure('Webhook указывает на страницу логина Google.', 'Web App закрыт авторизацией. Разверните Web App с доступом "Anyone".');
      } else if (expectedWebhookTargetUrl && !webhookUrlsEquivalent(currentWebhookUrl, expectedWebhookTargetUrl)) {
        pushFailure('Webhook указывает не на ожидаемый URL (после редиректа).', 'Переразверните текущий Web App и снова запустите __setWebhookProd().');
      }

      if (targetInfo && targetInfo.authBlocked) {
        pushFailure('Web App закрыт авторизацией Google.', 'Переразверните Web App: Execute as me, Who has access: Anyone.');
      }

      if (!hasCallback) {
        pushFailure('В webhook не включен callback_query.', 'Запустите __setWebhookProd(), он задаст allowed_updates корректно.');
      }

      if (pending > 0) {
        pushWarning('У webhook есть pending updates: ' + pending + '.', 'Обычно это временно. Если долго не уходит, заново поставьте webhook.');
      }

      if (lastError) {
        pushWarning('Telegram сообщает last_error_message: ' + lastError, 'После исправлений нажмите кнопку и снова запустите диагностику.');
      }
    }
  }

  if (resolvedExecUrl) {
    const health = checkWebAppPublicHealth(resolvedExecUrl);
    out.checks.webAppHealth = health;
    if (!health.ok || health.statusCode !== 200 || !health.bodyJson || health.bodyJson.ok !== true) {
      pushFailure('Web App health-check неуспешен (внешний GET /?health=1).', 'Переразверните Web App: Execute as me, Who has access: Anyone.');
    }

    const probe = __probeWebhookDoPostVersion(resolvedExecUrl);
    out.checks.doPostProbe = probe;
    if (!probe || probe.ok !== true) {
      pushFailure('Внешний POST до doPost неуспешен.', 'Проверьте публичность Web App и что используется URL именно с /exec.');
    } else {
      const body = probe.bodyJson || {};
      const action = String(body.action || '').trim();
      const probeBuild = String(body.buildVersion || '').trim();
      const probeError = String(body.error || '').trim();

      if (action !== 'probe_version' || body.ok !== true) {
        pushFailure('doPost ответил не на probe_version (возможен старый код/другой деплой).', 'Проверьте, что webhook смотрит на текущий /exec URL.');
      }
      if (probeBuild && probeBuild !== BUILD_VERSION) {
        pushFailure('doPost вернул другой buildVersion: ' + probeBuild, 'Это не текущая версия скрипта. Нужен новый деплой.');
      }
      if (probeError && probeError.toLowerCase().indexOf('unknown action') !== -1) {
        pushFailure('doPost вернул unknown action на probe_version.', 'Это почти всегда признак старого/чужого backend URL.');
      }
    }
  }

  const parserSamples = [
    'take:CLN-12345678',
    'take_CLN-12345678',
    'take|CLN-12345678',
    '{"action":"take","orderId":"CLN-12345678"}',
    'paid:CLN-12345678'
  ];
  const parserChecks = [];
  for (let i = 0; i < parserSamples.length; i++) {
    const sample = parserSamples[i];
    const parsed = parseCallbackActionData(sample);
    parserChecks.push({ sample: sample, parsed: parsed });
    const expectedAction = sample.indexOf('paid:') === 0 ? CALLBACK_ACTIONS.PAID : CALLBACK_ACTIONS.TAKE;
    if (!parsed || parsed.action !== expectedAction || parsed.orderId !== 'CLN-12345678') {
      pushFailure('parseCallbackActionData не проходит self-test для: ' + sample, 'Проверьте parseCallbackActionData в текущей версии кода.');
    }
  }
  out.checks.callbackParser = parserChecks;

  if (!out.failures.length) {
    out.advice.push('Критических проблем не найдено. Если кнопка не реагирует, нажмите кнопку и сразу запустите __getTelegramWebhookInfo() и __checkButtonEndToEnd() повторно.');
  }

  Logger.log(JSON.stringify(out));
  return out;
}

function checkWebAppPublicHealth(execUrl) {
  const url = normalizeWebhookUrlToExec(execUrl);
  if (!url) {
    return { ok: false, statusCode: 0, bodyJsonOk: false, error: 'empty_url', url: '' };
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
  const token = getTelegramBotToken();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в Script Properties');
  const resp = urlFetchJson('https://api.telegram.org/bot' + token + '/deleteWebhook', {
    method: 'post',
    payload: JSON.stringify({ drop_pending_updates: true })
  });
  Logger.log(JSON.stringify(resp));
  return resp;
}

function __probeWebhookDoPostVersion(targetUrl) {
  const url = resolveWebhookExecUrl(targetUrl || '');
  if (!url) return { ok: false, error: 'webhook_url_not_available', buildVersion: BUILD_VERSION };

  try {
    const resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      payload: 'action=probe_version',
      muteHttpExceptions: true,
      followRedirects: true
    });

    const code = resp.getResponseCode();
    const bodyText = String(resp.getContentText() || '');
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
  const token = getTelegramBotToken();
  const chat = String(PROP.getProperty('TELEGRAM_CHAT_NOVOSIBIRSK') || PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан');
  if (!chat) throw new Error('TELEGRAM_CHAT_NOVOSIBIRSK/TELEGRAM_CHAT_ID не задан');

  const resp = urlFetchJson('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    payload: JSON.stringify({ chat_id: chat, text: '✅ Тест Telegram из Apps Script' })
  });

  Logger.log(JSON.stringify(resp));
  return resp;
}

function __sendTestGroupMessage() {
  const token = getTelegramBotToken();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан');

  const managerChat = String(getManagerChatId() || PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim();
  const out = sendGroupCallbackTestMessage(token, managerChat, managerChat);
  Logger.log(JSON.stringify(out));
  return out;
}

function __repairTelegramButtonsAndSendTest(webAppExecUrl) {
  const mode = __switchToAppsScriptTelegramMode();
  let setUrl = null;
  const incomingUrl = normalizeWebhookUrlToExec(webAppExecUrl || '');
  if (incomingUrl) setUrl = __setWebAppExecUrl(incomingUrl);

  const webhook = __setWebhookProd();
  const commands = __setTelegramBotCommands();
  const diagnostics = __checkAllButtonReasons(incomingUrl || '');
  const testMessage = __sendTestGroupMessage();

  const out = {
    ok: !!(
      webhook && webhook.ok !== false &&
      commands && commands.ok === true &&
      diagnostics && diagnostics.ok === true &&
      testMessage && testMessage.ok === true
    ),
    buildVersion: BUILD_VERSION,
    mode: mode,
    setUrl: setUrl,
    webhook: webhook,
    commands: commands,
    diagnostics: diagnostics,
    testMessage: testMessage
  };
  Logger.log(JSON.stringify(out));
  return out;
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
    orderDate: Utilities.formatDate(new Date(), scriptTimeZone(), 'dd.MM.yyyy'),
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
