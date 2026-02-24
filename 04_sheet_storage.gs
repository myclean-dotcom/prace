/* ---------- Spreadsheet ---------- */

function getSheet() {
  const spreadsheetId = String(PROP.getProperty('SPREADSHEET_ID') || '').trim();

  let ss = null;
  if (spreadsheetId) {
    try {
      ss = SpreadsheetApp.openById(spreadsheetId);
    } catch (err) {
      ss = null;
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
    throw new Error(
      'Не удалось открыть таблицу. Укажите Script Property SPREADSHEET_ID или запустите bound-скрипт.'
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

  const currentHeaders = sheet.getRange(1, 1, 1, width).getValues()[0].map(function(v) {
    return String(v || '').trim();
  });

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
    const h = String(headers[i] || '').trim();
    if (h) map[h] = i + 1;
  }

  return map;
}

function appendOrderRow(sheet, rowData) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function(h) {
    return String(h || '').trim();
  });

  const row = headers.map(function(h) {
    return Object.prototype.hasOwnProperty.call(rowData, h) ? rowData[h] : '';
  });

  sheet.appendRow(row);
}

function setCellByHeader(sheet, rowNum, headerMap, headerName, value) {
  const col = headerMap[headerName];
  if (!col) return;
  sheet.getRange(rowNum, col).setValue(value);
}

function patchRowByHeaders(sheet, rowNum, headerMap, patch) {
  const width = sheet.getLastColumn();
  const row = sheet.getRange(rowNum, 1, 1, width).getValues()[0];
  const keys = Object.keys(patch || {});

  for (let i = 0; i < keys.length; i++) {
    const header = keys[i];
    const col = headerMap[header];
    if (!col) continue;
    row[col - 1] = patch[header];
  }

  sheet.getRange(rowNum, 1, 1, width).setValues([row]);
}

function getCellFromRowByHeader(rowValues, headerMap, headerName) {
  const col = headerMap[headerName];
  if (!col) return '';
  return rowValues[col - 1];
}

function findOrderRowById(orderId) {
  const target = normalizeOrderId(orderId);
  if (!target) return null;

  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const col = map['Номер заявки'];
  const lastRow = sheet.getLastRow();
  if (!col || lastRow < 2) return null;

  const values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    const candidate = normalizeOrderId(values[i][0]);
    if (candidate && candidate === target) return i + 2;
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

  const chatValues = sheet.getRange(2, chatCol, lastRow - 1, 1).getValues();
  const msgValues = sheet.getRange(2, msgCol, lastRow - 1, 1).getValues();
  const msgDigits = normalizeNumericString(msg);

  for (let i = 0; i < chatValues.length; i++) {
    const c = String(chatValues[i][0] || '').trim();
    const m = String(msgValues[i][0] || '').trim();
    if (c !== chat) continue;
    if (m === msg) return i + 2;
    if (msgDigits && normalizeNumericString(m) === msgDigits) return i + 2;
  }

  return null;
}

function findActiveOrderRowByMasterId(masterId) {
  const target = String(masterId || '').trim();
  if (!target) return null;

  const sheet = getSheet();
  const map = getHeaderMap(sheet);
  const idCol = map['Master ID'];
  const statusCol = map['Статус'];
  const lastRow = sheet.getLastRow();
  if (!idCol || !statusCol || lastRow < 2) return null;

  const idValues = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
  const statusValues = sheet.getRange(2, statusCol, lastRow - 1, 1).getValues();

  for (let i = idValues.length - 1; i >= 0; i--) {
    const id = String(idValues[i][0] || '').trim();
    const status = String(statusValues[i][0] || '').toLowerCase().trim();
    if (id !== target) continue;
    if (
      status.indexOf('взята') === -1 &&
      status.indexOf('на объекте') === -1 &&
      status.indexOf('ожидает оплат') === -1
    ) continue;
    return i + 2;
  }

  return null;
}

function getOrderByRow(rowNum) {
  const sheet = getSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function(h) {
    return String(h || '').trim();
  });
  const values = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];

  const out = {};
  for (let i = 0; i < headers.length; i++) {
    if (headers[i]) out[headers[i]] = values[i];
  }
  return out;
}

