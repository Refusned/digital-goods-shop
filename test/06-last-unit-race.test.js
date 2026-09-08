/**
 * Второй этап, задача 2: покупка последней единицы наперегонки.
 *
 * Проверяется, что последнюю единицу получает ровно один покупатель, второй получает понятный
 * отказ до оплаты, и ни у кого не остаётся оплаченного заказа без товара.
 */

import './env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, resetData, api, waitFor, paidEvent, pool } from './helpers.js';

let stack, http;

before(async () => { stack = await startStack({ worker: true, workerIntervalMs: 100 }); http = api(stack.base); });
after(async () => { await stack.stop(); await pool.end(); });
beforeEach(async () => { await resetData({ keysPerSku: 1 }); });

test('последнюю единицу получает ровно один покупатель, второй узнаёт об этом до оплаты', async () => {
  const [first, second] = await Promise.all([
    http.post('/api/orders', { sku: 'KEY-CS2-PRIME' }),
    http.post('/api/orders', { sku: 'KEY-CS2-PRIME' }),
  ]);

  const created = [first, second].filter((r) => r.status === 201);
  const refused = [first, second].filter((r) => r.status === 409);

  assert.equal(created.length, 1, 'заказ на последнюю единицу создаётся ровно один');
  assert.equal(refused.length, 1, 'второй покупатель получает отказ');
  assert.equal(refused[0].body.error, 'sold_out');
  assert.match(refused[0].body.message, /раскупили/i, 'сообщение объясняет причину, а не пугает кодом ошибки');

  // Проигравший не создал заказ, значит платить ему нечего и списать у него нечего.
  const orders = await pool.query('SELECT count(*)::int AS n FROM orders');
  assert.equal(orders.rows[0].n, 1);

  const reserved = await pool.query(
    `SELECT count(*)::int AS n FROM stock_keys WHERE reserved_by_order = $1`, [created[0].body.id]);
  assert.equal(reserved.rows[0].n, 1, 'ключ забронирован за победителем');
});

test('двадцать одновременных попыток на один ключ: победитель один', async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, () => http.post('/api/orders', { sku: 'KEY-GTA5' })),
  );

  const created = results.filter((r) => r.status === 201);
  const soldOut = results.filter((r) => r.status === 409 && r.body.error === 'sold_out');

  assert.equal(created.length, 1, 'ключ был один, значит и заказ один');
  assert.equal(soldOut.length, 19, 'все остальные получили понятный отказ');

  const keys = await pool.query(
    `SELECT count(*)::int AS n FROM stock_keys WHERE sku = 'KEY-GTA5' AND reserved_by_order IS NOT NULL`);
  assert.equal(keys.rows[0].n, 1, 'один ключ не забронирован под два заказа');
});

test('проигравший в гонке не остаётся с оплаченным заказом без товара', async () => {
  const [first, second] = await Promise.all([
    http.post('/api/orders', { sku: 'STEAM-TOPUP-500' }),
    http.post('/api/orders', { sku: 'STEAM-TOPUP-500' }),
  ]);
  const winner = [first, second].find((r) => r.status === 201).body;

  await http.post('/webhook/payment', paidEvent(winner.id, winner.amount));
  const delivered = await waitFor(async () => {
    const { body } = await http.get(`/api/orders/${winner.id}`);
    return body.status === 'delivered' ? body : null;
  }, { timeoutMs: 10000 });

  assert.ok(delivered, 'победитель получает код');
  assert.ok(delivered.delivery.code);

  // Ни одного оплаченного заказа без выдачи: у проигравшего заказа просто нет.
  const orphanPaid = await pool.query(
    `SELECT count(*)::int AS n FROM orders o
       LEFT JOIN stock_keys k ON k.order_id = o.id
      WHERE o.paid_at IS NOT NULL AND k.id IS NULL`);
  assert.equal(orphanPaid.rows[0].n, 0);

  const { body: report } = await http.get('/api/admin/reconciliation');
  assert.equal(report.ledger.balanced, true);
  assert.equal(report.delivered_not_paid.count, 0);
});

test('после отказа товар честно показан как раскупленный', async () => {
  await Promise.all([
    http.post('/api/orders', { sku: 'KEY-CS2-PRIME' }),
    http.post('/api/orders', { sku: 'KEY-CS2-PRIME' }),
  ]);

  const { body: catalog } = await http.get('/api/catalog?limit=50');
  const item = catalog.items.find((i) => i.sku === 'KEY-CS2-PRIME');
  assert.equal(item.available, 0, 'забронированный ключ не показывается как доступный');

  // Поиск с фильтром "только в наличии" такой товар тоже не отдаёт.
  const { body: search } = await http.get('/api/search?in_stock=1&limit=100');
  assert.equal(search.items.some((i) => i.sku === 'KEY-CS2-PRIME'), false);
});

test('промокод не расходуется, если товар раскупили', async () => {
  const before = await pool.query(`SELECT used_count FROM promocodes WHERE code = 'ONCEONLY'`);

  const [a, b] = await Promise.all([
    http.post('/api/orders', { sku: 'KEY-GTA5', promocode: 'ONCEONLY' }),
    http.post('/api/orders', { sku: 'KEY-GTA5', promocode: 'ONCEONLY' }),
  ]);

  const refused = [a, b].filter((r) => r.status === 409);
  assert.equal(refused.length, 1);

  const after = await pool.query(`SELECT used_count FROM promocodes WHERE code = 'ONCEONLY'`);
  assert.equal(after.rows[0].used_count, before.rows[0].used_count + 1,
    'использование засчитано только победителю: отказ откатывает транзакцию целиком');
});
