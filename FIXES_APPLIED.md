# Исправления ошибок в Code.gs

## Дата: 2024

---

## Исправление 1: Неправильные индексы колонок в `setTelegramIdsForOrder()`

**Файл:** `Code.gs:373-380`

**Проблема:** Индексы колонок были на 1 больше, чем нужно.

**Было:**
```javascript
sheet.getRange(row, 19).setValue(chatId);      // Telegram Chat ID
sheet.getRange(row, 20).setValue(messageId);   // Telegram Message ID
```

**Стало:**
```javascript
sheet.getRange(row, 18).setValue(chatId);      // Telegram Chat ID (колонка 18)
sheet.getRange(row, 19).setValue(messageId);   // Telegram Message ID (колонка 19)
```

---

## Исправление 2: Неправильные индексы колонок в `updateOrderTaken()`

**Файл:** `Code.gs:382-391`

**Проблема:** Индексы колонок для Master ID, Master Name и Дата принятия были неверными.

**Было:**
```javascript
sheet.getRange(row, 18).setValue('Взята');          // Статус = "Взята"
sheet.getRange(row, 21).setValue(masterId);         // Master ID
sheet.getRange(row, 22).setValue(masterName);       // Master Name
sheet.getRange(row, 23).setValue(takenAt);          // Дата принятия
```

**Стало:**
```javascript
sheet.getRange(row, 18).setValue('Взята');          // Статус = "Взята" (колонка 17)
sheet.getRange(row, 20).setValue(masterId);         // Master ID (колонка 19)
sheet.getRange(row, 21).setValue(masterName);       // Master Name (колонка 20)
sheet.getRange(row, 22).setValue(takenAt);          // Дата принятия (колонка 21)
```

---

## Исправление 3: Ошибка в вызове `generateFullText()`

**Файл:** `Code.gs:179`

**Проблема:** Функция `generateFullText()` ожидает данные в формате объекта с русскими ключами (как из таблицы), но передавался обычный объект order.

**Было:**
```javascript
const fullText = generateFullText(order);
```

**Стало:**
```javascript
const fullText = generateFullText(order, order);
```

---

## Исправление 4: Неправильные индексы колонок в `sendReminders()`

**Файл:** `Code.gs:434-495`

**Проблема:** Индексы для Master ID, sent24h и sent2h были неверными.

**Было:**
```javascript
const masterId = row[19];        // Master ID
const sent24h = row[22];         // Напоминание 24ч
const sent2h = row[23];          // Напоминание 2ч

sheet.getRange(i + 1, 23).setValue('Отправлено...');  // Для 24ч
sheet.getRange(i + 1, 24).setValue('Отправлено...');  // Для 2ч
```

**Стало:**
```javascript
const masterId = row[20];        // Master ID (колонка 20, 0-indexed)
const sent24h = row[23];         // Напоминание 24ч (колонка 23, 0-indexed)
const sent2h = row[24];          // Напоминание 2ч (колонка 24, 0-indexed)

sheet.getRange(i + 1, 24).setValue('Отправлено...');  // Для 24ч
sheet.getRange(i + 1, 25).setValue('Отправлено...');  // Для 2ч
```

---

## Как проверить исправления

1. Откройте Google Apps Script проект
2. Замените весь код в `Code.gs` на исправленную версию
3. Запустите функцию `__checkConfiguration()` для проверки настроек
4. Создайте тестовую заявку через веб-интерфейс
5. Проверьте, что:
   - Telegram Message ID сохраняется в правильную колонку
   - При нажатии кнопки "Выхожу на заявку" мастеру приходит полное сообщение
   - Напоминания отправляются корректно

---

## Таблица соответствия колонок (0-indexed)

| Колонка | Индекс | Название |
|---------|--------|----------|
| A | 0 | Номер заявки |
| B | 1 | Дата создания |
| C | 2 | Менеджер |
| D | 3 | Имя клиента |
| E | 4 | Телефон клиента |
| F | 5 | Город |
| G | 6 | Улица и дом |
| H | 7 | Квартира/офис |
| I | 8 | Дата уборки |
| J | 9 | Время уборки |
| K | 10 | Сумма заказа |
| L | 11 | Зарплата мастерам |
| M | 12 | Тип уборки |
| N | 13 | Площадь (м²) |
| O | 14 | Химия |
| P | 15 | Оборудование |
| Q | 16 | Описание работ |
| R | 17 | Статус |
| S | 18 | Telegram Chat ID |
| T | 19 | Telegram Message ID |
| U | 20 | Master ID |
| V | 21 | Master Name |
| W | 22 | Дата принятия |
| X | 23 | Напоминание 24ч |
| Y | 24 | Напоминание 2ч |
| Z | 25 | Статус выполнения |
