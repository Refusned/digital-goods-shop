/**
 * Второй этап, задача 4: устойчивость покупки к любым действиям покупателя.
 *
 * Двойной клик, кнопка «Назад» после оплаты, обновление страницы и обрыв связи в момент оплаты
 * не должны создавать второй заказ, задваивать платёж или показывать неверный статус.
 */

import './env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, resetData, api, waitFor, paidEvent, pool } from './helpers.js';

let stack, http;

before(async () => { stack = await startStack({ worker: true, workerIntervalMs: 100 }); http = api(stack.base); });
after(async () => { await stack.stop(); await pool.end(); });
beforeEach(async () => { await resetData({ keysPerSku: 3 }); });

const delivered = (orderId) => waitFor(async () => {
  const { body } = await http.get(`/api/orders/${orderId}`);
  return body.status === 'delivered' ? body : null;
}, { timeoutMs: 10000 });

test('двойной клик по «Купить» создаёт один заказ и держит одну бронь', async () => {
  const key = 'double-click-key';
  const [a, b] = await Promise.all([
    http.post('/api/orders', { sku: 'KEY-CS2-PRIME' }, { 'Idempotency-Key': key }),
    http.post('/api/orders', { sku: 'KEY-CS2-PRIME' }, { 'Idempotency-Key': key }),
  ]);

  assert.equal(a.body.id, b.body.id, 'оба клика вернули один и тот же заказ');

  const orders = await pool.query('SELECT count(*)::int AS n FROM orders');
  assert.equal(orders.rows[0].n, 1);

  const reserved = await pool.query('SELECT count(*)::int AS n FROM stock_keys WHERE reserved_by_order IS NOT NULL');
  assert.equal(reserved.rows[0].n, 1, 'двойной клик не съедает два ключа со склада');
});

test('двойной клик по «Оплатить» не задваивает платёж', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-GTA5' });
  const key = `pay-${order.id}`;

  await Promise.all([
    http.post(`/api/orders/${order.id}/simulate-payment`, { success: true }, { 'Idempotency-Key': key }),
    http.post(`/api/orders/${order.id}/simulate-payment`, { success: true }, { 'Idempotency-Key': key }),
  ]);

  const done = await delivered(order.id);
  assert.ok(done, 'заказ оплачен и выдан');

  const events = await pool.query('SELECT count(*)::int AS n FROM payment_events WHERE order_id = $1', [order.id]);
  assert.equal(events.rows[0].n, 1, 'одно событие оплаты на два клика');

  const keys = await pool.query('SELECT count(*)::int AS n FROM stock_keys WHERE order_id = $1', [order.id]);
  assert.equal(keys.rows[0].n, 1, 'и один выданный ключ');
});

test('повтор оплаты после обрыва связи безопасен: ключ идемпотентности тот же', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME' });
  const key = `pay-retry-${order.id}`;

  // Первая попытка «не доехала» до пользователя, он нажимает ещё раз, и ещё раз.
  await http.post(`/api/orders/${order.id}/simulate-payment`, { success: true }, { 'Idempotency-Key': key });
  await http.post(`/api/orders/${order.id}/simulate-payment`, { success: true }, { 'Idempotency-Key': key });
  await http.post(`/api/orders/${order.id}/simulate-payment`, { success: true }, { 'Idempotency-Key': key });

  const done = await delivered(order.id);
  assert.ok(done);

  const events = await pool.query('SELECT count(*)::int AS n FROM payment_events WHERE order_id = $1', [order.id]);
  assert.equal(events.rows[0].n, 1);

  const ledger = await pool.query(
    `SELECT COALESCE(SUM(amount_minor), 0) AS paid FROM ledger_entries
      WHERE order_id = $1 AND account = 'cash' AND direction = 'debit'`, [order.id]);
  assert.equal(Number(ledger.rows[0].paid), order.amount, 'деньги посчитаны один раз');
});

test('ключ оплаты одного заказа нельзя использовать для другого', async () => {
  const { body: first } = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME' });
  const { body: second } = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME' });
  const key = 'shared-payment-key';

  const ok = await http.post(`/api/orders/${first.id}/simulate-payment`, { success: true }, { 'Idempotency-Key': key });
  assert.equal(ok.status, 200);

  const conflict = await http.post(`/api/orders/${second.id}/simulate-payment`, { success: true }, { 'Idempotency-Key': key });
  assert.equal(conflict.status, 409, 'чужой ключ оплаты не должен молча оплатить другой заказ');
  assert.equal(conflict.body.error, 'payment_key_conflict');

  const secondState = await http.get(`/api/orders/${second.id}`);
  assert.equal(secondState.body.paid_at, null, 'второй заказ остался неоплаченным');
});

test('повторная оплата уже оплаченного заказа ничего не меняет', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-GTA5' });
  await http.post('/webhook/payment', paidEvent(order.id, order.amount));
  const done = await delivered(order.id);

  // Новое событие оплаты по уже выданному заказу: контур обязан его принять и ничего не сломать.
  const again = await http.post('/webhook/payment', paidEvent(order.id, order.amount));
  assert.equal(again.status, 200);
  assert.equal(again.body.outcome, 'already_paid');

  const { body: after } = await http.get(`/api/orders/${order.id}`);
  assert.equal(after.status, 'delivered');
  assert.equal(after.delivery.code, done.delivery.code, 'код не поменялся');

  const keys = await pool.query('SELECT count(*)::int AS n FROM stock_keys WHERE order_id = $1', [order.id]);
  assert.equal(keys.rows[0].n, 1);

  const ledger = await pool.query(
    `SELECT COALESCE(SUM(amount_minor), 0) AS paid FROM ledger_entries
      WHERE order_id = $1 AND account = 'cash' AND direction = 'debit'`, [order.id]);
  assert.equal(Number(ledger.rows[0].paid), order.amount, 'деньги не удвоились');
});

test('после возврата на страницу заказ показывает верный статус, а не кешированный', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME' });
  assert.equal(order.status, 'created');

  await http.post('/webhook/payment', paidEvent(order.id, order.amount));
  await delivered(order.id);

  // Страница по кнопке "Назад" перечитывает состояние с сервера: это и есть источник правды.
  const { body: fresh } = await http.get(`/api/orders/${order.id}`);
  assert.equal(fresh.status, 'delivered');
  assert.ok(fresh.delivery.code);
  assert.equal(fresh.reservation_seconds_left, null, 'кнопки оплаты на выданном заказе быть не может');
});

test('изменение цены во время оформления видно ДО оплаты, а сумма заказа не растёт', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME' });
  assert.equal(order.price_changed, false);

  // Товар подорожал, пока покупатель оформлял.
  await pool.query(`UPDATE products SET price_minor = price_minor * 2 WHERE sku = 'KEY-CS2-PRIME'`);

  const { body: beforePayment } = await http.get(`/api/orders/${order.id}`);
  assert.equal(beforePayment.price_changed, true, 'покупатель видит расхождение до оплаты');
  assert.equal(beforePayment.current_price, order.base_amount * 2);
  assert.equal(beforePayment.amount, order.amount, 'а платит по зафиксированной цене');

  await http.post('/webhook/payment', paidEvent(order.id, order.amount));
  const done = await delivered(order.id);
  assert.ok(done, 'оплата по зафиксированной сумме проходит');
});
