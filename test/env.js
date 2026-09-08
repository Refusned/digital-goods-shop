/**
 * Страж тестового окружения. Импортируется первым в каждом тестовом файле.
 *
 * Подготовку базы делает scripts/test.js ДО запуска процесса тестов, потому что подменить
 * DATABASE_URL "перед импортами" внутри самого файла нельзя: статические импорты ESM
 * выполняются раньше, чем завершается top-level await соседнего модуля.
 *
 * Здесь остаётся только проверка fail closed: тесты очищают таблицы, поэтому они обязаны
 * работать на выделенной базе и обязаны падать, если это не так.
 */
const url = process.env.DATABASE_URL || '';
const dbName = (() => {
  try { return new URL(url).pathname.replace(/^\//, ''); } catch { return ''; }
})();

const allowed = process.env.ALLOW_DESTRUCTIVE_TESTS === '1' && dbName.endsWith('_test');
if (!allowed) {
  throw new Error(
    `Тесты чистят таблицы и запускаются только на выделенной базе.\n` +
    `Запускайте их через "npm test" (он сам создаст и мигрирует базу <имя>_test).\n` +
    `Сейчас DATABASE_URL указывает на базу "${dbName || 'не задана'}".`,
  );
}

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
process.env.WORKER_ENABLED = '0';                  // воркер тесты поднимают точечно

process.env.OUT_OF_STOCK_RETRY_MS = '200';
process.env.ADMIN_TOKEN = 'test-token';

// Второй этап: бронь в тестах короткая, иначе сценарий её истечения занимал бы минуты.
process.env.RESERVATION_TTL_MS = process.env.RESERVATION_TTL_MS || '2000';
process.env.RESERVATION_PAYMENT_TTL_MS = process.env.RESERVATION_PAYMENT_TTL_MS || '2000';
process.env.LIVE_BATCH_MS = '30';
process.env.LIVE_HEARTBEAT_MS = '2000';
