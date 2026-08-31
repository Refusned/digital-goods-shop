// Импортируется ПЕРВЫМ в каждом тестовом файле: настройки должны попасть в config до его загрузки.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
process.env.WORKER_ENABLED = '0';            // воркер тесты поднимают точечно
process.env.OUT_OF_STOCK_RETRY_MS = '200';
process.env.ADMIN_TOKEN = 'test-token';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://shop:shop@localhost:5443/shop';
