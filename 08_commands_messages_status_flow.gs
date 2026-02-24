/* ---------- Order status update helpers ---------- */


function updateOrderTakenByRow(rowNum, masterId, masterName, takenAt) {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const cleanMasterId = String(masterId || '').trim();
  const cleanMasterName = String(masterName || '').trim();
  const cleanTakenAt = String(takenAt || '').trim();

  patchRowByHeaders(sheet, rowNum, map, {
    'Статус': 'Взята',
    'Master ID': cleanMasterId,
    'Master Name': cleanMasterName,
    'Дата принятия': cleanTakenAt,
    'Дата прибытия': '',
    'Дата завершения': '',
    'Дата оплаты': '',
    'Напоминание 24ч': '',
    'Напоминание 2ч': '',
    'Статус выполнения': 'Заявка принята: ' + cleanTakenAt
  });
}

function updateOrderArrivedByRow(rowNum, arrivedAt) {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const cleanArrivedAt = String(arrivedAt || '').trim();

  patchRowByHeaders(sheet, rowNum, map, {
    'Статус': 'На объекте',
    'Дата прибытия': cleanArrivedAt,
    'Статус выполнения': 'Прибыл на объект: ' + cleanArrivedAt
  });
}

function updateOrderDoneByRow(rowNum, doneAt) {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const cleanDoneAt = String(doneAt || '').trim();

  patchRowByHeaders(sheet, rowNum, map, {
    'Статус': 'Ожидает оплаты',
    'Дата завершения': cleanDoneAt,
    'Статус выполнения': 'Работы завершены: ' + cleanDoneAt
  });
}

function updateOrderPaidByRow(rowNum, paidAt) {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const cleanPaidAt = String(paidAt || '').trim();

  patchRowByHeaders(sheet, rowNum, map, {
    'Статус': 'Завершена',
    'Дата оплаты': cleanPaidAt,
    'Статус выполнения': 'Оплата подтверждена: ' + cleanPaidAt
  });
}

function updateOrderCancelledByRow(rowNum, masterName, cancelledAt) {
  const sheet = getSheet();
  const map = getHeaderMap(sheet);

  const cleanMasterName = String(masterName || '').trim() || 'Мастер';
  const cleanCancelledAt = String(cancelledAt || '').trim();

  patchRowByHeaders(sheet, rowNum, map, {
    'Статус': 'Опубликована',
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
  return status.indexOf('взята') !== -1 || status.indexOf('на объекте') !== -1;
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

