/**
 * Живая витрина: изменения наличия и цен доезжают до открытых вкладок без перезагрузки.
 *
 * Источник событий это сама база (LISTEN/NOTIFY), а не прикладной код. Так витрина остаётся
 * правдивой при любом способе изменения данных: ручным UPDATE, миграцией, второй копией сервиса.
 * Прикладной код, который «не забыл разослать событие», работает только пока о нём все помнят.
 *
 * Канал до браузера это Server-Sent Events: поток в одну сторону, встроенное переподключение,
 * работает через обычный HTTP. Вебсокет здесь дал бы двусторонний канал, который витрине не нужен.
 */

import pg from 'pg';
import { pool } from '../db.js';
import { config } from '../config.js';
import { log } from '../logger.js';

const clients = new Set();
let seq = 0;
let listener = null;

// Изменения копятся микропачками: завоз сотни ключей это сотня уведомлений об одном товаре,
// и слать сотню сообщений в каждую вкладку незачем.
const pendingSkus = new Set();
let flushTimer = null;

/** Подписать SSE-соединение. Возвращает функцию отписки. */
export function addClient(res) {
  clients.add(res);
  return () => clients.delete(res);
}

export const clientCount = () => clients.size;

function broadcast(event, data) {
  seq += 1;
  const payload = `id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

/** Свежее состояние товаров, о которых пришло уведомление, одним запросом. */
async function flush() {
  flushTimer = null;
  const skus = [...pendingSkus];
  pendingSkus.clear();
  if (skus.length === 0 || clients.size === 0) return;

  try {
    const { rows } = await pool.query(
      `SELECT p.sku, p.name, p.price_minor, p.old_price_minor, p.currency, p.is_active,
              COALESCE(s.available, 0) AS available
         FROM products p
         LEFT JOIN product_stock s ON s.sku = p.sku
        WHERE p.sku = ANY($1)`,
      [skus],
    );
    if (rows.length === 0) return;

    broadcast('products', rows.map((r) => ({
      sku: r.sku,
      name: r.name,
      price: Number(r.price_minor),
      old_price: r.old_price_minor === null ? null : Number(r.old_price_minor),
      currency: r.currency,
      is_active: r.is_active,
      available: Number(r.available),
    })));
  } catch (err) {
    log.error('live.flush_failed', { error: err.message });
  }
}

function schedule(sku) {
  pendingSkus.add(sku);
  if (!flushTimer) flushTimer = setTimeout(flush, config.live.batchMs);
}

/**
 * Отдельное соединение под LISTEN: пул для этого не годится, соединение должно жить
 * всё время работы процесса и не возвращаться в оборот между запросами.
 */
export async function startLiveUpdates() {
  if (listener) return async () => {};

  let stopped = false;
  const connect = async () => {
    const client = new pg.Client({ connectionString: config.databaseUrl });
    client.on('error', (err) => {
      log.warn('live.listener_error', { error: err.message });
      if (!stopped) setTimeout(reconnect, 1000);
    });
    await client.connect();
    await client.query('LISTEN shop_stock');
    await client.query('LISTEN shop_product');
    client.on('notification', (msg) => schedule(msg.payload));
    listener = client;
    log.info('live.listening', { channels: ['shop_stock', 'shop_product'] });
  };

  const reconnect = async () => {
    if (stopped) return;
    try {
      await listener?.end().catch(() => {});
      listener = null;
      await connect();
    } catch (err) {
      log.warn('live.reconnect_failed', { error: err.message });
      setTimeout(reconnect, 1000);
    }
  };

  await connect();

  // Пульс держит соединение живым через прокси и даёт браузеру понять, что канал цел.
  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try { res.write(': ping\n\n'); } catch { clients.delete(res); }
    }
  }, config.live.heartbeatMs);
  heartbeat.unref?.();

  return async function stop() {
    stopped = true;
    clearInterval(heartbeat);
    if (flushTimer) clearTimeout(flushTimer);
    for (const res of clients) { try { res.end(); } catch { /* соединение уже закрыто */ } }
    clients.clear();
    await listener?.end().catch(() => {});
    listener = null;
  };
}

/** Ручная рассылка: нужна там, где изменение не проходит через таблицы с триггерами. */
export function publish(event, data) {
  broadcast(event, data);
}
