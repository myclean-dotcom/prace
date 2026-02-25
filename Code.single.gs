// ============================================================
// Apex Clean - Google Apps Script backend (single-file rewrite)
// Build: 2026-02-25-button-stable-v1
// ============================================================

const BUILD_VERSION = '2026-02-25-button-stable-v1';
const API_SIGNATURE = 'apex-backend-v3';

const PROP = PropertiesService.getScriptProperties();
const SHEET_NAME = 'Заявки';

const PROP_SPREADSHEET_ID = 'SPREADSHEET_ID';
const PROP_BOT_TOKEN = 'TELEGRAM_BOT_TOKEN';
const PROP_CHAT_FALLBACK = 'TELEGRAM_CHAT_ID';
const PROP_CHAT_NSK = 'TELEGRAM_CHAT_NOVOSIBIRSK';
const PROP_MANAGER_CHAT_ID = 'TELEGRAM_MANAGER_CHAT_ID';
const PROP_WEBAPP_EXEC_URL = 'WEBAPP_EXEC_URL';

const CALLBACK_TTL_SEC = 600;

const STATUS_PUBLISHED = 'Опубликована';
const STATUS_TAKEN = 'Взята';
const STATUS_ARRIVED = 'На объекте';
const STATUS_DONE = 'Завершена';
const STATUS_PAID = 'Оплачена';
const STATUS_CANCELLED = 'Отменена';

const ACTION_TAKE = 'take';
const ACTION_ARRIVE = 'arrive';
const ACTION_DONE = 'done';
const ACTION_PAID = 'paid';
const ACTION_CANCEL = 'cancel';

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

// =========================
// Entry points
// =========================

function doGet(e) {
  try {
    const q = e && e.parameter ? e.parameter : {};
    const isHealth = String(q.health || '') === '1';

    if (isHealth) {
      return jsonResponse({
        ok: true,
        info: 'webapp active',
        buildVersion: BUILD_VERSION,
        apiSignature: API_SIGNATURE,
        execUrl: resolveWebhookExecUrl('')
      });
    }

    const html = HtmlService.createHtmlOutput(
      '<!doctype html><html><head><meta charset="utf-8"><title>WebApp Active</title></head>' +
      '<body style="font-family:Arial,sans-serif;padding:24px;">' +
      '<h2>Web App развернут</h2>' +
      '<p>Проверка: добавьте <code>?health=1</code>.</p>' +
      '<p>buildVersion: <code>' + escapeHtml(BUILD_VERSION) + '</code></p>' +
      '</body></html>'
    );
    return html.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message, buildVersion: BUILD_VERSION, apiSignature: API_SIGNATURE });
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
      return jsonResponse({ ok: true, action: 'probe_version', buildVersion: BUILD_VERSION, apiSignature: API_SIGNATURE });
    }

    if (action === 'check_bot') {
      return checkTelegramBotStatus();
    }

    if (action === 'create' || action === 'update' || looksLikeCreatePayload(body)) {
      return createOrUpdateOrder(body, action || 'create');
    }

    return jsonResponse({
      ok: false,
      error: 'unknown action',
      keys: Object.keys(body || {}),
      buildVersion: BUILD_VERSION,
      apiSignature: API_SIGNATURE
    });
  } catch (err) {
    Logger.log('doPost error: ' + err.message + '\n' + (err.stack || ''));
    return jsonResponse({ ok: false, error: err.message, buildVersion: BUILD_VERSION, apiSignature: API_SIGNATURE });
  }
}

// =========================
// Incoming payload parsing
// =========================

function parseIncomingBody(event) {
  const raw = event.postData && event.postData.contents ? String(event.postData.contents) : '';
  const paramsFlat = flattenParameters(event.parameters || {});
  const param = event.parameter || {};

  let body = {};

  if (raw) {
    const json = tryParseJson(raw);
    if (json && typeof json === 'object') {
      body = json;
    } else {
      body = parseFormEncoded(raw);
    }
  } else {
    body = Object.keys(param).length ? param : paramsFlat;
  }

  body = unwrapNestedPayload(body);

  if (!body || typeof body !== 'object') body = {};

  const action = String(body.action || '').trim().toLowerCase();
  if (action) body.action = action;
  if (!action && looksLikeCreatePayload(body)) body.action = 'create';

  return body;
}

function flattenParameters(parameters) {
  const out = {};
  const keys = Object.keys(parameters || {});
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = parameters[k];
    out[k] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}

function parseFormEncoded(raw) {
  const out = {};
  const pairs = String(raw || '').split('&');
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    if (!p) continue;
    const idx = p.indexOf('=');
    const key = decodeURIComponent((idx >= 0 ? p.slice(0, idx) : p).replace(/\+/g, ' '));
    const val = decodeURIComponent((idx >= 0 ? p.slice(idx + 1) : '').replace(/\+/g, ' '));
    if (!key) continue;
    out[key] = val;
  }
  return out;
}

function unwrapNestedPayload(obj) {
  let current = obj || {};

  for (let i = 0; i < 6; i++) {
    if (!current || typeof current !== 'object') break;

    const jsonParsed = tryParseJson(current.json);
    if (jsonParsed && typeof jsonParsed === 'object') {
      current = jsonParsed;
      continue;
    }

    const payloadParsed = tryParseJson(current.payload);
    if (payloadParsed && typeof payloadParsed === 'object') {
      current = payloadParsed;
      continue;
    }

    const dataParsed = tryParseJson(current.data);
    if (dataParsed && typeof dataParsed === 'object') {
      current = dataParsed;
      continue;
    }

    break;
  }

  return current;
}

function looksLikeCreatePayload(body) {
  if (!body || typeof body !== 'object') return false;
  const keys = Object.keys(body || {});
  if (!keys.length) return false;

  const hints = [
    'customerName', 'customerPhone', 'customerCity',
    'customerAddress', 'orderDate', 'orderTime',
    'cleaningType', 'orderTotal', 'masterPay', 'equipment', 'chemistry'
  ];

  for (let i = 0; i < hints.length; i++) {
    if (Object.prototype.hasOwnProperty.call(body, hints[i])) return true;
  }

  return false;
}

// =========================
// Create/update order
// =========================

function createOrUpdateOrder(payload, action) {
  const sheet = getSheet();
  const order = normalizeOrderPayload(payload || {});

  if (String(action || '').toLowerCase() === 'update' && order.orderId) {
    const existing = findRowByOrderId(order.orderId);
    if (existing) {
      updateOrderRow(existing, order);
      return jsonResponse({ ok: true, updated: true, orderId: order.orderId, buildVersion: BUILD_VERSION, apiSignature: API_SIGNATURE });
    }
  }

  const rowData = buildRowData(order, STATUS_PUBLISHED);
  appendOrderRow(sheet, rowData);

  const publish = sendOrderToGroup(order);

  if (publish.ok) {
    setTelegramMessageIds(order.orderId, publish.chatId, publish.messageId);
    return jsonResponse({
      ok: true,
      orderId: order.orderId,
      chat: publish.chatId,
      messageId: publish.messageId,
      buildVersion: BUILD_VERSION,
      apiSignature: API_SIGNATURE
    });
  }

  return jsonResponse({
    ok: true,
    orderId: order.orderId,
    note: publish.note || publish.error || 'saved without telegram',
    telegramOk: false,
    buildVersion: BUILD_VERSION,
    apiSignature: API_SIGNATURE
  });
}

function normalizeOrderPayload(payload) {
  const city = normalizeCity(pick(payload, ['customerCity', 'city', 'Город']));
  const now = new Date();

  const orderId = normalizeStr(pick(payload, ['orderId', 'Номер заявки'])) || ('CLN-' + String(Date.now()).slice(-8));
  const manager = normalizeStr(pick(payload, ['manager', 'Менеджер'])) || 'Менеджер';
  const customerName = normalizeClientName(pick(payload, ['customerName', 'Имя клиента']));
  const customerPhone = normalizePhone(pick(payload, ['customerPhone', 'Телефон клиента']));
  const address = normalizeStr(pick(payload, ['customerAddress', 'address', 'Улица и дом']));
  const flat = normalizeStr(pick(payload, ['customerFlat', 'Квартира/офис']));

  const orderDate = normalizeDateValue(pick(payload, ['orderDate', 'Дата уборки']), now);
  const orderTime = normalizeTimeValue(pick(payload, ['orderTime', 'Время уборки']));

  const orderTotal = normalizeMoney(pick(payload, ['orderTotal', 'Сумма заказа']));
  const masterPay = normalizeMoney(pick(payload, ['masterPay', 'Зарплата мастерам']));

  const cleaningType = normalizeStr(pick(payload, ['cleaningType', 'Тип уборки'])) || 'Не указано';
  const area = normalizeArea(pick(payload, ['area', 'Площадь (м²)']));

  const equipment = normalizeListField(pick(payload, ['equipment', 'equipmentList', 'Оборудование'])) || 'Не указано';
  const chemistry = normalizeListField(pick(payload, ['chemistry', 'chemistryList', 'Химия'])) || 'Не указано';

  const worksDescription = normalizeStr(pick(payload, ['worksDescription', 'Описание работ', 'description'])) || '';

  return {
    orderId: orderId,
    createdAt: formatDateTime(now),
    manager: manager,
    customerName: customerName,
    customerPhone: customerPhone,
    customerCity: city,
    customerAddress: address,
    customerFlat: flat,
    orderDate: orderDate,
    orderTime: orderTime,
    orderTotal: orderTotal,
    masterPay: masterPay,
    cleaningType: cleaningType,
    area: area,
    chemistry: chemistry,
    equipment: equipment,
    worksDescription: worksDescription
  };
}

function buildRowData(order, status) {
  return {
    'Номер заявки': order.orderId,
    'Дата создания': order.createdAt,
    'Менеджер': order.manager,
    'Имя клиента': order.customerName,
    'Телефон клиента': order.customerPhone,
    'Город': order.customerCity,
    'Улица и дом': order.customerAddress,
    'Квартира/офис': order.customerFlat,
    'Дата уборки': order.orderDate,
    'Время уборки': order.orderTime,
    'Сумма заказа': order.orderTotal,
    'Зарплата мастерам': order.masterPay,
    'Тип уборки': order.cleaningType,
    'Площадь (м²)': order.area,
    'Химия': order.chemistry,
    'Оборудование': order.equipment,
    'Описание работ': order.worksDescription,
    'Статус': status || STATUS_PUBLISHED,
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
  const headerMap = getHeaderMap(sheet);

  setCell(sheet, rowNum, headerMap, 'Менеджер', order.manager);
  setCell(sheet, rowNum, headerMap, 'Имя клиента', order.customerName);
  setCell(sheet, rowNum, headerMap, 'Телефон клиента', order.customerPhone);
  setCell(sheet, rowNum, headerMap, 'Город', order.customerCity);
  setCell(sheet, rowNum, headerMap, 'Улица и дом', order.customerAddress);
  setCell(sheet, rowNum, headerMap, 'Квартира/офис', order.customerFlat);
  setCell(sheet, rowNum, headerMap, 'Дата уборки', order.orderDate);
  setCell(sheet, rowNum, headerMap, 'Время уборки', order.orderTime);
  setCell(sheet, rowNum, headerMap, 'Сумма заказа', order.orderTotal);
  setCell(sheet, rowNum, headerMap, 'Зарплата мастерам', order.masterPay);
  setCell(sheet, rowNum, headerMap, 'Тип уборки', order.cleaningType);
  setCell(sheet, rowNum, headerMap, 'Площадь (м²)', order.area);
  setCell(sheet, rowNum, headerMap, 'Химия', order.chemistry);
  setCell(sheet, rowNum, headerMap, 'Оборудование', order.equipment);
  setCell(sheet, rowNum, headerMap, 'Описание работ', order.worksDescription);
}

// =========================
// Telegram publishing
// =========================

function sendOrderToGroup(order) {
  const token = getBotToken();
  const chatId = resolveTelegramChat(order.customerCity);

  if (!token) return { ok: false, note: 'token not set' };
  if (!chatId) return { ok: false, note: 'chat id not set' };

  const text = buildGroupMessage(order);
  const keyboard = {
    inline_keyboard: [[
      { text: '✅ ВЫХОЖУ НА ЗАЯВКУ', callback_data: makeCallbackData(ACTION_TAKE, order.orderId) }
    ]]
  };

  const resp = tgSendMessage(token, chatId, text, keyboard);
  if (!resp.ok) {
    return { ok: false, error: resp.error || 'telegram send error', raw: resp.raw };
  }

  return {
    ok: true,
    chatId: String(chatId),
    messageId: resp.result && resp.result.message_id ? String(resp.result.message_id) : ''
  };
}

function buildGroupMessage(order) {
  const streetOnly = extractStreetOnly(order.customerAddress);
  const dt = joinDateTime(order.orderDate, order.orderTime);

  let t = '';
  t += `🧹 <b>ЗАЯВКА №${escapeTg(order.orderId)}</b>\n`;
  t += '────────────────────\n';
  t += `📍 Город: ${escapeTg(order.customerCity)}\n`;
  t += `🧽 Вид уборки: ${escapeTg(order.cleaningType)}\n`;
  t += `📐 Площадь: ${escapeTg(order.area)}\n`;
  if (dt) t += `🗓 Дата и время: ${escapeTg(dt)}\n`;
  t += `💰 Оплата мастеру: ${escapeTg(order.masterPay)} руб\n`;
  t += `📍 Улица: ${escapeTg(streetOnly || order.customerAddress || 'Не указано')}\n`;

  t += `\n🧰 Оборудование: ${escapeTg(order.equipment || 'Не указано')}\n`;
  t += `🧪 Химия: ${escapeTg(order.chemistry || 'Не указано')}\n`;

  if (order.worksDescription) {
    t += `\n📝 Дополнительное описание: ${escapeTg(order.worksDescription)}\n`;
  }

  return t;
}

function buildMasterFullMessage(orderRow) {
  const date = formatSheetDate(orderRow['Дата уборки']);
  const time = formatSheetTime(orderRow['Время уборки']);
  const dt = joinDateTime(date, time);

  const city = normalizeCity(orderRow['Город']);
  const address = normalizeStr(orderRow['Улица и дом']);
  const flat = normalizeStr(orderRow['Квартира/офис']);
  const fullAddr = [address, flat].filter(Boolean).join(', ');

  let t = '';
  t += `🧹 <b>ПОЛНАЯ ИНФОРМАЦИЯ О ЗАЯВКЕ №${escapeTg(orderRow['Номер заявки'])}</b>\n`;
  t += '────────────────────────────────────\n\n';

  t += '<b>📋 ОСНОВНАЯ ИНФОРМАЦИЯ</b>\n';
  t += `🏙 Город: ${escapeTg(city)}\n`;
  t += `🧽 Вид уборки: ${escapeTg(orderRow['Тип уборки'] || 'Не указано')}\n`;
  t += `📐 Площадь: ${escapeTg(orderRow['Площадь (м²)'] || '—')}\n`;
  if (dt) t += `🗓 Дата и время: ${escapeTg(dt)}\n`;
  t += `📍 Адрес: ${escapeTg(fullAddr || 'Не указан')}\n`;

  const mapUrl = build2gisLink(city, fullAddr || address);
  if (mapUrl) {
    t += `🗺 2ГИС: ${escapeTg(mapUrl)}\n`;
  }

  t += '\n<b>👤 ДАННЫЕ КЛИЕНТА</b>\n';
  t += `Имя: ${escapeTg(orderRow['Имя клиента'] || '—')}\n`;
  t += `Телефон: <code>${escapeTg(orderRow['Телефон клиента'] || '—')}</code>\n`;

  t += '\n<b>🧰 ЧТО ВЗЯТЬ С СОБОЙ</b>\n';
  t += `Оборудование: ${escapeTg(orderRow['Оборудование'] || 'Не указано')}\n`;
  t += `Химия: ${escapeTg(orderRow['Химия'] || 'Не указано')}\n`;

  t += '\n<b>💰 ФИНАНСЫ</b>\n';
  t += `Сумма заказа: ${escapeTg(orderRow['Сумма заказа'] || '0')} руб\n`;
  t += `Ваша оплата: ${escapeTg(orderRow['Зарплата мастерам'] || '0')} руб\n`;

  t += '\n<b>✅ ЧТО НУЖНО СДЕЛАТЬ</b>\n';
  t += '1️⃣ Напишите клиенту: подтвердите, что вы приняты на заказ, укажите дату, время и адрес.\n';
  t += '2️⃣ Подготовьтесь заранее: проверьте оборудование, химию и маршрут без опоздания.\n';
  t += '3️⃣ По прибытии нажмите кнопку «Приехал на заявку» и отправьте фото оборудования/химии.\n';
  t += '4️⃣ После выполнения отправьте фотографии результата.\n';
  t += '5️⃣ Отправьте фото подписанного акта выполненных работ.\n';
  t += '6️⃣ После оплаты нажмите кнопку «Оплата получена».\n';

  return t;
}

function buildMasterKeyboard(orderId) {
  return {
    inline_keyboard: [
      [{ text: '📍 ПРИЕХАЛ НА ЗАЯВКУ', callback_data: makeCallbackData(ACTION_ARRIVE, orderId) }],
      [{ text: '✅ ЗАВЕРШИЛ ЗАЯВКУ', callback_data: makeCallbackData(ACTION_DONE, orderId) }],
      [{ text: '💰 ОПЛАТА ПОЛУЧЕНА', callback_data: makeCallbackData(ACTION_PAID, orderId) }],
      [{ text: '❌ ОТМЕНИТЬ ЗАЯВКУ', callback_data: makeCallbackData(ACTION_CANCEL, orderId) }]
    ]
  };
}

// =========================
// Telegram update handling
// =========================

function handleTelegramUpdate(update) {
  const token = getBotToken();
  if (!token) return jsonResponse({ ok: false, error: 'TELEGRAM_BOT_TOKEN not set', buildVersion: BUILD_VERSION, apiSignature: API_SIGNATURE });

  try {
    if (update.callback_query) {
      const res = handleCallbackQuery(update.callback_query, token);
      return jsonResponse(res);
    }

    if (update.message) {
      const msg = update.message;

      // /menu and help commands
      if (msg.text) {
        handleBotTextCommand(msg, token);
      }

      // photos from masters
      if (msg.photo && msg.from && msg.from.id) {
        handleMasterPhotoMessage(msg, token);
      }
    }

    return jsonResponse({ ok: true, buildVersion: BUILD_VERSION, apiSignature: API_SIGNATURE });
  } catch (err) {
    Logger.log('handleTelegramUpdate error: ' + err.message + '\n' + (err.stack || ''));
    return jsonResponse({ ok: false, error: err.message, buildVersion: BUILD_VERSION, apiSignature: API_SIGNATURE });
  }
}

function handleCallbackQuery(cb, token) {
  const callbackId = String(cb.id || '');
  const rawData = cb.data || '';

  if (!callbackId) return { ok: false, error: 'callback id missing' };

  if (isDuplicateCallback(callbackId)) {
    answerCallback(token, callbackId, '⏳ Уже обработано');
    return { ok: true, duplicate: true };
  }

  const parsed = parseCallbackData(rawData);
  const action = parsed.action;
  const orderId = parsed.orderId;

  if (!action || !orderId) {
    answerCallback(token, callbackId, '❌ Некорректная кнопка');
    return { ok: false, error: 'bad callback data', rawData: rawData };
  }

  if (action === ACTION_TAKE) return handleTakeCallback(cb, token, callbackId, orderId);
  if (action === ACTION_ARRIVE) return handleArriveCallback(cb, token, callbackId, orderId);
  if (action === ACTION_DONE) return handleDoneCallback(cb, token, callbackId, orderId);
  if (action === ACTION_PAID) return handlePaidCallback(cb, token, callbackId, orderId);
  if (action === ACTION_CANCEL) return handleCancelCallback(cb, token, callbackId, orderId);

  answerCallback(token, callbackId, '❌ Неизвестное действие');
  return { ok: false, error: 'unknown callback action', action: action };
}

function handleTakeCallback(cb, token, callbackId, orderId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const rowNum = findRowByOrderId(orderId);
    if (!rowNum) {
      answerCallback(token, callbackId, '❌ Заявка не найдена');
      return { ok: false, error: 'order not found', orderId: orderId };
    }

    const row = getOrderRowByNumber(rowNum);
    const status = normalizeStr(row['Статус']);

    if (status === STATUS_TAKEN || status === STATUS_ARRIVED || status === STATUS_DONE || status === STATUS_PAID) {
      answerCallback(token, callbackId, '⚠️ Заявка уже взята');
      return { ok: true, alreadyTaken: true, orderId: orderId, status: status };
    }

    const from = cb.from || {};
    const masterId = String(from.id || '');
    const masterName = normalizeMasterName(from);

    updateOrderState(orderId, {
      'Статус': STATUS_TAKEN,
      'Master ID': masterId,
      'Master Name': masterName,
      'Дата принятия': formatDateTime(new Date())
    });

    // Send full info to master
    const fullText = buildMasterFullMessage(row);
    const kb = buildMasterKeyboard(orderId);
    const dm = tgSendMessage(token, masterId, fullText, kb);

    // Remove/disable group button
    const srcChatId = row['Telegram Chat ID'] || (cb.message && cb.message.chat ? cb.message.chat.id : '');
    const srcMsgId = row['Telegram Message ID'] || (cb.message ? cb.message.message_id : '');
    if (srcChatId && srcMsgId) {
      tgEditReplyMarkup(token, srcChatId, srcMsgId, { inline_keyboard: [] });
    }

    if (dm.ok) {
      answerCallback(token, callbackId, '✅ Заявка принята');
    } else {
      answerCallback(token, callbackId, '⚠️ Заявка принята, но не удалось отправить в ЛС');
    }

    notifyManager(`✅ Мастер взял заявку ${orderId}\n👤 ${masterName}`);

    return { ok: true, action: ACTION_TAKE, orderId: orderId, dmOk: dm.ok };
  } finally {
    lock.releaseLock();
  }
}

function handleArriveCallback(cb, token, callbackId, orderId) {
  const fromId = String(cb.from && cb.from.id ? cb.from.id : '');
  if (!ensureMasterOwnership(orderId, fromId)) {
    answerCallback(token, callbackId, '❌ Это не ваша заявка');
    return { ok: false, error: 'not owner', orderId: orderId };
  }

  updateOrderState(orderId, {
    'Статус': STATUS_ARRIVED,
    'Дата прибытия': formatDateTime(new Date())
  });

  answerCallback(token, callbackId, '✅ Отметили прибытие');
  notifyManager(`📍 Мастер прибыл на заявку ${orderId}.\nНужно сформировать ссылку/QR на оплату.`);

  return { ok: true, action: ACTION_ARRIVE, orderId: orderId };
}

function handleDoneCallback(cb, token, callbackId, orderId) {
  const fromId = String(cb.from && cb.from.id ? cb.from.id : '');
  if (!ensureMasterOwnership(orderId, fromId)) {
    answerCallback(token, callbackId, '❌ Это не ваша заявка');
    return { ok: false, error: 'not owner', orderId: orderId };
  }

  updateOrderState(orderId, {
    'Статус': STATUS_DONE,
    'Дата завершения': formatDateTime(new Date()),
    'Статус выполнения': 'Выполнено'
  });

  answerCallback(token, callbackId, '✅ Отметили завершение');
  notifyManager(`✅ Мастер завершил заявку ${orderId}.\nПроверьте фото и акт.`);

  return { ok: true, action: ACTION_DONE, orderId: orderId };
}

function handlePaidCallback(cb, token, callbackId, orderId) {
  const fromId = String(cb.from && cb.from.id ? cb.from.id : '');
  if (!ensureMasterOwnership(orderId, fromId)) {
    answerCallback(token, callbackId, '❌ Это не ваша заявка');
    return { ok: false, error: 'not owner', orderId: orderId };
  }

  updateOrderState(orderId, {
    'Статус': STATUS_PAID,
    'Дата оплаты': formatDateTime(new Date()),
    'Статус выполнения': 'Оплачено'
  });

  answerCallback(token, callbackId, '✅ Оплата отмечена');
  notifyManager(`💰 Подтверждена оплата по заявке ${orderId}.`);

  return { ok: true, action: ACTION_PAID, orderId: orderId };
}

function handleCancelCallback(cb, token, callbackId, orderId) {
  const fromId = String(cb.from && cb.from.id ? cb.from.id : '');
  if (!ensureMasterOwnership(orderId, fromId)) {
    answerCallback(token, callbackId, '❌ Это не ваша заявка');
    return { ok: false, error: 'not owner', orderId: orderId };
  }

  const rowNum = findRowByOrderId(orderId);
  if (!rowNum) {
    answerCallback(token, callbackId, '❌ Заявка не найдена');
    return { ok: false, error: 'not found', orderId: orderId };
  }

  const row = getOrderRowByNumber(rowNum);

  updateOrderState(orderId, {
    'Статус': STATUS_CANCELLED,
    'Master ID': '',
    'Master Name': '',
    'Дата принятия': '',
    'Дата прибытия': '',
    'Дата завершения': '',
    'Дата оплаты': '',
    'Статус выполнения': 'Отменена мастером'
  });

  // republish with fresh button
  const order = mapRowToOrder(row);
  const publish = sendOrderToGroup(order);
  if (publish.ok) {
    setTelegramMessageIds(orderId, publish.chatId, publish.messageId);
  }

  answerCallback(token, callbackId, '✅ Заявка отменена и возвращена в группу');
  notifyManager(`↩️ Мастер отменил заявку ${orderId}. Заявка возвращена в группу.`);

  return { ok: true, action: ACTION_CANCEL, orderId: orderId, republishOk: publish.ok };
}

function handleBotTextCommand(msg, token) {
  const rawText = normalizeStr(msg.text);
  if (!rawText) return;

  const normalizedCommand = parseBotCommand(rawText);
  const text = rawText.toLowerCase();
  const chatId = String(msg.chat.id);

  if (
    normalizedCommand === '/start' ||
    normalizedCommand === '/menu' ||
    normalizedCommand === '/help' ||
    normalizedCommand === '/commands'
  ) {
    const kb = {
      keyboard: [
        ['📋 МЕНЮ КОМАНД'],
        ['/menu', '/help'],
        ['🆔 МОЙ CHAT ID']
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    };

    let out = '';
    out += '📋 Команды бота:\n';
    out += '/menu - показать меню\n';
    out += '/help - короткая справка\n';
    out += '\nКнопки по заявке:\n';
    out += '1) ВЫХОЖУ НА ЗАЯВКУ\n';
    out += '2) ПРИЕХАЛ НА ЗАЯВКУ\n';
    out += '3) ЗАВЕРШИЛ ЗАЯВКУ\n';
    out += '4) ОПЛАТА ПОЛУЧЕНА\n';
    out += '5) ОТМЕНИТЬ ЗАЯВКУ';

    tgSendMessage(token, chatId, out, null, kb);
    return;
  }

  if (normalizedCommand === '/id' || text === '🆔 мой chat id') {
    tgSendMessage(token, chatId, 'Ваш chat_id: <code>' + escapeTg(chatId) + '</code>');
    return;
  }

  if (text === '📋 меню команд' || text === 'меню') {
    tgSendMessage(token, chatId, 'Используйте /menu для полного списка команд.');
    return;
  }
}

function parseBotCommand(text) {
  const s = normalizeStr(text);
  if (!s || s.charAt(0) !== '/') return '';

  const firstToken = s.split(' ')[0];
  const cmd = firstToken.split('@')[0].toLowerCase();
  return cmd;
}

function handleMasterPhotoMessage(msg, token) {
  const fromId = String(msg.from && msg.from.id ? msg.from.id : '');
  if (!fromId) return;

  const rowNum = findLatestOrderByMasterId(fromId);
  if (!rowNum) {
    tgSendMessage(token, fromId, '✅ Фото получено. Не удалось автоматически привязать к заявке.');
    return;
  }

  const fileId = msg.photo && msg.photo.length ? msg.photo[msg.photo.length - 1].file_id : '';
  const caption = normalizeStr(msg.caption);

  appendPhotoToOrder(rowNum, fileId, caption);
  tgSendMessage(token, fromId, '✅ Фото получено и сохранено в таблицу.');

  const order = getOrderRowByNumber(rowNum);
  notifyManager(`📷 Получено фото по заявке ${order['Номер заявки'] || ''} от мастера.`);
}

// =========================
// Callback parsing + dedupe
// =========================

function makeCallbackData(action, orderId) {
  return String(action) + ':' + String(orderId);
}

function parseCallbackData(raw) {
  const data = String(raw || '').trim();
  if (!data) return { action: '', orderId: '' };

  const asJson = tryParseJson(data);
  if (asJson && typeof asJson === 'object') {
    return {
      action: normalizeStr(asJson.action).toLowerCase(),
      orderId: normalizeStr(asJson.orderId)
    };
  }

  let m = data.match(/^([a-z_]+):(.+)$/i);
  if (m) return { action: m[1].toLowerCase(), orderId: m[2] };

  m = data.match(/^([a-z_]+)_(CLN-[0-9]+)$/i);
  if (m) return { action: m[1].toLowerCase(), orderId: m[2] };

  m = data.match(/^([a-z_]+)\|(.+)$/i);
  if (m) return { action: m[1].toLowerCase(), orderId: m[2] };

  return { action: '', orderId: '' };
}

function isDuplicateCallback(callbackId) {
  const key = 'CB_' + String(callbackId);
  const cache = CacheService.getScriptCache();
  const exists = cache.get(key);
  if (exists) return true;
  cache.put(key, '1', CALLBACK_TTL_SEC);
  return false;
}

// =========================
// Spreadsheet
// =========================

function getSpreadsheet() {
  const ssId = normalizeStr(PROP.getProperty(PROP_SPREADSHEET_ID));
  if (ssId) {
    return SpreadsheetApp.openById(ssId);
  }

  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;

  throw new Error('Не удалось открыть таблицу. Задайте SPREADSHEET_ID в Script Properties.');
}

function getSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  ensureHeaders(sheet);
  return sheet;
}

function ensureHeaders(sheet) {
  const maxCols = Math.max(sheet.getLastColumn(), REQUIRED_HEADERS.length, 1);
  if (sheet.getMaxColumns() < maxCols) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), maxCols - sheet.getMaxColumns());
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, REQUIRED_HEADERS.length).setValues([REQUIRED_HEADERS]);
    return;
  }

  const headers = sheet.getRange(1, 1, 1, maxCols).getValues()[0].map(function(v) { return normalizeStr(v); });
  const missing = [];
  for (let i = 0; i < REQUIRED_HEADERS.length; i++) {
    if (headers.indexOf(REQUIRED_HEADERS[i]) === -1) missing.push(REQUIRED_HEADERS[i]);
  }

  if (!missing.length) return;

  let lastFilled = 0;
  for (let c = 0; c < headers.length; c++) {
    if (headers[c]) lastFilled = c + 1;
  }

  const start = Math.max(1, lastFilled + 1);
  const needEnd = start + missing.length - 1;
  if (sheet.getMaxColumns() < needEnd) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), needEnd - sheet.getMaxColumns());
  }

  sheet.getRange(1, start, 1, missing.length).setValues([missing]);
}

function getHeaderMap(sheet) {
  const sh = sheet || getSheet();
  ensureHeaders(sh);
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = {};

  for (let i = 0; i < headers.length; i++) {
    const h = normalizeStr(headers[i]);
    if (h) map[h] = i + 1;
  }

  return map;
}

function appendOrderRow(sheet, rowData) {
  const sh = sheet || getSheet();
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function(v) { return normalizeStr(v); });
  const row = headers.map(function(h) { return Object.prototype.hasOwnProperty.call(rowData, h) ? rowData[h] : ''; });
  sh.appendRow(row);
}

function findRowByOrderId(orderId) {
  const sh = getSheet();
  const map = getHeaderMap(sh);
  const col = map['Номер заявки'];
  const last = sh.getLastRow();
  if (!col || last < 2) return null;

  const values = sh.getRange(2, col, last - 1, 1).getValues();
  const target = normalizeStr(orderId);

  for (let i = 0; i < values.length; i++) {
    if (normalizeStr(values[i][0]) === target) return i + 2;
  }

  return null;
}

function findLatestOrderByMasterId(masterId) {
  const sh = getSheet();
  const map = getHeaderMap(sh);
  const colMaster = map['Master ID'];
  const colStatus = map['Статус'];
  const last = sh.getLastRow();

  if (!colMaster || !colStatus || last < 2) return null;

  const rows = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  let found = null;

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (normalizeStr(row[colMaster - 1]) !== String(masterId)) continue;
    const status = normalizeStr(row[colStatus - 1]);
    if (status === STATUS_TAKEN || status === STATUS_ARRIVED || status === STATUS_DONE || status === STATUS_PAID) {
      found = i + 2;
      break;
    }
  }

  return found;
}

function getOrderRowByNumber(rowNum) {
  const sh = getSheet();
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function(v) { return normalizeStr(v); });
  const values = sh.getRange(rowNum, 1, 1, lastCol).getValues()[0];

  const out = {};
  for (let i = 0; i < headers.length; i++) {
    if (!headers[i]) continue;
    out[headers[i]] = values[i];
  }

  return out;
}

function updateOrderState(orderId, patch) {
  const rowNum = findRowByOrderId(orderId);
  if (!rowNum) return false;

  const sh = getSheet();
  const map = getHeaderMap(sh);
  const keys = Object.keys(patch || {});

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    setCell(sh, rowNum, map, key, patch[key]);
  }

  return true;
}

function setTelegramMessageIds(orderId, chatId, messageId) {
  updateOrderState(orderId, {
    'Telegram Chat ID': String(chatId || ''),
    'Telegram Message ID': String(messageId || '')
  });
}

function ensureMasterOwnership(orderId, masterId) {
  const rowNum = findRowByOrderId(orderId);
  if (!rowNum) return false;
  const row = getOrderRowByNumber(rowNum);
  return normalizeStr(row['Master ID']) === normalizeStr(masterId);
}

function setCell(sheet, rowNum, headerMap, header, value) {
  const col = headerMap[header];
  if (!col) return;
  sheet.getRange(rowNum, col).setValue(value);
}

function appendPhotoToOrder(rowNum, fileId, caption) {
  const sh = getSheet();
  const map = getHeaderMap(sh);
  const base = map['Статус выполнения'] || REQUIRED_HEADERS.length;
  const firstPhotoCol = base + 1;

  const lastCol = sh.getLastColumn();
  let col = null;

  for (let c = firstPhotoCol; c <= lastCol; c++) {
    const cell = sh.getRange(rowNum, c).getValue();
    if (!cell) {
      col = c;
      break;
    }
  }

  if (!col) {
    col = Math.max(lastCol + 1, firstPhotoCol);
    sh.getRange(1, col).setValue('Фото ' + (col - firstPhotoCol + 1));
  }

  const info = [String(fileId || ''), String(caption || ''), formatDateTime(new Date())].join(' | ');
  sh.getRange(rowNum, col).setValue(info);
}

function mapRowToOrder(row) {
  return {
    orderId: normalizeStr(row['Номер заявки']),
    manager: normalizeStr(row['Менеджер']),
    customerName: normalizeStr(row['Имя клиента']),
    customerPhone: normalizeStr(row['Телефон клиента']),
    customerCity: normalizeCity(row['Город']),
    customerAddress: normalizeStr(row['Улица и дом']),
    customerFlat: normalizeStr(row['Квартира/офис']),
    orderDate: formatSheetDate(row['Дата уборки']),
    orderTime: formatSheetTime(row['Время уборки']),
    orderTotal: normalizeStr(row['Сумма заказа']),
    masterPay: normalizeStr(row['Зарплата мастерам']),
    cleaningType: normalizeStr(row['Тип уборки']),
    area: normalizeStr(row['Площадь (м²)']),
    chemistry: normalizeListField(row['Химия']) || 'Не указано',
    equipment: normalizeListField(row['Оборудование']) || 'Не указано',
    worksDescription: normalizeStr(row['Описание работ'])
  };
}

// =========================
// Reminders (24h and 2h)
// =========================

function sendReminders() {
  const token = getBotToken();
  if (!token) return;

  const sh = getSheet();
  const map = getHeaderMap(sh);
  const last = sh.getLastRow();
  if (last < 2) return;

  const rows = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  const now = new Date();

  for (let i = 0; i < rows.length; i++) {
    const rowVals = rows[i];
    const rowNum = i + 2;

    const status = normalizeStr(rowVals[(map['Статус'] || 1) - 1]);
    if (!(status === STATUS_TAKEN || status === STATUS_ARRIVED)) continue;

    const masterId = normalizeStr(rowVals[(map['Master ID'] || 1) - 1]);
    if (!masterId) continue;

    const dateStr = formatSheetDate(rowVals[(map['Дата уборки'] || 1) - 1]);
    const timeStr = formatSheetTime(rowVals[(map['Время уборки'] || 1) - 1]);
    const target = parseOrderDateTime(dateStr, timeStr);
    if (!target) continue;

    const diff = target.getTime() - now.getTime();

    const sent24 = normalizeStr(rowVals[(map['Напоминание 24ч'] || 1) - 1]);
    const sent2 = normalizeStr(rowVals[(map['Напоминание 2ч'] || 1) - 1]);

    // 24h window: 24h..23h
    if (!sent24 && diff <= 24 * 60 * 60 * 1000 && diff > 23 * 60 * 60 * 1000) {
      tgSendMessage(token, masterId, `⏰ Напоминание: заявка через 24 часа.`);
      setCell(sh, rowNum, map, 'Напоминание 24ч', 'Отправлено ' + formatDateTime(new Date()));
    }

    // 2h window: 2h..1h30
    if (!sent2 && diff <= 2 * 60 * 60 * 1000 && diff > 90 * 60 * 1000) {
      tgSendMessage(token, masterId, `🚨 Напоминание: заявка через 2 часа.`);
      setCell(sh, rowNum, map, 'Напоминание 2ч', 'Отправлено ' + formatDateTime(new Date()));
    }
  }
}

// =========================
// Bot status / health API
// =========================

function checkTelegramBotStatus() {
  const token = getBotToken();
  const chat = resolveTelegramChat('Новосибирск');

  if (!token) {
    return jsonResponse({ ok: false, error: 'TELEGRAM_BOT_TOKEN не задан', buildVersion: BUILD_VERSION, apiSignature: API_SIGNATURE });
  }

  if (!chat) {
    return jsonResponse({ ok: false, error: 'TELEGRAM_CHAT_NOVOSIBIRSK/TELEGRAM_CHAT_ID не задан', buildVersion: BUILD_VERSION, apiSignature: API_SIGNATURE });
  }

  const me = tgApi(token, 'getMe', {});
  if (!me.ok) {
    return jsonResponse({ ok: false, error: 'Ошибка Telegram токена', details: me, buildVersion: BUILD_VERSION, apiSignature: API_SIGNATURE });
  }

  return jsonResponse({
    ok: true,
    bot: me.result,
    targetChat: String(chat),
    buildVersion: BUILD_VERSION,
    apiSignature: API_SIGNATURE
  });
}

// =========================
// Setup + diagnostics
// =========================

function __setWebAppExecUrl(webAppExecUrl) {
  const url = normalizeExecUrl(webAppExecUrl);
  if (!url) throw new Error('Передайте корректный URL Web App (/exec)');

  PROP.setProperty(PROP_WEBAPP_EXEC_URL, url);

  const out = {
    ok: true,
    storedWebAppExecUrl: normalizeExecUrl(PROP.getProperty(PROP_WEBAPP_EXEC_URL)),
    resolvedWebhookExecUrl: resolveWebhookExecUrl(url),
    buildVersion: BUILD_VERSION
  };
  Logger.log(JSON.stringify(out));
  return out;
}

function __setWebhookProd(webAppExecUrl) {
  const token = getBotToken();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан');

  const targetUrl = resolveWebhookExecUrl(webAppExecUrl || '');
  if (!targetUrl) throw new Error('Не удалось определить URL Web App /exec');

  const delResp = tgApi(token, 'deleteWebhook', { drop_pending_updates: false });
  const setResp = tgApi(token, 'setWebhook', {
    url: targetUrl,
    allowed_updates: ['message', 'edited_message', 'callback_query']
  });
  const commandsResp = __setTelegramBotCommands();
  const infoResp = tgApi(token, 'getWebhookInfo', {});

  const out = {
    ok: !!(setResp && setResp.ok),
    buildVersion: BUILD_VERSION,
    targetUrl: targetUrl,
    deleteWebhook: delResp,
    setWebhook: setResp,
    setCommands: commandsResp,
    webhookInfo: infoResp
  };

  Logger.log(JSON.stringify(out));
  return out;
}

function __checkSelfAll() {
  const out = {
    ok: true,
    buildVersion: BUILD_VERSION,
    checkedAt: formatDateTime(new Date()),
    checks: {},
    failures: [],
    advice: []
  };

  try {
    out.checks.properties = {
      tokenSet: !!getBotToken(),
      spreadsheetIdSet: !!normalizeStr(PROP.getProperty(PROP_SPREADSHEET_ID)),
      telegramChatNovosibirskSet: !!normalizeStr(PROP.getProperty(PROP_CHAT_NSK)),
      telegramChatFallbackSet: !!normalizeStr(PROP.getProperty(PROP_CHAT_FALLBACK)),
      managerChatIdSet: !!normalizeStr(PROP.getProperty(PROP_MANAGER_CHAT_ID))
    };
  } catch (e1) {
    out.failures.push('properties check error: ' + e1.message);
  }

  try {
    const sh = getSheet();
    const map = getHeaderMap(sh);
    const missing = [];
    for (let i = 0; i < REQUIRED_HEADERS.length; i++) {
      if (!map[REQUIRED_HEADERS[i]]) missing.push(REQUIRED_HEADERS[i]);
    }
    out.checks.sheet = { ok: missing.length === 0, missingHeaders: missing };
    if (missing.length) out.failures.push('В таблице не хватает заголовков: ' + missing.join(', '));
  } catch (e2) {
    out.failures.push('sheet check error: ' + e2.message);
  }

  try {
    const token = getBotToken();
    if (token) {
      const cmdResp = tgApi(token, 'getMyCommands', {});
      const cmdList = cmdResp && cmdResp.ok && Array.isArray(cmdResp.result) ? cmdResp.result : [];
      const hasMenu = cmdList.some(function(c) { return String(c.command || '') === 'menu'; });
      out.checks.botCommands = {
        ok: !!(cmdResp && cmdResp.ok),
        count: cmdList.length,
        hasMenu: hasMenu,
        sample: cmdList.slice(0, 10)
      };
      if (!cmdResp || !cmdResp.ok) out.failures.push('Не удалось прочитать команды бота (getMyCommands)');
      if (!hasMenu) out.failures.push('У бота не задана команда /menu');

      const info = tgApi(token, 'getWebhookInfo', {});
      const current = normalizeExecUrl(info && info.result ? info.result.url : '');
      const expected = resolveWebhookExecUrl('');
      out.checks.webhook = {
        ok: !!(info && info.ok),
        currentWebhookUrl: current,
        expectedWebhookUrl: expected,
        pendingUpdateCount: info && info.result ? Number(info.result.pending_update_count || 0) : 0,
        allowedUpdates: info && info.result ? (info.result.allowed_updates || []) : [],
        lastErrorMessage: info && info.result ? String(info.result.last_error_message || '') : ''
      };

      if (!info.ok) out.failures.push('Ошибка getWebhookInfo');
      if (current !== expected) out.failures.push('Webhook URL не совпадает с ожидаемым /exec');
      const allowed = out.checks.webhook.allowedUpdates || [];
      if (allowed.indexOf('callback_query') === -1) out.failures.push('Webhook не получает callback_query');
    }
  } catch (e3) {
    out.failures.push('webhook check error: ' + e3.message);
  }

  try {
    const execUrl = resolveWebhookExecUrl('');
    const health = probeGet(execUrl + '?health=1');
    out.checks.webAppHealth = health;
    if (!health.ok) out.failures.push('Web App health-check неуспешен');
  } catch (e4) {
    out.failures.push('health check error: ' + e4.message);
  }

  try {
    const execUrl = resolveWebhookExecUrl('');
    const probe = probeDoPost(execUrl, { action: 'probe_version' });
    out.checks.doPostProbe = probe;
    if (!probe.ok) {
      out.failures.push('Внешний POST до doPost неуспешен');
    } else if (!probe.bodyJson || probe.bodyJson.buildVersion !== BUILD_VERSION) {
      out.failures.push('doPost вернул другой buildVersion: ' + (probe.bodyJson ? probe.bodyJson.buildVersion : 'нет')); 
    }
  } catch (e5) {
    out.failures.push('doPost probe error: ' + e5.message);
  }

  try {
    const sample = {
      orderId: 'CLN-12345678',
      customerCity: 'Новосибирск',
      cleaningType: 'Поддерживающая',
      area: '60 м²',
      orderDate: '25.02.2026',
      orderTime: '15:30',
      masterPay: '2880',
      customerAddress: 'Ленина, 10',
      equipment: 'Пылесос, швабра',
      chemistry: 'Универсальное средство',
      worksDescription: 'Тест'
    };
    const text = buildGroupMessage(sample);
    const hasEq = text.indexOf('Оборудование') !== -1;
    const hasChem = text.indexOf('Химия') !== -1;
    out.checks.groupTemplate = { hasEquipmentLine: hasEq, hasChemistryLine: hasChem };
    if (!hasEq || !hasChem) out.failures.push('В шаблоне первого сообщения нет строк оборудования/химии');
  } catch (e6) {
    out.failures.push('group template check error: ' + e6.message);
  }

  try {
    out.checks.callbackParser = [
      'take:CLN-12345678',
      'take_CLN-12345678',
      'take|CLN-12345678',
      '{"action":"take","orderId":"CLN-12345678"}'
    ].map(function(v) {
      return { sample: v, parsed: parseCallbackData(v) };
    });
  } catch (e7) {
    out.failures.push('callback parser check error: ' + e7.message);
  }

  if (out.failures.length) {
    out.ok = false;
    out.advice.push('Переразверните Web App: Выполнять от моего имени, Доступ: Все.');
    out.advice.push('Запустите __setWebhookProd() после деплоя.');
  }

  Logger.log(JSON.stringify(out));
  return out;
}

function __fixAndCheck(webAppExecUrl) {
  const target = normalizeExecUrl(webAppExecUrl || '');
  if (target) {
    __setWebAppExecUrl(target);
  }

  const hook = __setWebhookProd(target || '');
  const check = __checkSelfAll();

  const out = {
    ok: !!(hook.ok && check.ok),
    buildVersion: BUILD_VERSION,
    targetUrl: target || resolveWebhookExecUrl(''),
    setWebhook: hook,
    check: check
  };

  Logger.log(JSON.stringify(out));
  return out;
}

function __checkButtonEndToEnd() {
  return __checkSelfAll();
}

function __setTelegramBotCommands() {
  const token = getBotToken();
  if (!token) {
    const outNoToken = { ok: false, error: 'TELEGRAM_BOT_TOKEN не задан', buildVersion: BUILD_VERSION };
    Logger.log(JSON.stringify(outNoToken));
    return outNoToken;
  }

  const commands = [
    { command: 'start', description: 'Запуск и краткая справка' },
    { command: 'menu', description: 'Показать меню команд' },
    { command: 'help', description: 'Помощь по кнопкам заявки' },
    { command: 'id', description: 'Показать ваш chat_id' }
  ];

  const resp = tgApi(token, 'setMyCommands', { commands: commands });
  const out = {
    ok: !!(resp && resp.ok),
    response: resp,
    commands: commands,
    buildVersion: BUILD_VERSION
  };
  Logger.log(JSON.stringify(out));
  return out;
}

function __cleanupLegacyOrderMetaProps(dryRun) {
  const isDryRun = String(dryRun || '').toLowerCase() === '1' || dryRun === true;
  const props = PROP.getProperties() || {};
  const keys = Object.keys(props);
  const target = [];

  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k.indexOf('ORDER_DM_META_') === 0) {
      target.push(k);
    }
  }

  if (!isDryRun) {
    for (let j = 0; j < target.length; j++) {
      PROP.deleteProperty(target[j]);
    }
  }

  const out = {
    ok: true,
    dryRun: isDryRun,
    found: target.length,
    deleted: isDryRun ? 0 : target.length,
    sampleKeys: target.slice(0, 20),
    buildVersion: BUILD_VERSION
  };

  Logger.log(JSON.stringify(out));
  return out;
}

// =========================
// Telegram API wrappers
// =========================

function getBotToken() {
  return normalizeStr(PROP.getProperty(PROP_BOT_TOKEN));
}

function resolveTelegramChat(city) {
  const cityKey = normalizeCity(city);
  if (cityKey === 'новосибирск') {
    return normalizeStr(PROP.getProperty(PROP_CHAT_NSK)) || normalizeStr(PROP.getProperty(PROP_CHAT_FALLBACK));
  }

  return normalizeStr(PROP.getProperty(PROP_CHAT_FALLBACK));
}

function notifyManager(text) {
  const token = getBotToken();
  const chat = normalizeStr(PROP.getProperty(PROP_MANAGER_CHAT_ID));
  if (!token || !chat) return;
  tgSendMessage(token, chat, text);
}

function tgSendMessage(token, chatId, text, inlineKeyboard, replyKeyboard) {
  const payload = {
    chat_id: String(chatId),
    text: String(text || ''),
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };

  if (inlineKeyboard) payload.reply_markup = inlineKeyboard;
  if (replyKeyboard) payload.reply_markup = replyKeyboard;

  return tgApi(token, 'sendMessage', payload);
}

function tgEditReplyMarkup(token, chatId, messageId, replyMarkup) {
  return tgApi(token, 'editMessageReplyMarkup', {
    chat_id: String(chatId),
    message_id: Number(messageId),
    reply_markup: replyMarkup || { inline_keyboard: [] }
  });
}

function answerCallback(token, callbackId, text) {
  return tgApi(token, 'answerCallbackQuery', {
    callback_query_id: String(callbackId),
    text: String(text || ''),
    show_alert: false
  });
}

function tgApi(token, method, payload) {
  const url = 'https://api.telegram.org/bot' + token + '/' + method;
  const params = {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify(payload || {})
  };

  let resp;
  try {
    resp = UrlFetchApp.fetch(url, params);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const text = resp.getContentText();
  const json = tryParseJson(text);
  if (json && typeof json === 'object') return json;

  return {
    ok: false,
    error: 'non-json telegram response',
    raw: text,
    statusCode: resp.getResponseCode()
  };
}

// =========================
// External probes (diagnostics)
// =========================

function probeGet(url) {
  try {
    const resp = UrlFetchApp.fetch(url, {
      method: 'get',
      muteHttpExceptions: true,
      followRedirects: true
    });
    const code = resp.getResponseCode();
    const body = resp.getContentText() || '';
    const json = tryParseJson(body);
    return {
      ok: code >= 200 && code < 300 && !!json && json.ok === true,
      url: url,
      statusCode: code,
      bodyJsonOk: !!(json && json.ok === true),
      bodyJson: json,
      bodySnippet: body.slice(0, 240)
    };
  } catch (e) {
    return { ok: false, url: url, error: e.message };
  }
}

function probeDoPost(url, obj) {
  try {
    const resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      payload: JSON.stringify(obj || {})
    });

    const code = resp.getResponseCode();
    const body = resp.getContentText() || '';
    const json = tryParseJson(body);

    return {
      ok: code >= 200 && code < 300 && !!json && json.ok === true,
      statusCode: code,
      url: url,
      bodyJson: json,
      bodySnippet: body.slice(0, 240),
      buildVersion: BUILD_VERSION
    };
  } catch (e) {
    return { ok: false, url: url, error: e.message };
  }
}

// =========================
// Date/time helpers
// =========================

function parseOrderDateTime(dateStr, timeStr) {
  const d = normalizeDateValue(dateStr, new Date());
  const t = normalizeTimeValue(timeStr);
  if (!d || !t) return null;

  const dm = d.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  const tm = t.match(/^(\d{2}):(\d{2})$/);
  if (!dm || !tm) return null;

  const y = Number(dm[3]);
  const m = Number(dm[2]) - 1;
  const day = Number(dm[1]);
  const hh = Number(tm[1]);
  const mm = Number(tm[2]);

  const dt = new Date(y, m, day, hh, mm, 0, 0);
  if (isNaN(dt.getTime())) return null;
  return dt;
}

function normalizeDateValue(value, fallbackDate) {
  const v = value;

  if (v instanceof Date && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'dd.MM.yyyy');
  }

  const s = normalizeStr(v);
  if (!s) {
    if (fallbackDate instanceof Date) return Utilities.formatDate(fallbackDate, Session.getScriptTimeZone(), 'dd.MM.yyyy');
    return '';
  }

  let m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) return s;

  m = s.match(/^(\d{2})\.(\d{2})$/);
  if (m) {
    const year = new Date().getFullYear();
    return m[1] + '.' + m[2] + '.' + year;
  }

  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return m[3] + '.' + m[2] + '.' + m[1];

  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, Session.getScriptTimeZone(), 'dd.MM.yyyy');
  }

  return '';
}

function normalizeTimeValue(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'HH:mm');
  }

  const s = normalizeStr(value);
  if (!s) return '';

  let m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const hh = ('0' + Number(m[1])).slice(-2);
    const mm = ('0' + Number(m[2])).slice(-2);
    return hh + ':' + mm;
  }

  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, Session.getScriptTimeZone(), 'HH:mm');
  }

  return '';
}

function formatSheetDate(value) {
  return normalizeDateValue(value, null);
}

function formatSheetTime(value) {
  return normalizeTimeValue(value);
}

function joinDateTime(dateStr, timeStr) {
  const d = normalizeStr(dateStr);
  const t = normalizeStr(timeStr);
  if (d && t) return d + ' в ' + t;
  if (d) return d;
  if (t) return t;
  return '';
}

function formatDateTime(dateObj) {
  return Utilities.formatDate(dateObj, Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm:ss');
}

// =========================
// Normalization helpers
// =========================

function pick(obj, keys) {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (Object.prototype.hasOwnProperty.call(obj || {}, k)) {
      const v = obj[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
  }
  return '';
}

function normalizeStr(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

function normalizeCity(v) {
  return normalizeStr(v);
}

function normalizePhone(v) {
  return normalizeStr(v);
}

function normalizeClientName(v) {
  const cleaned = String(v || '')
    .replace(/[^A-Za-zА-Яа-яЁё\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.split(' ')[0];
}

function normalizeMasterName(from) {
  const first = normalizeStr(from && from.first_name ? from.first_name : '');
  const last = normalizeStr(from && from.last_name ? from.last_name : '');
  const username = normalizeStr(from && from.username ? from.username : '');

  const full = [first, last].filter(Boolean).join(' ').trim();
  if (full) return full;
  if (username) return '@' + username;
  return 'Master';
}

function normalizeArea(v) {
  const s = normalizeStr(v);
  if (!s) return '0 м²';
  if (s.indexOf('м²') !== -1) return s;
  if (/^\d+(?:[\.,]\d+)?$/.test(s)) return s.replace(',', '.') + ' м²';
  return s;
}

function normalizeMoney(v) {
  const s = normalizeStr(v);
  if (!s) return '0';
  const digits = s.replace(/[^0-9]/g, '');
  return digits || '0';
}

function normalizeListField(v) {
  if (Array.isArray(v)) {
    const arr = v.map(function(x) { return normalizeStr(x); }).filter(Boolean);
    return arr.join(', ');
  }

  const s = normalizeStr(v);
  if (!s) return '';

  const compact = s.replace(/[;|]+/g, ',');
  const parts = compact.split(',').map(function(x) { return normalizeStr(x); }).filter(Boolean);
  return parts.join(', ');
}

function extractStreetOnly(address) {
  const a = normalizeStr(address);
  if (!a) return '';
  const part = a.split(',')[0];
  return normalizeStr(part);
}

function build2gisLink(city, address) {
  const c = normalizeStr(city);
  const a = normalizeStr(address);
  if (!c && !a) return '';
  const q = [c, a].filter(Boolean).join(', ');
  return 'https://2gis.ru/search/' + encodeURIComponent(q);
}

function normalizeExecUrl(url) {
  let u = normalizeStr(url);
  if (!u) return '';

  u = u.replace(/\/$/, '');
  if (u.indexOf('/exec') !== -1) {
    u = u.replace(/\/exec.*/, '/exec');
  }
  return u;
}

function resolveWebhookExecUrl(preferred) {
  const p = normalizeExecUrl(preferred || '');
  if (p) return p;

  const stored = normalizeExecUrl(PROP.getProperty(PROP_WEBAPP_EXEC_URL));
  if (stored) return stored;

  try {
    const serviceUrl = normalizeExecUrl(ScriptApp.getService().getUrl());
    if (serviceUrl) return serviceUrl;
  } catch (e) {}

  return '';
}

function tryParseJson(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (!(s[0] === '{' || s[0] === '[')) return null;
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

function escapeTg(v) {
  return String(v || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtml(v) {
  return String(v || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// =========================
// JSON response helper
// =========================

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj || {}))
    .setMimeType(ContentService.MimeType.JSON);
}
