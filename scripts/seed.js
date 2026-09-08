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
    // Товары из задания всегда впереди синтетической массы: витрина должна открываться макетом,
    // а не сгенерированным наполнением для проверки поиска.
    [p.sku, p.name, p.type, p.price, Math.round(p.price * 1.7), p.currency, image, section, 100_000 - i],
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

/**
 * Большой каталог для проверки поиска.
 *
 * Задание требует, чтобы поиск и фильтры оставались мгновенными на тысячах предложений,
 * а каталог из задания это дюжина позиций. Поэтому по флагу досыпается синтетическая масса:
 *   npm run seed -- --bulk=5000
 * Названия составляются из реальных игр и площадок, чтобы поиск проверялся на осмысленных
 * запросах, а не на строке «товар 4271».
 */
const bulkArg = process.argv.find((a) => a.startsWith('--bulk'));
if (bulkArg) {
  const total = Number(bulkArg.split('=')[1] || 5000);
  const games = ['Counter-Strike 2', 'GTA V', 'Cyberpunk 2077', 'Elden Ring', 'Dota 2', 'Fortnite', 'Minecraft',
    'Escape from Tarkov', 'Valorant', 'Apex Legends', 'PUBG', 'Rust', 'Terraria', 'Stardew Valley', 'Hades',
    'Baldurs Gate 3', 'Starfield', 'Palworld', 'Helldivers 2', 'Warframe'];
  const platforms = ['Steam', 'PlayStation', 'Xbox', 'Nintendo', 'Epic Games', 'Battle.net', 'GOG', 'Origin'];
  const kinds = [
    ['key', ['ключ активации', 'предзаказ', 'издание Deluxe', 'дополнение']],
    ['topup', ['пополнение 500', 'пополнение 1000', 'пополнение 2500', 'пополнение 5000']],
    ['subscription', ['подписка 1 месяц', 'подписка 3 месяца', 'подписка 12 месяцев']],
    ['giftcard', ['подарочная карта 1000', 'подарочная карта 2500', 'подарочная карта 5000']],
  ];
  const sectionsAll = ['popular', 'recommended', 'other'];

  const rows = [];
  for (let n = 0; n < total; n++) {
    const game = games[n % games.length];
    const platform = platforms[Math.floor(n / games.length) % platforms.length];
    const [type, variants] = kinds[n % kinds.length];
    const variant = variants[Math.floor(n / kinds.length) % variants.length];
    const price = 199 + ((n * 137) % 9800);
    rows.push({
      sku: `BULK-${String(n).padStart(5, '0')}`,
      name: `${game} ${platform}: ${variant}`,
      type,
      price,
      old: Math.round(price * 1.4),
      section: sectionsAll[n % sectionsAll.length],
      popularity: (n * 31) % 1000,
    });
  }

  // Пачками: пять тысяч отдельных INSERT это минуты ожидания на ровном месте.
  const chunk = 500;
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const values = part.map((_, j) => {
      const b = j * 8;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, 'RUB', $${b + 6}, $${b + 7}, $${b + 8})`;
    }).join(', ');
    await pool.query(
      `INSERT INTO products (sku, name, type, price_minor, old_price_minor, currency, image, section, popularity)
       VALUES ${values}
       ON CONFLICT (sku) DO NOTHING`,
      part.flatMap((r) => [r.sku, r.name, r.type, r.price, r.old, 'assets/product-steam.webp', r.section, r.popularity]),
    );
  }

  // Наличие: каждому третьему товару по паре ключей, остальные показываются как раскупленные.
  const withKeys = rows.filter((_, idx) => idx % 3 === 0);
  for (let i = 0; i < withKeys.length; i += chunk) {
    const part = withKeys.slice(i, i + chunk);
    const values = part.flatMap((r, j) => [r.sku, `${r.sku}-A`, r.sku, `${r.sku}-B`]);
    const tuples = part.map((_, j) => `($${j * 4 + 1}, $${j * 4 + 2}), ($${j * 4 + 3}, $${j * 4 + 4})`).join(', ');
    await pool.query(
      `INSERT INTO stock_keys (sku, code) VALUES ${tuples} ON CONFLICT (code) DO NOTHING`,
      values,
    );
  }

  // Проекция остатков заполняется триггером на ключи, но товары без ключей в неё не попали.
  await pool.query(
    `INSERT INTO product_stock (sku, available)
     SELECT p.sku, 0 FROM products p
      WHERE NOT EXISTS (SELECT 1 FROM product_stock s WHERE s.sku = p.sku)`,
  );
  process.stdout.write(`seed: добавлено синтетических товаров: ${total}\n`);
}

const stats = await pool.query(
  `SELECT (SELECT count(*) FROM products)::int AS products,
          (SELECT count(*) FROM stock_keys)::int AS keys,
          (SELECT count(*) FROM promocodes)::int AS promocodes`,
);
process.stdout.write(`seed: ${JSON.stringify(stats.rows[0])} (новых ключей: ${added})\n`);
await closePool();
