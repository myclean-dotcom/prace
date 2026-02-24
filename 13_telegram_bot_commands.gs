/* ---------- Telegram bot commands/panels ---------- */

/* ---------- Message text/photo ---------- */

function handleTextMessage(message, token) {
  const chatId = String((message.chat && message.chat.id) || '').trim();
  const userId = String((message.from && message.from.id) || '').trim();
  const text = String(message.text || '').trim();
  if (!text) return jsonResponse({ ok: true, buildVersion: BUILD_VERSION });

  if (!String(PROP.getProperty('TELEGRAM_CHAT_ID') || '').trim() && chatId) {
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
  if (t === '/active') return '/active';
  if (t === '/planned') return '/planned';
  if (t === '/pay') return '/pay';
  if (t === '/panel') return '/panel';
  if (t === '/help') return '/help';
  if (t === '/hidepanel') return '/hidepanel';
  if (t === '📋 активные заявки' || t === 'активные заявки') return '/active';
  if (t === '📅 запланированные' || t === 'запланированные') return '/planned';
  if (t === '💳 отправить оплату' || t === 'отправить оплату') return '/pay';
  if (t === '🧭 панель' || t === 'панель') return '/panel';
  if (t === '❓ помощь' || t === 'помощь') return '/help';
  if (t === '⌨️ скрыть панель' || t === 'скрыть панель') return '/hidepanel';
  return '';
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
      `Ваш user_id: <code>${escapeTelegramHtml(uid)}</code>`,
      `Текущий chat_id: <code>${escapeTelegramHtml(cid)}</code>`
    ].join('\n');
    sendManagerCommandReply(token, replyChatId, textInfo, 'HTML', buildManagerPanelKeyboard());
    return { handled: true, ok: true, command: command, userId: uid, chatId: cid };
  }

  if (command === '/setmanager') {
    const cid = String(replyChatId || '').trim();
    if (!cid) return { handled: true, ok: false, error: 'chat_id_empty' };
    PROP.setProperty('TELEGRAM_MANAGER_CHAT_ID', cid);
    sendManagerCommandReply(token, replyChatId, `✅ TELEGRAM_MANAGER_CHAT_ID = ${cid}`, null, buildManagerPanelKeyboard());
    return { handled: true, ok: true, command: command, chatId: cid };
  }

  // Ниже — только для назначенного менеджерского контекста
  if (!managerMode) return { handled: false };

  if (command === '/setevents') {
    const cid = String(replyChatId || '').trim();
    if (!cid) return { handled: true, ok: false, error: 'chat_id_empty' };
    PROP.setProperty('TELEGRAM_EVENTS_CHAT_ID', cid);
    sendManagerCommandReply(token, replyChatId, `✅ TELEGRAM_EVENTS_CHAT_ID = ${cid}`, null, buildManagerPanelKeyboard());
    return { handled: true, ok: true, command: command, chatId: cid };
  }

  if (command === '/setgroup') {
    const cid = String(replyChatId || '').trim();
    if (!cid) return { handled: true, ok: false, error: 'chat_id_empty' };
    PROP.setProperty('TELEGRAM_CHAT_ID', cid);
    sendManagerCommandReply(token, replyChatId, `✅ TELEGRAM_CHAT_ID = ${cid}`, null, buildManagerPanelKeyboard());
    return { handled: true, ok: true, command: command, chatId: cid };
  }

  if (command === '/setnsk') {
    const cid = String(replyChatId || '').trim();
    if (!cid) return { handled: true, ok: false, error: 'chat_id_empty' };
    PROP.setProperty('TELEGRAM_CHAT_NOVOSIBIRSK', cid);
    sendManagerCommandReply(token, replyChatId, `✅ TELEGRAM_CHAT_NOVOSIBIRSK = ${cid}`, null, buildManagerPanelKeyboard());
    return { handled: true, ok: true, command: command, chatId: cid };
  }

  if (command === '/pay') {
    if (parts.length === 1) {
      return sendManagerPaymentPicker(token, replyChatId);
    }
    return processManagerPaymentCommand(parts, token, replyChatId, pendingKey);
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

  return { handled: false };
}

function sendManagerPaymentPicker(token, chatId) {
  const cid = String(chatId || '').trim();
  if (!cid) return { handled: true, ok: false, error: 'chat_id not set' };

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
    buttons.push([{ text: `${orderId} · ${masterName}`, callback_data: makeCallbackData(CALLBACK_ACTIONS.MANAGER_PAY, orderId) }]);
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
  // /pay CLN-12345678 https://...
  if (!parts || parts.length < 1) return { handled: false };

  if (parts.length < 2) {
    sendManagerCommandReply(token, replyChatId, '❌ Используйте: /pay НОМЕР_ЗАЯВКИ ССЫЛКА [QR: ...]');
    return { handled: true, ok: false, error: 'Используйте: /pay НОМЕР_ЗАЯВКИ ССЫЛКА [QR: ...]' };
  }

  const orderId = normalizeOrderId(parts[1]);
  if (!orderId) {
    sendManagerCommandReply(token, replyChatId, '❌ Укажите корректный номер заявки');
    return { handled: true, ok: false, error: 'Неверный номер заявки' };
  }

  if (parts.length < 3) {
    setManagerPendingPaymentInput(userId, orderId);
    sendManagerCommandReply(
      token,
      replyChatId,
      [
        `🧾 Заявка ${orderId} выбрана.`,
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
    return { handled: true, ok: false, error: 'Ссылка оплаты не найдена' };
  }

  const rowNum = findOrderRowById(orderId);
  if (!rowNum) {
    sendManagerCommandReply(token, replyChatId, `❌ Заявка ${orderId} не найдена`);
    return { handled: true, ok: false, error: 'Заявка не найдена' };
  }

  const order = getOrderByRow(rowNum);
  const masterId = String(order['Master ID'] || '').trim();
  if (!masterId) {
    sendManagerCommandReply(token, replyChatId, `❌ У заявки ${orderId} нет назначенного мастера`);
    return { handled: true, ok: false, error: 'У заявки нет назначенного мастера' };
  }

  const textLines = [`💳 Оплата по заявке <code>${escapeTelegramHtml(orderId)}</code>`];
  if (parsed.payLink) textLines.push(`Ссылка: ${escapeTelegramHtml(parsed.payLink)}`);
  if (parsed.qrValue) textLines.push(`QR: ${escapeTelegramHtml(parsed.qrValue)}`);
  const textToMaster = textLines.join('\n');

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
    sendManagerCommandReply(token, replyChatId, `❌ Не удалось отправить ссылку мастеру по заявке ${orderId}`);
    return { handled: true, ok: false, error: 'Не удалось отправить ссылку мастеру', telegram: resp || null };
  }

  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  setCellByHeader(sheet, rowNum, map, 'Статус выполнения', 'Ссылка/QR отправлены ' + formatDateTime(new Date()));
  clearManagerPendingPaymentInput(userId);
  sendManagerCommandReply(token, replyChatId, `✅ Данные оплаты отправлены мастеру по заявке ${orderId}`);
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

  return urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify(payload)
  });
}

function buildManagerPanelKeyboard() {
  return {
    keyboard: [
      ['/active', '/planned'],
      ['/pay', '/panel'],
      ['/setevents', '/setgroup'],
      ['/setnsk', '/myid'],
      ['/help', '/hidepanel']
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

function mapMasterPanelTextToCommand(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return '';
  if (t === '/myorder') return '/myorder';
  if (t === '/arrived') return '/arrived';
  if (t === '/done') return '/done';
  if (t === '/paid') return '/paid';
  if (t === '/cancel') return '/cancel';
  if (t === '/panel') return '/panel';
  if (t === '/help') return '/help';
  if (t === '/hidepanel') return '/hidepanel';
  if (t === '🧾 моя заявка' || t === 'моя заявка') return '/myorder';
  if (t === '📍 я приехал' || t === 'я приехал') return '/arrived';
  if (t === '✅ я завершил' || t === 'я завершил') return '/done';
  if (t === '💳 оплата получена' || t === 'оплата получена') return '/paid';
  if (t === '❌ отменить заявку' || t === 'отменить заявку') return '/cancel';
  if (t === '🧭 панель' || t === 'панель') return '/panel';
  if (t === '❓ помощь' || t === 'помощь') return '/help';
  if (t === '⌨️ скрыть панель' || t === 'скрыть панель') return '/hidepanel';
  return '';
}

function processMasterCommand(text, token, userId, chatId) {
  const mapped = mapMasterPanelTextToCommand(text);
  const normalizedText = mapped || String(text || '').trim();
  const parts = normalizedText.split(/\s+/);
  if (!parts.length) return { handled: false };

  const command = normalizeBotCommandToken(parts[0]);
  if (!command) return { handled: false };

  const allowed = ['/myorder', '/arrived', '/done', '/paid', '/cancel', '/help', '/start', '/panel', '/hidepanel'];
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
      `Текущая заявка: ${orderId || '—'}`,
      `Статус: ${String(order['Статус'] || '').trim() || '—'}`,
      `Дата и время: ${dateTime}`,
      `Адрес: ${address || '—'}`,
      link ? `2ГИС: ${link}` : ''
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

function sendOrdersDigestToChat(token, chatId, mode) {
  const targetChatId = String(chatId || '').trim();
  if (!targetChatId) return { handled: true, ok: false, error: 'chat_id not set' };

  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    const emptyText = mode === 'active' ? 'Сейчас нет заявок в работе.' : 'Нет запланированных заявок.';
    urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'post',
      payload: JSON.stringify({ chat_id: targetChatId, text: emptyText })
    });
    return { handled: true, ok: true, count: 0, mode: mode };
  }

  const rows = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const chunks = [];

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

    let item = `• <code>${escapeTelegramHtml(orderId)}</code> — ${escapeTelegramHtml(masterName)}`;
    if (dateTime) item += `\n  ${escapeTelegramHtml(dateTime)}`;
    if (link2gis) item += `\n  <a href="${escapeTelegramHtml(link2gis)}">2ГИС</a>`;
    if (rowLink) item += ` | <a href="${escapeTelegramHtml(rowLink)}">Таблица</a>`;
    chunks.push(item);
  }

  const title = mode === 'active' ? '🟢 <b>Заявки в работе сейчас</b>' : '🗓 <b>Запланированные заявки</b>';
  if (!chunks.length) {
    const empty = mode === 'active' ? 'Сейчас нет заявок в работе.' : 'Нет запланированных заявок.';
    urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'post',
      payload: JSON.stringify({ chat_id: targetChatId, text: empty })
    });
    return { handled: true, ok: true, count: 0, mode: mode };
  }

  const maxItems = 25;
  const lines = chunks.slice(0, maxItems);
  let text = title + '\n\n' + lines.join('\n\n');
  if (chunks.length > maxItems) {
    text += `\n\n…и еще ${chunks.length - maxItems}`;
  }

  const resp = urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: targetChatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });

  return { handled: true, ok: !!(resp && resp.ok === true), count: chunks.length, mode: mode, telegram: resp || null };
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
    sendBotTextMessage(token, chatId, `❌ Заявка ${orderId} не найдена. Введите /pay снова.`, false, buildManagerPanelKeyboard());
    return { handled: true, ok: false, error: 'order_not_found' };
  }

  const order = getOrderByRow(rowNum);
  const masterId = String(order['Master ID'] || '').trim();
  if (!masterId) {
    clearManagerPendingPaymentInput(pendingKey);
    sendBotTextMessage(token, chatId, `❌ У заявки ${orderId} нет назначенного мастера.`, false, buildManagerPanelKeyboard());
    return { handled: true, ok: false, error: 'master_not_assigned' };
  }

  let resp = null;
  const caption = `💳 QR/документ оплаты по заявке ${orderId}`;

  if (message.photo && message.photo.length) {
    const photo = message.photo[message.photo.length - 1];
    const fileId = String((photo && photo.file_id) || '').trim();
    if (fileId) {
      resp = urlFetchJson(`https://api.telegram.org/bot${token}/sendPhoto`, {
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
      resp = urlFetchJson(`https://api.telegram.org/bot${token}/sendDocument`, {
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
    sendBotTextMessage(token, chatId, `❌ Не удалось отправить файл мастеру по заявке ${orderId}.`, false, buildManagerPanelKeyboard());
    return { handled: true, ok: false, error: 'telegram_send_failed', telegram: resp || null };
  }

  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  setCellByHeader(sheet, rowNum, map, 'Статус выполнения', 'QR/документ оплаты отправлен ' + formatDateTime(new Date()));
  clearManagerPendingPaymentInput(pendingKey);
  sendBotTextMessage(token, chatId, `✅ QR/документ отправлен мастеру по заявке ${orderId}.`, false, buildManagerPanelKeyboard());

  return { handled: true, ok: true, orderId: orderId };
}
