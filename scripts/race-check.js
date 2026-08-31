/**
 * Проверка критериев приёмки против ЖИВОГО сервера.
 *
 *   npm start      # в одном терминале
 *   npm run race   # в другом
 *
 * Проверяет ровно те пять сценариев, которые перечислены в задании.
 */
import pg from 'pg';

const base = process.env.API_URL || `http://127.0.0.1:${process.env.PORT || 3020}`;
const adminToken = process.env.ADMIN_TOKEN || 'admin-token';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL || 'postgres://shop:shop@localhost:5443/shop' });
await db.connect();

const post = (path, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Admin-Token': adminToken },
    body: JSON.stringify(body ?? {}),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const get = (path) =>
  fetch(base + path, { headers: { 'X-Admin-Token': adminToken } })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitStatus(orderId, statuses, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const { body } = await get(`/api/orders/${orderId}`);
    if (statuses.includes(body.status)) return body;
    await sleep(150);
  }
  return (await get(`/api/orders/${orderId}`)).body;
}

const results = [];
const check = (name, ok, details) => {
  results.push({ name, ok });
  process.stdout.write(`${ok ? 'OK  ' : 'FAIL'} ${name} ${JSON.stringify(details)}\n`);
};

const paid = (orderId, amount) => ({
  event_id: `evt_${Math.random().toString(36).slice(2, 12)}`,
  order_id: orderId, status: 'paid', amount, currency: 'RUB', created_at: new Date().toISOString(),
});

// 1. Пятьдесят параллельных вебхуков по одному заказу.
{
  const { body: order } = await post('/api/orders', { sku: 'KEY-CS2-PRIME' });
  await Promise.all(Array.from({ length: 50 }, () => post('/webhook/payment', paid(order.id, order.amount))));
  const final = await waitStatus(order.id, ['delivered']);
  const keys = await db.query('SELECT count(*)::int AS n FROM stock_keys WHERE order_id = $1', [order.id]);
  check('50 параллельных вебхуков -> один факт выдачи, один ключ',
    final.status === 'delivered' && keys.rows[0].n === 1,
    { order: order.id, status: final.status, keys: keys.rows[0].n, code: final.delivery?.code });
}

// 2. Повтор того же события.
{
  const { body: order } = await post('/api/orders', { sku: 'KEY-GTA5' });
  const event = paid(order.id, order.amount);
  const responses = await Promise.all(Array.from({ length: 20 }, () => post('/webhook/payment', event)));
  const final = await waitStatus(order.id, ['delivered']);
  const stored = await db.query('SELECT count(*)::int AS n FROM payment_events WHERE event_id = $1', [event.event_id]);
  const duplicates = responses.filter((r) => r.body.outcome === 'duplicate').length;
  check('повторный вебхук с тем же event_id ничего не меняет',
    stored.rows[0].n === 1 && duplicates === 19 && final.status === 'delivered',
    { stored_events: stored.rows[0].n, duplicate_responses: duplicates, status: final.status });
}

// 3. Вебхук раньше заказа плюс устаревшее событие не по порядку.
{
  const orderId = `ord_early_${Math.random().toString(36).slice(2, 8)}`;
  const early = await post('/webhook/payment', paid(orderId, 1290));
  const { body: order } = await post('/api/orders', { sku: 'KEY-CS2-PRIME', order_id: orderId });

  const stale = await post('/webhook/payment', {
    ...paid(orderId, order.amount),
    status: 'failed',
    created_at: new Date(Date.now() - 60_000).toISOString(),
  });

  const final = await waitStatus(orderId, ['delivered']);
  const keys = await db.query('SELECT count(*)::int AS n FROM stock_keys WHERE order_id = $1', [orderId]);
  check('вебхук раньше заказа и событие не по порядку обработаны корректно',
    early.body.outcome === 'pending_order' && stale.body.outcome === 'stale'
      && final.status === 'delivered' && keys.rows[0].n === 1,
    { early: early.body.outcome, stale: stale.body.outcome, status: final.status, keys: keys.rows[0].n });
}

// 4. Пустой пул и восстановление после завоза.
{
  const sku = 'SUB-SPOTIFY-1M';
  await db.query('UPDATE stock_keys SET order_id = NULL, issued_at = NULL WHERE sku = $1 AND order_id IS NULL', [sku]);
  const free = await db.query('SELECT id FROM stock_keys WHERE sku = $1 AND order_id IS NULL', [sku]);
  await db.query('DELETE FROM stock_keys WHERE sku = $1 AND order_id IS NULL', [sku]);   // опустошаем пул

  const { body: order } = await post('/api/orders', { sku });
  await post('/webhook/payment', paid(order.id, order.amount));
  const stuck = await waitStatus(order.id, ['out_of_stock'], 8000);

  const restockCode = `RACE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  await post(`/api/admin/stock/${sku}/restock`, { codes: [restockCode] });
  const recovered = await waitStatus(order.id, ['delivered'], 15000);
  const keys = await db.query('SELECT count(*)::int AS n FROM stock_keys WHERE order_id = $1', [order.id]);

  check('пустой пул -> восстановимое состояние -> после завоза ровно один ключ',
    stuck.status === 'out_of_stock' && recovered.status === 'delivered' && keys.rows[0].n === 1,
    { emptied: free.rowCount, stuck: stuck.status, recovered: recovered.status, code: recovered.delivery?.code });
}

// 5. Лимит промокода под параллельными запросами.
{
  await db.query(`UPDATE promocodes SET used_count = 0 WHERE code = 'LIMIT3'`);
  await db.query(`DELETE FROM promocode_uses WHERE code = 'LIMIT3'`);

  const results20 = await Promise.all(
    Array.from({ length: 20 }, () => post('/api/orders', { sku: 'KEY-GTA5', promocode: 'LIMIT3' })),
  );
  const applied = results20.filter((r) => r.body.promocode === 'LIMIT3').length;
  const { rows } = await db.query(`SELECT used_count, max_uses FROM promocodes WHERE code = 'LIMIT3'`);

  check('промокод с лимитом 3 под 20 параллельными запросами применён ровно 3 раза',
    applied === 3 && rows[0].used_count === 3,
    { applied, used_count: rows[0].used_count, max_uses: rows[0].max_uses });
}

// Итог: сверка обязана быть здоровой.
{
  const { body: report } = await get('/api/admin/reconciliation');
  check('сверка здорова: нет выданного без оплаты, журнал денег сходится',
    report.healthy === true,
    { delivered_not_paid: report.delivered_not_paid.count, ledger_balanced: report.ledger.balanced });
}

await db.end();
const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} проверок пройдено\n`);
process.exit(failed.length ? 1 : 0);
