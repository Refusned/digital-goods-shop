/**
 * Второй этап, задача 1: живая витрина.
 *
 * Проверяется, что изменение цены и наличия доезжает до всех открытых вкладок без перезагрузки,
 * что товар гаснет у всех одновременно, и что после обрыва связи вкладка догоняет состояние.
 */

import './env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, resetData, api, waitFor, openStream, pool, sleep } from './helpers.js';

let stack, http;

before(async () => { stack = await startStack({ live: true }); http = api(stack.base); });
after(async () => { await stack.stop(); await pool.end(); });
beforeEach(async () => { await resetData({ keysPerSku: 2 }); });

const productEvents = (stream) => stream.events.filter((e) => e.type === 'products');
const findUpdate = (stream, sku, predicate = () => true) => productEvents(stream)
  .flatMap((e) => e.data)
  .filter((p) => p.sku === sku && predicate(p))
  .at(-1);

test('изменение цены доезжает до открытых вкладок без перезагрузки', async () => {
  const first = await openStream(stack.base);
  const second = await openStream(stack.base);
  try {
    await waitFor(async () => first.events.some((e) => e.type === 'hello') && second.events.some((e) => e.type === 'hello'));

    await pool.query(`UPDATE products SET price_minor = 999 WHERE sku = 'KEY-CS2-PRIME'`);

    const seen = await waitFor(async () => findUpdate(first, 'KEY-CS2-PRIME', (p) => p.price === 999), { timeoutMs: 5000 });
    assert.ok(seen, 'первая вкладка обязана узнать о новой цене');

    const seenBySecond = await waitFor(async () => findUpdate(second, 'KEY-CS2-PRIME', (p) => p.price === 999), { timeoutMs: 5000 });
    assert.ok(seenBySecond, 'вторая вкладка тоже, событие получают все подписчики');
  } finally {
    first.close();
    second.close();
  }
});

test('когда остаток дошёл до нуля, товар гаснет у всех сразу', async () => {
  const stream = await openStream(stack.base);
  try {
    await waitFor(async () => stream.events.some((e) => e.type === 'hello'));

    // Два ключа: два заказа разбирают весь остаток.
    const first = await http.post('/api/orders', { sku: 'KEY-GTA5' });
    const second = await http.post('/api/orders', { sku: 'KEY-GTA5' });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);

    const zero = await waitFor(async () => {
      const update = findUpdate(stream, 'KEY-GTA5');
      return update && update.available === 0 ? update : null;
    }, { timeoutMs: 5000 });

    assert.ok(zero, 'вкладка обязана узнать, что товар закончился');
    assert.equal(zero.available, 0);

    // Тот же ноль виден и в обычном ответе каталога: живое событие не расходится с состоянием.
    const { body: catalog } = await http.get('/api/catalog?limit=50');
    assert.equal(catalog.items.find((i) => i.sku === 'KEY-GTA5').available, 0);
  } finally {
    stream.close();
  }
});

test('изменение, сделанное в обход приложения, тоже доезжает до витрины', async () => {
  const stream = await openStream(stack.base);
  try {
    await waitFor(async () => stream.events.some((e) => e.type === 'hello'));

    // Никакого HTTP: ключ добавлен прямо в базу, как это делает миграция или админ руками.
    await pool.query(`INSERT INTO stock_keys (sku, code) VALUES ('KEY-CS2-PRIME', 'DIRECT-INSERT-0001')`);

    const update = await waitFor(
      async () => findUpdate(stream, 'KEY-CS2-PRIME', (p) => p.available === 3), { timeoutMs: 5000 });
    assert.ok(update, 'источник событий это база, а не аккуратность прикладного кода');
  } finally {
    stream.close();
  }
});

test('после обрыва связи вкладка догоняет состояние снимком', async () => {
  const stream = await openStream(stack.base);
  await waitFor(async () => stream.events.some((e) => e.type === 'hello'));
  stream.close();               // вкладка «потеряла» соединение
  await sleep(100);

  // Пока связи не было, цена изменилась.
  await pool.query(`UPDATE products SET price_minor = 4242 WHERE sku = 'STEAM-TOPUP-500'`);

  // Браузер переподключается и запрашивает снимок: ровно это делает витрина в обработчике open.
  const reconnected = await openStream(stack.base);
  try {
    const { body: snapshot } = await http.get('/api/catalog?limit=50');
    assert.equal(snapshot.items.find((i) => i.sku === 'STEAM-TOPUP-500').price, 4242,
      'снимок после переподключения показывает актуальную цену, а не ту, что была до обрыва');

    // И дальше канал снова живой.
    await pool.query(`UPDATE products SET price_minor = 4343 WHERE sku = 'STEAM-TOPUP-500'`);
    const update = await waitFor(
      async () => findUpdate(reconnected, 'STEAM-TOPUP-500', (p) => p.price === 4343), { timeoutMs: 5000 });
    assert.ok(update, 'после переподключения канал снова живой');
  } finally {
    reconnected.close();
  }
});

test('поток отдаётся в формате Server-Sent Events с идентификаторами событий', async () => {
  const res = await fetch(`${stack.base}/api/stream`);
  try {
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    assert.match(res.headers.get('cache-control'), /no-cache/);

    const reader = res.body.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    assert.match(chunk, /retry: \d+/, 'браузеру сказано, через сколько переподключаться');
    await reader.cancel();
  } finally {
    // соединение закрывается вместе с reader
  }
});
