const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Настройки из .env
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GOOGLE_SHEETS_CREDENTIALS = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;

// Инициализация Telegram бота
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Подготовка Google Sheets
const auth = new google.auth.GoogleAuth({
    credentials: GOOGLE_SHEETS_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });

// Хранилище заявок в памяти (в проде используйте БД)
const orders = new Map();
const masters = new Map(); // мастер -> chatId

// Маппинг городов на Telegram каналы
const CITY_CHANNELS = {
    'Москва': '@apexclean_moscow',
    'Санкт-Петербург': '@apexclean_spb',
    'Казань': '@apexclean_kazan'
    // добавьте другие города
};

// =============== API ЭНДПОИНТЫ ===============

// Создание заявки менеджером
app.post('/api/create-order', async (req, res) => {
    try {
        const orderData = req.body;
        const orderId = 'CLN-' + Date.now();
        
        // Сохраняем заявку
        orders.set(orderId, {
            ...orderData,
            id: orderId,
            status: 'pending',
            createdAt: new Date().toISOString()
        });

        // Определяем город (по адресу или явно)
        const city = extractCityFromAddress(orderData.customerAddress);
        const channel = CITY_CHANNELS[city] || CITY_CHANNELS['Москва'];

        // Формируем сообщение для Telegram
        const telegramMessage = formatOrderForTelegram(orderData, orderId);
        
        // Отправляем в канал города
        const message = await bot.sendMessage(channel, telegramMessage, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Взять заявку', callback_data: `take_${orderId}` },
                    { text: '❌ Отклонить', callback_data: `reject_${orderId}` }
                ]]
            }
        });

        // Сохраняем ID сообщения для последующего удаления
        orders.get(orderId).telegramMessageId = message.message_id;
        orders.get(orderId).telegramChatId = message.chat.id;

        // Сохраняем в Google Sheets
        await saveToGoogleSheets(orderData, orderId, 'pending');

        res.json({
            success: true,
            orderId,
            telegramLink: `https://t.me/${channel.replace('@', '')}/${message.message_id}`
        });

    } catch (error) {
        console.error('Error creating order:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Обработка взятия заявки мастером
app.post('/api/take-order', async (req, res) => {
    try {
        const { orderId, masterId, masterName } = req.body;
        const order = orders.get(orderId);
        
        if (!order) {
            return res.status(404).json({ success: false, error: 'Заявка не найдена' });
        }

        // Обновляем статус заявки
        order.status = 'taken';
        order.masterId = masterId;
        order.masterName = masterName;
        order.takenAt = new Date().toISOString();

        // Удаляем сообщение из канала
        await bot.deleteMessage(order.telegramChatId, order.telegramMessageId);

        // Отправляем полную информацию мастеру
        const masterChatId = masters.get(masterId);
        if (masterChatId) {
            const fullInfo = formatFullOrderInfo(order);
            await bot.sendMessage(masterChatId, fullInfo, { parse_mode: 'HTML' });
        }

        // Обновляем в Google Sheets
        await updateGoogleSheet(orderId, {
            status: 'taken',
            masterName,
            takenAt: order.takenAt
        });

        // Настраиваем напоминания
        scheduleNotifications(orderId, order.orderDate, order.orderTime);

        res.json({ success: true });

    } catch (error) {
        console.error('Error taking order:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Загрузка фото от мастера
app.post('/api/upload-photo', async (req, res) => {
    try {
        const { orderId, type, photoUrl, masterId } = req.body;
        const order = orders.get(orderId);
        
        if (!order) {
            return res.status(404).json({ success: false, error: 'Заявка не найдена' });
        }

        // Добавляем фото в заявку
        if (!order.photos) order.photos = {};
        order.photos[type] = photoUrl;

        // Обновляем в Google Sheets
        await updateGoogleSheet(orderId, {
            [`photo_${type}`]: photoUrl,
            [`${type}_at`]: new Date().toISOString()
        });

        // Если это фото "после работы", отправляем уведомление менеджеру
        if (type === 'after') {
            await notifyManager(order, 'Работа завершена!');
        }

        res.json({ success: true });

    } catch (error) {
        console.error('Error uploading photo:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Получение статистики
app.get('/api/stats', async (req, res) => {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: 'Заявки!A:Z'
        });
        
        const rows = response.data.values;
        const stats = {
            total: rows.length - 1,
            pending: rows.filter(row => row[10] === 'pending').length,
            taken: rows.filter(row => row[10] === 'taken').length,
            completed: rows.filter(row => row[10] === 'completed').length
        };
        
        res.json({ success: true, stats });
    } catch (error) {
        console.error('Error getting stats:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =============== TELEGRAM ОБРАБОТЧИКИ ===============

// Регистрация мастера
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userName = msg.from.first_name;
    
    masters.set(userId.toString(), chatId);
    
    bot.sendMessage(chatId, 
        `👋 Привет, ${userName}!\n\n` +
        `Я бот для принятия заявок на уборку.\n` +
        `Когда в канале появится новая заявка, ты сможешь нажать кнопку "Взять заявку".\n\n` +
        `После принятия заявки я пришлю тебе полную информацию.`,
        { parse_mode: 'HTML' }
    );
});

// Обработка callback кнопок
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;
    const masterId = callbackQuery.from.id;
    const masterName = callbackQuery.from.first_name;
    
    if (data.startsWith('take_')) {
        const orderId = data.replace('take_', '');
        const order = orders.get(orderId);
        
        if (order && order.status === 'pending') {
            // Отмечаем заявку как взятую
            order.status = 'taken';
            order.masterId = masterId;
            order.masterName = masterName;
            order.takenAt = new Date().toISOString();
            
            // Удаляем сообщение из канала
            await bot.deleteMessage(chatId, messageId);
            
            // Отправляем мастеру полную информацию
            const fullInfo = formatFullOrderInfo(order);
            await bot.sendMessage(masters.get(masterId), fullInfo, { parse_mode: 'HTML' });
            
            // Обновляем в Google Sheets
            await updateGoogleSheet(orderId, {
                status: 'taken',
                masterName,
                takenAt: order.takenAt
            });
            
            // Отправляем подтверждение
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: '✅ Вы приняли заявку! Полная информация отправлена в личные сообщения.'
            });
            
            // Напоминания
            scheduleNotifications(orderId, order.orderDate, order.orderTime);
            
        } else {
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: '❌ Заявка уже кем-то взята'
            });
        }
    }
    
    if (data.startsWith('reject_')) {
        await bot.answerCallbackQuery(callbackQuery.id, {
            text: 'Заявка отклонена'
        });
    }
});

// Обработка фото от мастера
bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const photo = msg.photo[msg.photo.length - 1];
    
    // Определяем тип фото по тексту
    const text = msg.caption || '';
    let type = '';
    
    if (text.includes('на месте')) type = 'on_site';
    else if (text.includes('химия')) type = 'chemistry';
    else if (text.includes('до')) type = 'before';
    else if (text.includes('после')) type = 'after';
    
    if (type) {
        // Сохраняем фото
        const file = await bot.getFile(photo.file_id);
        const photoUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        
        // Находим заявку по мастеру
        const order = Array.from(orders.values()).find(
            o => o.masterId === msg.from.id && o.status === 'taken'
        );
        
        if (order) {
            if (!order.photos) order.photos = {};
            order.photos[type] = photoUrl;
            
            await updateGoogleSheet(order.id, {
                [`photo_${type}`]: photoUrl,
                [`${type}_at`]: new Date().toISOString()
            });
            
            bot.sendMessage(chatId, '✅ Фото сохранено!');
            
            // Если это фото "после работ", завершаем заявку
            if (type === 'after') {
                order.status = 'completed';
                await updateGoogleSheet(order.id, { status: 'completed' });
                bot.sendMessage(chatId, '🎉 Заявка завершена! Ожидайте оплату.');
            }
        }
    }
});

// =============== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===============

function extractCityFromAddress(address) {
    const cities = Object.keys(CITY_CHANNELS);
    for (const city of cities) {
        if (address.toLowerCase().includes(city.toLowerCase())) {
            return city;
        }
    }
    return 'Москва'; // по умолчанию
}

function formatOrderForTelegram(orderData, orderId) {
    return `
🧹 <b>НОВАЯ ЗАЯВКА #${orderId}</b>
───────────────
📍 <b>Адрес:</b> ${orderData.customerAddress}, ${orderData.customerFlat}
📏 <b>Площадь:</b> ${orderData.area} м²
🧼 <b>Тип уборки:</b> ${orderData.cleaningType}
💰 <b>Стоимость:</b> ${orderData.orderTotal} руб
⏰ <b>Дата:</b> ${orderData.orderDate} ${orderData.orderTime}
👤 <b>Клиент:</b> ${orderData.customerName}

───────────────
🎯 <b>Для принятия заявки нажмите кнопку ниже</b>
⚠️ <i>Будьте готовы предоставить фото отчет</i>`;
}

function formatFullOrderInfo(order) {
    return `
🔐 <b>ПОЛНАЯ ИНФОРМАЦИЯ ПО ЗАЯВКЕ</b>
───────────────
📋 <b>Номер заявки:</b> ${order.id}
📍 <b>Полный адрес:</b> ${order.customerAddress}, ${order.customerFlat}
📞 <b>Телефон клиента:</b> <code>${order.customerPhone}</code>
👤 <b>Имя клиента:</b> ${order.customerName}
⏰ <b>Дата и время:</b> ${order.orderDate} ${order.orderTime}

📏 <b>Детали уборки:</b>
• Площадь: ${order.area} м²
• Тип: ${order.cleaningType}
• Сложность: уровень ${order.difficulty}
• Животные: ${order.pets}

💰 <b>Финансы:</b>
• Сумма заказа: ${order.orderTotal} руб
• Зарплата мастерам: ${order.masterPay} руб

🧰 <b>Оборудование:</b> ${order.equipment || '—'}
🧴 <b>Химия:</b> ${order.chemistry || '—'}

📝 <b>Описание работ:</b>
${order.worksDescription || '—'}

───────────────
<b>ИНСТРУКЦИЯ:</b>
1. Позвоните клиенту для подтверждения
2. Приезжайте вовремя
3. Присылайте фото:
   • Прибытие на объект
   • Используемая химия
   • До начала работ
   • После завершения работ

⏰ <i>Напоминания придут за 24 часа и за 2 часа до уборки</i>`;
}

async function saveToGoogleSheets(orderData, orderId, status) {
    const values = [[
        new Date().toISOString(),
        orderId,
        orderData.manager,
        orderData.customerName,
        orderData.customerPhone,
        orderData.customerAddress,
        orderData.customerFlat,
        orderData.area,
        orderData.cleaningType,
        orderData.difficulty,
        status,
        orderData.orderDate,
        orderData.orderTime,
        orderData.orderTotal,
        orderData.masterPay,
        orderData.pets,
        orderData.equipment,
        orderData.chemistry,
        orderData.worksDescription,
        '', // masterName (заполнится позже)
        '', // takenAt
        '', // completedAt
        ''  // telegramMessageId
    ]];
    
    await sheets.spreadsheets.values.append({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: 'Заявки!A:T',
        valueInputOption: 'USER_ENTERED',
        resource: { values }
    });
}

async function updateGoogleSheet(orderId, updates) {
    // Находим строку с заявкой и обновляем
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: 'Заявки!A:B'
    });
    
    const rows = response.data.values;
    const rowIndex = rows.findIndex(row => row[1] === orderId) + 1;
    
    if (rowIndex > 0) {
        const range = `Заявки!K${rowIndex}:T${rowIndex}`;
        await sheets.spreadsheets.values.update({
            spreadsheetId: GOOGLE_SHEET_ID,
            range,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [Object.values(updates)] }
        });
    }
}

function scheduleNotifications(orderId, date, time) {
    // Расписание напоминаний за 24 часа и 2 часа
    const orderDateTime = new Date(`${date}T${time}`);
    const masterChatId = masters.get(orders.get(orderId).masterId);
    
    if (masterChatId) {
        // Напоминание за 24 часа
        const reminder24h = new Date(orderDateTime.getTime() - 24 * 60 * 60 * 1000);
        setTimeout(() => {
            bot.sendMessage(masterChatId, 
                `⏰ Напоминание: завтра в ${time} у вас заявка ${orderId}\n` +
                `Адрес: ${orders.get(orderId).customerAddress}`
            );
        }, reminder24h - Date.now());
        
        // Напоминание за 2 часа
        const reminder2h = new Date(orderDateTime.getTime() - 2 * 60 * 60 * 1000);
        setTimeout(() => {
            bot.sendMessage(masterChatId,
                `⏰ Через 2 часа у вас заявка ${orderId}\n` +
                `Подготовьтесь к выезду!\n` +
                `Телефон клиента: ${orders.get(orderId).customerPhone}`
            );
        }, reminder2h - Date.now());
    }
}

async function notifyManager(order, message) {
    // Отправляем уведомление менеджеру (можно в отдельный канал или боту)
    const managerChannel = '@apexclean_managers';
    await bot.sendMessage(managerChannel, 
        `📢 ${message}\n` +
        `Заявка: ${order.id}\n` +
        `Мастер: ${order.masterName}\n` +
        `Клиент: ${order.customerName}`
    );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
