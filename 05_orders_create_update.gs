/* ---------- Create/Update order ---------- */

function createOrUpdateOrder(payload, action) {
  const orderId = normalizeOrderId(payload.orderId) || ('CLN-' + Date.now().toString().slice(-8));

  const order = {
    orderId: orderId,
    createdAt: normalizeCreatedAtValue(
      pickPayloadValue(payload, ['createdAt', '_ts', 'Дата создания'], new Date())
    ),
    manager: pickPayloadValue(payload, ['manager', 'Менеджер'], ''),
    customerName: normalizeCustomerName(
      pickPayloadValue(payload, ['customerName', 'Имя клиента'], '')
    ),
    customerPhone: pickPayloadValue(payload, ['customerPhone', 'Телефон клиента'], ''),
    customerCity: pickPayloadValue(payload, ['customerCity', 'Город'], ''),
    customerAddress: pickPayloadValue(payload, ['customerAddress', 'Улица и дом'], ''),
    customerFlat: pickPayloadValue(payload, ['customerFlat', 'Квартира/офис'], ''),
    orderDate: normalizeOrderDateValue(
      pickPayloadValue(payload, ['orderDate', 'Дата уборки'], '')
    ),
    orderTime: normalizeOrderTimeValue(
      pickPayloadValue(payload, ['orderTime', 'Время уборки'], '')
    ),
    orderTotal: pickPayloadValue(payload, ['orderTotal', 'Сумма заказа'], '0'),
    masterPay: pickPayloadValue(payload, ['masterPay', 'Зарплата мастерам'], '0'),
    cleaningType: pickPayloadValue(payload, ['cleaningType', 'Тип уборки'], ''),
    area: pickPayloadValue(payload, ['area', 'Площадь (м²)'], ''),
    chemistry: pickPayloadValue(payload, ['chemistry', 'Химия', 'chemistry[]'], '—'),
    equipment: pickPayloadValue(payload, ['equipment', 'Оборудование', 'equipment[]'], '—'),
    worksDescription: pickPayloadValue(payload, ['worksDescription', 'Описание работ'], '')
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

