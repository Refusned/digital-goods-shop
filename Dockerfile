# Образ приложения. База поднимается отдельным сервисом, миграции и сид запускаются
# отдельными командами, чтобы контейнер оставался предсказуемым и без магии на старте.
# Базовый образ вынесен в аргумент: на машинах, где Docker Hub упирается в лимит,
# сборка идёт с зеркала без правки файла.
ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE}

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3020

CMD ["node", "src/server.js"]
