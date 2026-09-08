/**
 * Поиск и фильтры по каталогу в тысячи позиций.
 *
 * Требование «мгновенно» означает не только быстрый SQL: результат обязан оставаться быстрым
 * на каждом нажатии клавиши. Поэтому:
 *   - подстрочный поиск идёт по триграммному индексу, а не по LIKE со сканом таблицы;
 *   - наличие берётся из проекции product_stock, а не считается по ключам каждый раз;
 *   - страницы листаются курсором, а не OFFSET: OFFSET на глубоких страницах читает и выбрасывает
 *     всё, что до них.
 */

import { pool } from '../db.js';

const SORTS = {
  popular: { sql: 'p.popularity DESC, p.sku', cursor: (r) => `${r.popularity}|${r.sku}`,
    where: 'ROW(p.popularity, p.sku) < ROW($CURSOR_A::int, $CURSOR_B::text)' },
  price_asc: { sql: 'p.price_minor ASC, p.sku', cursor: (r) => `${r.price_minor}|${r.sku}`,
    where: 'ROW(p.price_minor, p.sku) > ROW($CURSOR_A::bigint, $CURSOR_B::text)' },
  price_desc: { sql: 'p.price_minor DESC, p.sku', cursor: (r) => `${r.price_minor}|${r.sku}`,
    where: 'ROW(p.price_minor, p.sku) < ROW($CURSOR_A::bigint, $CURSOR_B::text)' },
  name: { sql: 'p.name ASC, p.sku', cursor: (r) => `${r.name}|${r.sku}`,
    where: 'ROW(p.name, p.sku) > ROW($CURSOR_A::text, $CURSOR_B::text)' },
};

export const SORT_KEYS = Object.keys(SORTS);

/**
 * Поиск товаров.
 * Все фильтры необязательны; пустой запрос это обычная витрина, отсортированная по популярности.
 */
export async function searchProducts({
  q = '', type = null, section = null, minPrice = null, maxPrice = null,
  inStock = false, sort = 'popular', cursor = null, limit = 24,
} = {}) {
  const order = SORTS[sort] ? sort : 'popular';
  const spec = SORTS[order];
  const take = Math.min(Math.max(Number(limit) || 24, 1), 100);

  const where = ['p.is_active'];
  const params = [];
  const add = (value) => { params.push(value); return `$${params.length}`; };

  const query = String(q || '').trim();
  if (query) {
    // Триграммный поиск с порогом похожести плюс прямое вхождение подстроки:
    // короткие запросы («cs2») триграммам даются плохо, а покупатель вводит именно их.
    const p = add(query);
    where.push(`(p.name ILIKE '%' || ${p} || '%' OR p.sku ILIKE '%' || ${p} || '%' OR p.name % ${p})`);
  }
  if (type) where.push(`p.type = ${add(type)}`);
  if (section) where.push(`p.section = ${add(section)}`);
  if (minPrice !== null && minPrice !== undefined && minPrice !== '') where.push(`p.price_minor >= ${add(Number(minPrice))}`);
  if (maxPrice !== null && maxPrice !== undefined && maxPrice !== '') where.push(`p.price_minor <= ${add(Number(maxPrice))}`);
  if (inStock) where.push('COALESCE(s.available, 0) > 0');

  if (cursor) {
    const [a, b] = String(cursor).split('|');
    if (a !== undefined && b !== undefined) {
      const pa = add(order === 'name' ? a : Number(a));
      const pb = add(b);
      where.push(spec.where.replace('$CURSOR_A', pa).replace('$CURSOR_B', pb));
    }
  }

  const { rows } = await pool.query(
    `SELECT p.sku, p.name, p.type, p.section, p.price_minor, p.old_price_minor, p.currency,
            p.image, p.popularity, COALESCE(s.available, 0) AS available
       FROM products p
       LEFT JOIN product_stock s ON s.sku = p.sku
      WHERE ${where.join(' AND ')}
      ORDER BY ${spec.sql}
      LIMIT ${take + 1}`,
    params,
  );

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;

  return {
    items: page.map((r) => ({
      sku: r.sku,
      name: r.name,
      type: r.type,
      section: r.section,
      price: Number(r.price_minor),
      old_price: r.old_price_minor === null ? null : Number(r.old_price_minor),
      currency: r.currency,
      image: r.image,
      available: Number(r.available),
    })),
    next_cursor: hasMore ? spec.cursor(page[page.length - 1]) : null,
    sort: order,
  };
}

/**
 * Сколько всего подходит под фильтр.
 *
 * Считается с потолком: точное число на широком запросе требует пройти всю выборку,
 * а покупателю разница между «1000+» и «4137» не нужна. Потолок держит ответ быстрым
 * независимо от размера каталога.
 */
export const COUNT_CAP = 1000;

export async function countProducts({ q = '', type = null, section = null, minPrice = null, maxPrice = null, inStock = false } = {}) {
  const where = ['p.is_active'];
  const params = [];
  const add = (value) => { params.push(value); return `$${params.length}`; };

  const query = String(q || '').trim();
  if (query) {
    const p = add(query);
    where.push(`(p.name ILIKE '%' || ${p} || '%' OR p.sku ILIKE '%' || ${p} || '%' OR p.name % ${p})`);
  }
  if (type) where.push(`p.type = ${add(type)}`);
  if (section) where.push(`p.section = ${add(section)}`);
  if (minPrice !== null && minPrice !== undefined && minPrice !== '') where.push(`p.price_minor >= ${add(Number(minPrice))}`);
  if (maxPrice !== null && maxPrice !== undefined && maxPrice !== '') where.push(`p.price_minor <= ${add(Number(maxPrice))}`);
  if (inStock) where.push('COALESCE(s.available, 0) > 0');

  const { rows } = await pool.query(
    `SELECT count(*)::int AS total FROM (
       SELECT 1 FROM products p LEFT JOIN product_stock s ON s.sku = p.sku
        WHERE ${where.join(' AND ')}
        LIMIT ${COUNT_CAP + 1}) capped`,
    params,
  );
  return { total: Math.min(rows[0].total, COUNT_CAP), capped: rows[0].total > COUNT_CAP };
}
