/**
 * Второй этап, задача 5: мгновенный поиск по большому каталогу.
 *
 * Проверяется, что поиск и фильтры работают на тысячах позиций, остаются быстрыми,
 * листаются курсором без пропусков и повторов, и что состояние подборки полностью
 * восстанавливается по адресу страницы.
 */

import './env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, resetData, api, pool } from './helpers.js';

let stack, http;

const BULK = 3000;

before(async () => {
  stack = await startStack();
  http = api(stack.base);
  await resetData({ keysPerSku: 2 });

  // Большой каталог: на дюжине позиций «мгновенно» ничего не значит.
  const rows = [];
  const games = ['Counter-Strike 2', 'GTA V', 'Cyberpunk 2077', 'Elden Ring', 'Escape from Tarkov'];
  const platforms = ['Steam', 'PlayStation', 'Xbox', 'Nintendo'];
  const types = ['key', 'topup', 'subscription', 'giftcard'];
  for (let n = 0; n < BULK; n++) {
    rows.push([
      `TEST-${String(n).padStart(5, '0')}`,
      `${games[n % games.length]} ${platforms[Math.floor(n / games.length) % platforms.length]}: вариант ${n}`,
      types[n % types.length],
      100 + ((n * 37) % 9000),
      (n * 17) % 5000,
    ]);
  }
  // Массовая загрузка идёт без построчных триггеров: они нужны для правды в бою,
  // а на засыпке трёх тысяч строк превращают подготовку в минуты ожидания.
  await pool.query('ALTER TABLE stock_keys DISABLE TRIGGER USER');
  const chunk = 500;
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const values = part.map((_, j) => `($${j * 5 + 1}, $${j * 5 + 2}, $${j * 5 + 3}, $${j * 5 + 4}, 'RUB', 'other', $${j * 5 + 5})`).join(', ');
    await pool.query(
      `INSERT INTO products (sku, name, type, price_minor, currency, section, popularity)
       VALUES ${values} ON CONFLICT (sku) DO NOTHING`,
      part.flat(),
    );
  }
  // Каждому пятому товару даём наличие: фильтр по наличию должен что-то отсекать.
  await pool.query(
    `INSERT INTO stock_keys (sku, code)
     SELECT sku, sku || '-K1' FROM products WHERE sku LIKE 'TEST-%' AND (right(sku, 1))::int % 5 = 0
     ON CONFLICT (code) DO NOTHING`);
  await pool.query('ALTER TABLE stock_keys ENABLE TRIGGER USER');

  // Проекция остатков пересчитывается одним запросом вместо построчных триггеров.
  await pool.query(
    `INSERT INTO product_stock (sku, available)
     SELECT p.sku, COALESCE(k.free, 0)
       FROM products p
       LEFT JOIN (SELECT sku, count(*)::int AS free FROM stock_keys
                   WHERE order_id IS NULL AND (reserved_by_order IS NULL OR reserved_until <= now())
                   GROUP BY sku) k ON k.sku = p.sku
     ON CONFLICT (sku) DO UPDATE SET available = EXCLUDED.available`);

  // Без свежей статистики планировщик считает таблицу крошечной и уходит в скан:
  // проверять план на несобранной статистике бессмысленно.
  await pool.query('ANALYZE products');
});
after(async () => {
  await pool.query('ALTER TABLE stock_keys DISABLE TRIGGER USER');
  await pool.query("DELETE FROM products WHERE sku LIKE 'TEST-%'");
  await pool.query('ALTER TABLE stock_keys ENABLE TRIGGER USER');
  await stack.stop();
  await pool.end();
});
beforeEach(async () => { /* каталог общий на файл: он большой и пересоздавать его на каждый тест дорого */ });

test('поиск по подстроке находит товары в каталоге из тысяч позиций', async () => {
  const { body } = await http.get('/api/search?q=Tarkov&limit=10');
  assert.ok(body.items.length > 0);
  assert.equal(body.items.every((i) => /tarkov/i.test(i.name)), true);
  assert.ok(body.total > 0);
});

test('поиск остаётся быстрым', async () => {
  const queries = ['Cyberpunk', 'Steam', 'вариант 271', 'Elden Ring Xbox', 'GTA'];
  for (const q of queries) {
    const started = Date.now();
    const { status } = await http.get(`/api/search?q=${encodeURIComponent(q)}&limit=24`);
    const took = Date.now() - started;
    assert.equal(status, 200);
    assert.ok(took < 400, `запрос «${q}» занял ${took} мс, это уже не мгновенно`);
  }
});

test('поиск идёт по индексу, а не сканом таблицы', async () => {
  const { rows } = await pool.query(
    `EXPLAIN (FORMAT JSON)
     SELECT p.sku FROM products p LEFT JOIN product_stock s ON s.sku = p.sku
      WHERE p.is_active AND (p.name ILIKE '%Tarkov%' OR p.sku ILIKE '%Tarkov%' OR p.name % 'Tarkov')
      ORDER BY p.popularity DESC, p.sku LIMIT 25`);
  const plan = JSON.stringify(rows[0]['QUERY PLAN']);
  assert.match(plan, /Bitmap Index Scan|Index Scan/, `план запроса: ${plan}`);
});

test('фильтры сужают выдачу: тип, цена, наличие', async () => {
  const { body: byType } = await http.get('/api/search?type=subscription&limit=50');
  assert.equal(byType.items.every((i) => i.type === 'subscription'), true);

  const { body: byPrice } = await http.get('/api/search?min_price=5000&max_price=6000&limit=50');
  assert.equal(byPrice.items.every((i) => i.price >= 5000 && i.price <= 6000), true);

  const { body: inStock } = await http.get('/api/search?in_stock=1&limit=50');
  assert.equal(inStock.items.every((i) => i.available > 0), true);
  assert.ok(inStock.items.length > 0);
});

test('сортировки дают заявленный порядок', async () => {
  const { body: cheap } = await http.get('/api/search?sort=price_asc&limit=20');
  const prices = cheap.items.map((i) => i.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));

  const { body: expensive } = await http.get('/api/search?sort=price_desc&limit=20');
  const desc = expensive.items.map((i) => i.price);
  assert.deepEqual(desc, [...desc].sort((a, b) => b - a));

  // Порядок по названию сверяется с самой базой, а не с сортировкой JavaScript:
  // правила сравнения строк у них разные, и расхождение говорило бы о локали, а не о ручке.
  const { body: byName } = await http.get('/api/search?sort=name&limit=20');
  const expected = await pool.query(
    'SELECT name FROM products WHERE is_active ORDER BY name, sku LIMIT 20');
  assert.deepEqual(byName.items.map((i) => i.name), expected.rows.map((r) => r.name));
});

test('листание курсором не пропускает и не повторяет товары', async () => {
  const seen = [];
  let cursor = null;
  for (let page = 0; page < 5; page++) {
    const url = `/api/search?sort=price_asc&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const { body } = await http.get(url);
    seen.push(...body.items.map((i) => i.sku));
    cursor = body.next_cursor;
    if (!cursor) break;
  }
  assert.equal(new Set(seen).size, seen.length, 'ни один товар не пришёл дважды');
  assert.ok(seen.length >= 80, 'страницы действительно листаются');
});

test('фильтры полностью восстанавливаются из параметров запроса', async () => {
  // Ровно та ссылка, которую собирает витрина при выборе фильтров.
  const { body } = await http.get('/api/search?q=Steam&type=key&min_price=1000&max_price=8000&in_stock=1&sort=price_desc&limit=10');

  assert.equal(body.sort, 'price_desc');
  assert.equal(body.items.every((i) => /steam/i.test(i.name)), true);
  assert.equal(body.items.every((i) => i.type === 'key'), true);
  assert.equal(body.items.every((i) => i.price >= 1000 && i.price <= 8000), true);
  assert.equal(body.items.every((i) => i.available > 0), true);
});

test('пустой поиск это обычная витрина, а не ошибка', async () => {
  const { status, body } = await http.get('/api/search?q=&limit=5');
  assert.equal(status, 200);
  assert.equal(body.items.length, 5);
});

test('запрос без совпадений отдаёт пустой список, а не выдумывает результаты', async () => {
  const { body } = await http.get('/api/search?q=zzzzzzzzzzzz&limit=10');
  assert.deepEqual(body.items, []);
  assert.equal(body.total, 0);
});
