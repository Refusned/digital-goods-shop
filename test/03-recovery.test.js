/**
 * Восстановление после сбоев.
 *
 * Во втором этапе ключ бронируется в момент оформления, поэтому «оплачено, а выдать нечем»
 * больше не возникает из пустого пула: заказ на отсутствующий товар просто не создаётся.
 * Зато такое состояние достижимо честным путём: бронь истекла, ключ забрал другой покупатель,
 * и ровно тогда пришёл опоздавший платёж. Эти сценарии и проверяются.
 */

import './env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, resetData, api, waitFor, paidEvent, pool, sleep, config } from './helpers.js';

let stack, http;

// Здесь нужен живой воркер: проверяем автоматическое восстановление.
before(async () => { stack = await startStack({ worker: true, workerIntervalMs: 120 }); http = api(stack.base); });
after(async () => { await stack.stop(); await pool.end(); });
beforeEach(async () => { await resetData({ keysPerSku: 1 }); });

/**
 * Заказ, оставшийся без ключа: бронь истекла, единственный ключ ушёл другому покупателю.
 * После этого приходит опоздавший платёж, и заказ обязан остаться восстановимым,
 * а не потерять деньги покупателя.
 */
async function orderThatLostItsKey(sku) {
  const { body: order } = await http.post('/api/orders', { sku });

  // Ждём, пока бронь истечёт и товар вернётся в продажу.
  await waitFor(async () => {
    const { body } = await http.get(`/api/orders/${order.id}`);
    return body.status === 'expired' ? body : null;
  }, { timeoutMs: 10000 });

  // Ключ забирает следующий покупатель.
  const { body: rival, status } = await http.post('/api/orders', { sku });
  assert.equal(status, 201, 'освободившийся ключ достаётся следующему');
  await http.post('/webhook/payment', paidEvent(rival.id, rival.amount));
  await waitFor(async () => {
    const { body } = await http.get(`/api/orders/${rival.id}`);
    return body.status === 'delivered' ? body : null;
  }, { timeoutMs: 10000 });

  // И только теперь доезжает платёж по первому заказу.
  const hook = await http.post('/webhook/payment', paidEvent(order.id, order.amount));
  assert.equal(hook.status, 200, 'платёж принят и не потерян');
  return order;
}

test('оплата пришла, а ключа уже нет -> восстановимое состояние без падения', async () => {
  const order = await orderThatLostItsKey('KEY-CS2-PRIME');

  const stuck = await waitFor(async () => {
    const { body } = await http.get(`/api/orders/${order.id}`);
    return body.status === 'out_of_stock' ? body : null;
  }, { timeoutMs: 10000 });

  assert.ok(stuck, 'заказ уходит в out_of_stock, а не в ошибку');
  assert.ok(stuck.paid_at);
  assert.equal(stuck.delivery, null);

  const { body: report } = await http.get('/api/admin/reconciliation');
  assert.ok(report.paid_not_delivered.items.some((o) => o.id === order.id), 'виден в админке');
  assert.equal(report.delivered_not_paid.count, 0);
  assert.equal(report.ledger.balanced, true);
});

test('после пополнения пула заказ доводится автоматически, ровно одним ключом', async () => {
  const order = await orderThatLostItsKey('KEY-CS2-PRIME');
  await waitFor(async () => {
    const { body } = await http.get(`/api/orders/${order.id}`);
    return body.status === 'out_of_stock' ? body : null;
  }, { timeoutMs: 10000 });

  const restock = await http.post('/api/admin/stock/KEY-CS2-PRIME/restock', { codes: ['NEW-0001', 'NEW-0002'] });
  assert.equal(restock.body.added, 2);

  const delivered = await waitFor(async () => {
    const { body } = await http.get(`/api/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  }, { timeoutMs: 10000 });

  assert.ok(delivered, 'фоновая задача обязана добить заказ');
  assert.equal(delivered.delivery.code, 'NEW-0001');

  const free = await pool.query(
    `SELECT count(*)::int AS n FROM stock_keys WHERE sku = 'KEY-CS2-PRIME' AND order_id IS NULL`);
  assert.equal(free.rows[0].n, 1, 'израсходован ровно один завезённый ключ, второй остался в пуле');

  const { body: report } = await http.get('/api/admin/reconciliation');
  assert.equal(report.healthy, true);
  assert.equal(report.paid_not_delivered.count, 0);
});

test('ручная повторная выдача идемпотентна', async () => {
  const order = await orderThatLostItsKey('KEY-GTA5');
  await waitFor(async () => {
    const { body } = await http.get(`/api/orders/${order.id}`);
    return body.status === 'out_of_stock' ? body : null;
  }, { timeoutMs: 10000 });

  await http.post('/api/admin/stock/KEY-GTA5/restock', { codes: ['MANUAL-0001'] });

  const results = await Promise.all(
    Array.from({ length: 5 }, () => http.post(`/api/admin/orders/${order.id}/deliver`, {})),
  );
  assert.ok(results.every((r) => r.status === 200), 'все пять нажатий отвечают 200');
  const codes = results.map((r) => r.body.order.delivery?.code);
  assert.ok(codes.every(Boolean), 'в каждом ответе есть выданный код');
  assert.equal(new Set(codes).size, 1, 'пять нажатий "Выдать" дают один и тот же код');
  assert.equal(codes[0], 'MANUAL-0001');

  const used = await pool.query(
    `SELECT count(*)::int AS n FROM stock_keys WHERE order_id = $1`, [order.id]);
  assert.equal(used.rows[0].n, 1);
});

test('пять покупателей на два ключа: два заказа, три честных отказа, обе выдачи прошли', async () => {
  await resetData({ keysPerSku: 0 });
  await http.post('/api/admin/stock/KEY-CS2-PRIME/restock', { codes: ['PAIR-1', 'PAIR-2'] });

  const results = await Promise.all(
    Array.from({ length: 5 }, () => http.post('/api/orders', { sku: 'KEY-CS2-PRIME' })),
  );
  const created = results.filter((r) => r.status === 201).map((r) => r.body);
  const refused = results.filter((r) => r.status === 409);

  assert.equal(created.length, 2, 'ключей было два, значит и заказов два');
  assert.equal(refused.length, 3, 'остальные узнали об этом до оплаты');

  await Promise.all(created.map((o) => http.post('/webhook/payment', paidEvent(o.id, o.amount))));
  for (const order of created) {
    const delivered = await waitFor(async () => {
      const { body } = await http.get(`/api/orders/${order.id}`);
      return body.status === 'delivered' ? body : null;
    }, { timeoutMs: 10000 });
    assert.ok(delivered, `заказ ${order.id} обязан быть выдан`);
  }

  const used = await pool.query('SELECT count(*)::int AS n FROM stock_keys WHERE order_id IS NOT NULL');
  assert.equal(used.rows[0].n, 2);

  const codes = await pool.query('SELECT count(DISTINCT code)::int AS n FROM stock_keys WHERE order_id IS NOT NULL');
  assert.equal(codes.rows[0].n, 2, 'коды не задвоились');

  const { body: report } = await http.get('/api/admin/reconciliation');
  assert.equal(report.ledger.balanced, true);
});

test('брошенное оформление не держит товар дольше срока брони', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'STEAM-TOPUP-500' });

  const { body: blocked } = await http.get('/api/catalog?limit=50');
  assert.equal(blocked.items.find((i) => i.sku === 'STEAM-TOPUP-500').available, 0);

  await sleep(config.reservation.ttlMs + 400);

  const freed = await waitFor(async () => {
    const { body } = await http.get('/api/catalog?limit=50');
    const item = body.items.find((i) => i.sku === 'STEAM-TOPUP-500');
    return item.available === 1 ? item : null;
  }, { timeoutMs: 8000 });

  assert.ok(freed, 'товар обязан вернуться в продажу сам, без вмешательства человека');
  const { body: expired } = await http.get(`/api/orders/${order.id}`);
  assert.equal(expired.status, 'expired');
});
