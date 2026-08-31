import './env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, resetData, api, waitFor, paidEvent, pool } from './helpers.js';

let stack, http;
before(async () => { stack = await startStack(); http = api(stack.base); });
after(async () => { await stack.stop(); await pool.end(); });
beforeEach(async () => { await resetData(); });

test('витрина отдаёт товары с остатком и ценой', async () => {
  const { body } = await http.get('/api/catalog');
  assert.ok(body.items.length >= 3);
  const cs2 = body.items.find((i) => i.sku === 'KEY-CS2-PRIME');
  assert.equal(cs2.price, 1290);
  assert.equal(cs2.available, 5);
});

test('заказ создаётся и доходит до выданного ключа после оплаты', async () => {
  const created = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME' });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'created');
  assert.equal(created.body.amount, 1290);

  const pay = await http.post(`/api/orders/${created.body.id}/simulate-payment`, { success: true });
  assert.equal(pay.status, 200);

  const delivered = await waitFor(async () => {
    const { body } = await http.get(`/api/orders/${created.body.id}`);
    return body.status === 'delivered' ? body : null;
  });
  assert.ok(delivered, 'заказ должен дойти до delivered');
  assert.match(delivered.delivery.code, /^KEY-CS2-PRIME-KEY-\d{4}$/);
});

test('неуспешная оплата не выдаёт ключ', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-GTA5' });
  await http.post(`/api/orders/${order.id}/simulate-payment`, { success: false });

  const { body } = await http.get(`/api/orders/${order.id}`);
  assert.equal(body.status, 'payment_failed');
  assert.equal(body.delivery, null);

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM stock_keys WHERE order_id = $1', [order.id]);
  assert.equal(rows[0].n, 0);
});

test('двойной клик "Купить" с одним Idempotency-Key даёт один заказ', async () => {
  const key = `idem_${Math.random().toString(36).slice(2)}`;
  const [a, b] = await Promise.all([
    http.post('/api/orders', { sku: 'KEY-CS2-PRIME' }, { 'Idempotency-Key': key }),
    http.post('/api/orders', { sku: 'KEY-CS2-PRIME' }, { 'Idempotency-Key': key }),
  ]);
  assert.equal(a.body.id, b.body.id);

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders');
  assert.equal(rows[0].n, 1);
});

test('несуществующий товар -> 404', async () => {
  const res = await http.post('/api/orders', { sku: 'NOPE' });
  assert.equal(res.status, 404);
});

test('битый вебхук -> 400', async () => {
  const res = await http.post('/webhook/payment', { order_id: 'x', status: 'paid' });
  assert.equal(res.status, 400);
});

test('оплата без суммы, без валюты или с мусорной суммой отклоняется с 400', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME' });
  const base = { order_id: order.id, status: 'paid', created_at: new Date().toISOString() };

  const noAmount = await http.post('/webhook/payment', { ...base, event_id: 'e1_' + order.id, currency: 'RUB' });
  const noCurrency = await http.post('/webhook/payment', { ...base, event_id: 'e2_' + order.id, amount: order.amount });
  const badAmount = await http.post('/webhook/payment', { ...base, event_id: 'e3_' + order.id, amount: 'not-a-number', currency: 'RUB' });
  const noDate = await http.post('/webhook/payment', { event_id: 'e4_' + order.id, order_id: order.id, status: 'paid', amount: order.amount, currency: 'RUB' });

  for (const res of [noAmount, noCurrency, badAmount, noDate]) assert.equal(res.status, 400);

  const { body } = await http.get(`/api/orders/${order.id}`);
  assert.equal(body.status, 'created');
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM payment_events WHERE order_id = $1', [order.id]);
  assert.equal(rows[0].n, 0, 'битые события в журнал не попадают');
});

test('оплата в чужой валюте не выдаёт ключ', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME' });
  const res = await http.post('/webhook/payment', { ...paidEvent(order.id, order.amount), currency: 'USD' });
  assert.equal(res.body.outcome, 'currency_mismatch');

  const { body } = await http.get(`/api/orders/${order.id}`);
  assert.equal(body.status, 'created');
  assert.equal(body.delivery, null);
});

test('один и тот же код не может лежать в двух товарах', async () => {
  const code = `DUP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const first = await http.post('/api/admin/stock/KEY-CS2-PRIME/restock', { codes: [code] });
  assert.equal(first.body.added, 1);

  const second = await http.post('/api/admin/stock/KEY-GTA5/restock', { codes: [code] });
  assert.equal(second.body.added, 0, 'тот же код во втором товаре завозить нельзя');
  assert.deepEqual(second.body.rejected, [code]);

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM stock_keys WHERE code = $1', [code]);
  assert.equal(rows[0].n, 1);
});

test('тот же Idempotency-Key с другими параметрами -> 409, а не чужой заказ', async () => {
  const key = `idem_${Math.random().toString(36).slice(2)}`;
  const first = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME' }, { 'Idempotency-Key': key });
  assert.equal(first.status, 201);

  const conflicting = await http.post('/api/orders', { sku: 'KEY-GTA5' }, { 'Idempotency-Key': key });
  assert.equal(conflicting.status, 409);
  assert.equal(conflicting.body.error, 'idempotency_conflict');

  const same = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME' }, { 'Idempotency-Key': key });
  assert.equal(same.body.id, first.body.id, 'повтор того же запроса по-прежнему возвращает тот же заказ');
});

test('админка закрыта без токена', async () => {
  const res = await fetch(`${stack.base}/api/admin/reconciliation`);
  assert.equal(res.status, 401);
});
