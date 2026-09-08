/**
 * Второй этап, задача 3: бронь с таймером.
 *
 * Проверяется, что бронь видна покупателю и держит товар, по истечении снимается и возвращает
 * товар в продажу всем, оплаченный вовремя заказ уходит в выдачу, и один ключ не может быть
 * забронирован под два заказа.
 */

import './env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, resetData, api, waitFor, paidEvent, pool, sleep, config } from './helpers.js';

let stack, http;

before(async () => { stack = await startStack({ worker: true, workerIntervalMs: 100 }); http = api(stack.base); });
after(async () => { await stack.stop(); await pool.end(); });
beforeEach(async () => { await resetData({ keysPerSku: 1 }); });

test('заказ отдаёт срок брони и остаток времени для обратного отсчёта', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME' });

  assert.ok(order.reserved_until, 'бронь имеет конкретный срок');
  assert.ok(order.reservation_seconds_left > 0, 'и понятный остаток времени');
  assert.ok(order.server_time, 'вместе с серверным временем: часы браузера могут врать');

  const drift = Math.abs(new Date(order.reserved_until) - new Date(order.server_time) - config.reservation.ttlMs);
  assert.ok(drift < 1000, 'остаток считается от серверного времени, а не от часов клиента');
});

test('пока бронь жива, товар недоступен другим покупателям', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-GTA5' });
  assert.ok(order.id);

  const second = await http.post('/api/orders', { sku: 'KEY-GTA5' });
  assert.equal(second.status, 409, 'второй покупатель не может забрать забронированное');

  const { body: catalog } = await http.get('/api/catalog?limit=50');
  assert.equal(catalog.items.find((i) => i.sku === 'KEY-GTA5').available, 0);
});

test('по истечении отсчёта бронь снимается и товар возвращается в продажу', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME' });

  const expired = await waitFor(async () => {
    const { body } = await http.get(`/api/orders/${order.id}`);
    return body.status === 'expired' ? body : null;
  }, { timeoutMs: 10000 });

  assert.ok(expired, 'заказ без оплаты обязан перестать держать товар');
  assert.equal(expired.reservation_seconds_left, null);

  const { body: catalog } = await http.get('/api/catalog?limit=50');
  assert.equal(catalog.items.find((i) => i.sku === 'KEY-CS2-PRIME').available, 1,
    'товар снова доступен ВСЕМ, а не только бывшему держателю брони');

  const next = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME' });
  assert.equal(next.status, 201, 'следующий покупатель спокойно оформляет заказ');
});

test('оплата вовремя переводит заказ в выдачу, и отсчёт больше ни на что не влияет', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-GTA5' });
  await http.post('/webhook/payment', paidEvent(order.id, order.amount));

  const delivered = await waitFor(async () => {
    const { body } = await http.get(`/api/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  }, { timeoutMs: 10000 });

  assert.ok(delivered, 'оплаченный вовремя заказ доходит до кода');
  assert.equal(delivered.reservation_seconds_left, null, 'после оплаты отсчёт не показывается');

  // Ждём дольше срока брони: уборка не должна тронуть оплаченный заказ.
  await sleep(config.reservation.ttlMs + 500);
  const { body: later } = await http.get(`/api/orders/${order.id}`);
  assert.equal(later.status, 'delivered', 'истёкший таймер не отменяет уже выданный заказ');
  assert.ok(later.delivery.code);
});

test('покупателю выдаётся именно тот ключ, который был за ним забронирован', async () => {
  await resetData({ keysPerSku: 3 });
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME' });

  const reserved = await pool.query(
    'SELECT code FROM stock_keys WHERE reserved_by_order = $1', [order.id]);
  assert.equal(reserved.rowCount, 1);

  await http.post('/webhook/payment', paidEvent(order.id, order.amount));
  const delivered = await waitFor(async () => {
    const { body } = await http.get(`/api/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  }, { timeoutMs: 10000 });

  assert.equal(delivered.delivery.code, reserved.rows[0].code);
});

test('один ключ не может быть забронирован под два заказа', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME' });

  // Попытка навесить чужую бронь на тот же ключ ловится ограничением базы, а не кодом.
  const other = await http.post('/api/orders', { sku: 'KEY-GTA5' });
  await assert.rejects(
    () => pool.query(
      `UPDATE stock_keys SET reserved_by_order = $1 WHERE reserved_by_order = $2`,
      [other.body.id, order.id]),
    /stock_keys_reserved_order_uidx/,
    'уникальный индекс не даёт одному заказу держать два ключа',
  );
});

test('уход на оплату продлевает бронь, но не делает её бесконечной', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME' });
  await sleep(600);

  const { body: held } = await http.post(`/api/orders/${order.id}/hold`);
  assert.equal(held.extended, true);
  assert.ok(new Date(held.reserved_until) > new Date(order.reserved_until),
    'время оплаты не съедает время, потраченное на оформление');

  // Продление тоже конечно: не оплатив, товар отдаём обратно в продажу.
  const expired = await waitFor(async () => {
    const { body } = await http.get(`/api/orders/${order.id}`);
    return body.status === 'expired' ? body : null;
  }, { timeoutMs: 10000 });
  assert.ok(expired);
});

test('покупатель может отказаться сам, и товар возвращается в продажу сразу', async () => {
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-GTA5' });

  const { body: cancelled } = await http.post(`/api/orders/${order.id}/cancel`);
  assert.equal(cancelled.status, 'expired');

  const { body: catalog } = await http.get('/api/catalog?limit=50');
  assert.equal(catalog.items.find((i) => i.sku === 'KEY-GTA5').available, 1,
    'не дожидаясь конца отсчёта');

  const next = await http.post('/api/orders', { sku: 'KEY-GTA5' });
  assert.equal(next.status, 201);
});

test('оплата после истечения брони: товар выдаётся, если он ещё есть', async () => {
  await resetData({ keysPerSku: 2 });
  const { body: order } = await http.post('/api/orders', { sku: 'KEY-CS2-PRIME' });

  await waitFor(async () => {
    const { body } = await http.get(`/api/orders/${order.id}`);
    return body.status === 'expired' ? body : null;
  }, { timeoutMs: 10000 });

  // Опоздавший платёж: бронь уже снята, но на складе остались другие ключи.
  await http.post('/webhook/payment', paidEvent(order.id, order.amount));

  const delivered = await waitFor(async () => {
    const { body } = await http.get(`/api/orders/${order.id}`);
    return body.status === 'delivered' ? body : null;
  }, { timeoutMs: 10000 });

  assert.ok(delivered, 'деньги пришли, значит покупатель обязан получить товар');
  assert.ok(delivered.delivery.code);
});
