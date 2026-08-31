import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool, closePool } from '../src/db.js';
import { config } from '../src/config.js';

const catalog = JSON.parse(readFileSync(join(config.root, 'db/data/catalog.json'), 'utf8'));
const keyPool = JSON.parse(readFileSync(join(config.root, 'db/data/keys.json'), 'utf8'));
const promos = JSON.parse(readFileSync(join(config.root, 'db/data/promocodes.json'), 'utf8'));

if (process.argv.includes('--reset')) {
  await pool.query('TRUNCATE ledger_entries, promocode_uses, payment_events, stock_keys, orders RESTART IDENTITY CASCADE');
  await pool.query('UPDATE promocodes SET used_count = 0');
}

// Каталог. Секции повторяют ряды витрины из макета.
const sections = ['popular', 'recommended', 'other'];
let i = 0;
for (const p of catalog.products) {
  const section = sections[Math.floor(i / 4) % sections.length];
  const image = p.image || '';
  await pool.query(
    `INSERT INTO products (sku, name, type, price_minor, old_price_minor, currency, image, section, popularity)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (sku) DO UPDATE
        SET name = EXCLUDED.name, type = EXCLUDED.type, price_minor = EXCLUDED.price_minor,
            old_price_minor = EXCLUDED.old_price_minor, image = EXCLUDED.image,
            section = EXCLUDED.section, popularity = EXCLUDED.popularity`,
    [p.sku, p.name, p.type, p.price, Math.round(p.price * 1.7), p.currency, image, section, catalog.products.length - i],
  );
  i++;
}

// Пул ключей из задания раскладываем по товарам по кругу: один код принадлежит ровно одному SKU.
const skus = catalog.products.map((p) => p.sku);
let added = 0;
for (const [idx, code] of keyPool.keys.entries()) {
  const sku = skus[idx % skus.length];
  const r = await pool.query(
    'INSERT INTO stock_keys (sku, code) VALUES ($1, $2) ON CONFLICT (sku, code) DO NOTHING RETURNING id',
    [sku, code],
  );
  added += r.rowCount;
}

for (const promo of promos.promocodes) {
  await pool.query(
    `INSERT INTO promocodes (code, type, value, currency, max_uses)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (code) DO UPDATE
        SET type = EXCLUDED.type, value = EXCLUDED.value, max_uses = EXCLUDED.max_uses, is_active = TRUE`,
    [promo.code, promo.type, promo.value, promo.currency ?? null, promo.max_uses],
  );
}

const stats = await pool.query(
  `SELECT (SELECT count(*) FROM products)::int AS products,
          (SELECT count(*) FROM stock_keys)::int AS keys,
          (SELECT count(*) FROM promocodes)::int AS promocodes`,
);
process.stdout.write(`seed: ${JSON.stringify(stats.rows[0])} (новых ключей: ${added})\n`);
await closePool();
