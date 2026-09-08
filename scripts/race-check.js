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
const dbUrl = process.env.DATABASE_URL || 'postgres://shop:shop@localhost:5443/shop';

// Скрипт создаёт заказы, расходует ключи и трогает счётчики промокодов, поэтому на базе
// с ценными данными он работать не должен. Осознанный запуск разрешается флагом.
if (process.env.ALLOW_DESTRUCTIVE_RACE !== '1') {
  process.stderr.write(
    'npm run race меняет данные: создаёт заказы, расходует ключи и сбрасывает счётчики промокодов.\n' +
    'Запускайте его на демонстрационной базе и подтвердите намерение:\n' +
    '  ALLOW_DESTRUCTIVE_RACE=1 npm run race\n',
  );
  process.exit(2);
}

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();

/** Код товара это ценность: в вывод попадает только хвост. */
const maskCode = (code) => (typeof code === 'string' && code.length > 4 ? `***${code.slice(-4)}` : '***');

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

process.stdout.write('Сценарии выполняются против ЗАПУЩЕННОГО сервера и создают в его базе реальные заказы.\n\n');

const results = [];
const check = (name, ok, details) => {
  results.push({ name, ok });
  process.stdout.write(`${ok ? 'OK  ' : 'FAIL'} ${name} ${JSON.stringify(details)}\n`);
};

const paid = (orderId, amount) => ({
  event_id: `evt_${Math.random().toString(36).slice(2, 12)}`,
  order_id: orderId, status: 'paid', amount, currency: 'RUB', created_at: new Date().toISOString(),
});

/**
 * Склад под сценарии.
 *
 * Скрипт не должен зависеть от того, что запускали до него: прогон сценариев второго этапа
 * или предыдущий прогон этого же скрипта расходуют ключи, а во втором этапе заказ на товар
 * без свободного ключа вообще не создаётся. Без этой подготовки проверки гонок падали бы
 * не потому, что сломаны гарантии, а потому, что продавать нечего.
 */
const SCENARIO_SKUS = ['KEY-CS2-PRIME', 'KEY-GTA5', 'SUB-SPOTIFY-1M'];
for (const sku of SCENARIO_SKUS) {
  const { rows } = await db.query('SELECT COALESCE(available, 0) AS available FROM product_stock WHERE sku = $1', [sku]);
  const available = Number(rows[0]?.available ?? 0);
  if (available < 30) {
    const codes = Array.from({ length: 30 - available }, (_, i) =>
      `RACE-${sku}-${Date.now().toString(36)}-${i}`);
    await post(`/api/admin/stock/${sku}/restock`, { codes });
  }
}

// 1. Пятьдесят параллельных вебхуков по одному заказу.
{
  const { body: order } = await post('/api/orders', { sku: 'KEY-CS2-PRIME' });
  await Promise.all(Array.from({ length: 50 }, () => post('/webhook/payment', paid(order.id, order.amount))));
  const final = await waitStatus(order.id, ['delivered']);
  const keys = await db.query('SELECT count(*)::int AS n FROM stock_keys WHERE order_id = $1', [order.id]);
  check('50 параллельных вебхуков -> один факт выдачи, один ключ',
    final.status === 'delivered' && keys.rows[0].n === 1,
    { order: order.id, status: final.status, keys: keys.rows[0].n, code: maskCode(final.delivery?.code) });
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
  // Сумма берётся из каталога, а не из константы: цену товара мог поменять кто угодно,
  // а расхождение суммы это отдельный сценарий, который здесь только мешал бы.
  const { body: catalog } = await get('/api/search?q=KEY-CS2-PRIME&limit=1');
  const price = catalog.items[0]?.price;
  const early = await post('/webhook/payment', paid(orderId, price));
  const { body: order } = await post('/api/orders', { sku: 'KEY-CS2-PRIME', order_id: orderId });

  const stale = await post('/webhook/payment', {
    ...paid(orderId, order.amount),
    status: 'failed',
    created_at: new Date(Date.now() - 60_000).toISOString(),
  });

  const final = await waitStatus(orderId, ['delivered']);
  const keys = await db.query('SELECT count(*)::int AS n FROM stock_keys WHERE order_id = $1', [orderId]);
  check('вебхук раньше заказа и событие не по порядку обработаны корректно',
    early.body.outcome === 'pending_order' && stale.body.outcome === 'ignored_after_paid'
      && final.status === 'delivered' && keys.rows[0].n === 1,
    { early: early.body.outcome, late_failed: stale.body.outcome, status: final.status, keys: keys.rows[0].n });
}

// 4. Нет свободных ключей: честный отказ до оплаты, восстановление после завоза.
//
// Во втором этапе ключ занимается при оформлении, поэтому заказ на товар без свободного ключа
// не создаётся вовсе: покупатель узнаёт об этом ДО оплаты. Проверяем обе половины:
// отказ на пустом складе и выдачу после завоза.
{
  const sku = 'SUB-SPOTIFY-1M';
  await db.query(
    `UPDATE stock_keys SET reserved_by_order = NULL, reserved_until = NULL
      WHERE sku = $1 AND order_id IS NULL`, [sku]);
  const free = await db.query('SELECT id FROM stock_keys WHERE sku = $1 AND order_id IS NULL', [sku]);
  await db.query('DELETE FROM stock_keys WHERE sku = $1 AND order_id IS NULL', [sku]);   // опустошаем пул

  const refused = await post('/api/orders', { sku });

  const restockCode = `RACE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  await post(`/api/admin/stock/${sku}/restock`, { codes: [restockCode] });

  const { body: order } = await post('/api/orders', { sku });
  await post('/webhook/payment', paid(order.id, order.amount));
  const recovered = await waitStatus(order.id, ['delivered'], 15000);
  const keys = await db.query('SELECT count(*)::int AS n FROM stock_keys WHERE order_id = $1', [order.id]);

  check('пустой склад -> отказ до оплаты -> после завоза заказ выдан ровно одним ключом',
    refused.status === 409 && refused.body.error === 'sold_out'
      && recovered.status === 'delivered' && keys.rows[0].n === 1,
    { emptied: free.rowCount, refused: refused.status, refused_error: refused.body.error,
      recovered: recovered.status, code: maskCode(recovered.delivery?.code) });
}

// 4b. Оплата догнала заказ, который уже потерял свой ключ: восстановимое состояние и завоз.
//
// Это единственный оставшийся путь к состоянию "оплачено, а выдать нечем": бронь истекла,
// ключ забрал другой покупатель, и ровно тогда доехал платёж.
{
  const sku = 'SUB-SPOTIFY-1M';
  // Предыдущий сценарий оставил склад пустым: заводим ровно один ключ под этот.
  await post(`/api/admin/stock/${sku}/restock`, {
    codes: [`RACE-LOST-${Math.random().toString(36).slice(2, 8).toUpperCase()}`],
  });
  const { body: order } = await post('/api/orders', { sku });

  // Срок брони истекает: в проде это минуты, здесь сдвигаем время явно.
  await db.query(`UPDATE orders SET reserved_until = now() - interval '1 second' WHERE id = $1`, [order.id]);
  await db.query(
    `UPDATE stock_keys SET reserved_until = now() - interval '1 second' WHERE reserved_by_order = $1`, [order.id]);
  const expired = await waitStatus(order.id, ['expired'], 10000);

  // Освободившийся ключ забирает другой покупатель, склад снова пуст.
  const { body: rival } = await post('/api/orders', { sku });
  await post('/webhook/payment', paid(rival.id, rival.amount));
  await waitStatus(rival.id, ['delivered'], 15000);

  // И только теперь приходит опоздавший платёж по первому заказу.
  await post('/webhook/payment', paid(order.id, order.amount));
  const stuck = await waitStatus(order.id, ['out_of_stock'], 10000);

  const lateCode = `RACE-LATE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  await post(`/api/admin/stock/${sku}/restock`, { codes: [lateCode] });
  const recovered = await waitStatus(order.id, ['delivered'], 15000);
  const keys = await db.query('SELECT count(*)::int AS n FROM stock_keys WHERE order_id = $1', [order.id]);

  check('опоздавший платёж не теряется: восстановимое состояние и выдача после завоза',
    expired.status === 'expired' && stuck.status === 'out_of_stock'
      && recovered.status === 'delivered' && keys.rows[0].n === 1,
    { expired: expired.status, stuck: stuck.status, recovered: recovered.status });
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

// 6. Один код не может уйти в два товара, а значит и в два заказа.
{
  const code = `RACE-DUP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const first = await post('/api/admin/stock/KEY-CS2-PRIME/restock', { codes: [code] });
  const second = await post('/api/admin/stock/KEY-GTA5/restock', { codes: [code] });
  const { rows } = await db.query('SELECT count(*)::int AS n FROM stock_keys WHERE code = $1', [code]);

  check('один код нельзя завезти в два товара',
    first.body.added === 1 && second.body.added === 0 && rows[0].n === 1,
    { first_added: first.body.added, second_added: second.body.added, rows: rows[0].n });
}

// 7. Лимит промокода не обходится через неуспешную оплату.
{
  await db.query(`UPDATE promocodes SET used_count = 0 WHERE code = 'ONCEONLY'`);
  await db.query(`DELETE FROM promocode_uses WHERE code = 'ONCEONLY'`);

  const { body: first } = await post('/api/orders', { sku: 'KEY-GTA5', promocode: 'ONCEONLY' });
  await post('/webhook/payment', { ...paid(first.id, first.amount), status: 'failed' });
  const { body: second } = await post('/api/orders', { sku: 'KEY-GTA5', promocode: 'ONCEONLY' });
  const { rows } = await db.query(`SELECT used_count FROM promocodes WHERE code = 'ONCEONLY'`);

  check('неуспешная оплата не освобождает одноразовый промокод',
    first.promocode === 'ONCEONLY' && second.promocode === null && rows[0].used_count === 1,
    { first: first.promocode, second: second.promocode, used_count: rows[0].used_count });
}

// 8. Деньги: без суммы или в чужой валюте товар не уходит.
{
  const { body: order } = await post('/api/orders', { sku: 'KEY-CS2-PRIME' });
  const noAmount = await post('/webhook/payment', {
    event_id: `race_noamt_${order.id}`, order_id: order.id, status: 'paid',
    currency: 'RUB', created_at: new Date().toISOString(),
  });
  const wrongCurrency = await post('/webhook/payment', {
    event_id: `race_cur_${order.id}`, order_id: order.id, status: 'paid',
    amount: order.amount, currency: 'USD', created_at: new Date().toISOString(),
  });
  const { body: after } = await get(`/api/orders/${order.id}`);

  check('оплата без суммы отклоняется, оплата в чужой валюте не выдаёт ключ',
    noAmount.status === 400 && wrongCurrency.body.outcome === 'currency_mismatch' && after.status === 'created',
    { no_amount_http: noAmount.status, wrong_currency: wrongCurrency.body.outcome, order_status: after.status });
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
