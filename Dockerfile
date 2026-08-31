# Образ приложения. База поднимается отдельным сервисом, миграции и сид запускаются
# отдельными командами, чтобы контейнер оставался предсказуемым и без магии на старте.
FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3020

CMD ["node", "src/server.js"]
