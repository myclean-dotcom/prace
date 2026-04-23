# Apex Clean: Google Apps Script + Telegram

Актуальная версия backend: `2026-04-23-gas-clean-v2`

Проект управляет заявками клининга:
- создание заявки с сайта `index.html`
- запись в Google Таблицу
- публикация заявки в Telegram-группу
- кнопки мастера: взять, приехал, завершил, оплата, отмена
- панель менеджера и отправка ссылки/QR мастеру

## Канонические файлы
- `Code.gs` — основной и единственный исходник backend для Google Apps Script
- `Code.single.gs` — автоматически собранная копия `Code.gs` для ручной вставки в Apps Script
- `index.html` — форма сайта
- `appsscript.json` — манифест Apps Script

Старые модульные файлы `01_config.gs` ... `13_telegram_bot_commands.gs` оставлены в репозитории только как архив. В `clasp push` они больше не попадают.

## Обязательные Script Properties
- `SPREADSHEET_ID`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_NOVOSIBIRSK` или `TELEGRAM_CHAT_ID`

Рекомендуется:
- `TELEGRAM_MANAGER_CHAT_ID`
- `TELEGRAM_EVENTS_CHAT_ID`
- `WEBAPP_EXEC_URL`

## Быстрый запуск вручную
1. Откройте Apps Script.
2. Вставьте содержимое `Code.single.gs` в один файл `Code.gs`.
3. При необходимости вставьте `index.html` как HTML-файл проекта.
4. В `Script Properties` задайте обязательные значения.
5. Сделайте Deploy Web App:
   `Execute as me`
   `Who has access: Anyone`
6. Запустите:
   `__setWebhookProd()`
   `__setTelegramBotCommands()`
7. Проверьте:
   `__checkConfiguration()`
   `__checkButtonEndToEnd()`

## Загрузка через clasp
В репозитории настроено так, что `clasp push -f` отправляет только:
- `Code.gs`
- `index.html`
- `appsscript.json`

Шаги:
1. `npm i -g @google/clasp`
2. `clasp login`
3. `clasp push -f`
4. Затем в Apps Script сделайте новый `Deploy -> Manage deployments -> Edit -> New version`

## Диагностика
- `__repairTelegramButtonsAndSendTest()` — перепривязать webhook, обновить команды и отправить тест в группу
- `__getTelegramWebhookInfo()` — посмотреть webhook Telegram
- `__checkButtonEndToEnd()` — полная проверка callback-маршрута
- `__testTelegramSend()` — тест отправки сообщения
- `__sendTestGroupMessage()` — тестовая кнопка в группу

## Важно по кнопкам Telegram
Если кнопки перестали работать, причина почти всегда одна:
- Telegram webhook смотрит на старый `/exec` URL

Что делать:
1. Сделайте новый Deploy Web App.
2. Запустите `__repairTelegramButtonsAndSendTest()`.
3. Если функция покажет расхождение URL, выполните ее с явным адресом:
   `__repairTelegramButtonsAndSendTest("ВАШ_НОВЫЙ_/exec_URL")`
