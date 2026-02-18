// Code.gs - чистая версия backend для заявок и Telegram
// Развертывается как Google Apps Script Web App

const PROP = PropertiesService.getScriptProperties();

const BUILD_VERSION = '2026-02-18-clean-v1';
const SHEET_NAME = 'Заявки';
const WEBAPP_EXEC_URL_PROPERTY = 'WEBAPP_EXEC_URL';
const DEFAULT_WEBAPP_EXEC_URL = 'https://script.google.com/macros/s/AKfycbyJhU9LoZbVCCtEPQCK4u3_VlQS0qBv9fcjLUHXgK0aNFSFcxLXqgIHa8dJ_i7eB4Ef/exec';

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
      }, 200);
    }

    const html = HtmlService.createHtmlOutput(
      '<!doctype html><html><head><meta charset="utf-8"><title>WebApp Active</title></head>' +
      '<body style="font-family:Arial,sans-serif;padding:24px;">' +
      '<h2>Web App развернут</h2>' +
      '<p>Этот URL используется как backend endpoint (webhook/API).</p>' +
      '<p>Проверка: добавьте <code>?health=1</code> к URL.</p>' +
      `<p>buildVersion: <code>${escapeHtml(BUILD_VERSION)}</code></p>` +
      '</body></html>'
    );
    return html.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message, buildVersion: BUILD_VERSION }, 500);
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
      return jsonResponse({ ok: true, action: 'probe_version', buildVersion: BUILD_VERSION }, 200);
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
    }, 400);
  } catch (err) {
    Logger.log('doPost error: ' + err.message + '\n' + (err.stack || ''));
    return jsonResponse({ ok: false, error: err.message, buildVersion: BUILD_VERSION }, 500);
  }
}

/* ---------- Request parsing ---------- */

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

function tryParseJson(value) {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}

function unwrapBodyPayload(body) {
  let current = body || {};

  for (let i = 0; i < 6; i++) {
    if (typeof current === 'string') {
      const parsedString = tryParseJson(current);
      if (parsedString) {
        current = parsedString;
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

  const currentHeaders = sheet
    .getRange(1, 1, 1, width)
    .getValues()[0]
    .map(function(h) { return String(h || '').trim(); });

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
  const headers = sheet
    .getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0]
    .map(function(h) { return String(h || '').trim(); });

  const row = headers.map(function(header) {
    return Object.prototype.hasOwnProperty.call(rowData, header) ? rowData[header] : '';
  });

  sheet.appendRow(row);
}

function findOrderRowById(orderId) {
  const target = String(orderId || '').trim();
  if (!target) return null;

  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const col = map['Номер заявки'];
  const lastRow = sheet.getLastRow();

  if (!col || lastRow < 2) return null;

  const values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === target) {
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

  const rows = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (String(row[chatCol - 1] || '').trim() === chat && String(row[msgCol - 1] || '').trim() === msg) {
      return i + 2;
    }
  }

  return null;
}

function setCellByHeader(sheet, row, headerMap, headerName, value) {
  const col = headerMap[headerName];
  if (!col) return;
  sheet.getRange(row, col).setValue(value);
}

function getOrderByRow(rowNum) {
  const sheet = getSheet();
  const headers = sheet
    .getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0]
    .map(function(h) { return String(h || '').trim(); });

  const values = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];
  const out = {};

  for (let i = 0; i < headers.length; i++) {
    if (headers[i]) out[headers[i]] = values[i];
  }

  return out;
}

/* ---------- Order create/update ---------- */

function createOrUpdateOrder(payload, action) {
  const sheet = getSheet();
  const orderId = String(payload.orderId || '').trim() || ('CLN-' + Date.now().toString().slice(-8));

  const order = {
    orderId: orderId,
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
    worksDescription: String(payload.worksDescription || '').trim(),
    createdAt: normalizeCreatedAtValue(payload.createdAt || payload._ts)
  };

  if (action === 'update') {
    const rowNum = findOrderRowById(orderId);
    if (rowNum) {
      updateOrderRow(rowNum, order);
      return jsonResponse({ ok: true, orderId: orderId, updated: true, buildVersion: BUILD_VERSION }, 200);
    }
  }

  const rowData = buildOrderRowData(order, 'Опубликована');
  appendOrderRow(sheet, rowData);

  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  const chatId = resolveTelegramChat(order.customerCity, payload.telegramChannel);

  if (!token) {
    return jsonResponse({ ok: true, orderId: orderId, note: 'saved, token not set', buildVersion: BUILD_VERSION }, 200);
  }

  if (!chatId) {
    return jsonResponse({ ok: true, orderId: orderId, note: 'saved, chat id not set', buildVersion: BUILD_VERSION }, 200);
  }

  const briefText = generateBriefText(order);
  const callbackData = makeTakeCallbackData(orderId);

  const sendResp = urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: chatId,
      text: briefText,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ ВЫХОЖУ НА ЗАЯВКУ', callback_data: callbackData }
        ]]
      },
      disable_web_page_preview: true
    })
  });

  if (!sendResp || sendResp.ok !== true) {
    Logger.log('Telegram sendMessage failed: ' + JSON.stringify(sendResp));
    return jsonResponse({ ok: true, orderId: orderId, note: 'saved, telegram error', telegram: sendResp || null, buildVersion: BUILD_VERSION }, 200);
  }

  setTelegramIdsForOrder(orderId, chatId, sendResp.result.message_id);

  return jsonResponse({
    ok: true,
    orderId: orderId,
    chat: String(chatId),
    messageId: sendResp.result.message_id,
    buildVersion: BUILD_VERSION
  }, 200);
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
    'Статус выполнения': ''
  };
}

function updateOrderRow(rowNum, order) {
  const sheet = getSheet();
  const headers = sheet
    .getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0]
    .map(function(h) { return String(h || '').trim(); });

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
    const header = headers[i];
    if (Object.prototype.hasOwnProperty.call(map, header)) {
      row[i] = map[header];
    }
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

/* ---------- Telegram callback ---------- */

function handleTelegramUpdate(body) {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!token) return jsonResponse({ ok: false, error: 'Token not set', buildVersion: BUILD_VERSION }, 500);

  if (body.callback_query) {
    const cb = body.callback_query;
    const callbackId = String(cb.id || '').trim();
    const data = String(cb.data || '').trim();
    const from = cb.from || {};
    const message = cb.message || {};
    const cbChatId = message.chat ? String(message.chat.id || '') : '';
    const cbMessageId = String(message.message_id || '');

    if (isDuplicateCallback(callbackId)) {
      answerCallback(token, callbackId, 'ℹ️ Нажатие уже обработано');
      return jsonResponse({ ok: true, duplicate: true, buildVersion: BUILD_VERSION }, 200);
    }

    const parsed = parseTakeCallbackData(data);
    if (!parsed) {
      answerCallback(token, callbackId, 'Неизвестное действие');
      return jsonResponse({ ok: true, ignored: true, buildVersion: BUILD_VERSION }, 200);
    }

    const lock = LockService.getScriptLock();
    if (!lock.tryLock(3000)) {
      answerCallback(token, callbackId, '⏳ Попробуйте снова через пару секунд');
      return jsonResponse({ ok: true, busy: true, buildVersion: BUILD_VERSION }, 200);
    }

    try {
      let rowNum = findOrderRowById(parsed.orderId);
      if (!rowNum) rowNum = findOrderRowByTelegramMessage(cbChatId, cbMessageId);

      if (!rowNum) {
        answerCallback(token, callbackId, '❌ Заявка не найдена');
        return jsonResponse({ ok: false, error: 'Order not found', buildVersion: BUILD_VERSION }, 200);
      }

      const order = getOrderByRow(rowNum);
      const orderId = String(order['Номер заявки'] || parsed.orderId || '').trim();
      const status = String(order['Статус'] || '').toLowerCase();
      const currentMasterId = String(order['Master ID'] || '').trim();

      const masterId = String(from.id || '').trim();
      let masterName = `${from.first_name || ''} ${from.last_name || ''}`.trim();
      if (!masterName && from.username) masterName = '@' + from.username;
      if (!masterName) masterName = 'Мастер';

      if (!masterId || !orderId) {
        answerCallback(token, callbackId, '❌ Не удалось обработать заявку');
        return jsonResponse({ ok: false, error: 'Bad callback payload', buildVersion: BUILD_VERSION }, 200);
      }

      if (status.indexOf('взята') !== -1) {
        if (currentMasterId && currentMasterId === masterId) {
          answerCallback(token, callbackId, 'ℹ️ Вы уже приняли эту заявку');
          return jsonResponse({ ok: true, alreadyTakenBySameMaster: true, buildVersion: BUILD_VERSION }, 200);
        }
        answerCallback(token, callbackId, '❌ Заявка уже принята другим мастером');
        return jsonResponse({ ok: true, alreadyTaken: true, buildVersion: BUILD_VERSION }, 200);
      }

      const takenAt = formatDateTime(new Date());
      updateOrderTakenByRow(rowNum, masterId, masterName, takenAt);
      answerCallback(token, callbackId, '✅ Заявка принята. Отправляю детали в личные сообщения.');

      const updatedOrder = getOrderByRow(rowNum);

      if (!isMasterDmAlreadySent(orderId)) {
        const fullText = generateFullText(updatedOrder);

        const dm1 = urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'post',
          payload: JSON.stringify({
            chat_id: masterId,
            text: fullText,
            parse_mode: 'HTML'
          })
        });

        if (dm1 && dm1.ok === true) {
          const clientMessage = buildClientReadyMessage(updatedOrder);
          urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'post',
            payload: JSON.stringify({
              chat_id: masterId,
              text: `📩 Сообщение клиенту (скопируйте и отправьте):\n\n<code>${escapeTelegramHtml(clientMessage)}</code>`,
              parse_mode: 'HTML'
            })
          });
          markMasterDmSent(orderId, masterId);
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

      return jsonResponse({ ok: true, orderId: orderId, buildVersion: BUILD_VERSION }, 200);
    } catch (err) {
      Logger.log('callback error: ' + err.message + '\n' + (err.stack || ''));
      answerCallback(token, callbackId, '❌ Ошибка обработки кнопки. Нажмите еще раз.');
      return jsonResponse({ ok: false, error: err.message, buildVersion: BUILD_VERSION }, 200);
    } finally {
      try { lock.releaseLock(); } catch (err) {}
    }
  }

  if (body.message && body.message.photo && body.message.from) {
    const userId = String(body.message.from.id || '').trim();
    const photos = body.message.photo || [];
    const lastPhoto = photos.length ? photos[photos.length - 1] : null;
    const fileId = lastPhoto ? String(lastPhoto.file_id || '').trim() : '';
    const caption = String(body.message.caption || '').trim();

    if (userId && fileId) {
      appendPhotoByMasterId(userId, fileId, caption);
    }

    urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'post',
      payload: JSON.stringify({
        chat_id: userId,
        text: '✅ Фото получено, спасибо!'
      })
    });

    return jsonResponse({ ok: true, buildVersion: BUILD_VERSION }, 200);
  }

  return jsonResponse({ ok: true, buildVersion: BUILD_VERSION }, 200);
}

function updateOrderTakenByRow(rowNum, masterId, masterName, takenAt) {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);

  setCellByHeader(sheet, rowNum, map, 'Статус', 'Взята');
  setCellByHeader(sheet, rowNum, map, 'Master ID', String(masterId || '').trim());
  setCellByHeader(sheet, rowNum, map, 'Master Name', String(masterName || '').trim());
  setCellByHeader(sheet, rowNum, map, 'Дата принятия', String(takenAt || '').trim());
}

function appendPhotoByMasterId(masterId, fileId, caption) {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const masterCol = map['Master ID'];
  const lastRow = sheet.getLastRow();
  if (!masterCol || lastRow < 2) return;

  const values = sheet.getRange(2, masterCol, lastRow - 1, 1).getValues();
  let rowNum = null;
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === String(masterId || '').trim()) {
      rowNum = i + 2;
      break;
    }
  }

  if (!rowNum) return;

  const statusDoneCol = map['Статус выполнения'] || REQUIRED_HEADERS.length;
  const firstPhotoCol = statusDoneCol + 1;
  const lastCol = sheet.getLastColumn();

  let targetCol = null;
  for (let c = firstPhotoCol; c <= lastCol; c++) {
    const current = sheet.getRange(rowNum, c).getValue();
    if (!current) {
      targetCol = c;
      break;
    }
  }

  if (!targetCol) {
    targetCol = Math.max(lastCol + 1, firstPhotoCol);
    const photoIndex = targetCol - firstPhotoCol + 1;
    sheet.getRange(1, targetCol).setValue('Фото ' + photoIndex);
  }

  const value = `${fileId} | ${caption} | ${formatDateTime(new Date())}`;
  sheet.getRange(rowNum, targetCol).setValue(value);
}

/* ---------- Telegram text ---------- */

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
    text += `\n📝 Пожелания: ${escapeTelegramHtml(order.worksDescription)}\n`;
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
  const clientPhone = escapeTelegramHtml(order['Телефон клиента'] || 'не указан');
  const orderTotal = escapeTelegramHtml(order['Сумма заказа'] || '0');
  const masterPay = escapeTelegramHtml(order['Зарплата мастерам'] || '0');

  const fullAddress = [
    String(order['Улица и дом'] || '').trim(),
    String(order['Квартира/офис'] || '').trim()
  ].filter(Boolean).join(', ');

  const equipment = String(order['Оборудование'] || '').trim() || '—';
  const chemistry = String(order['Химия'] || '').trim() || '—';
  const description = String(order['Описание работ'] || '').trim();

  const clientMessage = buildClientReadyMessage(order);

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
  text += `Телефон: <code>${clientPhone}</code>\n\n`;

  text += '<b>🧰 ЧТО ВЗЯТЬ С СОБОЙ</b>\n';
  text += `Оборудование: ${escapeTelegramHtml(equipment)}\n`;
  text += `Химия: ${escapeTelegramHtml(chemistry)}\n\n`;

  if (description) {
    text += '<b>📝 ПОЖЕЛАНИЯ / ОПИСАНИЕ РАБОТ</b>\n';
    text += `${escapeTelegramHtml(description)}\n\n`;
  }

  text += '<b>💰 ФИНАНСЫ</b>\n';
  text += `Сумма заказа: ${orderTotal} руб\n`;
  text += `Ваша оплата: ${masterPay} руб\n\n`;

  text += '<b>✅ ЧТО НУЖНО СДЕЛАТЬ</b>\n';
  text += '1️⃣ Написать клиенту готовое сообщение из блока ниже.\n';
  text += '2️⃣ Подготовьтесь ответственно к заявке: заранее возьмите нужное оборудование, спланируйте, как добраться, и приезжайте без опозданий.\n';
  text += '3️⃣ Отправьте фотографии химии и оборудования, когда прибудете на объект.\n';
  text += '4️⃣ После работы отправьте фотографии выполненных работ.\n';
  text += '5️⃣ Отправьте фото подписанного акта выполненных работ.\n';
  text += '6️⃣ Подтвердите оплату от клиента.\n\n';

  text += '<b>💬 ГОТОВОЕ СООБЩЕНИЕ КЛИЕНТУ</b>\n';
  text += `<code>${escapeTelegramHtml(clientMessage)}</code>\n\n`;
  text += `🔖 Версия: <code>${escapeTelegramHtml(BUILD_VERSION)}</code>`;

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

/* ---------- Callback parsing & dedupe ---------- */

function makeTakeCallbackData(orderId) {
  return `take|${String(orderId || '').trim()}`;
}

function parseTakeCallbackData(data) {
  const raw = String(data || '').trim();
  if (!raw) return null;

  if (raw.indexOf('take|') === 0) {
    const id = String(raw.split('|')[1] || '').trim();
    return id ? { orderId: id } : null;
  }

  if (raw.indexOf('takev2|') === 0) {
    const id = String(raw.split('|')[1] || '').trim();
    return id ? { orderId: id } : null;
  }

  if (raw.indexOf('take_') === 0) {
    const id = String(raw.replace(/^take_/, '') || '').trim();
    return id ? { orderId: id } : null;
  }

  return null;
}

function isDuplicateCallback(callbackId) {
  const id = String(callbackId || '').trim();
  if (!id) return false;

  const cache = CacheService.getScriptCache();
  const key = 'cbq_' + id;
  const exists = cache.get(key);
  if (exists) return true;

  cache.put(key, '1', 600);
  return false;
}

function isMasterDmAlreadySent(orderId) {
  const id = String(orderId || '').trim();
  if (!id) return false;
  const key = 'ORDER_DM_SENT_' + id;
  return String(PROP.getProperty(key) || '').trim() !== '';
}

function markMasterDmSent(orderId, masterId) {
  const id = String(orderId || '').trim();
  if (!id) return;
  const by = String(masterId || '').trim() || 'unknown';
  PROP.setProperty('ORDER_DM_SENT_' + id, by + '|' + formatDateTime(new Date()));
}

/* ---------- Telegram API ---------- */

function checkTelegramBotStatus() {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!token) {
    return jsonResponse({
      ok: false,
      error: 'TELEGRAM_BOT_TOKEN не задан в Script Properties',
      buildVersion: BUILD_VERSION
    }, 200);
  }

  const resp = urlFetchJson(`https://api.telegram.org/bot${token}/getMe`, { method: 'get' });

  if (!resp || resp.ok !== true || !resp.result) {
    return jsonResponse({
      ok: false,
      error: 'Ошибка Telegram API',
      telegram: resp || null,
      buildVersion: BUILD_VERSION
    }, 200);
  }

  return jsonResponse({
    ok: true,
    bot: {
      id: resp.result.id,
      username: resp.result.username,
      first_name: resp.result.first_name
    },
    buildVersion: BUILD_VERSION
  }, 200);
}

function answerCallback(token, callbackId, text) {
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
    return { ok: false, raw: text, statusCode: resp.getResponseCode() };
  }
}

/* ---------- Formatting ---------- */

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

function normalizeCustomerName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.split(/\s+/)[0];
}

/* ---------- Routing / config ---------- */

function normalizeCityKey(city) {
  return String(city || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveTelegramChat(city, fallbackFromPayload) {
  const key = normalizeCityKey(city);

  const cityMap = {
    'новосибирск': String(PROP.getProperty('TELEGRAM_CHAT_NOVOSIBIRSK') || '').trim()
  };

  const cityChat = cityMap[key] || '';
  const fallback = String(fallbackFromPayload || PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim();
  return String(cityChat || fallback).trim();
}

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

  const def = normalizeWebhookUrlToExec(DEFAULT_WEBAPP_EXEC_URL);
  if (def) return def;

  return normalizeWebhookUrlToExec(getCurrentServiceExecUrl());
}

/* ---------- Diagnostics & setup ---------- */

function __setSpreadsheetId(spreadsheetId) {
  const id = String(spreadsheetId || '').trim();
  if (!id) throw new Error('Передайте spreadsheetId');

  PROP.setProperty('SPREADSHEET_ID', id);
  const sheet = getSheet();

  return {
    ok: true,
    spreadsheetId: id,
    sheetName: sheet.getName(),
    buildVersion: BUILD_VERSION
  };
}

function __checkConfiguration() {
  const out = {
    buildVersion: BUILD_VERSION,
    spreadsheetId: String(PROP.getProperty('SPREADSHEET_ID') || '').trim() || 'NOT_SET',
    botTokenSet: !!String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim(),
    telegramChatId: String(PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim() || 'NOT_SET',
    telegramChatNovosibirsk: String(PROP.getProperty('TELEGRAM_CHAT_NOVOSIBIRSK') || '').trim() || 'NOT_SET',
    storedWebAppExecUrl: String(PROP.getProperty(WEBAPP_EXEC_URL_PROPERTY) || '').trim() || 'NOT_SET',
    serviceExecUrl: getCurrentServiceExecUrl(),
    defaultWebAppExecUrl: DEFAULT_WEBAPP_EXEC_URL
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
      values[i][0] = norm;
      updated++;
    }
  }

  if (updated > 0) {
    sheet.getRange(2, col, values.length, 1).setValues(values);
  }

  const out = { ok: true, updated: updated, buildVersion: BUILD_VERSION };
  Logger.log(JSON.stringify(out));
  return out;
}

function __normalizeOrderDateTimeColumns() {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const dateCol = map['Дата уборки'];
  const timeCol = map['Время уборки'];
  const lastRow = sheet.getLastRow();

  if (!dateCol || !timeCol || lastRow < 2) {
    const out = { ok: true, updatedDate: 0, updatedTime: 0, buildVersion: BUILD_VERSION };
    Logger.log(JSON.stringify(out));
    return out;
  }

  const dateValues = sheet.getRange(2, dateCol, lastRow - 1, 1).getValues();
  const timeValues = sheet.getRange(2, timeCol, lastRow - 1, 1).getValues();

  let updatedDate = 0;
  let updatedTime = 0;

  for (let i = 0; i < dateValues.length; i++) {
    const prevDate = dateValues[i][0];
    const prevTime = timeValues[i][0];

    const normDate = normalizeOrderDateValue(prevDate);
    const normTime = normalizeOrderTimeValue(prevTime);

    if (String(prevDate || '') !== String(normDate || '')) {
      dateValues[i][0] = normDate;
      updatedDate++;
    }

    if (String(prevTime || '') !== String(normTime || '')) {
      timeValues[i][0] = normTime;
      updatedTime++;
    }
  }

  if (updatedDate > 0) {
    sheet.getRange(2, dateCol, dateValues.length, 1).setValues(dateValues);
  }

  if (updatedTime > 0) {
    sheet.getRange(2, timeCol, timeValues.length, 1).setValues(timeValues);
  }

  const out = { ok: true, updatedDate: updatedDate, updatedTime: updatedTime, buildVersion: BUILD_VERSION };
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

  const info = urlFetchJson(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
    method: 'get'
  });

  PROP.setProperty(WEBAPP_EXEC_URL_PROPERTY, url);

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

function __getTelegramWebhookInfo() {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в Script Properties');

  const info = urlFetchJson(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
    method: 'get'
  });

  const out = {
    buildVersion: BUILD_VERSION,
    webhookInfo: info
  };

  Logger.log(JSON.stringify(out));
  return out;
}

function __hardResetBotRouting() {
  return __setWebhookProd();
}

function __probeWebhookDoPostVersion(targetUrl) {
  const url = resolveWebhookExecUrl(targetUrl || '');
  if (!url) return { ok: false, error: 'webhook url not available' };

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

/* ---------- Helpers ---------- */

function jsonResponse(obj, code) {
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
