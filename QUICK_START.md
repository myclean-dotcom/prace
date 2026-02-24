# QUICK START

1. В Apps Script создайте проект и добавьте все `.gs` файлы из репозитория.
2. Вставьте `index.html` (frontend) на хостинг/страницу.
3. В Script Properties задайте:
- `SPREADSHEET_ID`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_NOVOSIBIRSK`
- (опц.) `TELEGRAM_MANAGER_CHAT_ID`, `TELEGRAM_EVENTS_CHAT_ID`
4. Деплой Web App (`/exec`), доступ: `Anyone`.
5. Выполните функции:
- `__setWebhookProd()`
- `__setTelegramBotCommands()`
6. Проверьте:
- `__checkConfiguration()`
- `__checkButtonEndToEnd()`
7. В чате бота выполните `/panel`.
