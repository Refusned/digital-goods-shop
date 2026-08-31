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

test('админка закрыта без токена', async () => {
  const res = await fetch(`${stack.base}/api/admin/reconciliation`);
  assert.equal(res.status, 401);
});
