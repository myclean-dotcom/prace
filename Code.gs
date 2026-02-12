// Code.gs - Google Apps Script для системы управления заявками клининга
// Вставляется в проект Google Apps Script

const PROP = PropertiesService.getScriptProperties();
const SHEET_NAME = 'Заявки';

// Главная функция для обработки POST запросов
function doPost(e) {
  try {
    const raw = e.postData && e.postData.contents ? e.postData.contents : null;
    let body = {};

    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch (err) {
        body = e.parameter || {};
      }
    } else if (e.parameter && e.parameter.json) {
      // Когда запрос отправлен как form-urlencoded с полем `json`
      try {
        body = JSON.parse(e.parameter.json);
      } catch (err) {
        body = e.parameter || {};
      }
    } else {
      body = e.parameter || {};
    }

    // Логируем вход для отладки (посмотрите Execution logs)
    try { Logger.log('doPost raw: ' + String(raw)); } catch (e) {}
    try { Logger.log('doPost parameters: ' + JSON.stringify(e.parameter || {})); } catch (e) {}
    try { Logger.log('doPost body: ' + JSON.stringify(body)); } catch (e) {}

    // Обработка Telegram обновлений (callback_query или сообщения)
    if (body.callback_query || body.message || body.edited_message) {
      return handleTelegramUpdate(body);
    }

    // Обработка заявки с фронтенда (создание или обновление)
    if (body.action === 'create' || body.action === 'update' || body.orderId) {
      return createOrUpdateOrder(body);
    }

    return jsonResponse({ ok: false, error: 'unknown action' }, 400);
  } catch (err) {
    Logger.log('Error in doPost: ' + err.message);
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

/* ---------- Создание/обновление заявки ---------- */
function createOrUpdateOrder(payload) {
  const sheet = getSheet();
  const order = payload;
  const orderId = order.orderId || ('CLN-' + Date.now().toString().slice(-8));
  order.orderId = orderId;
  order._ts = new Date().toISOString();

  // Обновление существующей заявки
  if (payload.action === 'update' && payload.orderId) {
    const rowNum = findOrderRowById(orderId);
    if (rowNum) {
      updateOrderRow(rowNum, order);
      return jsonResponse({ ok: true, orderId, updated: true });
    }
  }

  // Добавление новой строки в таблицу
  const status = payload.action === 'update' ? 'Черновик' : 'Опубликована';
  const row = [
    order.orderId,
    order._ts,
    order.manager || '',
    order.customerName || '',
    order.customerPhone || '',
    order.customerCity || '',
    order.customerAddress || '',
    order.customerFlat || '',
    order.orderDate || '',
    order.orderTime || '',
    order.orderTotal || '',
    order.masterPay || '',
    order.cleaningType || '',
    order.area || '',
    order.chemistry || '',
    order.equipment || '',
    order.worksDescription || '',
    status,
    '', // Telegram Chat ID
    '', // Telegram Message ID
    '', // Master ID (заполняется когда мастер берёт заявку)
    '', // Master Name (заполняется когда мастер берёт заявку)
    '', // Дата/время принятия мастером
    '', // Напоминание за 24ч (отправлено)
    '', // Напоминание за 2ч (отправлено)
    ''  // Фотографии/статус выполнения
  ];
  
  sheet.appendRow(row);

  // Отправка сообщения в Telegram
  const token = PROP.getProperty('TELEGRAM_BOT_TOKEN') || '';
  let chat = (order.telegramChannel || PROP.getProperty('TELEGRAM_CHAT_ID') || '').toString().trim();
  
  if (!token) return jsonResponse({ ok: true, orderId, note: 'saved, token not set' });
  if (!chat) return jsonResponse({ ok: true, orderId, note: 'saved, chat id not set' });

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
    return jsonResponse({ ok: true, orderId, note: 'saved, telegram error' });
  }

  // Сохраняем Telegram IDs в таблице - ВАЖНО: нужно получить номер строки, которую только что добавили
  const newRowNum = sheet.getLastRow();
  setTelegramIdsForOrder(order.orderId, chat, resp.result.message_id);
  
  return jsonResponse({ ok: true, orderId, chat, messageId: resp.result.message_id });
}

/* ---------- Обработка обновлений из Telegram ---------- */
function handleTelegramUpdate(body) {
  const token = PROP.getProperty('TELEGRAM_BOT_TOKEN') || '';
  if (!token) return jsonResponse({ ok: false, error: 'Token not set' }, 500);

  // Обработка нажатия кнопки "Выхожу на заявку"
  if (body.callback_query) {
    const cb = body.callback_query;
    const data = cb.data || '';
    const callbackId = cb.id;
    const from = cb.from || {};
    
    if (data.indexOf('take_') === 0) {
      const orderId = data.split('take_')[1];
      const rowNum = findOrderRowById(orderId);
      
      if (!rowNum) {
        answerCallback(token, callbackId, '❌ Заявка не найдена');
        return jsonResponse({ ok: false, error: 'Order not found' }, 200);
      }

      // Получаем данные заявки
      const order = getOrderByRow(rowNum);
      const masterName = `${from.first_name || ''} ${from.last_name || ''}`.trim();
      const masterId = from.id;
      const takenAt = new Date().toLocaleString('ru-RU');

      // Обновляем таблицу: добавляем информацию о мастере
      updateOrderTaken(orderId, masterId, masterName, takenAt);

      // Генерируем полное сообщение с полной информацией о заявке
      const fullText = generateFullText(order);

      // Отправляем полное сообщение мастеру в личку
      const dmResp = urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'post',
        payload: JSON.stringify({
          chat_id: masterId,
          text: fullText,
          parse_mode: 'HTML'
        })
      });

      // Пытаемся удалить исходное сообщение из группы — если нельзя удалить, очищаем клавиатуру
      try {
        const chatId = order['Telegram Chat ID'] || cb.message.chat.id;
        const messageId = order['Telegram Message ID'] || cb.message.message_id;

        if (chatId && messageId) {
          // Сначала попробуем удалить
          const delResp = urlFetchJson(`https://api.telegram.org/bot${token}/deleteMessage`, {
            method: 'post',
            payload: JSON.stringify({ chat_id: chatId, message_id: messageId })
          });

          // Если удалить не получилось, пробуем убрать клавиатуру (editMessageReplyMarkup)
          if (!delResp || delResp.ok === false) {
            urlFetchJson(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
              method: 'post',
              payload: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: {} })
            });
          }
        }
      } catch (e) {
        Logger.log('Failed to delete/edit message: ' + e);
      }

      // Подтверждаем событие кнопки и даём пользователю понятный ответ
      if (dmResp && dmResp.ok) {
        answerCallback(token, callbackId, '✅ Заявка принята! Полная информация отправлена в личные сообщения.');
      } else {
        answerCallback(token, callbackId, '⚠️ Заявка принята, но не удалось отправить личное сообщение. Попросите мастера начать чат с ботом.');
      }

      return jsonResponse({ ok: true, masterAccepted: true }, 200);
    }

    if (data.indexOf('reject_') === 0) {
      answerCallback(token, callbackId, '❌ Вы отказались от заявки.');
      return jsonResponse({ ok: true }, 200);
    }

    answerCallback(token, callbackId, 'Неизвестное действие.');
    return jsonResponse({ ok: true }, 200);
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
    
    return jsonResponse({ ok: true }, 200);
  }

  // Сохранение chat_id автоматически
  if (body.message && body.message.chat && body.message.chat.id) {
    const chatId = body.message.chat.id;
    const saved = PROP.getProperty('TELEGRAM_CHAT_ID') || '';
    if (!saved) PROP.setProperty('TELEGRAM_CHAT_ID', String(chatId));
  }

  return jsonResponse({ ok: true }, 200);
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

  if (!ss) ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow([
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
    ]);
  }
  
  return sheet;
}

function findOrderRowById(orderId) {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(orderId).trim()) {
      return i + 1;
    }
  }
  
  return null;
}

function findOrderRowByMasterId(masterId) {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    const masterIdCell = data[i][19]; // Master ID в колонке 20
    if (String(masterIdCell) === String(masterId)) {
      return i + 1;
    }
  }
  
  return null;
}

function updateOrderRow(rowNum, order) {
  const sheet = getSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  
  const map = {
    'Номер заявки': order.orderId || '',
    'Дата создания': order._ts || '',
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
    'Статус': order.status || ''
  };
  
  const row = headers.map(h => map[h] || '');
  sheet.getRange(rowNum, 1, 1, row.length).setValues([row]);
}

function setTelegramIdsForOrder(orderId, chatId, messageId) {
  const row = findOrderRowById(orderId);
  if (!row) return;
  
  const sheet = getSheet();
  sheet.getRange(row, 19).setValue(chatId);      // Telegram Chat ID
  sheet.getRange(row, 20).setValue(messageId);   // Telegram Message ID
}

function updateOrderTaken(orderId, masterId, masterName, takenAt) {
  const row = findOrderRowById(orderId);
  if (!row) return;
  
  const sheet = getSheet();
  sheet.getRange(row, 18).setValue('Взята');          // Статус = "Взята"
  sheet.getRange(row, 21).setValue(masterId);         // Master ID
  sheet.getRange(row, 22).setValue(masterName);       // Master Name
  sheet.getRange(row, 23).setValue(takenAt);          // Дата принятия
}

function getOrderByRow(rowNum) {
  const sheet = getSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const values = sheet.getRange(rowNum, 1, 1, sheet.getLastColumn()).getValues()[0];
  
  const obj = {};
  for (let i = 0; i < headers.length; i++) {
    obj[headers[i]] = values[i];
  }
  
  return obj;
}

function appendPhotoToOrder(rowNum, fileId, caption) {
  const sheet = getSheet();
  
  // Найдём последнюю заполненную колонку
  const lastCol = sheet.getLastColumn();
  
  // Проверим, есть ли уже колонка для фото
  let photoCol = null;
  for (let col = 27; col <= lastCol; col++) {
    const cellValue = sheet.getRange(rowNum, col).getValue();
    if (!cellValue) {
      photoCol = col;
      break;
    }
  }
  
  // Если нет пустой колонки, добавим новую
  if (!photoCol) {
    photoCol = lastCol + 1;
    sheet.getRange(1, photoCol).setValue('Фото ' + (photoCol - 26));
  }
  
  // Сохраняем информацию о фото
  const photoInfo = `${fileId} | ${caption} | ${new Date().toLocaleString('ru-RU')}`;
  sheet.getRange(rowNum, photoCol).setValue(photoInfo);
}

/* ---------- Функции отправки напоминаний ---------- */
function sendReminders() {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  const token = PROP.getProperty('TELEGRAM_BOT_TOKEN') || '';
  
  if (!token) return;
  
  const now = new Date();
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const status = row[17];          // Статус
    const orderId = row[0];          // Номер заявки
    const masterId = row[19];        // Master ID
    const dateStr = row[8];          // Дата уборки
    const timeStr = row[9];          // Время уборки
    const sent24h = row[22];         // Напоминание 24ч
    const sent2h = row[23];          // Напоминание 2ч
    
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
      sheet.getRange(i + 1, 23).setValue('Отправлено ' + new Date().toLocaleString('ru-RU'));
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
      sheet.getRange(i + 1, 24).setValue('Отправлено ' + new Date().toLocaleString('ru-RU'));
    }
  }
}

function parseOrderDateTime(dateStr, timeStr) {
  try {
    let d = null;
    
    // Формат DD.MM или DD.MM.YYYY
    if (dateStr.indexOf('.') !== -1) {
      const parts = dateStr.split('.');
      if (parts.length === 3) {
        d = new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
      } else if (parts.length === 2) {
        const year = new Date().getFullYear();
        d = new Date(year, Number(parts[1]) - 1, Number(parts[0]));
      }
    } 
    // Формат YYYY-MM-DD
    else if (dateStr.indexOf('-') !== -1) {
      d = new Date(dateStr);
    } else {
      return null;
    }
    
    if (!d || isNaN(d.getTime())) return null;
    
    // Установиставляем время
    if (timeStr) {
      const t = timeStr.split(':');
      if (t.length >= 2) {
        d.setHours(Number(t[0]), Number(t[1]), 0, 0);
      }
    }
    
    return d;
  } catch (e) {
    return null;
  }
}

/* ---------- Генерация текстов для Telegram ---------- */
function generateBriefText(order) {
  let text = `🧹 <b>ЗАЯВКА №${order.orderId}</b>\n`;
  text += `───────────────────\n`;
  text += `📍 Город: ${order.customerCity}\n`;
  text += `🔧 Тип уборки: ${order.cleaningType}\n`;
  text += `📏 Площадь: ${order.area} м²\n`;
  
  if (order.orderTime) {
    text += `⏰ Время: ${order.orderTime}\n`;
  }
  
  text += `💰 Оплата мастеру: ${order.masterPay || order.orderTotal} руб\n`;
  text += `📍 Адрес: ${order.customerAddress}\n`;
  
  if (order.worksDescription) {
    text += `\n📝 Пожелания: ${order.worksDescription}\n`;
  }
  
  if (order.equipment && order.equipment !== '—') {
    text += `\n🛠 Оборудование: ${order.equipment}\n`;
  }
  
  if (order.chemistry && order.chemistry !== '—') {
    text += `🧴 Химия: ${order.chemistry}\n`;
  }
  
  return text;
}

function generateFullText(orderRow, orderData) {
  // orderRow - данные из таблицы
  // orderData - может быть пусто, используем что есть
  
  let text = `🧹 <b>ПОЛНАЯ ИНФОРМАЦИЯ О ЗАЯВКЕ №${orderRow['Номер заявки']}</b>\n`;
  text += `────────────────────────────────────\n\n`;
  
  text += `📋 <b>ОСНОВНАЯ ИНФОРМАЦИЯ:</b>\n`;
  text += `───────────────────────\n`;
  text += `Город: ${orderRow['Город']}\n`;
  text += `Тип уборки: ${orderRow['Тип уборки']}\n`;
  text += `Площадь: ${orderRow['Площадь (м²)']} м²\n`;
  
  if (orderRow['Дата уборки']) {
    text += `Дата: ${orderRow['Дата уборки']}\n`;
  }
  
  if (orderRow['Время уборки']) {
    text += `Время: ${orderRow['Время уборки']}\n`;
  }
  
  text += `\n`;
  
  text += `👤 <b>ДАННЫЕ КЛИЕНТА:</b>\n`;
  text += `──────────────────\n`;
  text += `Имя: ${orderRow['Имя клиента']}\n`;
  text += `📱 Телефон: <code>${orderRow['Телефон клиента']}</code>\n`;
  text += `📍 Адрес: ${orderRow['Улица и дом']}\n`;
  
  if (orderRow['Квартира/офис']) {
    text += `Квартира/офис: ${orderRow['Квартира/офис']}\n`;
  }
  
  text += `\n`;
  
  text += `💰 <b>ФИНАНСЫ:</b>\n`;
  text += `──────────\n`;
  text += `Сумма заказа: ${orderRow['Сумма заказа']} руб\n`;
  text += `Ваша оплата: ${orderRow['Зарплата мастерам']} руб\n`;
  text += `\n`;
  
  if (orderRow['Оборудование'] && orderRow['Оборудование'] !== '—') {
    text += `🛠 <b>ОБОРУДОВАНИЕ:</b>\n`;
    text += `──────────────\n${orderRow['Оборудование']}\n\n`;
  }
  
  if (orderRow['Химия'] && orderRow['Химия'] !== '—') {
    text += `🧴 <b>ХИМИЯ:</b>\n`;
    text += `──────────\n${orderRow['Химия']}\n\n`;
  }
  
  if (orderRow['Описание работ']) {
    text += `📝 <b>ПОЖЕЛАНИЯ/ОПИСАНИЕ:</b>\n`;
    text += `────────────────────\n${orderRow['Описание работ']}\n\n`;
  }
  
  text += `───────────────────────────────────\n`;
  text += `✅ <b>ЧТО НУЖНО СДЕЛАТЬ:</b>\n`;
  text += `1️⃣ Звоните клиенту и уточняйте детали\n`;
  text += `2️⃣ Отправьте фото при прибытии на объект\n`;
  text += `3️⃣ Отправьте фото использованной химии\n`;
  text += `4️⃣ Отправьте фото выполненных работ\n`;
  text += `5️⃣ Получите фото подписанного акта\n`;
  text += `6️⃣ Проведите расчет с клиентом\n\n`;
  text += `⏰ <b>НАПОМИНАНИЯ:</b>\n`;
  text += `  • Вы получите напоминание за 24 часа\n`;
  text += `  • Вы получите напоминание за 2 часа`;
  
  return text;
}

/* ---------- Вспомогательные функции Telegram ---------- */
function urlFetchJson(url, options) {
  const params = {
    method: options.method || 'get',
    contentType: 'application/json',
    payload: options.payload || null,
    muteHttpExceptions: true
  };
  
  const resp = UrlFetchApp.fetch(url, params);
  const text = resp.getContentText();
  
  try { 
    return JSON.parse(text); 
  } catch (e) { 
    Logger.log('Failed to parse JSON: ' + text);
    return { ok: false, raw: text }; 
  }
}

function answerCallback(token, callbackId, text) {
  urlFetchJson(`https://api.telegram.org/bot${token}/answerCallbackQuery`, { 
    method: 'post', 
    payload: JSON.stringify({ 
      callback_query_id: callbackId, 
      text: text,
      show_alert: false
    }) 
  });
}

/* ---------- Утилиты ---------- */
function jsonResponse(obj, code) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Простая проверка доступности веб‑приложения
function doGet(e) {
  try {
    return jsonResponse({ ok: true, info: 'webapp active' }, 200);
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

// Функция для настройки свойств (запустить один раз через Apps Script)
function __setScriptPropertiesForToken() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('TELEGRAM_BOT_TOKEN', '8471091759:AAGiszC401WRMWcTXXPi9PizsqxX-oAUurI');
  props.setProperty('TELEGRAM_CHAT_ID', '-1003875039787'); // Замените на ваш ID группы
  Logger.log('✅ Properties set successfully');
}

// Функция для проверки конфигурации
function __checkConfiguration() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('TELEGRAM_BOT_TOKEN');
  const chatId = props.getProperty('TELEGRAM_CHAT_ID');
  
  Logger.log('=== CONFIGURATION CHECK ===');
  Logger.log('Bot Token: ' + (token ? '✅ Set' : '❌ Not set'));
  Logger.log('Chat ID: ' + (chatId ? '✅ Set (' + chatId + ')' : '❌ Not set'));
  Logger.log('Sheet Name: ' + SHEET_NAME);
  Logger.log('========================');
}

// Функция для тестирования напоминаний (запустить один раз)
function __testReminders() {
  Logger.log('Testing reminder system...');
  sendReminders();
  Logger.log('✅ Reminders test completed');
}
