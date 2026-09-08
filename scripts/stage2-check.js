/**
 * Сценарии приёмки ВТОРОГО этапа против ЖИВОГО сервера.
 *
 *   npm start                                  # в одном терминале
 *   ALLOW_DESTRUCTIVE_RACE=1 npm run stage2    # в другом
 *
 * Проверяет ровно то, что просит задание:
 *   1. живое обновление витрины: цена и наличие доезжают без перезагрузки;
 *   2. покупка последней единицы наперегонки: один победитель, один понятный отказ;
 *   3. бронь с таймером: держит товар, истекает, возвращает товар в продажу;
 *   4. устойчивость покупки: двойной клик и повторы не создают второго заказа и платежа;
 *   5. мгновенный поиск по большому каталогу.
 */
import pg from 'pg';

const base = process.env.API_URL || `http://127.0.0.1:${process.env.PORT || 3020}`;
const dbUrl = process.env.DATABASE_URL || 'postgres://shop:shop@localhost:5443/shop';

if (process.env.ALLOW_DESTRUCTIVE_RACE !== '1') {
  process.stderr.write(
    'npm run stage2 меняет данные: создаёт заказы, расходует ключи и трогает наличие.\n' +
    'Запускайте на демонстрационной базе и подтвердите намерение:\n' +
    '  ALLOW_DESTRUCTIVE_RACE=1 npm run stage2\n',
  );
  process.exit(2);
}

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();

const post = (path, body, headers = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Admin-Token': process.env.ADMIN_TOKEN || 'admin-token', ...headers },
    body: JSON.stringify(body ?? {}),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (path) => fetch(base + path).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(name, ok, detail) {
  process.stdout.write(`${ok ? 'OK  ' : 'FAIL'}  ${name}\n`);
  if (!ok) {
    failed += 1;
    process.stdout.write(`      ${JSON.stringify(detail)}\n`);
  }
}

async function waitOrder(orderId, statuses, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const { body } = await get(`/api/orders/${orderId}`);
    if (statuses.includes(body.status)) return body;
    await sleep(150);
  }
  return null;
}

/** Подписка на живой канал так же, как это делает браузер. */
async function openStream() {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/stream`, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const type = chunk.match(/^event: (.+)$/m)?.[1];
          const data = chunk.match(/^data: (.+)$/m)?.[1];
          if (type && data) events.push({ type, data: JSON.parse(data) });
        }
      }
    } catch { /* поток закрыт */ }
  })();
  return { events, close: () => controller.abort() };
}

const waitEvent = async (stream, predicate, timeoutMs = 8000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const found = stream.events.filter((e) => e.type === 'products').flatMap((e) => e.data).find(predicate);
    if (found) return found;
    await sleep(100);
  }
  return null;
};

// Готовим товар, на котором будем гонять сценарии: ровно один свободный ключ.
const probeSku = `STAGE2-${Date.now()}`;
await db.query(
  `INSERT INTO products (sku, name, type, price_minor, old_price_minor, currency, image, section, popularity)
   VALUES ($1, 'Проверочный товар второго этапа', 'key', 1500, 2000, 'RUB', 'assets/product-cs2.webp', 'popular', 1)`,
  [probeSku],
);
await post(`/api/admin/stock/${probeSku}/restock`, { codes: [`${probeSku}-KEY-1`] });

// --- 1. Живое обновление витрины ----------------------------------------------
{
  const first = await openStream();
  const second = await openStream();
  await sleep(300);

  await db.query('UPDATE products SET price_minor = 1777 WHERE sku = $1', [probeSku]);

  const seenByFirst = await waitEvent(first, (p) => p.sku === probeSku && p.price === 1777);
  const seenBySecond = await waitEvent(second, (p) => p.sku === probeSku && p.price === 1777);

  check('цена доезжает до всех открытых вкладок без перезагрузки',
    Boolean(seenByFirst && seenBySecond), { first: seenByFirst, second: seenBySecond });

  check('живое событие не расходится с обычным ответом каталога',
    (await get(`/api/search?q=${probeSku}&limit=1`)).body.items[0]?.price === 1777);

  first.close();
  second.close();
}

// --- 2. Покупка последней единицы наперегонки ---------------------------------
let winner = null;
{
  const stream = await openStream();
  await sleep(200);

  const attempts = await Promise.all(
    Array.from({ length: 5 }, () => post('/api/orders', { sku: probeSku })),
  );
  const created = attempts.filter((r) => r.status === 201);
  const refused = attempts.filter((r) => r.status === 409 && r.body.error === 'sold_out');
  winner = created[0]?.body ?? null;

  check('последнюю единицу получает ровно один покупатель',
    created.length === 1, { created: created.length, refused: refused.length });
  check('остальные получают понятный отказ до оплаты, без списания',
    refused.length === 4 && /раскупили/i.test(refused[0]?.body.message ?? ''),
    refused.map((r) => r.body));

  const gone = await waitEvent(stream, (p) => p.sku === probeSku && p.available === 0);
  check('товар гаснет у всех сразу', Boolean(gone), gone);
  stream.close();

  const orphanPaid = await db.query(
    `SELECT count(*)::int AS n FROM orders o LEFT JOIN stock_keys k ON k.order_id = o.id
      WHERE o.paid_at IS NOT NULL AND k.id IS NULL AND o.status NOT IN ('out_of_stock', 'delivery_failed')`);
  check('ни у кого нет оплаченного заказа без товара', orphanPaid.rows[0].n === 0, orphanPaid.rows[0]);
}

// --- 3. Бронь с таймером -------------------------------------------------------
{
  check('заказ отдаёт срок брони и остаток времени',
    Boolean(winner?.reserved_until) && winner.reservation_seconds_left > 0,
    { reserved_until: winner?.reserved_until, left: winner?.reservation_seconds_left });

  // Не ждём полный срок брони: сдвигаем её конец, как если бы время уже вышло.
  await db.query(
    `UPDATE orders SET reserved_until = now() - interval '1 second' WHERE id = $1`, [winner.id]);
  await db.query(
    `UPDATE stock_keys SET reserved_until = now() - interval '1 second' WHERE reserved_by_order = $1`, [winner.id]);

  const expired = await waitOrder(winner.id, ['expired']);
  check('по истечении отсчёта бронь снимается', expired?.status === 'expired', expired?.status);

  const back = await get(`/api/search?q=${probeSku}&limit=1`);
  check('товар вернулся в продажу для всех', back.body.items[0]?.available === 1, back.body.items[0]);

  const next = await post('/api/orders', { sku: probeSku });
  check('следующий покупатель спокойно оформляет заказ', next.status === 201, next.body);

  const paid = await post(`/api/orders/${next.body.id}/simulate-payment`, { success: true },
    { 'Idempotency-Key': `stage2-pay-${next.body.id}` });
  check('оплата вовремя уводит заказ в выдачу', paid.status === 200, paid.body?.error);

  const delivered = await waitOrder(next.body.id, ['delivered']);
  check('код выдан, и отсчёт больше ни на что не влияет',
    delivered?.status === 'delivered' && Boolean(delivered.delivery?.code) && delivered.reservation_seconds_left === null,
    { status: delivered?.status, left: delivered?.reservation_seconds_left });

  winner = delivered;
}

// --- 4. Устойчивость покупки ---------------------------------------------------
{
  await post(`/api/admin/stock/${probeSku}/restock`, { codes: [`${probeSku}-KEY-2`] });

  const key = `stage2-double-${Date.now()}`;
  const [a, b] = await Promise.all([
    post('/api/orders', { sku: probeSku }, { 'Idempotency-Key': key }),
    post('/api/orders', { sku: probeSku }, { 'Idempotency-Key': key }),
  ]);
  check('двойной клик по «Купить» даёт один заказ', a.body.id === b.body.id, { a: a.body.id, b: b.body.id });

  const payKey = `stage2-pay-double-${a.body.id}`;
  await Promise.all([
    post(`/api/orders/${a.body.id}/simulate-payment`, { success: true }, { 'Idempotency-Key': payKey }),
    post(`/api/orders/${a.body.id}/simulate-payment`, { success: true }, { 'Idempotency-Key': payKey }),
  ]);
  const done = await waitOrder(a.body.id, ['delivered']);
  check('двойной клик по «Оплатить» не задваивает платёж', done?.status === 'delivered', done?.status);

  const events = await db.query('SELECT count(*)::int AS n FROM payment_events WHERE order_id = $1', [a.body.id]);
  check('событие оплаты ровно одно', events.rows[0].n === 1, events.rows[0]);

  // Повторная оплата уже оплаченного заказа: ничего не меняется.
  const again = await post(`/api/orders/${a.body.id}/simulate-payment`, { success: true },
    { 'Idempotency-Key': payKey });
  const after = await get(`/api/orders/${a.body.id}`);
  check('повторная оплата оплаченного заказа ничего не меняет',
    again.status === 200 && after.body.delivery.code === done.delivery.code,
    { status: again.status });

  const keys = await db.query('SELECT count(*)::int AS n FROM stock_keys WHERE order_id = $1', [a.body.id]);
  check('заказ получил ровно один ключ', keys.rows[0].n === 1, keys.rows[0]);
}

// --- 5. Мгновенный поиск -------------------------------------------------------
{
  const { body: size } = await get('/api/search?limit=1');
  const queries = ['steam', 'подписка', 'tarkov', 'ключ'];
  const timings = [];
  for (const q of queries) {
    const started = Date.now();
    const res = await get(`/api/search?q=${encodeURIComponent(q)}&limit=24`);
    timings.push({ q, ms: Date.now() - started, found: res.body.items.length });
  }
  check('поиск отвечает быстро на каждом запросе', timings.every((t) => t.ms < 400), timings);
  check('каталог действительно большой', (size.total ?? 0) >= 1000 || size.total_capped === true,
    { total: size.total, capped: size.total_capped });

  const first = await get('/api/search?sort=price_asc&limit=20');
  const second = await get(`/api/search?sort=price_asc&limit=20&cursor=${encodeURIComponent(first.body.next_cursor)}`);
  const overlap = first.body.items.filter((i) => second.body.items.some((j) => j.sku === i.sku));
  check('листание курсором не повторяет товары', overlap.length === 0, overlap.map((i) => i.sku));

  const filtered = await get('/api/search?q=steam&type=topup&in_stock=1&sort=price_desc&limit=10');
  check('фильтры из адреса страницы применяются целиком',
    filtered.body.items.every((i) => i.type === 'topup' && i.available > 0),
    filtered.body.items.slice(0, 3));
}

// --- Уборка стенда -------------------------------------------------------------
await db.query('DELETE FROM stock_keys WHERE sku = $1', [probeSku]);
await db.query('DELETE FROM orders WHERE sku = $1', [probeSku]);
await db.query('DELETE FROM product_stock WHERE sku = $1', [probeSku]);
await db.query('DELETE FROM products WHERE sku = $1', [probeSku]);

await db.end();
process.stdout.write(failed === 0 ? '\nвсе сценарии второго этапа пройдены\n' : `\nпровалено сценариев: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
