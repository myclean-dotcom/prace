// Code.gs - Google Apps Script для системы управления заявками клининга
// Вставляется в проект Google Apps Script

const PROP = PropertiesService.getScriptProperties();
const SHEET_NAME = 'Заявки';
const WEBAPP_EXEC_URL_PROPERTY = 'WEBAPP_EXEC_URL';
const DEFAULT_WEBAPP_EXEC_URL = 'https://script.google.com/macros/s/AKfycbztMUmZ__-JQXy_IpIh_6zGAGkzMZGd9LYfxnCybzcKfAw4CM9lNBawhh_LgGJjeTGj/exec';
const BUILD_VERSION = '2026-02-17-stable-take-flow-v8';
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
  'Напоминание 24ч',
  'Напоминание 2ч',
  'Статус выполнения'
];

const CITY_TELEGRAM_CHAT_MAP = {
  'новосибирск': PROP.getProperty('TELEGRAM_CHAT_NOVOSIBIRSK') || '-1003875039787'
};

// Главная функция для обработки POST запросов
function doPost(e) {
  try {
    const event = e || {};
    const raw = event.postData && event.postData.contents ? event.postData.contents : null;
    const param = event.parameter || {};
    const flatParameters = flattenParameters(event.parameters || {});
    let body = {};

    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch (err) {
        // raw может быть "json=%7B...%7D" или "payload=..."
        body = parseFormEncoded(raw) || param || flatParameters || {};
      }
    } else {
      body = Object.keys(param).length ? param : flatParameters;
    }

    body = normalizeIncomingBody(body);

    // Последний fallback: иногда нужные данные остаются только в parameters
    if ((!body.action && !body.orderId) && Object.keys(flatParameters).length) {
      body = normalizeIncomingBody(flatParameters);
    }

    // Логируем вход для отладки (посмотрите Execution logs)
    try { Logger.log('doPost raw: ' + String(raw)); } catch (e) {}
    try { Logger.log('doPost parameters: ' + JSON.stringify(param)); } catch (e) {}
    try { Logger.log('doPost parameters(flat): ' + JSON.stringify(flatParameters)); } catch (e) {}
    try { Logger.log('doPost body: ' + JSON.stringify(body)); } catch (e) {}

    // Обработка Telegram обновлений (callback_query или сообщения)
    if (body.callback_query || body.message || body.edited_message) {
      return handleTelegramUpdate(body);
    }

    // Обработка заявки с фронтенда (создание или обновление)
    if (body.action === 'probe_version') {
      return jsonResponse({
        ok: true,
        action: 'probe_version',
        buildVersion: BUILD_VERSION,
        time: formatCreatedAt(new Date())
      }, 200);
    }

    if (body.action === 'check_bot') {
      return checkTelegramBotStatus();
    }

    if (body.action === 'create' || body.action === 'update' || body.orderId) {
      return createOrUpdateOrder(body);
    }

    return jsonResponse({
      ok: false,
      error: 'unknown action',
      buildVersion: BUILD_VERSION,
      details: {
        bodyKeys: Object.keys(body || {}),
        rawPresent: !!raw
      }
    }, 400);
  } catch (err) {
    Logger.log('Error in doPost: ' + err.message);
    return jsonResponse({ ok: false, error: err.message, buildVersion: BUILD_VERSION }, 500);
  }
}

function flattenParameters(parameters) {
  const out = {};
  const src = parameters || {};
  const keys = Object.keys(src);

  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = src[k];
    out[k] = Array.isArray(v) ? v[0] : v;
  }

  return out;
}

function parseFormEncoded(raw) {
  const text = String(raw || '');
  if (!text || text.indexOf('=') === -1) return null;

  const obj = {};
  const pairs = text.split('&');

  for (let i = 0; i < pairs.length; i++) {
    if (!pairs[i]) continue;
    const parts = pairs[i].split('=');
    const key = decodeURIComponent((parts[0] || '').replace(/\+/g, ' '));
    const value = decodeURIComponent((parts.slice(1).join('=') || '').replace(/\+/g, ' '));
    if (!key) continue;
    obj[key] = value;
  }

  return obj;
}

function tryParseJson(value) {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch (e) {
    return null;
  }
}

function normalizeIncomingBody(body) {
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

/* ---------- Создание/обновление заявки ---------- */
function createOrUpdateOrder(payload) {
  const sheet = getSheet();
  const order = payload;
  const orderId = order.orderId || ('CLN-' + Date.now().toString().slice(-8));
  order.orderId = orderId;
  order._ts = formatCreatedAt(new Date());

  // Обновление существующей заявки
  if (payload.action === 'update' && payload.orderId) {
    const rowNum = findOrderRowById(orderId);
    if (rowNum) {
      updateOrderRow(rowNum, order);
      return jsonResponse({ ok: true, orderId, updated: true, buildVersion: BUILD_VERSION });
    }
  }

  // Добавление новой строки в таблицу
  const status = payload.action === 'update' ? 'Черновик' : 'Опубликована';
  const rowData = buildOrderRowData(order, status);
  appendOrderRow(sheet, rowData);

  // Отправка сообщения в Telegram
  const token = PROP.getProperty('TELEGRAM_BOT_TOKEN') || '';
  let chat = resolveTelegramChat(order);
  
  if (!token) return jsonResponse({ ok: true, orderId, note: 'saved, token not set', buildVersion: BUILD_VERSION });
  if (!chat) return jsonResponse({ ok: true, orderId, note: 'saved, chat id not set', buildVersion: BUILD_VERSION });
  ensureWebhookPinnedToCurrentDeployment(token);

  // Преобразуем форматChat ID если нужно
  if (chat.startsWith('@')) {
    // Это username группы, оставляем как есть
  } else if (!isNaN(chat)) {
    // Это число, преобразуем в строку и проверяем
    chat = chat.toString();
  }

  // Генерируем краткое сообщение для группы
  const briefText = generateBriefText(order);
  const keyboard = { 
    inline_keyboard: [[
      { text: "✅ ВЫХОЖУ НА ЗАЯВКУ", callback_data: `take_${order.orderId}` }
    ]]
  };

  const resp = urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify({ 
      chat_id: chat, 
      text: briefText, 
      parse_mode: 'HTML', 
      reply_markup: keyboard, 
      disable_web_page_preview: true 
    })
  });

  if (!resp || !resp.ok) {
    Logger.log('Telegram error: ' + JSON.stringify(resp));
    return jsonResponse({ ok: true, orderId, note: 'saved, telegram error', buildVersion: BUILD_VERSION });
  }

  // Сохраняем Telegram IDs в таблице
  setTelegramIdsForOrder(order.orderId, chat, resp.result.message_id);
  
  return jsonResponse({ ok: true, orderId, chat, messageId: resp.result.message_id, buildVersion: BUILD_VERSION });
}

function checkTelegramBotStatus() {
  const token = PROP.getProperty('TELEGRAM_BOT_TOKEN') || '';
  if (!token) {
    return jsonResponse({
      ok: false,
      error: 'TELEGRAM_BOT_TOKEN не задан в Script Properties',
      buildVersion: BUILD_VERSION
    }, 200);
  }

  const resp = urlFetchJson(`https://api.telegram.org/bot${token}/getMe`, {
    method: 'get'
  });

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

function formatCreatedAt(date) {
  return Utilities.formatDate(
    date || new Date(),
    Session.getScriptTimeZone(),
    'dd.MM.yyyy HH:mm:ss'
  );
}

/* ---------- Обработка обновлений из Telegram ---------- */
function handleTelegramUpdate(body) {
  const token = PROP.getProperty('TELEGRAM_BOT_TOKEN') || '';
  if (!token) return jsonResponse({ ok: false, error: 'Token not set', buildVersion: BUILD_VERSION }, 500);

  // Обработка нажатия кнопки "Выхожу на заявку"
  if (body.callback_query) {
    const cb = body.callback_query;
    const data = cb.data || '';
    const callbackId = cb.id;
    const from = cb.from || {};
    const cbChatId = cb.message && cb.message.chat ? cb.message.chat.id : '';
    const cbMessageId = cb.message ? cb.message.message_id : '';

    try { Logger.log('callback_query: ' + JSON.stringify({ id: callbackId, data: data, fromId: from.id })); } catch (e) {}
    let duplicateCallback = false;
    try {
      duplicateCallback = isDuplicateCallback(callbackId);
    } catch (e) {
      Logger.log('isDuplicateCallback failed: ' + e.message);
      duplicateCallback = false;
    }
    if (duplicateCallback) {
      answerCallback(token, callbackId, 'ℹ️ Нажатие уже обработано.');
      return jsonResponse({ ok: true, duplicateCallback: true, buildVersion: BUILD_VERSION }, 200);
    }
    
    if (data.indexOf('take_') === 0) {
      const orderId = String(data).replace(/^take_/, '').trim();
      if (!orderId) {
        answerCallback(token, callbackId, '❌ Некорректный ID заявки.');
        return jsonResponse({ ok: false, error: 'Invalid order id in callback', buildVersion: BUILD_VERSION }, 200);
      }

      const lock = LockService.getScriptLock();
      if (!lock.tryLock(500)) {
        answerCallback(token, callbackId, '⏳ Попробуйте снова через пару секунд.');
        return jsonResponse({ ok: true, busy: true, buildVersion: BUILD_VERSION }, 200);
      }

      try {
        try {
          let rowNum = findOrderRowById(orderId);
          if (!rowNum) {
            rowNum = findOrderRowByTelegramMessage(cbChatId, cbMessageId);
          }
          if (!rowNum) {
            answerCallback(token, callbackId, '❌ Заявка не найдена');
            return jsonResponse({ ok: false, error: 'Order not found', buildVersion: BUILD_VERSION }, 200);
          }

          const order = getOrderByRow(rowNum);
          const effectiveOrderId = String(order['Номер заявки'] || orderId || '').trim();
          if (!effectiveOrderId) {
            answerCallback(token, callbackId, '❌ Не удалось определить ID заявки.');
            return jsonResponse({ ok: false, error: 'Effective order id missing', buildVersion: BUILD_VERSION }, 200);
          }
          const masterId = String(from.id || '').trim();
          let masterName = `${from.first_name || ''} ${from.last_name || ''}`.trim();
          if (!masterName && from.username) masterName = '@' + from.username;
          if (!masterName) masterName = 'Мастер';
          if (!masterId) {
            answerCallback(token, callbackId, '❌ Не удалось определить ваш Telegram ID.');
            return jsonResponse({ ok: false, error: 'Master id missing', buildVersion: BUILD_VERSION }, 200);
          }

          // Блокируем повторное взятие заявки другим мастером.
          const currentStatus = String(order['Статус'] || '').toLowerCase();
          const existingMasterId = String(order['Master ID'] || '').trim();
          const existingMasterName = String(order['Master Name'] || '').trim();
          if (currentStatus.indexOf('взята') !== -1) {
            const takenBy = existingMasterName || (existingMasterId ? ('ID ' + existingMasterId) : 'другим мастером');
            if (existingMasterId && existingMasterId === masterId) {
              answerCallback(token, callbackId, 'ℹ️ Вы уже приняли эту заявку.');
              return jsonResponse({ ok: true, alreadyTakenBySameMaster: true, buildVersion: BUILD_VERSION }, 200);
            }
            answerCallback(token, callbackId, `❌ Заявка уже принята: ${takenBy}`);
            return jsonResponse({ ok: true, alreadyTaken: true, buildVersion: BUILD_VERSION }, 200);
          }

          const takenAt = formatCreatedAt(new Date());
          updateOrderTakenByRow(rowNum, masterId, masterName, takenAt);
          answerCallback(token, callbackId, '✅ Заявка принята. Отправляю подробности в личные сообщения...');

          // Получаем обновленную строку для отправки полной информации мастеру.
          const updatedOrder = getOrderByRow(rowNum);
          const fullText = generateFullText(updatedOrder, updatedOrder);
          let dmResp = { ok: true, skipped: true };
          const dmAlreadySent = isMasterDmAlreadySent(effectiveOrderId);
          if (!dmAlreadySent) {
            dmResp = urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: 'post',
              payload: JSON.stringify({
                chat_id: masterId,
                text: fullText,
                parse_mode: 'HTML'
              })
            });

            if (dmResp && dmResp.ok) {
              const clientMsg = buildClientReadyMessage(updatedOrder);
              const secondResp = urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'post',
                payload: JSON.stringify({
                  chat_id: masterId,
                  text: `📩 Сообщение клиенту (скопируйте и отправьте):\n\n<code>${escapeTelegramHtml(clientMsg)}</code>`,
                  parse_mode: 'HTML'
                })
              });
              if (!secondResp || secondResp.ok !== true) {
                Logger.log('Failed to send second DM for order ' + effectiveOrderId + ': ' + JSON.stringify(secondResp));
              }
              markMasterDmSent(effectiveOrderId, masterId);
            }
          } else {
            Logger.log('DM already sent for order ' + effectiveOrderId + ', skip duplicate send');
          }

          // Минимальный стабильный путь: только убираем кнопку у сообщения в группе.
          try {
            const chatId = updatedOrder['Telegram Chat ID'] || cbChatId;
            const messageId = updatedOrder['Telegram Message ID'] || cbMessageId;

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
          } catch (e) {
            Logger.log('Failed to update group message: ' + e);
          }

          if (!dmResp || dmResp.ok !== true) {
            Logger.log('Failed to send DM for order ' + effectiveOrderId + ': ' + JSON.stringify(dmResp));
          }

          return jsonResponse({ ok: true, masterAccepted: true, buildVersion: BUILD_VERSION }, 200);
        } catch (err) {
          Logger.log('Error while processing callback take_: ' + err.message + '\n' + (err.stack || ''));
          answerCallback(token, callbackId, '❌ Ошибка обработки кнопки. Нажмите еще раз через 2-3 секунды.');
          return jsonResponse({ ok: false, error: 'callback processing failed', details: err.message, buildVersion: BUILD_VERSION }, 200);
        }
      } finally {
        try { lock.releaseLock(); } catch (e) {}
      }
    }

    if (data.indexOf('reject_') === 0) {
      answerCallback(token, callbackId, '❌ Вы отказались от заявки.');
      return jsonResponse({ ok: true, buildVersion: BUILD_VERSION }, 200);
    }

    answerCallback(token, callbackId, 'Неизвестное действие.');
    return jsonResponse({ ok: true, buildVersion: BUILD_VERSION }, 200);
  }

  // Обработка фотографий от мастера
  if (body.message && body.message.photo && body.message.from) {
    const userId = body.message.from.id;
    const photo = body.message.photo.pop();
    const fileId = photo.file_id;
    const caption = body.message.caption || '';
    
    const rowNum = findOrderRowByMasterId(userId);
    if (rowNum) {
      appendPhotoToOrder(rowNum, fileId, caption);
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

  // Сохранение chat_id автоматически
  if (body.message && body.message.chat && body.message.chat.id) {
    const chatId = body.message.chat.id;
    const saved = PROP.getProperty('TELEGRAM_CHAT_ID') || '';
    if (!saved) PROP.setProperty('TELEGRAM_CHAT_ID', String(chatId));
  }

  return jsonResponse({ ok: true, buildVersion: BUILD_VERSION }, 200);
}

/* ---------- Функции для работы с таблицей (русские заголовки) ---------- */
function getSheet() {
  // Попытаемся открыть по ID из Script Properties, если задано (надёжнее для standalone деплоев)
  const ssId = PROP.getProperty('SPREADSHEET_ID') || null;
  let ss = null;
  try {
    if (ssId) ss = SpreadsheetApp.openById(ssId);
  } catch (e) {
    Logger.log('Failed to open by id: ' + ssId + ' — ' + e.message);
    ss = null;
  }

  if (!ss) {
    try {
      ss = SpreadsheetApp.getActiveSpreadsheet();
    } catch (e) {
      ss = null;
    }
  }

  if (!ss) {
    throw new Error(
      'Не удалось открыть Google Таблицу. Укажите Script Property SPREADSHEET_ID ' +
      'или запустите скрипт как контейнерный (bound) в нужной таблице.'
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

  const headers = sheet.getRange(1, 1, 1, width).getValues()[0].map(h => String(h || '').trim());
  const missing = REQUIRED_HEADERS.filter(h => headers.indexOf(h) === -1);
  if (!missing.length) return;

  let lastFilledHeaderCol = 0;
  for (let i = 0; i < headers.length; i++) {
    if (headers[i]) lastFilledHeaderCol = i + 1;
  }

  const startCol = Math.max(lastFilledHeaderCol + 1, 1);
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

function setCellByHeader(sheet, row, headerMap, headerName, value) {
  const col = headerMap[headerName];
  if (!col) return;
  sheet.getRange(row, col).setValue(value);
}

function getCellByHeader(rowValues, headerMap, headerName) {
  const col = headerMap[headerName];
  if (!col) return '';
  return rowValues[col - 1];
}

function buildOrderRowData(order, status) {
  const createdAt = normalizeCreatedAtValue(order._ts || order.createdAt);
  return {
    'Номер заявки': order.orderId || '',
    'Дата создания': createdAt,
    'Менеджер': order.manager || '',
    'Имя клиента': order.customerName || '',
    'Телефон клиента': order.customerPhone || '',
    'Город': order.customerCity || '',
    'Улица и дом': order.customerAddress || '',
    'Квартира/офис': order.customerFlat || '',
    'Дата уборки': order.orderDate || '',
    'Время уборки': order.orderTime || '',
    'Сумма заказа': order.orderTotal || '',
    'Зарплата мастерам': order.masterPay || '',
    'Тип уборки': order.cleaningType || '',
    'Площадь (м²)': order.area || '',
    'Химия': order.chemistry || '',
    'Оборудование': order.equipment || '',
    'Описание работ': order.worksDescription || '',
    'Статус': status || '',
    'Telegram Chat ID': '',
    'Telegram Message ID': '',
    'Master ID': '',
    'Master Name': '',
    'Дата принятия': '',
    'Напоминание 24ч': '',
    'Напоминание 2ч': '',
    'Статус выполнения': ''
  };
}

function normalizeCreatedAtValue(value) {
  if (value === null || value === undefined || value === '') {
    return formatCreatedAt(new Date());
  }

  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return formatCreatedAt(value);
  }

  const raw = String(value).trim();
  if (!raw) return formatCreatedAt(new Date());

  const parsed = new Date(raw);
  if (!isNaN(parsed.getTime())) {
    return formatCreatedAt(parsed);
  }

  return raw;
}

function appendOrderRow(sheet, rowData) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h || '').trim());
  const row = headers.map(h => Object.prototype.hasOwnProperty.call(rowData, h) ? rowData[h] : '');
  sheet.appendRow(row);
}

function normalizeCityKey(city) {
  return String(city || '').trim().toLowerCase();
}

function resolveTelegramChat(order) {
  const cityKey = normalizeCityKey(order.customerCity);
  const cityChat = CITY_TELEGRAM_CHAT_MAP[cityKey];
  const fallback = order.telegramChannel || PROP.getProperty('TELEGRAM_CHAT_ID') || '';
  return String(cityChat || fallback).trim();
}

function findOrderRowById(orderId) {
  const sheet = getSheet();
  const headerMap = getHeaderMap(sheet);
  const orderIdCol = headerMap['Номер заявки'];
  const lastRow = sheet.getLastRow();
  if (!orderIdCol || lastRow < 2) return null;

  const values = sheet.getRange(2, orderIdCol, lastRow - 1, 1).getValues();
  const target = String(orderId || '').trim();

  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === target) {
      return i + 2;
    }
  }
  
  return null;
}

function findOrderRowByTelegramMessage(chatId, messageId) {
  const sheet = getSheet();
  const headerMap = getHeaderMap(sheet);
  const chatCol = headerMap['Telegram Chat ID'];
  const msgCol = headerMap['Telegram Message ID'];
  const lastRow = sheet.getLastRow();
  if (!chatCol || !msgCol || lastRow < 2) return null;

  const rows = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const targetChat = String(chatId || '').trim();
  const targetMsg = String(messageId || '').trim();
  if (!targetChat || !targetMsg) return null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowChat = String(row[chatCol - 1] || '').trim();
    const rowMsg = String(row[msgCol - 1] || '').trim();
    if (rowChat === targetChat && rowMsg === targetMsg) {
      return i + 2;
    }
  }

  return null;
}

function findOrderRowByMasterId(masterId) {
  const sheet = getSheet();
  const headerMap = getHeaderMap(sheet);
  const masterIdCol = headerMap['Master ID'];
  const lastRow = sheet.getLastRow();
  if (!masterIdCol || lastRow < 2) return null;

  const values = sheet.getRange(2, masterIdCol, lastRow - 1, 1).getValues();
  const target = String(masterId || '');

  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === target) {
      return i + 2;
    }
  }
  
  return null;
}

function updateOrderRow(rowNum, order) {
  const sheet = getSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h || '').trim());
  const currentRow = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];
  const statusCol = headers.indexOf('Статус');
  const createdAt = normalizeCreatedAtValue(order._ts || order.createdAt);

  const map = {
    'Номер заявки': order.orderId || '',
    'Дата создания': createdAt,
    'Менеджер': order.manager || '',
    'Имя клиента': order.customerName || '',
    'Телефон клиента': order.customerPhone || '',
    'Город': order.customerCity || '',
    'Улица и дом': order.customerAddress || '',
    'Квартира/офис': order.customerFlat || '',
    'Дата уборки': order.orderDate || '',
    'Время уборки': order.orderTime || '',
    'Сумма заказа': order.orderTotal || '',
    'Зарплата мастерам': order.masterPay || '',
    'Тип уборки': order.cleaningType || '',
    'Площадь (м²)': order.area || '',
    'Химия': order.chemistry || '',
    'Оборудование': order.equipment || '',
    'Описание работ': order.worksDescription || '',
    'Статус': order.status || (statusCol >= 0 ? currentRow[statusCol] : '')
  };

  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    if (Object.prototype.hasOwnProperty.call(map, header)) {
      currentRow[i] = map[header];
    }
  }

  sheet.getRange(rowNum, 1, 1, currentRow.length).setValues([currentRow]);
}

function setTelegramIdsForOrder(orderId, chatId, messageId) {
  const row = findOrderRowById(orderId);
  if (!row) return;
  
  const sheet = getSheet();
  const headerMap = getHeaderMap(sheet);
  setCellByHeader(sheet, row, headerMap, 'Telegram Chat ID', chatId);
  setCellByHeader(sheet, row, headerMap, 'Telegram Message ID', messageId);
}

function updateOrderTakenByRow(rowNum, masterId, masterName, takenAt) {
  const sheet = getSheet();
  const headerMap = getHeaderMap(sheet);
  setCellByHeader(sheet, rowNum, headerMap, 'Статус', 'Взята');
  setCellByHeader(sheet, rowNum, headerMap, 'Master ID', masterId);
  setCellByHeader(sheet, rowNum, headerMap, 'Master Name', masterName);
  setCellByHeader(sheet, rowNum, headerMap, 'Дата принятия', takenAt);
}

function updateOrderTaken(orderId, masterId, masterName, takenAt) {
  const row = findOrderRowById(orderId);
  if (!row) return;
  updateOrderTakenByRow(row, masterId, masterName, takenAt);
}

function getOrderByRow(rowNum) {
  const sheet = getSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h || '').trim());
  const values = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];
  
  const obj = {};
  for (let i = 0; i < headers.length; i++) {
    if (headers[i]) obj[headers[i]] = values[i];
  }
  
  return obj;
}

function appendPhotoToOrder(rowNum, fileId, caption) {
  const sheet = getSheet();
  const headerMap = getHeaderMap(sheet);
  const statusDoneCol = headerMap['Статус выполнения'] || REQUIRED_HEADERS.length;
  const firstPhotoCol = statusDoneCol + 1;
  
  // Найдём последнюю заполненную колонку
  const lastCol = sheet.getLastColumn();
  
  // Проверим, есть ли уже колонка для фото
  let photoCol = null;
  for (let col = firstPhotoCol; col <= lastCol; col++) {
    const cellValue = sheet.getRange(rowNum, col).getValue();
    if (!cellValue) {
      photoCol = col;
      break;
    }
  }
  
  // Если нет пустой колонки, добавим новую
  if (!photoCol) {
    photoCol = Math.max(lastCol + 1, firstPhotoCol);
    sheet.getRange(1, photoCol).setValue('Фото ' + (photoCol - firstPhotoCol + 1));
  }
  
  // Сохраняем информацию о фото
  const photoInfo = `${fileId} | ${caption} | ${new Date().toLocaleString('ru-RU')}`;
  sheet.getRange(rowNum, photoCol).setValue(photoInfo);
}

/* ---------- Функции отправки напоминаний ---------- */
function sendReminders() {
  const sheet = getSheet();
  const token = PROP.getProperty('TELEGRAM_BOT_TOKEN') || '';
  
  if (!token) return;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const headerMap = getHeaderMap(sheet);
  const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  
  const now = new Date();
  
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const status = getCellByHeader(row, headerMap, 'Статус');
    const orderId = getCellByHeader(row, headerMap, 'Номер заявки');
    const masterId = getCellByHeader(row, headerMap, 'Master ID');
    const dateStr = getCellByHeader(row, headerMap, 'Дата уборки');
    const timeStr = getCellByHeader(row, headerMap, 'Время уборки');
    const sent24h = getCellByHeader(row, headerMap, 'Напоминание 24ч');
    const sent2h = getCellByHeader(row, headerMap, 'Напоминание 2ч');
    
    // Пропускаем если заявка не в статусе "Взята"
    if (String(status).indexOf('Взята') === -1 || !masterId) continue;
    
    const dt = parseOrderDateTime(dateStr, timeStr);
    if (!dt) continue;
    
    const diffMs = dt.getTime() - now.getTime();
    const dayMs = 24 * 60 * 60 * 1000;
    const twoHoursMs = 2 * 60 * 60 * 1000;
    
    // Напоминание за 24 часа
    if (diffMs <= dayMs && diffMs > dayMs - 60 * 60 * 1000 && !sent24h) {
      const text = `⏰ <b>Напоминание за 24 часа!</b>\n\nЗаявка <code>${orderId}</code> завтра. Проверьте детали и подготовьте оборудование.`;
      urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, { 
        method: 'post', 
        payload: JSON.stringify({ 
          chat_id: masterId, 
          text: text,
          parse_mode: 'HTML'
        }) 
      });
      
      // Отмечаем что напоминание отправлено
      setCellByHeader(sheet, i + 2, headerMap, 'Напоминание 24ч', 'Отправлено ' + new Date().toLocaleString('ru-RU'));
    }
    
    // Напоминание за 2 часа
    if (diffMs <= twoHoursMs && diffMs > twoHoursMs - 30 * 60 * 1000 && !sent2h) {
      const text = `🚨 <b>Срочное напоминание!</b>\n\nЗаявка <code>${orderId}</code> через 2 часа. Отправляйтесь на объект. Не забудьте сделать фото прибытия!`;
      urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, { 
        method: 'post', 
        payload: JSON.stringify({ 
          chat_id: masterId, 
          text: text,
          parse_mode: 'HTML'
        }) 
      });
      
      // Отмечаем что напоминание отправлено
      setCellByHeader(sheet, i + 2, headerMap, 'Напоминание 2ч', 'Отправлено ' + new Date().toLocaleString('ru-RU'));
    }
  }
}

function parseOrderDateTime(dateStr, timeStr) {
  try {
    let d = null;

    if (Object.prototype.toString.call(dateStr) === '[object Date]' && !isNaN(dateStr.getTime())) {
      d = new Date(dateStr.getTime());
    } else {
      const rawDate = String(dateStr || '').trim();
      if (!rawDate) return null;

      // Формат DD.MM или DD.MM.YYYY
      if (rawDate.indexOf('.') !== -1) {
        const parts = rawDate.split('.');
        if (parts.length === 3) {
          d = new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
        } else if (parts.length === 2) {
          const year = new Date().getFullYear();
          d = new Date(year, Number(parts[1]) - 1, Number(parts[0]));
        }
      }
      // Формат YYYY-MM-DD
      else if (rawDate.indexOf('-') !== -1) {
        d = new Date(rawDate);
      } else {
        return null;
      }
    }

    if (!d || isNaN(d.getTime())) return null;

    // Устанавливаем время
    if (timeStr) {
      if (Object.prototype.toString.call(timeStr) === '[object Date]' && !isNaN(timeStr.getTime())) {
        d.setHours(timeStr.getHours(), timeStr.getMinutes(), 0, 0);
      } else {
        const t = String(timeStr).split(':');
        if (t.length >= 2) {
          d.setHours(Number(t[0]), Number(t[1]), 0, 0);
        }
      }
    }

    return d;
  } catch (e) {
    return null;
  }
}

/* ---------- Генерация текстов для Telegram ---------- */
function pad2(value) {
  return String(value).padStart(2, '0');
}

function spreadsheetSerialToDate(value) {
  const n = Number(value);
  if (!isFinite(n) || n <= 0) return null;

  const millisPerDay = 24 * 60 * 60 * 1000;
  const excelEpochUtc = Date.UTC(1899, 11, 30); // Google Sheets serial epoch.
  const ms = excelEpochUtc + Math.round(n * millisPerDay);
  const dt = new Date(ms);
  return isNaN(dt.getTime()) ? null : dt;
}

function formatDateForDisplay(value) {
  if (value === null || value === undefined || value === '') return '';

  if (typeof value === 'number') {
    const serialDate = spreadsheetSerialToDate(value);
    if (serialDate) {
      return Utilities.formatDate(serialDate, Session.getScriptTimeZone(), 'dd.MM.yyyy');
    }
  }

  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'dd.MM.yyyy');
  }

  const raw = String(value).trim();
  if (!raw) return '';
  if (/^\d+([.,]\d+)?$/.test(raw)) {
    const serialDate = spreadsheetSerialToDate(raw.replace(',', '.'));
    if (serialDate) {
      return Utilities.formatDate(serialDate, Session.getScriptTimeZone(), 'dd.MM.yyyy');
    }
  }

  const dmY = raw.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/);
  if (dmY) {
    const day = pad2(dmY[1]);
    const month = pad2(dmY[2]);
    const year = dmY[3] || String(new Date().getFullYear());
    return `${day}.${month}.${year}`;
  }

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return `${iso[3]}.${iso[2]}.${iso[1]}`;
  }

  const parsed = new Date(raw);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, Session.getScriptTimeZone(), 'dd.MM.yyyy');
  }

  // Строки вида "Sat Feb 28 2026 00:00:00 GMT+0700 (....)".
  const noTzLabel = raw.replace(/\s+\([^)]+\)\s*$/, '');
  const parsedNoTzLabel = new Date(noTzLabel);
  if (!isNaN(parsedNoTzLabel.getTime())) {
    return Utilities.formatDate(parsedNoTzLabel, Session.getScriptTimeZone(), 'dd.MM.yyyy');
  }

  return raw;
}

function formatTimeForDisplay(value) {
  if (value === null || value === undefined || value === '') return '';

  if (typeof value === 'number') {
    const serialDate = spreadsheetSerialToDate(value);
    if (serialDate) {
      return Utilities.formatDate(serialDate, Session.getScriptTimeZone(), 'HH:mm');
    }
  }

  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'HH:mm');
  }

  const raw = String(value).trim();
  if (!raw) return '';
  if (/^\d+([.,]\d+)?$/.test(raw)) {
    const serialDate = spreadsheetSerialToDate(raw.replace(',', '.'));
    if (serialDate) {
      return Utilities.formatDate(serialDate, Session.getScriptTimeZone(), 'HH:mm');
    }
  }

  const hhmmInside = raw.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\b/);
  if (hhmmInside) {
    return `${pad2(hhmmInside[1])}:${hhmmInside[2]}`;
  }

  const hhmm = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (hhmm) {
    return `${pad2(hhmm[1])}:${hhmm[2]}`;
  }

  const parsed = new Date(raw);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, Session.getScriptTimeZone(), 'HH:mm');
  }

  // Строки вида "Sat Dec 30 1899 10:00:00 GMT+0531 (....)".
  const noTzLabel = raw.replace(/\s+\([^)]+\)\s*$/, '');
  const parsedNoTzLabel = new Date(noTzLabel);
  if (!isNaN(parsedNoTzLabel.getTime())) {
    return Utilities.formatDate(parsedNoTzLabel, Session.getScriptTimeZone(), 'HH:mm');
  }

  return raw;
}

function formatDateTimeForDisplay(dateValue, timeValue) {
  const date = formatDateForDisplay(dateValue);
  const time = formatTimeForDisplay(timeValue);

  if (date && time) return `${date} в ${time}`;
  if (date) return date;
  if (time) return time;
  return 'не указаны';
}

function generateBriefText(order) {
  const dateTime = formatDateTimeForDisplay(order.orderDate, order.orderTime);
  const fullAddress = [order.customerAddress, order.customerFlat].filter(function(v) {
    return String(v || '').trim();
  }).join(', ');

  let text = `🧹 <b>ЗАЯВКА №${order.orderId}</b>\n`;
  text += `───────────────────\n`;
  text += `📍 Город: ${escapeTelegramHtml(order.customerCity || 'не указан')}\n`;
  text += `🔧 Тип уборки: ${escapeTelegramHtml(order.cleaningType || 'не указан')}\n`;
  text += `📏 Площадь: ${escapeTelegramHtml(order.area || 'не указана')} м²\n`;
  text += `🗓 Дата и время: ${escapeTelegramHtml(dateTime)}\n`;
  text += `💰 Оплата мастеру: ${escapeTelegramHtml(order.masterPay || order.orderTotal || '0')} руб\n`;
  text += `📍 Адрес: ${escapeTelegramHtml(fullAddress || 'не указан')}\n`;

  if (order.worksDescription) {
    text += `\n📝 Пожелания: ${escapeTelegramHtml(order.worksDescription)}\n`;
  }

  if (order.equipment && order.equipment !== '—') {
    text += `\n🛠 Оборудование: ${escapeTelegramHtml(order.equipment)}\n`;
  }

  if (order.chemistry && order.chemistry !== '—') {
    text += `🧴 Химия: ${escapeTelegramHtml(order.chemistry)}\n`;
  }

  return text;
}

function generateFullText(orderRow, orderData) {
  const date = formatDateForDisplay(orderRow['Дата уборки']);
  const time = formatTimeForDisplay(orderRow['Время уборки']);
  const dateTime = formatDateTimeForDisplay(orderRow['Дата уборки'], orderRow['Время уборки']);

  const city = escapeTelegramHtml(orderRow['Город'] || 'не указан');
  const cleaningType = escapeTelegramHtml(orderRow['Тип уборки'] || 'не указан');
  const area = escapeTelegramHtml(orderRow['Площадь (м²)'] || 'не указана');
  const orderId = escapeTelegramHtml(orderRow['Номер заявки'] || '');
  const clientName = escapeTelegramHtml(orderRow['Имя клиента'] || 'не указано');
  const clientPhone = escapeTelegramHtml(orderRow['Телефон клиента'] || 'не указан');
  const orderSum = escapeTelegramHtml(orderRow['Сумма заказа'] || '0');
  const masterPay = escapeTelegramHtml(orderRow['Зарплата мастерам'] || '0');

  const addressParts = [orderRow['Улица и дом'], orderRow['Квартира/офис']].filter(function(v) {
    return String(v || '').trim();
  });
  const fullAddress = addressParts.join(', ');
  const safeAddress = escapeTelegramHtml(fullAddress || 'не указан');

  const equipment = String(orderRow['Оборудование'] || '').trim() || '—';
  const chemistry = String(orderRow['Химия'] || '').trim() || '—';
  const description = String(orderRow['Описание работ'] || '').trim();

  const clientMessage = buildClientReadyMessage(orderRow);

  let text = `🧹 <b>ПОЛНАЯ ИНФОРМАЦИЯ О ЗАЯВКЕ №${orderId}</b>\n`;
  text += `────────────────────────────────────\n\n`;

  text += `📋 <b>ОСНОВНАЯ ИНФОРМАЦИЯ</b>\n`;
  text += `🏙 Город: ${city}\n`;
  text += `🧽 Вид уборки: ${cleaningType}\n`;
  text += `📐 Площадь: ${area} м²\n`;
  text += `🗓 Дата и время: ${escapeTelegramHtml(dateTime)}\n`;
  text += `📍 Адрес: ${safeAddress}\n\n`;

  text += `👤 <b>ДАННЫЕ КЛИЕНТА</b>\n`;
  text += `Имя: ${clientName}\n`;
  text += `Телефон: <code>${clientPhone}</code>\n\n`;

  text += `🧰 <b>ЧТО ВЗЯТЬ С СОБОЙ</b>\n`;
  text += `Оборудование: ${escapeTelegramHtml(equipment)}\n`;
  text += `Химия: ${escapeTelegramHtml(chemistry)}\n\n`;

  if (description) {
    text += `📝 <b>ПОЖЕЛАНИЯ / ОПИСАНИЕ РАБОТ</b>\n`;
    text += `${escapeTelegramHtml(description)}\n\n`;
  }

  text += `💰 <b>ФИНАНСЫ</b>\n`;
  text += `Сумма заказа: ${orderSum} руб\n`;
  text += `Ваша оплата: ${masterPay} руб\n\n`;

  text += `✅ <b>ЧТО НУЖНО СДЕЛАТЬ</b>\n`;
  text += `1️⃣ Написать клиенту готовое сообщение из блока ниже.\n`;
  text += `2️⃣ Подготовьтесь ответственно к заявке: заранее возьмите нужное оборудование, спланируйте, как добраться, и приезжайте без опозданий.\n`;
  text += `3️⃣ Отправьте фотографии химии и оборудования, когда прибудете на объект.\n`;
  text += `4️⃣ После работы отправьте фотографии выполненных работ.\n`;
  text += `5️⃣ Отправьте фото подписанного акта выполненных работ.\n`;
  text += `6️⃣ Подтвердите оплату от клиента.\n\n`;

  text += `💬 <b>ГОТОВОЕ СООБЩЕНИЕ КЛИЕНТУ</b>\n`;
  text += `<code>${escapeTelegramHtml(clientMessage)}</code>\n\n`;
  text += `🔖 Версия: <code>${escapeTelegramHtml(BUILD_VERSION)}</code>`;

  return text;
}

function buildClientReadyMessage(orderRow) {
  const date = formatDateForDisplay(orderRow['Дата уборки']);
  const time = formatTimeForDisplay(orderRow['Время уборки']);
  const addressParts = [orderRow['Улица и дом'], orderRow['Квартира/офис']].filter(function(v) {
    return String(v || '').trim();
  });
  const fullAddress = addressParts.join(', ');

  let msg = 'Здравствуйте! Я мастер по клинингу.';
  if (date && time) {
    msg += ` Приеду к вам ${date} в ${time}.`;
  } else if (date) {
    msg += ` Приеду к вам ${date}.`;
  } else if (time) {
    msg += ` Приеду к вам в ${time}.`;
  } else {
    msg += ' Время и дату уточню дополнительно.';
  }
  if (fullAddress) {
    msg += ` Адрес: ${fullAddress}.`;
  }
  msg += ' До встречи!';
  return msg;
}

function ensureWebhookPinnedToCurrentDeployment(token) {
  try {
    const botToken = String(token || '').trim();
    if (!botToken) return;

    const throttleKey = 'LAST_WEBHOOK_AUTO_SYNC_AT';
    const now = Date.now();
    const last = Number(PROP.getProperty(throttleKey) || 0);
    // Не дергаем Telegram API слишком часто.
    if (last && now - last < 2 * 60 * 1000) return;

    const expectedUrl = resolveWebhookExecUrl('');
    if (!expectedUrl) return;

    let needSet = false;
    let needDropPending = false;
    const info = urlFetchJson(`https://api.telegram.org/bot${botToken}/getWebhookInfo`, {
      method: 'get'
    });

    if (!info || info.ok !== true || !info.result) {
      needSet = true;
    } else {
      const currentUrl = normalizeWebhookUrlToExec(info.result.url || '');
      const allowed = Array.isArray(info.result.allowed_updates) ? info.result.allowed_updates : [];

      if (!currentUrl || currentUrl !== expectedUrl) {
        needSet = true;
        needDropPending = true;
      }
      if (allowed.length && allowed.indexOf('callback_query') === -1) {
        needSet = true;
        needDropPending = true;
      }
      if (Number(info.result.pending_update_count || 0) > 3) {
        // Если накопились апдейты, сбрасываем очередь, чтобы не было лавины дублей.
        needSet = true;
        needDropPending = true;
      }
    }

    if (needSet) {
      if (needDropPending) {
        const delResp = urlFetchJson(`https://api.telegram.org/bot${botToken}/deleteWebhook`, {
          method: 'post',
          payload: JSON.stringify({ drop_pending_updates: true })
        });
        Logger.log('auto deleteWebhook(drop_pending=true): ' + JSON.stringify(delResp));
      }

      const setResp = urlFetchJson(`https://api.telegram.org/bot${botToken}/setWebhook`, {
        method: 'post',
        payload: JSON.stringify({
          url: expectedUrl,
          allowed_updates: getTelegramAllowedUpdates()
        })
      });
      Logger.log('auto setWebhook to current deployment: ' + JSON.stringify(setResp));
    }

    PROP.setProperty(WEBAPP_EXEC_URL_PROPERTY, expectedUrl);
    PROP.setProperty(throttleKey, String(now));
  } catch (e) {
    Logger.log('ensureWebhookPinnedToCurrentDeployment failed: ' + e.message);
  }
}

/* ---------- Вспомогательные функции Telegram ---------- */
function urlFetchJson(url, options) {
  const params = {
    method: options.method || 'get',
    contentType: 'application/json',
    payload: options.payload || null,
    muteHttpExceptions: true
  };

  try {
    const resp = UrlFetchApp.fetch(url, params);
    const text = resp.getContentText();

    try {
      return JSON.parse(text);
    } catch (e) {
      Logger.log('Failed to parse JSON: ' + text);
      return { ok: false, raw: text };
    }
  } catch (e) {
    Logger.log('UrlFetch failed for ' + url + ': ' + e.message);
    return { ok: false, error: e.message };
  }
}

function escapeTelegramHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function answerCallback(token, callbackId, text) {
  try {
    urlFetchJson(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'post',
      payload: JSON.stringify({
        callback_query_id: callbackId,
        text: text,
        show_alert: false
      })
    });
  } catch (e) {
    Logger.log('answerCallback failed: ' + e.message);
  }
}

function isDuplicateCallback(callbackId) {
  const id = String(callbackId || '').trim();
  if (!id) return false;

  const propKey = 'CBQ_HANDLED_' + id;
  const alreadyHandled = String(PROP.getProperty(propKey) || '').trim();
  if (alreadyHandled) return true;

  const cache = CacheService.getScriptCache();
  const key = 'cbq_' + id;
  const exists = cache.get(key);
  if (exists) {
    try { PROP.setProperty(propKey, String(Date.now())); } catch (e) {}
    return true;
  }

  cache.put(key, '1', 600);
  try { PROP.setProperty(propKey, String(Date.now())); } catch (e) {}
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
  const key = 'ORDER_DM_SENT_' + id;
  PROP.setProperty(key, by + '|' + new Date().toISOString());
}

/* ---------- Утилиты ---------- */
function jsonResponse(obj, code) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Простая проверка доступности веб‑приложения
function doGet(e) {
  try {
    const isHealth = e && e.parameter && String(e.parameter.health || '') === '1';
    if (isHealth) {
      return jsonResponse({ ok: true, info: 'webapp active', buildVersion: BUILD_VERSION }, 200);
    }

    const html = HtmlService.createHtmlOutput(
      '<!doctype html><html><head><meta charset="utf-8"><title>WebApp Active</title></head>' +
      '<body style="font-family:Arial,sans-serif;padding:24px;">' +
      '<h2>Web App развернут</h2>' +
      '<p>Этот URL используется как backend endpoint (webhook/API).</p>' +
      '<p>Проверка здоровья: добавьте <code>?health=1</code> к URL.</p>' +
      '</body></html>'
    );
    return html.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

// Функция для настройки свойств (запустить один раз через Apps Script)
function __setScriptPropertiesForToken() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('TELEGRAM_BOT_TOKEN', '8471091759:AAGiszC401WRMWcTXXPi9PizsqxX-oAUurI');
  props.setProperty('TELEGRAM_CHAT_ID', '-1003875039787'); // Замените на ваш ID группы
  props.setProperty('TELEGRAM_CHAT_NOVOSIBIRSK', '-1003875039787');
  Logger.log('✅ Properties set successfully');
}

// Функция для проверки конфигурации
function __checkConfiguration() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('TELEGRAM_BOT_TOKEN');
  const chatId = props.getProperty('TELEGRAM_CHAT_ID');
  const nskChat = props.getProperty('TELEGRAM_CHAT_NOVOSIBIRSK');
  const ssId = props.getProperty('SPREADSHEET_ID');
  
  Logger.log('=== CONFIGURATION CHECK ===');
  Logger.log('Bot Token: ' + (token ? '✅ Set' : '❌ Not set'));
  Logger.log('Chat ID: ' + (chatId ? '✅ Set (' + chatId + ')' : '❌ Not set'));
  Logger.log('Novosibirsk Chat: ' + (nskChat ? '✅ Set (' + nskChat + ')' : '⚠️ Not set (used default in code)'));
  Logger.log('Spreadsheet ID: ' + (ssId ? '✅ Set (' + ssId + ')' : '❌ Not set'));
  Logger.log('Sheet Name: ' + SHEET_NAME);
  Logger.log('========================');
}

// Проверка доступа к таблице (критично для doPost)
function __checkSpreadsheetAccess() {
  const props = PropertiesService.getScriptProperties();
  const ssId = props.getProperty('SPREADSHEET_ID');
  Logger.log('=== SPREADSHEET ACCESS CHECK ===');
  Logger.log('SPREADSHEET_ID property: ' + (ssId || 'NOT SET'));

  try {
    if (ssId) {
      const byId = SpreadsheetApp.openById(ssId);
      Logger.log('openById: ✅ ' + byId.getName());
    } else {
      Logger.log('openById: ⚠️ skipped (SPREADSHEET_ID not set)');
    }
  } catch (e) {
    Logger.log('openById: ❌ ' + e.message);
  }

  try {
    const active = SpreadsheetApp.getActiveSpreadsheet();
    Logger.log('getActiveSpreadsheet: ' + (active ? ('✅ ' + active.getName()) : '❌ null'));
  } catch (e) {
    Logger.log('getActiveSpreadsheet: ❌ ' + e.message);
  }

  try {
    const sheet = getSheet();
    Logger.log('getSheet(): ✅ ' + sheet.getName());
  } catch (e) {
    Logger.log('getSheet(): ❌ ' + e.message);
  }

  Logger.log('===============================');
}

// Проверка наличия обязательных заголовков в Google Таблице
function __checkSheetHeaders() {
  const sheet = getSheet();
  const headerMap = getHeaderMap(sheet);
  const missing = REQUIRED_HEADERS.filter(h => !headerMap[h]);

  if (missing.length) {
    Logger.log('❌ Отсутствуют заголовки: ' + missing.join(', '));
    return { ok: false, missing: missing };
  }

  Logger.log('✅ Все обязательные заголовки на месте');
  return { ok: true, headers: REQUIRED_HEADERS };
}

// Функция для тестирования напоминаний (запустить один раз)
function __testReminders() {
  Logger.log('Testing reminder system...');
  sendReminders();
  Logger.log('✅ Reminders test completed');
}

// Прямая проверка отправки сообщения в Telegram (без фронтенда)
function __testTelegramSend() {
  const token = PROP.getProperty('TELEGRAM_BOT_TOKEN') || '';
  const chat =
    PROP.getProperty('TELEGRAM_CHAT_NOVOSIBIRSK') ||
    PROP.getProperty('TELEGRAM_CHAT_ID') ||
    '';

  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в Script Properties');
  if (!chat) throw new Error('TELEGRAM_CHAT_NOVOSIBIRSK/TELEGRAM_CHAT_ID не задан в Script Properties');

  const resp = urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: String(chat).trim(),
      text: '✅ Тест Telegram из Apps Script'
    })
  });

  Logger.log(JSON.stringify(resp));
  return resp;
}

// Сквозной тест: создает тестовую заявку и пытается отправить в Telegram
function __testCreateOrder() {
  const payload = {
    action: 'create',
    orderId: 'TEST-' + Date.now().toString().slice(-8),
    manager: 'Тест',
    customerName: 'Тест',
    customerPhone: '+79990000000',
    customerCity: 'Новосибирск',
    customerAddress: 'Тестовый адрес',
    customerFlat: '',
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

  const resp = createOrUpdateOrder(payload);
  Logger.log(resp.getContent());
  return resp;
}

// Разовая нормализация колонки "Дата создания" для старых строк (ISO -> dd.MM.yyyy HH:mm:ss)
function __normalizeCreatedAtColumn() {
  const sheet = getSheet();
  const headerMap = getHeaderMap(sheet);
  const col = headerMap['Дата создания'];
  const lastRow = sheet.getLastRow();
  if (!col || lastRow < 2) {
    Logger.log('Нет данных для нормализации');
    return { ok: true, updated: 0 };
  }

  const values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  let updated = 0;

  for (let i = 0; i < values.length; i++) {
    const raw = values[i][0];
    let parsed = null;

    if (Object.prototype.toString.call(raw) === '[object Date]' && !isNaN(raw.getTime())) {
      parsed = raw;
    } else {
      const text = String(raw || '').trim();
      if (!text) continue;

      // Чаще всего встречается ISO: 2026-02-17T10:01:13.062Z
      const isoLike = text.indexOf('T') !== -1 && text.indexOf(':') !== -1;
      if (!isoLike) continue;

      const dt = new Date(text);
      if (!isNaN(dt.getTime())) parsed = dt;
    }

    if (!parsed) continue;
    values[i][0] = formatCreatedAt(parsed);
    updated++;
  }

  if (updated > 0) {
    sheet.getRange(2, col, values.length, 1).setValues(values);
  }

  Logger.log('Нормализация завершена. Обновлено строк: ' + updated);
  return { ok: true, updated: updated };
}

// Установка webhook Telegram на URL веб-приложения
function __setTelegramWebhook(webAppUrl) {
  const token = PROP.getProperty('TELEGRAM_BOT_TOKEN') || '';
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в Script Properties');

  let url = resolveWebhookExecUrl(webAppUrl);
  if (!url) throw new Error('Передайте webAppUrl или сначала задеплойте Web App');

  const resp = urlFetchJson(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'post',
    payload: JSON.stringify({
      url: url,
      allowed_updates: getTelegramAllowedUpdates()
    })
  });

  Logger.log(JSON.stringify(resp));
  return resp;
}

// Проверка текущего webhook Telegram
function __getTelegramWebhookInfo() {
  const token = PROP.getProperty('TELEGRAM_BOT_TOKEN') || '';
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в Script Properties');

  const resp = urlFetchJson(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
    method: 'get'
  });
  try {
    const currentUrl = resp && resp.result ? String(resp.result.url || '') : '';
    if (currentUrl.indexOf('/dev') !== -1) {
      Logger.log('⚠️ ВНИМАНИЕ: webhook установлен на /dev. Для стабильной работы нужен /exec');
    }
  } catch (e) {}
  Logger.log(JSON.stringify(resp));
  return resp;
}

// Удаление webhook Telegram
function __deleteTelegramWebhook() {
  const token = PROP.getProperty('TELEGRAM_BOT_TOKEN') || '';
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в Script Properties');

  const resp = urlFetchJson(`https://api.telegram.org/bot${token}/deleteWebhook`, {
    method: 'post',
    payload: JSON.stringify({ drop_pending_updates: false })
  });
  Logger.log(JSON.stringify(resp));
  return resp;
}

// Полный сброс webhook + очистка накопленных апдейтов (когда приходят дубли)
function __resetTelegramWebhook(webAppUrl) {
  const token = PROP.getProperty('TELEGRAM_BOT_TOKEN') || '';
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в Script Properties');

  let url = resolveWebhookExecUrl(webAppUrl);
  if (!url) throw new Error('Передайте webAppUrl или сначала задеплойте Web App');
  PROP.setProperty(WEBAPP_EXEC_URL_PROPERTY, url);

  const delResp = urlFetchJson(`https://api.telegram.org/bot${token}/deleteWebhook`, {
    method: 'post',
    payload: JSON.stringify({ drop_pending_updates: true })
  });

  const setResp = urlFetchJson(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'post',
    payload: JSON.stringify({
      url: url,
      allowed_updates: getTelegramAllowedUpdates()
    })
  });

  Logger.log('deleteWebhook: ' + JSON.stringify(delResp));
  Logger.log('setWebhook: ' + JSON.stringify(setResp));
  return { deleteWebhook: delResp, setWebhook: setResp };
}

function normalizeWebhookUrlToExec(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  return raw.replace(/\/dev(\?|$)/, '/exec$1');
}

function getCurrentServiceExecUrl() {
  try {
    const serviceUrl = ScriptApp.getService().getUrl();
    return normalizeWebhookUrlToExec(serviceUrl);
  } catch (e) {
    return '';
  }
}

function getTelegramAllowedUpdates() {
  return ['message', 'edited_message', 'callback_query'];
}

function resolveWebhookExecUrl(preferredUrl) {
  let url = String(preferredUrl || '').trim();
  if (!url) {
    url = getCurrentServiceExecUrl();
  }
  if (!url) {
    url = String(PROP.getProperty(WEBAPP_EXEC_URL_PROPERTY) || '').trim();
  }
  if (!url) {
    url = DEFAULT_WEBAPP_EXEC_URL;
  }

  return normalizeWebhookUrlToExec(url);
}

// Быстрая настройка webhook строго на prod URL (/exec)
function __setWebhookProd() {
  const url = resolveWebhookExecUrl('');
  if (!url) {
    throw new Error('Не удалось получить URL сервиса. Сначала разверните Web App.');
  }
  PROP.setProperty(WEBAPP_EXEC_URL_PROPERTY, url);

  return __resetTelegramWebhook(url);
}

// Диагностика кнопки Telegram без поиска callback_query в журналах doPost
function __diagnoseTelegramButton() {
  const info = __getTelegramWebhookInfo();
  const result = (info && info.result) ? info.result : {};

  const expectedExecUrl = resolveWebhookExecUrl('');
  const currentWebhookUrl = String(result.url || '');
  const pendingCount = Number(result.pending_update_count || 0);
  const lastError = String(result.last_error_message || '');
  const currentAllowedUpdates = Array.isArray(result.allowed_updates) ? result.allowed_updates : [];
  const publicCheck = __checkWebhookPublicAccess();

  let advice = 'Webhook выглядит корректно. Если кнопка не работает, нажмите ее и повторно запустите __diagnoseTelegramButton().';
  if (!currentWebhookUrl || currentWebhookUrl.indexOf('/exec') === -1) {
    advice = 'Webhook не на /exec. Запустите __setWebhookProd().';
  } else if (expectedExecUrl && currentWebhookUrl !== expectedExecUrl) {
    advice = 'Webhook указывает на другой Web App URL. Запустите __setWebhookProd() для привязки к рабочему URL.';
  } else if (currentAllowedUpdates.length && currentAllowedUpdates.indexOf('callback_query') === -1) {
    advice = 'В webhook не включен callback_query. Запустите __setWebhookProd() для переустановки.';
  } else if (lastError.indexOf('401') !== -1 || (publicCheck && publicCheck.statusCode === 401)) {
    advice = 'Telegram получает 401 от Web App. Переразверните Web App: "Выполнять от моего имени" и "Доступ: Все", затем запустите __setWebhookProd().';
  } else if (publicCheck && !publicCheck.okPublic) {
    advice = 'Web App недоступен публично. Проверьте настройки доступа деплоя и заново выполните __setWebhookProd().';
  }

  const diag = {
    ok: true,
    buildVersion: BUILD_VERSION,
    currentWebhookUrl: currentWebhookUrl,
    expectedExecUrl: expectedExecUrl,
    webhookOnExec: !!currentWebhookUrl && currentWebhookUrl.indexOf('/exec') !== -1,
    webhookMatchesCurrentDeployment: !!expectedExecUrl && currentWebhookUrl === expectedExecUrl,
    allowedUpdates: currentAllowedUpdates,
    pendingUpdateCount: pendingCount,
    lastError: lastError || 'нет',
    publicAccess: publicCheck,
    advice: advice
  };

  Logger.log(JSON.stringify(diag));
  return diag;
}

function __checkWebhookPublicAccess() {
  const url = resolveWebhookExecUrl('');
  if (!url) {
    return { ok: false, error: 'webhook url not available' };
  }

  try {
    const resp = UrlFetchApp.fetch(url + '?health=1', {
      method: 'get',
      muteHttpExceptions: true,
      followRedirects: true
    });
    const statusCode = resp.getResponseCode();
    const body = resp.getContentText() || '';
    return {
      ok: true,
      url: url,
      statusCode: statusCode,
      okPublic: statusCode >= 200 && statusCode < 300,
      bodySnippet: body.slice(0, 200)
    };
  } catch (e) {
    return { ok: false, url: url, error: e.message };
  }
}

function __getBuildInfo() {
  const serviceExecUrl = getCurrentServiceExecUrl();
  const storedExecUrl = String(PROP.getProperty(WEBAPP_EXEC_URL_PROPERTY) || '').trim();
  const info = {
    buildVersion: BUILD_VERSION,
    storedWebAppExecUrl: storedExecUrl,
    serviceExecUrl: serviceExecUrl,
    defaultWebAppExecUrl: DEFAULT_WEBAPP_EXEC_URL,
    resolvedWebhookExecUrl: resolveWebhookExecUrl(''),
    note: serviceExecUrl
      ? 'Webhook должен указывать на serviceExecUrl текущего проекта.'
      : 'serviceExecUrl пустой: проект, вероятно, не развернут как Web App.'
  };
  Logger.log(JSON.stringify(info));
  return info;
}

function __probeWebhookDoPostVersion(targetUrl) {
  const url = resolveWebhookExecUrl(targetUrl || '');
  if (!url) return { ok: false, error: 'webhook url not available' };

  try {
    const resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ action: 'probe_version' }),
      muteHttpExceptions: true,
      followRedirects: true
    });

    const statusCode = resp.getResponseCode();
    const bodyText = resp.getContentText() || '';
    let bodyJson = null;
    try { bodyJson = JSON.parse(bodyText); } catch (e) {}

    return {
      ok: statusCode >= 200 && statusCode < 300,
      url: url,
      statusCode: statusCode,
      bodyJson: bodyJson,
      bodySnippet: bodyText.slice(0, 400)
    };
  } catch (e) {
    return { ok: false, url: url, error: e.message };
  }
}

function __hardResetBotRouting() {
  const token = PROP.getProperty('TELEGRAM_BOT_TOKEN') || '';
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан');

  const serviceUrl = getCurrentServiceExecUrl();
  const storedUrl = String(PROP.getProperty(WEBAPP_EXEC_URL_PROPERTY) || '').trim();
  const fallbackUrl = normalizeWebhookUrlToExec(DEFAULT_WEBAPP_EXEC_URL);
  const primaryUrl = serviceUrl || normalizeWebhookUrlToExec(storedUrl) || fallbackUrl;
  if (!primaryUrl) throw new Error('Не удалось определить URL Web App');

  function applyWebhook(url) {
    const delResp = urlFetchJson(`https://api.telegram.org/bot${token}/deleteWebhook`, {
      method: 'post',
      payload: JSON.stringify({ drop_pending_updates: true })
    });

    const setResp = urlFetchJson(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'post',
      payload: JSON.stringify({
        url: url,
        allowed_updates: getTelegramAllowedUpdates()
      })
    });

    const infoResp = urlFetchJson(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
      method: 'get'
    });
    const probeDoPost = __probeWebhookDoPostVersion(url);

    return {
      targetUrl: url,
      deleteWebhook: delResp,
      setWebhook: setResp,
      webhookInfo: infoResp,
      probeDoPost: probeDoPost
    };
  }

  let routing = applyWebhook(primaryUrl);
  let switchedToServiceUrl = false;

  const probeBuild = routing.probeDoPost && routing.probeDoPost.bodyJson
    ? String(routing.probeDoPost.bodyJson.buildVersion || '')
    : '';
  const mismatch = !probeBuild || probeBuild !== BUILD_VERSION;

  if (mismatch && serviceUrl && serviceUrl !== primaryUrl) {
    routing = applyWebhook(serviceUrl);
    switchedToServiceUrl = true;
  } else if (mismatch && storedUrl && normalizeWebhookUrlToExec(storedUrl) !== routing.targetUrl) {
    routing = applyWebhook(normalizeWebhookUrlToExec(storedUrl));
  } else if (mismatch && fallbackUrl && fallbackUrl !== routing.targetUrl) {
    routing = applyWebhook(fallbackUrl);
  }

  PROP.setProperty(WEBAPP_EXEC_URL_PROPERTY, String(routing.targetUrl || '').trim());

  const out = {
    buildVersion: BUILD_VERSION,
    primaryUrl: primaryUrl,
    serviceUrl: serviceUrl,
    storedUrl: normalizeWebhookUrlToExec(storedUrl),
    fallbackUrl: fallbackUrl,
    switchedToServiceUrl: switchedToServiceUrl,
    targetUrl: routing.targetUrl,
    deleteWebhook: routing.deleteWebhook,
    setWebhook: routing.setWebhook,
    webhookInfo: routing.webhookInfo,
    probeDoPost: routing.probeDoPost
  };
  Logger.log(JSON.stringify(out));
  return out;
}
