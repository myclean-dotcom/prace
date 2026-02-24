/* ---------- Telegram updates ---------- */

function handleTelegramUpdate(body) {
  const token = String(PROP.getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
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
  notifyManagerOrderTaken(updatedOrder, ctx.masterName, takenAt);

  return jsonResponse({ ok: true, action: CALLBACK_ACTIONS.TAKE, orderId: orderId, buildVersion: BUILD_VERSION });
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
      `🧾 Заявка: ${orderId}`,
      'Отправьте одним сообщением:',
      '',
      'Ссылка: https://ваша-ссылка',
      'QR: https://ссылка-на-qr-или-текст'
    ].join('\n'),
    false,
    buildManagerPanelKeyboard()
  );

  return jsonResponse({ ok: true, action: CALLBACK_ACTIONS.MANAGER_PAY, orderId: orderId, buildVersion: BUILD_VERSION });
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

  answerCallback(ctx.token, ctx.callbackId, '✅ Работы завершены. Подтвердите оплату кнопкой.');
  updateMasterActionMessageAfterDone(ctx.token, ctx.cbChatId, ctx.cbMessageId, ctx.orderId);
  notifyManagerOrderDone(updatedOrder, ctx.masterName, doneAt);

  return jsonResponse({ ok: true, action: CALLBACK_ACTIONS.DONE, orderId: ctx.orderId, buildVersion: BUILD_VERSION });
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

  return jsonResponse({ ok: true, action: CALLBACK_ACTIONS.PAID, orderId: ctx.orderId, buildVersion: BUILD_VERSION });
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

function updateMasterActionMessageAfterDone(token, chatId, messageId, orderId) {
  const chat = String(chatId || '').trim();
  const msg = String(messageId || '').trim();
  if (!chat || !msg) return;

  urlFetchJson(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
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
  const strict = raw.match(/^(take|arrive|done|paid|cancel|managerpay):(.+)$/i);
  if (strict) {
    const action = String(strict[1] || '').trim().toLowerCase();
    const orderId = normalizeOrderId(strict[2]);
    return (action && orderId) ? { action: action, orderId: orderId } : null;
  }

  // Совместимость: action|ORDER_ID
  const vPipe = raw.match(/^(take|arrive|done|paid|cancel|managerpay)\|(.+)$/i);
  if (vPipe) {
    const action = String(vPipe[1] || '').trim().toLowerCase();
    const orderId = normalizeOrderId(vPipe[2]);
    return (action && orderId) ? { action: action, orderId: orderId } : null;
  }

  // Совместимость: action_ORDER_ID
  const vUnderscore = raw.match(/^(take|arrive|done|paid|cancel|managerpay)_(.+)$/i);
  if (vUnderscore) {
    const action = String(vUnderscore[1] || '').trim().toLowerCase();
    const orderId = normalizeOrderId(vUnderscore[2]);
    return (action && orderId) ? { action: action, orderId: orderId } : null;
  }

  // Совместимость: просто "take" (без id)
  const onlyAction = raw.match(/^(take|arrive|done|paid|cancel|managerpay)$/i);
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

