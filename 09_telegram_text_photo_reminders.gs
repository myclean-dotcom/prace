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

  let text = `🧹 <b>ЗАЯВКА №${escapeTelegramHtml(order.orderId || '')}</b>\n`;
  text += '───────────────────\n';
  text += `📍 Город: ${city}\n`;
  text += `🧽 Вид уборки: ${type}\n`;
  text += `📐 Площадь: ${area} м²\n`;
  text += `🗓 Дата и время: ${dateTime}\n`;
  text += `💰 Оплата мастеру: ${pay} руб\n`;
  text += `📍 Улица: ${streetOnly}\n`;
  text += `🧰 Оборудование: ${equipment}\n`;
  text += `🧪 Химия: ${chemistry}\n`;

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
  const twoGisLink = build2GisLink(order['Город'], fullAddress);

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
  if (twoGisLink) {
    text += `🗺 2ГИС: <a href="${escapeTelegramHtml(twoGisLink)}">Открыть адрес</a>\n\n`;
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
    return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${gid}&range=A${row}`;
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

  let text = `📸 Фото от мастера: ${escapeTelegramHtml(masterName)}`;
  if (orderId) {
    text += `\nЗаявка: <code>${escapeTelegramHtml(orderId)}</code>`;
  }
  if (savedInfo && savedInfo.info) {
    text += `\nСохранено в таблицу: ${escapeTelegramHtml(savedInfo.info)}`;
  }
  if (caption) {
    text += `\nКомментарий: ${escapeTelegramHtml(caption)}`;
  }

  urlFetchJson(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: eventsChatId,
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
