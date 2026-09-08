import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Крошечный загрузчик .env, чтобы не тащить зависимость ради пяти переменных.
if (existsSync(join(root, '.env'))) {
  for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const num = (v, def) => (v === undefined || v === '' ? def : Number(v));

export const config = {
  root,
  port: num(process.env.PORT, 3020),
  databaseUrl: process.env.DATABASE_URL || 'postgres://shop:shop@localhost:5443/shop',
  adminToken: process.env.ADMIN_TOKEN ?? '',
  // Бронь ключа под заказ: сколько времени даётся на оформление и оплату.
  reservation: {
    ttlMs: num(process.env.RESERVATION_TTL_MS, 5 * 60_000),
    // Уход на оплату продлевает бронь: время оплаты не должно съедать время оформления.
    paymentTtlMs: num(process.env.RESERVATION_PAYMENT_TTL_MS, 3 * 60_000),
    sweepIntervalMs: num(process.env.RESERVATION_SWEEP_MS, 1000),
  },

  // Живые обновления витрины.
  live: {
    enabled: process.env.LIVE_UPDATES_ENABLED !== '0',
    batchMs: num(process.env.LIVE_BATCH_MS, 80),
    heartbeatMs: num(process.env.LIVE_HEARTBEAT_MS, 15_000),
  },

  worker: {
    enabled: process.env.WORKER_ENABLED !== '0',
    intervalMs: num(process.env.WORKER_INTERVAL_MS, 1000),
    maxAttempts: num(process.env.WORKER_MAX_ATTEMPTS, 10),
    // Нет свободных ключей это не ошибка системы: пул пополняют, поэтому такие заказы
    // ретраятся бессрочно, но редко.
    outOfStockRetryMs: num(process.env.OUT_OF_STOCK_RETRY_MS, 3000),
  },
  logLevel: process.env.LOG_LEVEL || 'info',
};
