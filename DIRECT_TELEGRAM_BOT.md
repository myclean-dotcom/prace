# Direct Telegram Bot (без Apps Script и Google Таблиц)

Этот режим работает полностью напрямую:
- сайт/CRM отправляет заявку в HTTP endpoint `/order`
- бот публикует заявку в Telegram-группу
- мастер работает кнопками и командами в боте
- статусы и история хранятся в `direct_bot_state.json`

## 1) Переменные окружения

Обязательная:
- `TELEGRAM_BOT_TOKEN`

Рекомендуемые:
- `TELEGRAM_CHAT_ID` — общий чат заявок
- `TELEGRAM_CHAT_NOVOSIBIRSK` — чат для Новосибирска
- `TELEGRAM_MANAGER_CHAT_ID` — чат менеджера
- `TELEGRAM_EVENTS_CHAT_ID` — чат событий/уведомлений
- `PORT` — HTTP порт (по умолчанию `8080`)
- `STATE_FILE` — путь к JSON-файлу состояния

## 2) Запуск

```bash
npm start
```

Проверка:
```bash
curl http://localhost:8080/health
```

## 3) Команды в Telegram

После запуска бот сам выставляет команды через `setMyCommands`.

Основные:
- `/panel`
- `/myorder`
- `/arrived`
- `/done`
- `/paid`
- `/cancel`
- `/active`
- `/planned`
- `/pay`
- `/setmanager`
- `/setevents`
- `/setgroup`
- `/setnsk`
- `/myid`
- `/diag`

## 4) HTTP API

### Создание заявки
`POST /order`

Пример:
```bash
curl -X POST http://localhost:8080/order \
  -H 'Content-Type: application/json' \
  -d '{
    "orderId": "CLN-12345678",
    "customerName": "Иван",
    "customerPhone": "+79991234567",
    "customerCity": "Новосибирск",
    "customerAddress": "Красный проспект, 10",
    "customerFlat": "кв 12",
    "orderDate": "26.02.2026",
    "orderTime": "12:30",
    "orderTotal": "4800",
    "masterPay": "2880",
    "cleaningType": "Поддерживающая",
    "area": "60",
    "equipment": "Пылесос, швабра",
    "chemistry": "Универсальное средство",
    "worksDescription": "Дополнительное описание"
  }'
```

### Отправка оплаты мастеру
`POST /manager/pay`

```bash
curl -X POST http://localhost:8080/manager/pay \
  -H 'Content-Type: application/json' \
  -d '{
    "orderId": "CLN-12345678",
    "link": "https://pay.example/link",
    "qr": "https://pay.example/qr"
  }'
```

### Диагностика
- `GET /health`
- `POST /diag`
- `GET /orders`
- `GET /orders?status=taken`

## 5) Важно

- Этот режим не использует Apps Script и Google Sheets.
- Если нужен деплой в интернет, поднимите процесс на VPS/сервере и пробросьте порт через reverse-proxy (nginx/caddy).
- Для стабильности запускайте через `pm2` или systemd.
