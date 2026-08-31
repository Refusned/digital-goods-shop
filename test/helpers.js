import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { startWorker } from '../src/worker.js';

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
});

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startStack({ worker = false, workerIntervalMs = 120 } = {}) {
  const server = await listen(createApp());
  const base = `http://127.0.0.1:${server.address().port}`;
  const stopWorker = worker ? startWorker({ intervalMs: workerIntervalMs }) : null;
  return {
    base,
    async stop() {
      if (stopWorker) await stopWorker();
      await new Promise((r) => server.close(r));
    },
  };
}

/** Полная очистка данных. keysPerSku задаёт размер пула на каждый товар. */
export async function resetData({ keysPerSku = 5 } = {}) {
  await pool.query('TRUNCATE ledger_entries, promocode_uses, payment_events, stock_keys, orders RESTART IDENTITY CASCADE');

  await pool.query(
    `INSERT INTO products (sku, name, type, price_minor, old_price_minor, currency, image, section, popularity)
     VALUES ('KEY-CS2-PRIME', 'CS2 Prime Status ключ', 'key', 1290, 2193, 'RUB', 'assets/cs2.svg', 'popular', 100),
            ('KEY-GTA5', 'GTA V ключ активации', 'key', 1990, 3383, 'RUB', 'assets/gta5.svg', 'popular', 90),
            ('STEAM-TOPUP-500', 'Пополнение Steam 500 ₽', 'topup', 500, 850, 'RUB', 'assets/steam.svg', 'popular', 80)
     ON CONFLICT (sku) DO UPDATE SET is_active = TRUE, price_minor = EXCLUDED.price_minor`,
  );

  for (const sku of ['KEY-CS2-PRIME', 'KEY-GTA5', 'STEAM-TOPUP-500']) {
    for (let i = 1; i <= keysPerSku; i++) {
      await pool.query(
        'INSERT INTO stock_keys (sku, code) VALUES ($1, $2) ON CONFLICT (sku, code) DO NOTHING',
        [sku, `${sku}-KEY-${String(i).padStart(4, '0')}`],
      );
    }
  }

  await pool.query(
    `INSERT INTO promocodes (code, type, value, currency, max_uses, used_count)
     VALUES ('WELCOME10', 'percent', 10, NULL, 100, 0),
            ('GG500', 'amount', 500, 'RUB', 20, 0),
            ('LIMIT3', 'percent', 25, NULL, 3, 0),
            ('ONCEONLY', 'percent', 50, NULL, 1, 0)
     ON CONFLICT (code) DO UPDATE SET used_count = 0, is_active = TRUE, max_uses = EXCLUDED.max_uses`,
  );
}

export const api = (base) => ({
  post: (path, body, headers = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Admin-Token': 'test-token', ...headers },
      body: JSON.stringify(body ?? {}),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })),
  get: (path) => fetch(base + path, { headers: { 'X-Admin-Token': 'test-token' } })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })),
});

export async function waitFor(fn, { timeoutMs = 8000, everyMs = 60 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await fn();
    if (value) return value;
    await sleep(everyMs);
  }
  return null;
}

export const paidEvent = (orderId, amount, extra = {}) => ({
  event_id: `evt_${Math.random().toString(36).slice(2, 12)}`,
  order_id: orderId,
  status: 'paid',
  amount,
  currency: 'RUB',
  created_at: new Date().toISOString(),
  ...extra,
});

export { pool };
