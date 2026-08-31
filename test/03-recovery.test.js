import './env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, resetData, api, waitFor, paidEvent, pool } from './helpers.js';

let stack, http;

// Здесь нужен живой воркер: проверяем автоматическое восстановление.
before(async () => { stack = await startStack({ worker: true, workerIntervalMs: 120 }); http = api(stack.base); });
after(async () => { await stack.stop(); await pool.end(); });
beforeEach(async () => { await resetData({ keysPerSku: 0 }); });

test('пул пуст: заказ оплачен, ключа нет -> восстановимое состояние без падения', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME' });
  const hook = await http.post('/webhook/payment', paidEvent(order.id, order.amount));
  assert.equal(hook.status, 200, 'платёж принят и не потерян');

  const stuck = await waitFor(async () => {
    const { body } = await http.get(`/api/orders/${order.id}`);
    return body.status === 'out_of_stock' ? body : null;
  });
  assert.ok(stuck, 'заказ уходит в out_of_stock, а не в ошибку');
  assert.ok(stuck.paid_at);
  assert.equal(stuck.delivery, null);

  const { body: report } = await http.get('/api/admin/reconciliation');
  assert.ok(report.paid_not_delivered.items.some((o) => o.id === order.id), 'виден в админке');
  assert.equal(report.delivered_not_paid.count, 0);
  assert.equal(report.ledger.balanced, true);
});

test('после пополнения пула заказ доводится автоматически, ровно одним ключом', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME' });
  await http.post('/webhook/payment', paidEvent(order.id, order.amount));

  await waitFor(async () => {
    const { body } = await http.get(`/api/orders/${order.id}`);
    return body.status === 'out_of_stock' ? body : null;
  });

  const restock = await http.post('/api/admin/stock/KEY-CS2-PRIME/restock', { codes: ['NEW-0001', 'NEW-0002'] });
  assert.equal(restock.body.added, 2);

  const delivered = await waitFor(async () => {
    const { body } = await http.get(`/api/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  }, { timeoutMs: 10000 });

  assert.ok(delivered, 'фоновая задача обязана добить заказ');
  assert.equal(delivered.delivery.code, 'NEW-0001');

  const used = await pool.query('SELECT count(*)::int AS n FROM stock_keys WHERE order_id IS NOT NULL');
  assert.equal(used.rows[0].n, 1, 'израсходован ровно один ключ');

  const { body: report } = await http.get('/api/admin/reconciliation');
  assert.equal(report.healthy, true);
  assert.equal(report.paid_not_delivered.count, 0);
});

test('ручная повторная выдача идемпотентна', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-GTA5' });
  await http.post('/webhook/payment', paidEvent(order.id, order.amount));
  await waitFor(async () => {
    const { body } = await http.get(`/api/orders/${order.id}`);
    return body.status === 'out_of_stock' ? body : null;
  });

  await http.post('/api/admin/stock/KEY-GTA5/restock', { codes: ['MANUAL-0001'] });

  const results = await Promise.all(
    Array.from({ length: 5 }, () => http.post(`/api/admin/orders/${order.id}/deliver`, {})),
  );
  assert.ok(results.every((r) => r.status === 200), 'все пять нажатий отвечают 200');
  const codes = results.map((r) => r.body.order.delivery?.code);
  assert.ok(codes.every(Boolean), 'в каждом ответе есть выданный код');
  assert.equal(new Set(codes).size, 1, 'пять нажатий "Выдать" дают один и тот же код');
  assert.equal(codes[0], 'MANUAL-0001');

  const used = await pool.query('SELECT count(*)::int AS n FROM stock_keys WHERE order_id IS NOT NULL');
  assert.equal(used.rows[0].n, 1);
});

test('пять заказов на два ключа: выдано ровно два, остальные ждут завоза', async () => {
  await http.post('/api/admin/stock/KEY-CS2-PRIME/restock', { codes: ['PAIR-1', 'PAIR-2'] });

  const orders = await Promise.all(
    Array.from({ length: 5 }, () => http.post('/api/orders', { sku: 'KEY-CS2-PRIME' }).then((r) => r.body)),
  );
  await Promise.all(orders.map((o) => http.post('/webhook/payment', paidEvent(o.id, o.amount))));

  await waitFor(async () => {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM stock_keys WHERE order_id IS NOT NULL');
    return rows[0].n === 2 ? rows[0] : null;
  }, { timeoutMs: 10000 });
  await new Promise((r) => setTimeout(r, 600));   // даём воркеру шанс ошибиться

  const used = await pool.query('SELECT count(*)::int AS n FROM stock_keys WHERE order_id IS NOT NULL');
  assert.equal(used.rows[0].n, 2);

  const waiting = await pool.query(
    `SELECT count(*)::int AS n FROM orders WHERE status IN ('out_of_stock', 'delivering', 'delivery_failed')`);
  assert.equal(waiting.rows[0].n, 3, 'остальные в восстановимом состоянии');

  const { body: report } = await http.get('/api/admin/reconciliation');
  assert.equal(report.ledger.balanced, true);
});
