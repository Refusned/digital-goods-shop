/**
 * Бронь ключа под заказ.
 *
 * Ключ занимается в момент оформления, ДО оплаты. Это и есть честная развязка гонки
 * за последнюю единицу: победитель уходит на оплату, проигравший сразу получает понятный отказ
 * и ничего не платит. Обратный порядок (оплата, потом поиск ключа) неизбежно рождает
 * оплаченные заказы без товара.
 *
 * Бронь ограничена по времени: иначе брошенное оформление навсегда вынимало бы товар из продажи.
 * Свободным считается ключ, который не выдан и не держится ЖИВОЙ бронью, поэтому истёкшая бронь
 * освобождает товар сама по себе, даже если фоновая уборка почему-то не отработала.
 */

import { pool } from '../db.js';
import { config } from '../config.js';
import { log } from '../logger.js';

/**
 * Забронировать один свободный ключ под заказ.
 *
 * FOR UPDATE SKIP LOCKED разводит параллельные попытки: двое одновременно берущих последнюю
 * единицу не встанут в очередь на одну строку, один получит ключ, другой пустой результат.
 * Уникальный индекс по reserved_by_order добивает случай, когда заказ пытается получить второй ключ.
 */
export async function reserveKey(client, orderId, sku, ttlMs = config.reservation.ttlMs) {
  const { rows } = await client.query(
    `UPDATE stock_keys
        SET reserved_by_order = $1,
            reserved_until = now() + ($3 || ' milliseconds')::interval
      WHERE id = (
        SELECT id FROM stock_keys
         WHERE sku = $2
           AND order_id IS NULL
           AND (reserved_by_order IS NULL OR reserved_until IS NULL OR reserved_until <= now())
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
    RETURNING id, code, reserved_until`,
    [orderId, sku, String(ttlMs)],
  );
  return rows[0] ?? null;
}

/**
 * Ключ, забронированный под заказ. Бронь считается действующей, пока не истёк срок:
 * после истечения ключ мог уже уйти другому покупателю, и притворяться, что он наш, нельзя.
 */
export async function activeReservation(client, orderId) {
  const { rows } = await client.query(
    `SELECT id, code, reserved_until FROM stock_keys
      WHERE reserved_by_order = $1 AND order_id IS NULL AND reserved_until > now()`,
    [orderId],
  );
  return rows[0] ?? null;
}

/** Снять бронь с ключей заказа: товар возвращается в продажу немедленно. */
export async function releaseReservation(client, orderId) {
  const { rowCount } = await client.query(
    `UPDATE stock_keys SET reserved_by_order = NULL, reserved_until = NULL
      WHERE reserved_by_order = $1 AND order_id IS NULL`,
    [orderId],
  );
  return rowCount;
}

/**
 * Продлить бронь. Нужно, когда покупатель ушёл на оплату: время оплаты не должно съедать
 * время, которое он потратил на оформление.
 */
export async function extendReservation(orderId, ttlMs = config.reservation.paymentTtlMs) {
  const { rows } = await pool.query(
    `WITH extended AS (
       UPDATE stock_keys
          SET reserved_until = now() + ($2 || ' milliseconds')::interval
        WHERE reserved_by_order = $1 AND order_id IS NULL
       RETURNING reserved_until
     )
     UPDATE orders o SET reserved_until = (SELECT reserved_until FROM extended), updated_at = now()
      WHERE o.id = $1 AND o.status = 'created' AND EXISTS (SELECT 1 FROM extended)
     RETURNING o.reserved_until`,
    [orderId, String(ttlMs)],
  );
  return rows[0]?.reserved_until ?? null;
}

/**
 * Уборка просроченных броней.
 *
 * Возвращает заказы, чья бронь снята: их статус становится "expired", а товар возвращается
 * в продажу. Оплаченные заказы уборка не трогает никогда: там бронь уже сыграла свою роль.
 */
export async function sweepExpiredReservations({ limit = 100 } = {}) {
  const { rows } = await pool.query(
    `WITH expired AS (
       SELECT id FROM orders
        WHERE status = 'created'
          AND reserved_until IS NOT NULL
          AND reserved_until <= now()
        ORDER BY reserved_until
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     ),
     freed AS (
       UPDATE stock_keys k SET reserved_by_order = NULL, reserved_until = NULL
         FROM expired e
        WHERE k.reserved_by_order = e.id AND k.order_id IS NULL
       RETURNING k.sku, e.id AS order_id
     )
     UPDATE orders o
        SET status = 'expired', last_error = 'reservation_expired', updated_at = now()
       FROM expired e
      WHERE o.id = e.id
     RETURNING o.id, o.sku`,
    [limit],
  );
  if (rows.length) log.info('reservation.expired', { orders: rows.map((r) => r.id) });
  return rows;
}
