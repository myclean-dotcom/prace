# SETUP GUIDE

## 1) Google Таблица
Создайте таблицу и скопируйте ID из URL:
`https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`

## 2) Script Properties
Откройте: Apps Script -> Project Settings -> Script Properties.

Добавьте:
- `SPREADSHEET_ID` = ID таблицы
- `TELEGRAM_BOT_TOKEN` = токен бота
- `TELEGRAM_CHAT_NOVOSIBIRSK` = ID рабочей группы по Новосибирску

Рекомендуется:
- `TELEGRAM_MANAGER_CHAT_ID` = ваш чат/группа менеджеров
- `TELEGRAM_EVENTS_CHAT_ID` = чат событий (если отдельно)

## 3) Деплой
Deploy -> New deployment -> Web app
- Execute as: Me
- Who has access: Anyone

Скопируйте URL `/exec`.

## 4) После деплоя
Запустите:
- `__setWebhookProd()`
- `__setTelegramBotCommands()`

## 5) Проверка
Запустите `__checkButtonEndToEnd()`.
Успех: `ok: true`, без ошибок по webhook и buildVersion.

## 6) Если кнопки не работают
- проверьте, что в webhook стоит именно текущий `/exec`
- заново Deploy и снова `__setWebhookProd()`
- повторите `__checkButtonEndToEnd()`
