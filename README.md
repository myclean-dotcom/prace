# Apex Clean: Google Apps Script + VK/Telegram

Актуальная версия backend: `2026-02-24-bot-module-v1`

Проект управляет заявками клининга:
- создание заявки с сайта (`index.html`)
- запись в Google Таблицу
- публикация заявки в чат/группу мессенджера
- кнопки мастера: взять, приехал, завершил, оплата, отмена
- панель менеджера и отправка ссылки/QR на оплату напрямую через бота

## Структура backend (.gs)
Файл разбит на модули для быстрого сопровождения:
- `01_config.gs`
- `02_entry_points.gs`
- `03_request_parsing_and_bot_health.gs`
- `04_sheet_storage.gs`
- `05_orders_create_update.gs`
- `06_telegram_publish_group.gs`
- `07_telegram_updates_callbacks.gs`
- `08_commands_messages_status_flow.gs`
- `09_telegram_text_photo_reminders.gs`
- `10_notifications_and_datetime.gs`
- `11_webhook_city_misc.gs`
- `12_diagnostics_and_setup.gs`
- `13_telegram_bot_commands.gs`
- `Code.gs` — индекс-файл

## Обязательные Script Properties
- `SPREADSHEET_ID`
- `MESSENGER_PROVIDER` = `vk` (или `telegram`)
- для `vk`: `VK_BOT_TOKEN`, `VK_CONFIRMATION_CODE`, `VK_CHAT_NOVOSIBIRSK` (или `VK_CHAT_ID`)
- для `telegram`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_NOVOSIBIRSK` (или `TELEGRAM_CHAT_ID`)

Рекомендуется:
- `TELEGRAM_MANAGER_CHAT_ID`
- `TELEGRAM_EVENTS_CHAT_ID`
- `VK_CALLBACK_SECRET` (если включили secret в VK Callback API)
- `WEBAPP_EXEC_URL`

## Быстрый запуск
1. Залить `.gs` файлы в Apps Script проект.
2. Деплой Web App: `Execute as me`, `Who has access: Anyone`.
3. Для `vk`: в настройках Callback API группы укажите URL вашего `/exec`, включите события `message_new` и `message_event`.
4. Для `telegram` запустить:
- `__setWebhookProd()`
- `__setTelegramBotCommands()`
5. Проверить:
- `__checkConfiguration()`
- `__checkButtonEndToEnd()`

## Загрузка через clasp
В репозитории уже настроены:
- `.clasp.json` (привязан к вашему Script ID)
- `.claspignore` (отправляет только `.gs`, `.html`, `appsscript.json`)

Остается выполнить локально:
1. `npm i -g @google/clasp`
2. `clasp login`
3. `clasp push -f`

## Команды менеджера (в VK/Telegram)
- `/panel` — показать панель
- `/active` — заявки в работе
- `/planned` — запланированные
- `/pay` — выбрать заявку и отправить оплату
- `/pay НОМЕР_ЗАЯВКИ ССЫЛКА [QR: ...]` — отправить оплату сразу
- `/setmanager` — назначить текущий чат как менеджерский
- `/setevents` — назначить текущий чат событий
- `/setgroup` — назначить текущий чат как общий чат заявок
- `/setnsk` — назначить текущий чат Новосибирска
- `/myid` — показать `user_id` и `chat_id`
- `/hidepanel` — скрыть панель

## Команды мастера (в VK/Telegram)
- `/panel`
- `/myorder`
- `/arrived`
- `/done`
- `/paid`
- `/cancel`
- `/hidepanel`

## Важно по кнопкам
Если кнопки перестали срабатывать, обычно причина в старом деплое `/exec`.

Что делать:
1. Новый Deploy Web App.
2. Сразу `__setWebhookProd()`.
3. Проверка `__checkButtonEndToEnd()`.
