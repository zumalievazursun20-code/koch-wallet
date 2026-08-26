# Koch Wallet 💰

Полноценный электронный кошелёк как **Telegram Mini App** с:

- Регистрацией через Telegram (автоматически)
- Балансом и историей транзакций
- Системой кредитов с процентами и одобрением администратором
- Админ-панелью (зачисление/списание денег, назначение админов, одобрение кредитов)
- Красивым современным тёмным дизайном

## Быстрый старт (локально)

1. Установите Node.js 18+
2. Скопируйте `.env.example` в `.env` и заполните:

```bash
cp .env.example .env
```

Обязательно укажите:
- `BOT_TOKEN` — токен бота от @BotFather
- `INITIAL_ADMIN_ID` — ваш числовой Telegram ID (узнать у @userinfobot)

3. Установите зависимости и запустите:

```bash
npm install
npm start
```

Приложение будет на `http://localhost:3000`

## Деплой (рекомендуется Render / Railway)

### Render.com (бесплатно)

1. Создайте аккаунт на [render.com](https://render.com)
2. New → Web Service
3. Подключите GitHub-репозиторий (или загрузите zip)
4. Настройки:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. Добавьте Environment Variables из `.env`
6. Создайте Persistent Disk (для базы данных `data/`) и смонтируйте в `/opt/render/project/src/data`

### Railway.app

1. New Project → Deploy from GitHub / Upload
2. Добавьте переменные окружения
3. Volume для папки `data`

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
RUN mkdir -p data
EXPOSE 3000
CMD ["npm", "start"]
```

```bash
docker build -t koch-wallet .
docker run -p 3000:3000 --env-file .env -v $(pwd)/data:/app/data koch-wallet
```

## Подключение к Telegram

1. Создайте бота через @BotFather → `/newbot`
2. Получите токен → вставьте в `BOT_TOKEN`
3. В @BotFather выполните:
   ```
   /newapp
   ```
   или `/mybots` → выберите бота → Bot Settings → Configure Mini App
4. Укажите URL вашего задеплоенного сайта (должен быть HTTPS)
5. Готово! Откройте бота и нажмите кнопку меню / команду с Mini App

## Возможности

### Пользователь
- Просмотр баланса
- Подача заявки на кредит (сумма, срок, цель)
- Погашение кредита с баланса
- История всех операций

### Админ
- Просмотр статистики
- Поиск пользователей
- Зачисление / списание денег любому пользователю
- Назначение / снятие прав администратора
- Одобрение / отклонение заявок на кредит (с возможностью изменить процент)

## Валюта
По умолчанию **USD**. Можно легко поменять в коде (иконки и подписи).

## Безопасность
- Валидация `initData` от Telegram (HMAC-SHA256)
- Rate limiting
- Только админы могут менять балансы и одобрять кредиты

---

Сделано для Koch Wallet 💜
