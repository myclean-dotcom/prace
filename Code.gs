// Code.gs - чистая версия backend для заявок и Telegram
// Развертывается как Google Apps Script Web App

const PROP = PropertiesService.getScriptProperties();

const BUILD_VERSION = '2026-02-18-clean-v6';
const SHEET_NAME = 'Заявки';
const WEBAPP_EXEC_URL_PROPERTY = 'WEBAPP_EXEC_URL';
const DEFAULT_WEBAPP_EXEC_URL = '';

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

function getCellFromRowByHeader(rowValues, headerMap, headerName) {
  const col = headerMap[headerName];
  if (!col) return '';
  return rowValues[col - 1];
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
    }, 200);
  }

  setTelegramIdsForOrder(orderId, publishResult.chatId, publishResult.messageId);

  return jsonResponse({
    ok: true,
    orderId: orderId,
    chat: String(publishResult.chatId),
    messageId: publishResult.messageId,
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
    'Дата прибытия': '',
    'Дата завершения': '',
    'Напоминание 24ч': '',
    'Напоминание 2ч': '',
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
    worksDescription: String(order['Описание работ'] || '').trim(),
    equipment: String(order['Оборудование'] || '').trim(),
    chemistry: String(order['Химия'] || '').trim()
  };
}

function sendOrderToGroup(order, fallbackTelegramChannel) {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!token) return { ok: false, reason: 'token_not_set' };

  const chatId = resolveTelegramChat(order.customerCity, fallbackTelegramChannel);
  if (!chatId) return { ok: false, reason: 'chat_not_set' };

  const briefText = generateBriefText(order);
  const callbackData = makeTakeCallbackData(order.orderId);

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

  if (!sendResp || sendResp.ok !== true || !sendResp.result) {
    Logger.log('Telegram sendMessage failed: ' + JSON.stringify(sendResp));
    return { ok: false, reason: 'telegram_error', telegram: sendResp || null };
  }

  return {
    ok: true,
    chatId: String(chatId),
    messageId: String(sendResp.result.message_id || '').trim(),
    telegram: sendResp
  };
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

    const parsed = parseCallbackActionData(data);
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
      const status = String(order['Статус'] || '').toLowerCase().trim();
      const currentMasterId = String(order['Master ID'] || '').trim();

      const masterId = String(from.id || '').trim();
      let masterName = `${from.first_name || ''} ${from.last_name || ''}`.trim();
      if (!masterName && from.username) masterName = '@' + from.username;
      if (!masterName) masterName = 'Мастер';

      if (!masterId || !orderId) {
        answerCallback(token, callbackId, '❌ Не удалось обработать заявку');
        return jsonResponse({ ok: false, error: 'Bad callback payload', buildVersion: BUILD_VERSION }, 200);
      }

      if (parsed.action === 'take') {
        if (status.indexOf('взята') !== -1 || status.indexOf('на объекте') !== -1) {
          if (currentMasterId && currentMasterId === masterId) {
            answerCallback(token, callbackId, 'ℹ️ Вы уже приняли эту заявку');
            return jsonResponse({ ok: true, alreadyTakenBySameMaster: true, buildVersion: BUILD_VERSION }, 200);
          }
          answerCallback(token, callbackId, '❌ Заявка уже принята другим мастером');
          return jsonResponse({ ok: true, alreadyTaken: true, buildVersion: BUILD_VERSION }, 200);
        }

        if (status.indexOf('заверш') !== -1) {
          answerCallback(token, callbackId, '❌ Заявка уже завершена');
          return jsonResponse({ ok: true, alreadyDone: true, buildVersion: BUILD_VERSION }, 200);
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
              parse_mode: 'HTML',
              reply_markup: buildMasterActionKeyboard(orderId)
            })
          });

          if (dm1 && dm1.ok === true) {
            const dmMessageIds = [];
            if (dm1.result && dm1.result.message_id !== undefined && dm1.result.message_id !== null) {
              dmMessageIds.push(String(dm1.result.message_id));
            }

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
                  { text: '📤 ОТКРЫТЬ ТЕКСТ ДЛЯ ОТПРАВКИ', url: shareUrl }
                ]]
              };
            }

            const dm2 = urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: 'post',
              payload: JSON.stringify(dm2Payload)
            });
            if (dm2 && dm2.ok === true && dm2.result && dm2.result.message_id !== undefined && dm2.result.message_id !== null) {
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

        return jsonResponse({ ok: true, orderId: orderId, action: 'take', buildVersion: BUILD_VERSION }, 200);
      }

      if (parsed.action === 'arrive') {
        if (!isOrderAssignedToMaster(status, currentMasterId, masterId)) {
          answerCallback(token, callbackId, '❌ Только назначенный мастер может отметить прибытие');
          return jsonResponse({ ok: true, denied: true, action: 'arrive', buildVersion: BUILD_VERSION }, 200);
        }

        const arrivedAt = formatDateTime(new Date());
        updateOrderArrivedByRow(rowNum, arrivedAt);
        const updatedOrder = getOrderByRow(rowNum);

        answerCallback(token, callbackId, '✅ Отметка о прибытии сохранена');
        updateMasterActionMessageAfterArrive(token, cbChatId, cbMessageId, orderId);
        notifyManagerNeedInvoice(updatedOrder, masterName, arrivedAt);
        return jsonResponse({ ok: true, orderId: orderId, action: 'arrive', buildVersion: BUILD_VERSION }, 200);
      }

      if (parsed.action === 'done') {
        if (!isOrderAssignedToMaster(status, currentMasterId, masterId)) {
          answerCallback(token, callbackId, '❌ Только назначенный мастер может завершить заявку');
          return jsonResponse({ ok: true, denied: true, action: 'done', buildVersion: BUILD_VERSION }, 200);
        }

        const doneAt = formatDateTime(new Date());
        updateOrderDoneByRow(rowNum, doneAt);
        const updatedOrder = getOrderByRow(rowNum);

        answerCallback(token, callbackId, '✅ Заявка отмечена как завершенная');
        clearMasterActionMessage(token, cbChatId, cbMessageId);
        notifyManagerOrderDone(updatedOrder, masterName, doneAt);
        return jsonResponse({ ok: true, orderId: orderId, action: 'done', buildVersion: BUILD_VERSION }, 200);
      }

      if (parsed.action === 'cancel') {
        if (!currentMasterId || currentMasterId !== masterId) {
          answerCallback(token, callbackId, '❌ Только назначенный мастер может отменить заявку');
          return jsonResponse({ ok: true, denied: true, action: 'cancel', buildVersion: BUILD_VERSION }, 200);
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
        }, 200);
      }

      answerCallback(token, callbackId, 'Неизвестное действие');
      return jsonResponse({ ok: true, ignored: true, buildVersion: BUILD_VERSION }, 200);
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

    let saved = null;
    if (userId && fileId) {
      saved = appendPhotoByMasterId(userId, fileId, caption);
    }

    forwardMasterPhotoToManager(token, body.message, saved);

    urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'post',
      payload: JSON.stringify({
        chat_id: userId,
        text: '✅ Фото получено, спасибо!'
      })
    });

    return jsonResponse({ ok: true, buildVersion: BUILD_VERSION }, 200);
  }

  if (body.message && body.message.text) {
    return handleTextMessage(body.message, token);
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
  setCellByHeader(sheet, rowNum, map, 'Дата прибытия', '');
  setCellByHeader(sheet, rowNum, map, 'Дата завершения', '');
  setCellByHeader(sheet, rowNum, map, 'Напоминание 24ч', '');
  setCellByHeader(sheet, rowNum, map, 'Напоминание 2ч', '');
  setCellByHeader(sheet, rowNum, map, 'Статус выполнения', '');
}

function isOrderAssignedToMaster(statusLower, currentMasterId, masterId) {
  const status = String(statusLower || '').toLowerCase();
  const current = String(currentMasterId || '').trim();
  const master = String(masterId || '').trim();
  if (!current || !master) return false;
  if (current !== master) return false;
  return (
    status.indexOf('взята') !== -1 ||
    status.indexOf('на объекте') !== -1
  );
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

function buildMasterActionKeyboard(orderId) {
  return {
    inline_keyboard: [
      [{ text: '📍 ПРИЕХАЛ НА ОБЪЕКТ', callback_data: makeCallbackData('arrive', orderId) }],
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
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ ЗАВЕРШИЛ ЗАЯВКУ', callback_data: makeCallbackData('done', orderId) }],
          [{ text: '❌ ОТМЕНИТЬ ЗАЯВКУ', callback_data: makeCallbackData('cancel', orderId) }]
        ]
      }
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

  urlFetchJson(`https://api.telegram.org/bot${token}/deleteMessage`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: chat,
      message_id: Number(msg)
    })
  });
}

function appendPhotoByMasterId(masterId, fileId, caption) {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const rowNum = findLatestActiveOrderRowByMasterId(String(masterId || '').trim(), sheet, map);
  if (!rowNum) return null;

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

  const orderId = String(getOrderByRow(rowNum)['Номер заявки'] || '').trim();
  return { rowNum: rowNum, orderId: orderId };
}

function findLatestActiveOrderRowByMasterId(masterId, sheet, headerMap) {
  const id = String(masterId || '').trim();
  if (!id) return null;

  const activeSheet = sheet || getSheet();
  const map = headerMap || getHeaderMap(activeSheet);
  const masterCol = map['Master ID'];
  const statusCol = map['Статус'];
  const lastRow = activeSheet.getLastRow();
  if (!masterCol || !statusCol || lastRow < 2) return null;

  const rows = activeSheet.getRange(2, 1, lastRow - 1, activeSheet.getLastColumn()).getValues();
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const rowMaster = String(row[masterCol - 1] || '').trim();
    const status = String(row[statusCol - 1] || '').toLowerCase().trim();
    if (rowMaster !== id) continue;
    if (status.indexOf('взята') === -1 && status.indexOf('на объекте') === -1) continue;
    return i + 2;
  }

  return null;
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
    text += '<b>📝 ПОЖЕЛАНИЯ / ОПИСАНИЕ РАБОТ</b>\n';
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
  const query = [String(city || '').trim(), String(fullAddress || '').trim()]
    .filter(Boolean)
    .join(', ');
  if (!query) return '';
  const longUrl = 'https://2gis.ru/search/' + encodeURIComponent(query);
  return shortenUrlWithCache(longUrl);
}

function shortenUrlWithCache(url) {
  const longUrl = String(url || '').trim();
  if (!longUrl) return '';

  const cache = CacheService.getScriptCache();
  const key = 'short_' + Utilities.base64EncodeWebSafe(longUrl).slice(0, 180);
  const cached = cache.get(key);
  if (cached) return cached;

  const shortUrl = tryShortenUrl(longUrl) || longUrl;
  cache.put(key, shortUrl, 6 * 60 * 60);
  return shortUrl;
}

function tryShortenUrl(url) {
  const longUrl = String(url || '').trim();
  if (!longUrl) return '';

  try {
    const resp = UrlFetchApp.fetch('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(longUrl), {
      method: 'get',
      muteHttpExceptions: true,
      followRedirects: true
    });
    const code = resp.getResponseCode();
    const text = String(resp.getContentText() || '').trim();
    if (code >= 200 && code < 300 && /^https?:\/\//i.test(text)) {
      return text;
    }
  } catch (err) {}

  return '';
}

function buildTelegramShareUrl(messageText) {
  const text = String(messageText || '').trim();
  if (!text) return '';
  return 'https://t.me/share/url?url=&text=' + encodeURIComponent(text);
}

function buildPhoneLink(rawPhone) {
  const source = String(rawPhone || '').trim();
  if (!source) return '';

  let normalized = source.replace(/[^\d+]/g, '');
  if (normalized.indexOf('+') > 0) {
    normalized = normalized.replace(/\+/g, '');
  }
  if (normalized && normalized[0] !== '+' && /^\d+$/.test(normalized)) {
    normalized = '+' + normalized;
  }

  if (!/^\+?\d{6,20}$/.test(normalized)) return '';
  return 'tel:' + normalized;
}

function getManagerChatId() {
  return String(
    PROP.getProperty('TELEGRAM_MANAGER_CHAT_ID') ||
    PROP.getProperty('TELEGRAM_ADMIN_CHAT_ID') ||
    ''
  ).trim();
}

function notifyManagerNeedInvoice(order, masterName, arrivedAt) {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  const managerChatId = getManagerChatId();
  if (!token || !managerChatId) return;

  const orderId = escapeTelegramHtml(order['Номер заявки'] || '');
  const fullAddress = [
    String(order['Улица и дом'] || '').trim(),
    String(order['Квартира/офис'] || '').trim()
  ].filter(Boolean).join(', ');
  const dateTime = formatDateTimeForDisplay(order['Дата уборки'], order['Время уборки']);

  let text = '🔔 <b>Мастер прибыл на заказ</b>\n';
  text += `Заявка: <code>${orderId}</code>\n`;
  text += `Мастер: ${escapeTelegramHtml(masterName || 'Мастер')}\n`;
  text += `Время отметки: ${escapeTelegramHtml(arrivedAt || '')}\n`;
  text += `Дата и время заявки: ${escapeTelegramHtml(dateTime)}\n`;
  text += `Адрес: ${escapeTelegramHtml(fullAddress || 'не указан')}\n`;
  text += '\n💳 Пора сформировать счёт на оплату.';

  urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: managerChatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });
}

function notifyManagerOrderDone(order, masterName, doneAt) {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  const managerChatId = getManagerChatId();
  if (!token || !managerChatId) return;

  const orderId = escapeTelegramHtml(order['Номер заявки'] || '');
  const text =
    '✅ <b>Заявка завершена</b>\n' +
    `Заявка: <code>${orderId}</code>\n` +
    `Мастер: ${escapeTelegramHtml(masterName || 'Мастер')}\n` +
    `Время: ${escapeTelegramHtml(doneAt || '')}`;

  urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: managerChatId,
      text: text,
      parse_mode: 'HTML'
    })
  });
}

function notifyManagerOrderCancelled(order, masterName, cancelledAt, republishResult) {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  const managerChatId = getManagerChatId();
  if (!token || !managerChatId) return;

  const orderId = escapeTelegramHtml(order['Номер заявки'] || '');
  const city = escapeTelegramHtml(order['Город'] || '');
  const republishOk = republishResult && republishResult.ok ? 'да' : 'нет';

  const text =
    '⚠️ <b>Мастер отменил заявку</b>\n' +
    `Заявка: <code>${orderId}</code>\n` +
    `Город: ${city}\n` +
    `Мастер: ${escapeTelegramHtml(masterName || 'Мастер')}\n` +
    `Время: ${escapeTelegramHtml(cancelledAt || '')}\n` +
    `Повторно отправлена в группу: ${escapeTelegramHtml(republishOk)}`;

  urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: managerChatId,
      text: text,
      parse_mode: 'HTML'
    })
  });
}

function forwardMasterPhotoToManager(token, message, savedInfo) {
  const managerChatId = getManagerChatId();
  if (!token || !managerChatId || !message || !message.photo) return;

  const photos = message.photo || [];
  const lastPhoto = photos.length ? photos[photos.length - 1] : null;
  const fileId = lastPhoto ? String(lastPhoto.file_id || '').trim() : '';
  if (!fileId) return;

  const from = message.from || {};
  const masterName = `${from.first_name || ''} ${from.last_name || ''}`.trim() || (from.username ? '@' + from.username : 'Мастер');
  const orderId = savedInfo && savedInfo.orderId ? String(savedInfo.orderId) : '';
  const caption = String(message.caption || '').trim();

  let text = '📷 <b>Фото от мастера</b>\n';
  text += `Мастер: ${escapeTelegramHtml(masterName)}\n`;
  if (orderId) text += `Заявка: <code>${escapeTelegramHtml(orderId)}</code>\n`;
  if (caption) text += `Комментарий: ${escapeTelegramHtml(caption)}\n`;
  text += `Время: ${escapeTelegramHtml(formatDateTime(new Date()))}`;

  urlFetchJson(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: managerChatId,
      photo: fileId,
      caption: text,
      parse_mode: 'HTML'
    })
  });
}

function handleTextMessage(message, token) {
  const text = String(message.text || '').trim();
  if (!text) return jsonResponse({ ok: true, ignored: true, buildVersion: BUILD_VERSION }, 200);

  const managerChatId = getManagerChatId();
  const chatId = String((message.chat && message.chat.id) || '').trim();
  const fromId = String((message.from && message.from.id) || '').trim();
  const isManager = !!managerChatId && (chatId === managerChatId || fromId === managerChatId);

  if (!isManager) {
    return jsonResponse({ ok: true, ignored: true, buildVersion: BUILD_VERSION }, 200);
  }

  const helpText =
    'Команды менеджера:\n' +
    '/pay ORDER_ID ССЫЛКА_НА_ОПЛАТУ\n' +
    'Пример:\n' +
    '/pay CLN-12345678 https://example.com/pay/abc';

  if (/^\/?(help|start)$/i.test(text)) {
    urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'post',
      payload: JSON.stringify({ chat_id: chatId, text: helpText })
    });
    return jsonResponse({ ok: true, action: 'help', buildVersion: BUILD_VERSION }, 200);
  }

  const pay = text.match(/^\/?(pay|оплата)\s+([A-Za-z0-9_-]+)\s+(https?:\/\/\S+)$/i);
  if (!pay) {
    return jsonResponse({ ok: true, ignored: true, buildVersion: BUILD_VERSION }, 200);
  }

  const orderId = String(pay[2] || '').trim();
  const paymentUrl = String(pay[3] || '').trim();
  const senderName =
    `${(message.from && message.from.first_name) || ''} ${(message.from && message.from.last_name) || ''}`.trim() ||
    ((message.from && message.from.username) ? '@' + message.from.username : 'Менеджер');

  const result = sendPaymentLinkToMaster(orderId, paymentUrl, senderName);

  if (result.ok) {
    urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'post',
      payload: JSON.stringify({
        chat_id: chatId,
        text: `✅ Ссылка на оплату отправлена мастеру по заявке ${orderId}`
      })
    });
  } else {
    urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'post',
      payload: JSON.stringify({
        chat_id: chatId,
        text: `❌ Не удалось отправить ссылку по заявке ${orderId}: ${result.error || 'неизвестная ошибка'}`
      })
    });
  }

  return jsonResponse({ ok: true, action: 'pay', result: result, buildVersion: BUILD_VERSION }, 200);
}

function sendPaymentLinkToMaster(orderId, paymentUrl, managerName) {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!token) return { ok: false, error: 'token_not_set' };

  const rowNum = findOrderRowById(orderId);
  if (!rowNum) return { ok: false, error: 'order_not_found' };

  const order = getOrderByRow(rowNum);
  const masterId = String(order['Master ID'] || '').trim();
  if (!masterId) return { ok: false, error: 'master_not_assigned' };

  const safeOrderId = escapeTelegramHtml(orderId);
  const safeManagerName = escapeTelegramHtml(managerName || 'Менеджер');
  const safeUrl = escapeTelegramHtml(paymentUrl);

  const text =
    '💳 <b>Ссылка на оплату</b>\n' +
    `Заявка: <code>${safeOrderId}</code>\n` +
    `Отправил: ${safeManagerName}\n` +
    `Ссылка: ${safeUrl}`;

  const resp = urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: masterId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });

  if (!resp || resp.ok !== true) {
    return { ok: false, error: 'telegram_send_failed', telegram: resp || null };
  }

  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const mark = `Ссылка на оплату отправлена ${formatDateTime(new Date())}`;
  setCellByHeader(sheet, rowNum, map, 'Статус выполнения', mark);

  return { ok: true, orderId: orderId, masterId: masterId };
}

/* ---------- Callback parsing & dedupe ---------- */

function makeCallbackData(action, orderId) {
  const actionName = String(action || '').trim().toLowerCase();
  const id = String(orderId || '').trim();
  if (!actionName || !id) return '';
  return `${actionName}|${id}`;
}

function makeTakeCallbackData(orderId) {
  return makeCallbackData('take', orderId);
}

function parseCallbackActionData(data) {
  const raw = String(data || '').trim();
  if (!raw) return null;

  const v2 = raw.match(/^(take|arrive|done|cancel)\|(.+)$/);
  if (v2) {
    const action = String(v2[1] || '').trim();
    const id = String(v2[2] || '').trim();
    return (action && id) ? { action: action, orderId: id } : null;
  }

  if (raw.indexOf('takev2|') === 0) {
    const id = String(raw.split('|')[1] || '').trim();
    return id ? { action: 'take', orderId: id } : null;
  }

  if (raw.indexOf('take_') === 0) {
    const id = String(raw.replace(/^take_/, '') || '').trim();
    return id ? { action: 'take', orderId: id } : null;
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

function markMasterDmSent(orderId, masterId, messageIds) {
  const id = String(orderId || '').trim();
  if (!id) return;
  const by = String(masterId || '').trim() || 'unknown';
  const msgIds = Array.isArray(messageIds)
    ? messageIds.map(function(v) { return String(v || '').trim(); }).filter(Boolean)
    : [];

  PROP.setProperty('ORDER_DM_SENT_' + id, by + '|' + formatDateTime(new Date()));
  PROP.setProperty('ORDER_DM_META_' + id, JSON.stringify({
    chatId: by,
    messageIds: msgIds,
    ts: formatDateTime(new Date())
  }));
}

function clearMasterDmSent(orderId) {
  const id = String(orderId || '').trim();
  if (!id) return;
  PROP.deleteProperty('ORDER_DM_SENT_' + id);
  PROP.deleteProperty('ORDER_DM_META_' + id);
}

function deleteMasterDmMessages(token, orderId) {
  const id = String(orderId || '').trim();
  if (!id) return;

  const rawMeta = String(PROP.getProperty('ORDER_DM_META_' + id) || '').trim();
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

  return '';
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
    defaultWebAppExecUrl: DEFAULT_WEBAPP_EXEC_URL,
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

function sendReminders() {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!token) {
    const out = { ok: false, error: 'TELEGRAM_BOT_TOKEN not set', buildVersion: BUILD_VERSION };
    Logger.log(JSON.stringify(out));
    return out;
  }

  const sheet = getSheet();
  const headerMap = getHeaderMap(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    const out = { ok: true, scanned: 0, sent24h: 0, sent2h: 0, buildVersion: BUILD_VERSION };
    Logger.log(JSON.stringify(out));
    return out;
  }

  const rows = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const twoHoursMs = 2 * 60 * 60 * 1000;
  let sent24h = 0;
  let sent2h = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;

    const status = String(getCellFromRowByHeader(row, headerMap, 'Статус') || '').toLowerCase().trim();
    const orderId = String(getCellFromRowByHeader(row, headerMap, 'Номер заявки') || '').trim();
    const masterId = String(getCellFromRowByHeader(row, headerMap, 'Master ID') || '').trim();
    const dateValue = getCellFromRowByHeader(row, headerMap, 'Дата уборки');
    const timeValue = getCellFromRowByHeader(row, headerMap, 'Время уборки');
    const mark24h = String(getCellFromRowByHeader(row, headerMap, 'Напоминание 24ч') || '').trim();
    const mark2h = String(getCellFromRowByHeader(row, headerMap, 'Напоминание 2ч') || '').trim();

    if (!orderId || !masterId) continue;
    if (status.indexOf('отмен') !== -1 || status.indexOf('заверш') !== -1) continue;
    if (status.indexOf('взята') === -1 && status.indexOf('на объекте') === -1) continue;

    const dt = parseOrderDateTime(dateValue, timeValue);
    if (!dt) continue;

    const diffMs = dt.getTime() - now.getTime();
    if (diffMs <= 0) continue;

    if (!mark24h && diffMs <= dayMs && diffMs > twoHoursMs) {
      const text =
        `⏰ <b>Напоминание за 24 часа</b>\n` +
        `Заявка <code>${escapeTelegramHtml(orderId)}</code> завтра в ${escapeTelegramHtml(formatDateTimeForDisplay(dateValue, timeValue))}.`;

      urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'post',
        payload: JSON.stringify({
          chat_id: masterId,
          text: text,
          parse_mode: 'HTML'
        })
      });

      setCellByHeader(sheet, rowNum, headerMap, 'Напоминание 24ч', 'Отправлено ' + formatDateTime(now));
      sent24h++;
    }

    if (!mark2h && diffMs <= twoHoursMs && diffMs > 0) {
      const text =
        `🚨 <b>Напоминание за 2 часа</b>\n` +
        `Заявка <code>${escapeTelegramHtml(orderId)}</code> скоро начнется: ${escapeTelegramHtml(formatDateTimeForDisplay(dateValue, timeValue))}.`;

      urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'post',
        payload: JSON.stringify({
          chat_id: masterId,
          text: text,
          parse_mode: 'HTML'
        })
      });

      setCellByHeader(sheet, rowNum, headerMap, 'Напоминание 2ч', 'Отправлено ' + formatDateTime(now));
      sent2h++;
    }
  }

  const out = {
    ok: true,
    scanned: rows.length,
    sent24h: sent24h,
    sent2h: sent2h,
    buildVersion: BUILD_VERSION
  };
  Logger.log(JSON.stringify(out));
  return out;
}

function __installReminderTrigger() {
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

function __setWebAppExecUrl(url) {
  const normalized =
    normalizeWebhookUrlToExec(url) ||
    normalizeWebhookUrlToExec(getCurrentServiceExecUrl());

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
