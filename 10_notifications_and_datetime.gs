/* ---------- Notifications to manager ---------- */

function getManagerChatId() {
  return String(PROP.getProperty('TELEGRAM_MANAGER_CHAT_ID') || '').trim();
}

function getEventsChatId() {
  return String(PROP.getProperty('TELEGRAM_EVENTS_CHAT_ID') || getManagerChatId() || '').trim();
}

function notifyManagerNeedInvoice(order, masterName, arrivedAt) {
  const token = getBotApiToken();
  const eventsChatId = getEventsChatId();
  if (!token || !eventsChatId) return;

  const orderId = escapeTelegramHtml(order['Номер заявки'] || '');
  const callbackData = makeCallbackData(CALLBACK_ACTIONS.MANAGER_PAY, order['Номер заявки'] || '');
  const text = [
    '💳 <b>Нужно сформировать ссылку на оплату</b>',
    `Заявка: <code>${orderId}</code>`,
    `Мастер: ${escapeTelegramHtml(masterName || 'Мастер')}`,
    `Время прибытия: ${escapeTelegramHtml(arrivedAt || '')}`,
    '',
    'Нажмите кнопку ниже или отправьте команду:',
    `<code>/pay ${orderId} https://ваша-ссылка QR: https://qr</code>`
  ].join('\n');

  const keyboard = callbackData
    ? { inline_keyboard: [[{ text: '💳 Отправить ссылку/QR мастеру', callback_data: callbackData }]] }
    : null;

  const payload = {
    chat_id: eventsChatId,
    text: text,
    parse_mode: 'HTML'
  };
  if (keyboard) payload.reply_markup = keyboard;

  urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify(payload)
  });
}

function notifyManagerOrderDone(order, masterName, doneAt) {
  const token = getBotApiToken();
  const eventsChatId = getEventsChatId();
  if (!token || !eventsChatId) return;

  const orderId = escapeTelegramHtml(order['Номер заявки'] || '');
  const text = [
    '✅ <b>Заявка завершена</b>',
    `Заявка: <code>${orderId}</code>`,
    `Мастер: ${escapeTelegramHtml(masterName || 'Мастер')}`,
    `Время завершения: ${escapeTelegramHtml(doneAt || '')}`
  ].join('\n');

  urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: eventsChatId,
      text: text,
      parse_mode: 'HTML'
    })
  });
}

function notifyManagerOrderCancelled(order, masterName, cancelledAt, republish) {
  const token = getBotApiToken();
  const eventsChatId = getEventsChatId();
  if (!token || !eventsChatId) return;

  const orderId = escapeTelegramHtml(order['Номер заявки'] || '');
  const republishState = republish && republish.ok ? 'Да' : 'Нет';
  const text = [
    '⚠️ <b>Заявка отменена мастером</b>',
    `Заявка: <code>${orderId}</code>`,
    `Мастер: ${escapeTelegramHtml(masterName || 'Мастер')}`,
    `Время отмены: ${escapeTelegramHtml(cancelledAt || '')}`,
    `Возвращена в группу: ${republishState}`
  ].join('\n');

  urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: eventsChatId,
      text: text,
      parse_mode: 'HTML'
    })
  });
}

function notifyManagerOrderTaken(order, masterName, takenAt) {
  const token = getBotApiToken();
  const eventsChatId = getEventsChatId();
  if (!token || !eventsChatId) return;

  const orderId = escapeTelegramHtml(order['Номер заявки'] || '');
  const text = [
    '📌 <b>Мастер взял заявку</b>',
    `Заявка: <code>${orderId}</code>`,
    `Мастер: ${escapeTelegramHtml(masterName || 'Мастер')}`,
    `Время принятия: ${escapeTelegramHtml(takenAt || '')}`
  ].join('\n');

  urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: eventsChatId,
      text: text,
      parse_mode: 'HTML'
    })
  });
}

function notifyManagerPaymentConfirmed(order, masterName, paidAt) {
  const token = getBotApiToken();
  const eventsChatId = getEventsChatId();
  if (!token || !eventsChatId) return;

  const orderId = escapeTelegramHtml(order['Номер заявки'] || '');
  const text = [
    '💵 <b>Оплата подтверждена мастером</b>',
    `Заявка: <code>${orderId}</code>`,
    `Мастер: ${escapeTelegramHtml(masterName || 'Мастер')}`,
    `Время подтверждения: ${escapeTelegramHtml(paidAt || '')}`
  ].join('\n');

  urlFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: JSON.stringify({
      chat_id: eventsChatId,
      text: text,
      parse_mode: 'HTML'
    })
  });
}

/* ---------- Date/time normalize ---------- */

function normalizeCreatedAtValue(value) {
  const dt = parseDateTimeLoose(value);
  if (!dt) return formatDateTime(new Date());
  return formatDateTime(dt);
}

function normalizeOrderDateValue(value) {
  if (value instanceof Date) {
    return formatDate(value);
  }

  const raw = String(value || '').trim();
  if (!raw) return '';

  const ddmmyyyy = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (ddmmyyyy) return `${ddmmyyyy[1]}.${ddmmyyyy[2]}.${ddmmyyyy[3]}`;

  const ddmm = raw.match(/^(\d{2})\.(\d{2})$/);
  if (ddmm) {
    const year = new Date().getFullYear();
    return `${ddmm[1]}.${ddmm[2]}.${year}`;
  }

  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) return `${ymd[3]}.${ymd[2]}.${ymd[1]}`;

  const dt = parseDateTimeLoose(raw);
  if (dt) return formatDate(dt);

  return raw;
}

function normalizeOrderTimeValue(value) {
  if (value instanceof Date) {
    return formatTime(value);
  }

  const raw = String(value || '').trim();
  if (!raw) return '';

  const hhmm = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmm) {
    const hh = ('0' + Number(hhmm[1])).slice(-2);
    const mm = ('0' + Number(hhmm[2])).slice(-2);
    return hh + ':' + mm;
  }

  const dt = parseDateTimeLoose(raw);
  if (dt) return formatTime(dt);

  return raw;
}

function formatDateTimeForDisplay(dateValue, timeValue) {
  const d = formatDateForDisplay(dateValue);
  const t = formatTimeForDisplay(timeValue);
  if (d && t) return d + ' в ' + t;
  if (d) return d;
  if (t) return t;
  return 'не указаны';
}

function formatDateForDisplay(value) {
  if (value instanceof Date) return formatDate(value);

  const raw = String(value || '').trim();
  if (!raw) return '';

  const ddmmyyyy = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (ddmmyyyy) return raw;

  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) return `${ymd[3]}.${ymd[2]}.${ymd[1]}`;

  const dt = parseDateTimeLoose(raw);
  return dt ? formatDate(dt) : raw;
}

function formatTimeForDisplay(value) {
  if (value instanceof Date) return formatTime(value);

  const raw = String(value || '').trim();
  if (!raw) return '';

  const hhmm = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmm) {
    const hh = ('0' + Number(hhmm[1])).slice(-2);
    const mm = ('0' + Number(hhmm[2])).slice(-2);
    return hh + ':' + mm;
  }

  const dt = parseDateTimeLoose(raw);
  return dt ? formatTime(dt) : raw;
}

function parseOrderDateTime(dateValue, timeValue) {
  let baseDate = null;

  if (dateValue instanceof Date) {
    baseDate = new Date(dateValue.getFullYear(), dateValue.getMonth(), dateValue.getDate());
  } else {
    const dateRaw = String(dateValue || '').trim();
    if (!dateRaw) return null;

    let m = dateRaw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (m) {
      baseDate = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    } else {
      m = dateRaw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) {
        baseDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      } else {
        const dt = parseDateTimeLoose(dateRaw);
        if (dt) baseDate = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
      }
    }
  }

  if (!baseDate || isNaN(baseDate.getTime())) return null;

  let hour = 0;
  let minute = 0;

  if (timeValue instanceof Date) {
    hour = timeValue.getHours();
    minute = timeValue.getMinutes();
  } else {
    const timeRaw = String(timeValue || '').trim();
    if (timeRaw) {
      const tm = timeRaw.match(/^(\d{1,2}):(\d{2})$/);
      if (tm) {
        hour = Number(tm[1]);
        minute = Number(tm[2]);
      } else {
        const dt = parseDateTimeLoose(timeRaw);
        if (dt) {
          hour = dt.getHours();
          minute = dt.getMinutes();
        }
      }
    }
  }

  baseDate.setHours(hour, minute, 0, 0);
  return baseDate;
}

function parseDateTimeLoose(value) {
  if (value instanceof Date) {
    const d = new Date(value.getTime());
    return isNaN(d.getTime()) ? null : d;
  }

  const raw = String(value || '').trim();
  if (!raw) return null;

  // ISO
  const iso = new Date(raw);
  if (!isNaN(iso.getTime())) return iso;

  // dd.MM.yyyy HH:mm:ss or dd.MM.yyyy HH:mm
  const m1 = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m1) {
    const day = Number(m1[1]);
    const month = Number(m1[2]) - 1;
    const year = Number(m1[3]);
    const h = Number(m1[4] || 0);
    const m = Number(m1[5] || 0);
    const s = Number(m1[6] || 0);
    const d = new Date(year, month, day, h, m, s, 0);
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
}

function formatDateTime(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm:ss');
}

function formatDate(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd.MM.yyyy');
}

function formatTime(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'HH:mm');
}

