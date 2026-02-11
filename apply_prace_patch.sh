#!/usr/bin/env bash
set -e

# ---------------------------
# Настройте перед запуском:
REPO="https://github.com/your-username/prace.git"
BRANCH="feature/telegram-backend"
TMPDIR="./prace_temp"
# ---------------------------

if [ "$REPO" = "https://github.com/your-username/prace.git" ]; then
  echo "Поменяйте переменную REPO на URL вашего repo перед запуском."
  exit 1
fi

rm -rf "$TMPDIR"
git clone "$REPO" "$TMPDIR"
cd "$TMPDIR"
git checkout -b "$BRANCH"

# CREATE FILES
cat > package.json <<'EOF'
{
  "name": "cleaning-orders-backend",
  "version": "0.1.0",
  "description": "Backend for cleaning orders: Telegram bot webhook + Google Sheets integration",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "author": "",
  "license": "MIT",
  "dependencies": {
    "body-parser": "^1.20.2",
    "dotenv": "^16.0.3",
    "express": "^4.18.2",
    "node-cron": "^3.0.2",
    "node-fetch": "^2.6.7"
  }
}
EOF

cat > server.js <<'EOF'
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const cron = require('node-cron');
const telegram = require('./telegram');
const storage = require('./storage');

const PORT = process.env.PORT || 3000;
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL || '';

const app = express();
app.use(bodyParser.json());

app.get('/', (req, res) => {
  res.send('Cleaning orders backend is running');
});

app.post('/api/orders', async (req, res) => {
  try {
    const order = req.body || {};
    if (!order.customerName || !order.customerPhone) {
      return res.status(400).json({ success: false, error: 'Missing customerName or customerPhone' });
    }

    if (!order.orderId) {
      order.orderId = 'CLN-' + Date.now().toString().slice(-8);
    }

    order.createdAt = new Date().toISOString();
    order.status = 'published';
    order.telegramMessageId = null;
    order.telegramChatId = order.telegramChannel || process.env.DEFAULT_CHAT_ID || '';

    storage.saveOrder(order);

    const text = formatOrderText(order);
    const chatId = order.telegramChatId;
    const reply_markup = {
      inline_keyboard: [[
        { text: '✅ ВЫХОЖУ НА ЗАЯВКУ', callback_data: `take_${order.orderId}` },
        { text: '❌ ОТКАЗАТЬСЯ', callback_data: `reject_${order.orderId}` }
      ]]
    };

    const tg = await telegram.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup });
    if (tg && tg.ok) {
      order.telegramMessageId = tg.result.message_id;
      order.telegramChatId = tg.result.chat.id;
      storage.updateOrder(order.orderId, { telegramMessageId: order.telegramMessageId, telegramChatId: order.telegramChatId });
    }

    if (GOOGLE_SCRIPT_URL) {
      try {
        await fetch(GOOGLE_SCRIPT_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', order })
        });
      } catch (e) {
        console.warn('Failed to call Google Script on create:', e.message);
      }
    }

    return res.json({ success: true, orderId: order.orderId, tg: tg && tg.ok ? true : false });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/webhook', async (req, res) => {
  const update = req.body;

  try {
    if (update.callback_query) {
      const cb = update.callback_query;
      const data = cb.data || '';
      const from = cb.from;
      const message = cb.message;

      if (data.startsWith('take_')) {
        const orderId = data.replace('take_', '');
        const order = storage.getOrder(orderId);
        if (!order) {
          await telegram.answerCallback(cb.id, 'Заявка не найдена');
          return res.sendStatus(200);
        }

        if (order.status === 'taken') {
          await telegram.answerCallback(cb.id, 'Заявка уже взята');
          return res.sendStatus(200);
        }

        storage.takeOrder(orderId, { masterId: from.id, masterName: from.username || (from.first_name || '') });
        storage.updateOrder(orderId, { status: 'taken', takenAt: new Date().toISOString() });

        try {
          if (message && message.chat && message.message_id) {
            await telegram.deleteMessage(message.chat.id, message.message_id);
          }
        } catch (e) { console.warn('deleteMessage failed', e.message); }

        const orderUpdated = storage.getOrder(orderId);
        const privateText = `Вы взяли заявку ${orderUpdated.orderId}\n\nКлиент: ${orderUpdated.customerName}\nТелефон: ${orderUpdated.customerPhone}\nАдрес: ${orderUpdated.customerAddress}${orderUpdated.customerFlat ? ', кв: ' + orderUpdated.customerFlat : ''}\nСумма: ${orderUpdated.orderTotal} руб`;
        await telegram.sendPrivateMessage(from.id, privateText);

        if (GOOGLE_SCRIPT_URL) {
          try {
            await fetch(GOOGLE_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'taken', order: orderUpdated }) });
          } catch (e) { console.warn('Google script taken error', e.message); }
        }

        await telegram.answerCallback(cb.id, 'Вы успешно взяли заявку — подробности в личных сообщениях.');
        return res.sendStatus(200);
      }

      if (data.startsWith('reject_')) {
        const orderId = data.replace('reject_', '');
        await telegram.answerCallback(cb.id, 'Спасибо, отказ принят');
        return res.sendStatus(200);
      }
    }

    if (update.message) {
      const msg = update.message;
      const masterId = msg.from && msg.from.id;
      const assigned = storage.findOrderByMasterId(masterId);
      if (assigned && msg.photo && msg.photo.length > 0) {
        const photo = msg.photo[msg.photo.length - 1];
        try {
          const fileLink = await telegram.getFileLink(photo.file_id);
          storage.appendPhotoToOrder(assigned.orderId, { by: masterId, file_id: photo.file_id, url: fileLink, when: new Date().toISOString() });

          if (GOOGLE_SCRIPT_URL) {
            try {
              await fetch(GOOGLE_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'photo', orderId: assigned.orderId, fileLink }) });
            } catch (e) { console.warn('Google script photo error', e.message); }
          }

          await telegram.sendPrivateMessage(masterId, 'Фото получено и сохранено. Спасибо.');
        } catch (e) {
          console.warn('photo processing failed', e.message);
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error', err);
    res.sendStatus(500);
  }
});

cron.schedule('* * * * *', () => {
  try {
    const now = Date.now();
    const orders = storage.listAllOrders();
    orders.forEach(async (o) => {
      if (!o.orderDate || !o.orderTime || o.status !== 'taken') return;
      const dt = parseOrderDateTime(o.orderDate, o.orderTime);
      if (!dt) return;
      const diffMs = dt.getTime() - now;
      if (diffMs <= 24 * 3600 * 1000 && diffMs > 24 * 3600 * 1000 - 60000 && !o.reminder24Sent) {
        if (o.assigned && o.assigned.masterId) {
          await telegram.sendPrivateMessage(o.assigned.masterId, `Напоминание: через 24 часа заявка ${o.orderId} у клиента ${o.customerName} (${o.customerPhone})`);
          storage.updateOrder(o.orderId, { reminder24Sent: true });
        }
      }
      if (diffMs <= 2 * 3600 * 1000 && diffMs > 2 * 3600 * 1000 - 60000 && !o.reminder2Sent) {
        if (o.assigned && o.assigned.masterId) {
          await telegram.sendPrivateMessage(o.assigned.masterId, `Напоминание: через 2 часа заявка ${o.orderId} — проверьте выезд`);
          storage.updateOrder(o.orderId, { reminder2Sent: true });
        }
      }
    });
  } catch (e) { console.warn('cron error', e.message); }
});

function parseOrderDateTime(dateStr, timeStr) {
  try {
    if (dateStr.includes('.')) {
      const parts = dateStr.split('.');
      const day = parseInt(parts[0]);
      const month = parseInt(parts[1]) - 1;
      const now = new Date();
      const year = now.getFullYear();
      const [hh = '00', mm = '00'] = (timeStr || '00:00').split(':');
      return new Date(year, month, day, parseInt(hh), parseInt(mm));
    }
    return new Date(`${dateStr}T${timeStr || '00:00:00'}`);
  } catch (e) { return null; }
}

function formatOrderText(o) {
  let text = `🧹 <b>ЗАКАЗ №${o.orderId}</b>\n`;
  text += `Город: ${o.customerCity || '—'}\n`;
  text += `Тип уборки: ${o.cleaningType || '—'}\n`;
  text += `Площадь: ${o.area || '—'} м²\n`;
  text += `Сумма: ${o.orderTotal || '—'} руб\n\n`;
  text += `<b>КЛИЕНТ:</b> ${o.customerName} — ${o.customerPhone}\n`;
  text += `Адрес: ${o.customerAddress}${o.customerFlat ? ', кв: ' + o.customerFlat : ''}\n`;
  if (o.orderDate || o.orderTime) text += `Дата/время: ${o.orderDate || ''} ${o.orderTime || ''}\n`;
  text += `\nID: ${o.orderId}`;
  return text;
}

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
EOF

cat > telegram.js <<'EOF'
const fetch = require('node-fetch');
require('dotenv').config();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;
const FILE_API = `https://api.telegram.org/file/bot${TOKEN}`;

async function sendMessage(chatId, text, options = {}) {
  try {
    const body = Object.assign({ chat_id: chatId, text }, options);
    const res = await fetch(`${API}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
  } catch (e) { return { ok: false, error: e.message }; }
}

async function sendPrivateMessage(userId, text) {
  return sendMessage(userId, text, { parse_mode: 'HTML' });
}

async function deleteMessage(chatId, messageId) {
  try {
    const res = await fetch(`${API}/deleteMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, message_id: messageId }) });
    return res.json();
  } catch (e) { return { ok: false, error: e.message }; }
}

async function answerCallback(callbackQueryId, text) {
  try {
    const res = await fetch(`${API}/answerCallbackQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: callbackQueryId, text }) });
    return res.json();
  } catch (e) { return { ok: false, error: e.message }; }
}

async function getFileLink(fileId) {
  try {
    const r = await fetch(`${API}/getFile?file_id=${fileId}`);
    const data = await r.json();
    if (!data.ok) throw new Error('getFile failed');
    const path = data.result.file_path;
    return `${FILE_API}/${path}`;
  } catch (e) { throw e; }
}

module.exports = { sendMessage, sendPrivateMessage, deleteMessage, answerCallback, getFileLink };
EOF

cat > storage.js <<'EOF'
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'orders.json');

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({ orders: {} }, null, 2));
}

function load() {
  ensure();
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { orders: {} };
  }
}

function save(data) {
  ensure();
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function saveOrder(order) {
  const data = load();
  data.orders[order.orderId] = order;
  save(data);
}

function getOrder(orderId) {
  const data = load();
  return data.orders[orderId] || null;
}

function updateOrder(orderId, updates) {
  const data = load();
  if (!data.orders[orderId]) return false;
  data.orders[orderId] = Object.assign({}, data.orders[orderId], updates);
  save(data);
  return true;
}

function takeOrder(orderId, assigned) {
  const data = load();
  if (!data.orders[orderId]) return false;
  data.orders[orderId].status = 'taken';
  data.orders[orderId].assigned = assigned;
  save(data);
  return true;
}

function findOrderByMasterId(masterId) {
  const data = load();
  for (const id of Object.keys(data.orders)) {
    const o = data.orders[id];
    if (o.assigned && o.assigned.masterId === masterId) return o;
  }
  return null;
}

function appendPhotoToOrder(orderId, photo) {
  const data = load();
  if (!data.orders[orderId]) return false;
  if (!data.orders[orderId].photos) data.orders[orderId].photos = [];
  data.orders[orderId].photos.push(photo);
  save(data);
  return true;
}

function listAllOrders() {
  const data = load();
  return Object.values(data.orders || {});
}

module.exports = { saveOrder, getOrder, updateOrder, takeOrder, findOrderByMasterId, appendPhotoToOrder, listAllOrders };
EOF

cat > .env.example <<'EOF'
TELEGRAM_BOT_TOKEN=8471091759:REPLACE_WITH_YOUR_TOKEN
DEFAULT_CHAT_ID=@your_channel_or_numeric_chat_id_or_-1001234567890
GOOGLE_SCRIPT_URL=https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec
PORT=3000
EOF

cat > google_apps_script.gs <<'EOF'
// Пример Google Apps Script для приёма POST из backend и записи в Google Sheets.
// 1) Вставьте ID вашей таблицы в SPREADSHEET_ID
// 2) Разверните как Web App: Deploy -> New deployment -> Web app -> Who has access: Anyone

const SPREADSHEET_ID = 'REPLACE_WITH_SPREADSHEET_ID'; // замените

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const action = payload.action || 'create';
    const order = payload.order || {};

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    let sheet = ss.getSheetByName('Orders');
    if (!sheet) {
      sheet = ss.insertSheet('Orders');
      const headers = ['orderId','manager','city','customerName','customerPhone','customerAddress','customerFlat','orderDate','orderTime','orderTotal','masterId','masterName','status','telegramMessageId','photos','createdAt','takenAt','notes'];
      sheet.appendRow(headers);
    }

    if (action === 'create') {
      const row = [
        order.orderId || '',
        order.manager || '',
        order.customerCity || '',
        order.customerName || '',
        order.customerPhone || '',
        order.customerAddress || '',
        order.customerFlat || '',
        order.orderDate || '',
        order.orderTime || '',
        order.orderTotal || '',
        '',
        '',
        order.status || 'published',
        order.telegramMessageId || '',
        '',
        order.createdAt || new Date().toISOString(),
        '',
        ''
      ];
      sheet.appendRow(row);
      return ContentService.createTextOutput(JSON.stringify({ success: true })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === 'taken') {
      const orderId = order.orderId;
      const rows = sheet.getDataRange().getValues();
      for (let r = 1; r < rows.length; r++) {
        if (rows[r][0] == orderId) {
          sheet.getRange(r+1, 11).setValue(order.assigned ? order.assigned.masterId : '');
          sheet.getRange(r+1, 12).setValue(order.assigned ? order.assigned.masterName : '');
          sheet.getRange(r+1, 13).setValue('taken');
          sheet.getRange(r+1, 16).setValue(order.takenAt || new Date().toISOString());
          return ContentService.createTextOutput(JSON.stringify({ success: true })).setMimeType(ContentService.MimeType.JSON);
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ success: false, error: 'orderId not found' })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === 'photo') {
      const orderId = payload.orderId || (order && order.orderId);
      const fileLink = payload.fileLink || payload.fileUrl || '';
      if (!orderId) return ContentService.createTextOutput(JSON.stringify({ success: false, error: 'no orderId' })).setMimeType(ContentService.MimeType.JSON);
      const rows = sheet.getDataRange().getValues();
      for (let r = 1; r < rows.length; r++) {
        if (rows[r][0] == orderId) {
          const existing = rows[r][14] || '';
          const updated = existing ? existing + '\\n' + fileLink : fileLink;
          sheet.getRange(r+1, 15).setValue(updated);
          return ContentService.createTextOutput(JSON.stringify({ success: true })).setMimeType(ContentService.MimeType.JSON);
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ success: false, error: 'orderId not found' })).setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ success: false, error: 'unknown action' })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: err.message })).setMimeType(ContentService.MimeType.JSON);
  }
}
EOF

cat > frontend_snippet.md <<'EOF'
Изменение фронтенда: вместо прямого вызова Telegram вызываем бекенд `POST /api/orders`.

1) Добавьте в ваш фронтенд конфиг базовый URL бекенда, например в `CONFIG`:

```js
CONFIG.BACKEND_URL = 'https://your-backend.example.com';
