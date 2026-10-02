# max-shop

Магазин для MAX: витрина + админка + бот. Node.js на Render, база и фото в Supabase (бесплатные тарифы).

## 1. Supabase
1. Создайте проект на supabase.com.
2. SQL Editor -> вставьте содержимое `schema.sql` -> Run (создаст таблицы, бакет `media` и 3 тестовых товара).
3. Project Settings -> API: скопируйте Project URL и ключ `service_role` (секретный, только для сервера).

## 2. GitHub
Загрузите все файлы этой папки в репозиторий (файл `.env` не загружайте).

## 3. Render
New -> Web Service -> ваш репозиторий. Build Command: `npm install`, Start Command: `npm start`, тариф Free.
Environment: переменные из `.env.example` (SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_PASSWORD, MAX_BOT_TOKEN, PUBLIC_URL, WEBHOOK_SECRET, MANAGER_USER_ID).
`PUBLIC_URL` - адрес сервиса, который покажет Render. При старте сервер сам подпишет бота на вебхук.

## 4. Менеджер
Напишите боту `/id`, он ответит вашим user_id. Впишите его в `MANAGER_USER_ID` на Render: новые заказы будут приходить вам в MAX.

## Адреса
- `/` - витрина, `/admin` - админка (пароль ADMIN_PASSWORD).
- Бесплатный Render засыпает без запросов, первый ответ может занять около минуты.
- Бесплатный Supabase замораживается после недели простоя.
