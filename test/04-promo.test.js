import './env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, resetData, api, waitFor, paidEvent, pool } from './helpers.js';

let stack, http;
before(async () => { stack = await startStack(); http = api(stack.base); });
after(async () => { await stack.stop(); await pool.end(); });
beforeEach(async () => { await resetData({ keysPerSku: 30 }); });

test('скидку считает сервер, данным клиента не доверяем', async () => {
  // Клиент присылает собственную сумму и собственную скидку: сервер обязан их игнорировать.
  const { body: order } = await http.post('/api/orders', {
    sku: 'STEAM-TOPUP-500', promocode: 'WELCOME10',
    amount: 1, discount: 499, base_amount: 1,
  });

  assert.equal(order.base_amount, 500);
  assert.equal(order.discount, 50, '10 процентов от 500');
  assert.equal(order.amount, 450);
  assert.equal(order.promocode, 'WELCOME10');
});

test('скидка в рублях не уводит сумму ниже нуля', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'STEAM-TOPUP-500', promocode: 'GG500' });
  assert.equal(order.discount, 500);
  assert.equal(order.amount, 0);
});

test('несуществующий промокод не ломает заказ, цена остаётся полной', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME', promocode: 'NOPE-123' });
  assert.equal(order.amount, 1290);
  assert.equal(order.promocode, null);
  assert.equal(order.promo_rejected, true);
});

test('лимит промокода соблюдается под параллельными запросами', async () => {
  // LIMIT3: три использования. Бьём двадцатью одновременными заказами.
  const results = await Promise.all(
    Array.from({ length: 20 }, () => http.post('/api/orders', { sku: 'KEY-CS2-PRIME', promocode: 'LIMIT3' })),
  );

  const withPromo = results.filter((r) => r.body.promocode === 'LIMIT3');
  assert.equal(withPromo.length, 3, 'промокод применён ровно три раза');
  assert.ok(results.every((r) => r.status === 201), 'остальные заказы всё равно созданы, но по полной цене');

  const { rows } = await pool.query(`SELECT used_count, max_uses FROM promocodes WHERE code = 'LIMIT3'`);
  assert.equal(rows[0].used_count, 3);
  assert.ok(rows[0].used_count <= rows[0].max_uses);

  const uses = await pool.query(`SELECT count(*)::int AS n FROM promocode_uses WHERE code = 'LIMIT3'`);
  assert.equal(uses.rows[0].n, 3);

  for (const r of withPromo) assert.equal(r.body.amount, 1290 - Math.floor(1290 * 0.25));
});

test('одноразовый промокод под гонкой достаётся ровно одному заказу', async () => {
  const results = await Promise.all(
    Array.from({ length: 30 }, () => http.post('/api/orders', { sku: 'KEY-GTA5', promocode: 'ONCEONLY' })),
  );
  assert.equal(results.filter((r) => r.body.promocode === 'ONCEONLY').length, 1);

  const { rows } = await pool.query(`SELECT used_count FROM promocodes WHERE code = 'ONCEONLY'`);
  assert.equal(rows[0].used_count, 1);
});

test('исчерпанный промокод в предпросмотре показывается честно', async () => {
  await Promise.all(Array.from({ length: 3 }, () => http.post('/api/orders', { sku: 'KEY-CS2-PRIME', promocode: 'LIMIT3' })));
  const { body } = await http.post('/api/promo/quote', { code: 'LIMIT3', sku: 'KEY-CS2-PRIME' });
  assert.equal(body.applied, false);
  assert.equal(body.reason, 'limit_reached');
});

test('неудачная оплата возвращает использование промокода в лимит', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME', promocode: 'ONCEONLY' });
  assert.equal(order.promocode, 'ONCEONLY');

  await http.post('/webhook/payment', { ...paidEvent(order.id, order.amount), status: 'failed' });

  const { rows } = await pool.query(`SELECT used_count FROM promocodes WHERE code = 'ONCEONLY'`);
  assert.equal(rows[0].used_count, 0, 'код снова доступен');

  const { body: next } = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME', promocode: 'ONCEONLY' });
  assert.equal(next.promocode, 'ONCEONLY');
});

test('оплата со скидкой сходится в журнале денег', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME', promocode: 'WELCOME10' });
  await http.post('/webhook/payment', paidEvent(order.id, order.amount));

  await waitFor(async () => {
    const { body } = await http.get(`/api/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  });

  const { rows } = await pool.query(
    `SELECT SUM(amount_minor) FILTER (WHERE direction = 'debit')::bigint AS d,
            SUM(amount_minor) FILTER (WHERE direction = 'credit')::bigint AS c
       FROM ledger_entries WHERE order_id = $1`, [order.id]);
  assert.equal(Number(rows[0].d), Number(rows[0].c));
  assert.equal(Number(rows[0].d), order.amount * 2, 'проводки идут на сумму СО скидкой');
});
