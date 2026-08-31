import './env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, resetData, api, waitFor, paidEvent, pool } from './helpers.js';

let stack, http;
before(async () => { stack = await startStack(); http = api(stack.base); });
after(async () => { await stack.stop(); await pool.end(); });
beforeEach(async () => { await resetData({ keysPerSku: 30 }); });

test('50 параллельных вебхуков по одному заказу -> один факт выдачи, один израсходованный ключ', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME' });

  const responses = await Promise.all(
    Array.from({ length: 50 }, () => http.post('/webhook/payment', paidEvent(order.id, order.amount))),
  );
  assert.ok(responses.every((r) => r.status === 200), 'все вебхуки приняты');

  const delivered = await waitFor(async () => {
    const { body } = await http.get(`/api/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  });
  assert.ok(delivered, 'заказ обязан быть выдан, без потери');

  const keys = await pool.query('SELECT count(*)::int AS n FROM stock_keys WHERE order_id = $1', [order.id]);
  assert.equal(keys.rows[0].n, 1, 'ключ выдан ровно один');

  const used = await pool.query('SELECT count(*)::int AS n FROM stock_keys WHERE order_id IS NOT NULL');
  assert.equal(used.rows[0].n, 1, 'из пула ушёл ровно один ключ');

  const applied = await pool.query(
    `SELECT count(*)::int AS n FROM payment_events WHERE order_id = $1 AND outcome = 'applied'`, [order.id]);
  assert.equal(applied.rows[0].n, 1, 'деньги применены один раз');
});

test('двойной клик "Купить" плюс двойной вебхук -> один заказ и один ключ', async () => {
  const key = `idem_${Math.random().toString(36).slice(2)}`;
  const [a, b] = await Promise.all([
    http.post('/api/orders', { sku: 'KEY-GTA5' }, { 'Idempotency-Key': key }),
    http.post('/api/orders', { sku: 'KEY-GTA5' }, { 'Idempotency-Key': key }),
  ]);
  const orderId = a.body.id;
  assert.equal(b.body.id, orderId);

  const event = paidEvent(orderId, a.body.amount);
  await Promise.all([http.post('/webhook/payment', event), http.post('/webhook/payment', event)]);

  await waitFor(async () => {
    const { body } = await http.get(`/api/orders/${orderId}`);
    return body.status === 'delivered' ? body : null;
  });

  const orders = await pool.query('SELECT count(*)::int AS n FROM orders');
  const keys = await pool.query('SELECT count(*)::int AS n FROM stock_keys WHERE order_id IS NOT NULL');
  assert.equal(orders.rows[0].n, 1);
  assert.equal(keys.rows[0].n, 1);
});

test('повторный вебхук с тем же event_id ничего не меняет', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME' });
  const event = paidEvent(order.id, order.amount);

  const first = await http.post('/webhook/payment', event);
  assert.equal(first.body.outcome, 'applied');

  const repeats = await Promise.all(Array.from({ length: 20 }, () => http.post('/webhook/payment', event)));
  assert.ok(repeats.every((r) => r.body.outcome === 'duplicate'));

  await waitFor(async () => {
    const { body } = await http.get(`/api/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  });

  const events = await pool.query('SELECT count(*)::int AS n FROM payment_events WHERE event_id = $1', [event.event_id]);
  const keys = await pool.query('SELECT count(*)::int AS n FROM stock_keys WHERE order_id = $1', [order.id]);
  assert.equal(events.rows[0].n, 1);
  assert.equal(keys.rows[0].n, 1);
});

test('вебхук пришёл раньше заказа -> платёж не потерян, заказ доезжает до выданного', async () => {
  const orderId = `ord_pre_${Math.random().toString(36).slice(2, 8)}`;

  const early = await http.post('/webhook/payment', paidEvent(orderId, 1290));
  assert.equal(early.status, 200);
  assert.equal(early.body.outcome, 'pending_order');

  const report = await http.get('/api/admin/reconciliation');
  assert.ok(report.body.payment_events_without_order.items.some((e) => e.order_id === orderId),
    'платёж без заказа виден в сверке');

  await http.post('/api/orders', { sku: 'KEY-CS2-PRIME', order_id: orderId });

  const delivered = await waitFor(async () => {
    const { body } = await http.get(`/api/orders/${orderId}`);
    return body.status === 'delivered' ? body : null;
  });
  assert.ok(delivered);

  const keys = await pool.query('SELECT count(*)::int AS n FROM stock_keys WHERE order_id = $1', [orderId]);
  assert.equal(keys.rows[0].n, 1);
});

test('вебхуки не по порядку: устаревший failed не отменяет оплаченный заказ', async () => {
  const orderId = `ord_ooo_${Math.random().toString(36).slice(2, 8)}`;
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME', order_id: orderId });

  const now = new Date();
  await http.post('/webhook/payment', paidEvent(orderId, order.amount, { created_at: now.toISOString() }));
  const stale = await http.post('/webhook/payment', {
    ...paidEvent(orderId, order.amount, { created_at: new Date(now.getTime() - 60_000).toISOString() }),
    status: 'failed',
  });
  assert.equal(stale.body.outcome, 'stale');

  const delivered = await waitFor(async () => {
    const { body } = await http.get(`/api/orders/${orderId}`);
    return body.status === 'delivered' ? body : null;
  });
  assert.ok(delivered);
});

test('20 заказов параллельно: каждый получает свой ключ, ни один код не повторяется', async () => {
  const orders = await Promise.all(
    Array.from({ length: 20 }, () => http.post('/api/orders', { sku: 'KEY-CS2-PRIME' }).then((r) => r.body)),
  );
  await Promise.all(orders.map((o) => http.post('/webhook/payment', paidEvent(o.id, o.amount))));

  for (const o of orders) {
    const delivered = await waitFor(async () => {
      const { body } = await http.get(`/api/orders/${o.id}`);
      return body.status === 'delivered' ? body : null;
    });
    assert.ok(delivered, `заказ ${o.id} должен быть выдан`);
  }

  const dupes = await pool.query(
    'SELECT code FROM stock_keys WHERE order_id IS NOT NULL GROUP BY code HAVING count(*) > 1');
  assert.equal(dupes.rowCount, 0, 'один ключ не может уйти в два заказа');

  const used = await pool.query('SELECT count(*)::int AS n FROM stock_keys WHERE order_id IS NOT NULL');
  assert.equal(used.rows[0].n, 20);
});
