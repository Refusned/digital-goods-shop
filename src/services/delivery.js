import { withTx, pool } from '../db.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { recordDelivery } from './ledger.js';
import { markRecoverable } from './orders.js';

const DELIVERABLE = ['paid', 'delivering', 'out_of_stock', 'delivery_failed'];

/**
 * Выдача ключа из пула. Идемпотентна и безопасна к параллельному вызову:
 * её одновременно дёргают обработчик вебхука и фоновый воркер.
 *
 * Однократность держится двумя ограничениями БД:
 *   1. частичный UNIQUE по stock_keys.order_id: один заказ не может получить два ключа;
 *   2. одна строка на код: ключ уходит ровно в один заказ.
 * Гонки внутри одного заказа снимает pg_advisory_xact_lock, конкуренцию за свободные ключи
 * между разными заказами снимает FOR UPDATE SKIP LOCKED.
 */
export async function deliverOrder(orderId, { trigger = 'unknown' } = {}) {
  const result = await withTx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [orderId]);

    const ord = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (ord.rowCount === 0) return { outcome: 'order_not_found' };
    const order = ord.rows[0];

    const existing = await client.query('SELECT code FROM stock_keys WHERE order_id = $1', [orderId]);
    if (existing.rowCount > 0) {
      // Ключ уже выдан. Дотягиваем статус, если прошлый заход прервался.
      await client.query(
        `UPDATE orders SET status = 'delivered', delivered_at = COALESCE(delivered_at, now()),
                           next_attempt_at = NULL, updated_at = now()
          WHERE id = $1 AND status <> 'delivered'`,
        [orderId],
      );
      return { outcome: 'already_delivered', code: existing.rows[0].code };
    }

    if (!DELIVERABLE.includes(order.status)) {
      return { outcome: 'not_payable', status: order.status };
    }

    // Берём свободный ключ. SKIP LOCKED: параллельные заказы не дерутся за одну строку.
    const claimed = await client.query(
      `UPDATE stock_keys
          SET order_id = $1, issued_at = now()
        WHERE id = (SELECT id FROM stock_keys
                     WHERE sku = $2 AND order_id IS NULL
                     ORDER BY id
                     FOR UPDATE SKIP LOCKED
                     LIMIT 1)
      RETURNING code`,
      [orderId, order.sku],
    );

    if (claimed.rowCount === 0) {
      return { outcome: 'out_of_stock', attempts: order.attempts + 1 };
    }

    await client.query(
      `UPDATE orders SET status = 'delivered', delivered_at = now(), last_error = NULL,
                         next_attempt_at = NULL, attempts = attempts + 1, updated_at = now()
        WHERE id = $1`,
      [orderId],
    );
    await recordDelivery(client, orderId, Number(order.amount_minor));

    log.info('delivery.done', { order_id: orderId, sku: order.sku, code: claimed.rows[0].code, trigger });
    return { outcome: 'delivered', code: claimed.rows[0].code };
  });

  if (result.outcome === 'out_of_stock') {
    // Ключей нет: заказ оплачен и ждёт завоза. Это восстановимое состояние, а не ошибка.
    await pool.query('UPDATE orders SET attempts = attempts + 1 WHERE id = $1', [orderId]);
    await markRecoverable(orderId, 'out_of_stock', 'нет свободных ключей', config.worker.outOfStockRetryMs);
  }

  return result;
}
