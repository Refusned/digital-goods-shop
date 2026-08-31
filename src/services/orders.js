import { createHash } from 'node:crypto';
import { pool, withTx, isUniqueViolation } from '../db.js';
import { newOrderId } from '../ids.js';
import { log } from '../logger.js';
import { claimPromo, recordPromoUse } from './promo.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Создание заказа.
 * Цена и скидка считаются на сервере: с клиента приходят только sku и промокод.
 * Idempotency-Key закрывает двойной клик "Купить" (второй запрос возвращает тот же заказ).
 */
export async function createOrder({ sku, promocode = null, idempotencyKey = null, orderId = null }) {
  if (!sku || typeof sku !== 'string') throw new ApiError(400, 'bad_request', 'sku обязателен');
  if (orderId !== null && !/^[A-Za-z0-9_-]{3,64}$/.test(orderId)) {
    throw new ApiError(400, 'bad_request', 'order_id: 3-64 символа [A-Za-z0-9_-]');
  }

  const product = await pool.query(
    'SELECT sku, price_minor, currency, is_active FROM products WHERE sku = $1', [sku]);
  if (product.rowCount === 0) throw new ApiError(404, 'product_not_found', `Товар ${sku} не найден`);
  if (!product.rows[0].is_active) throw new ApiError(409, 'product_inactive', `Товар ${sku} снят с продажи`);

  const base = Number(product.rows[0].price_minor);
  const currency = product.rows[0].currency;
  const id = orderId || newOrderId();

  // Идемпотентность это повтор ТОГО ЖЕ действия. Отпечаток запроса не даёт молча
  // подменить новый заказ старым результатом, если по тому же ключу пришли другие параметры.
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({
      sku,
      promocode: promocode ? String(promocode).toUpperCase() : null,
      order_id: orderId,
    }))
    .digest('hex')
    .slice(0, 32);

  try {
    return await withTx(async (client) => {
      const promo = await claimPromo(client, promocode, base, id);
      const discount = promo ? promo.discount_minor : 0;

      const { rows } = await client.query(
        `INSERT INTO orders (id, sku, amount_minor, base_amount_minor, discount_minor, promocode,
                             currency, status, idempotency_key, idempotency_fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'created', $8, $9)
         RETURNING *`,
        [id, sku, base - discount, base, discount, promo?.code ?? null, currency, idempotencyKey, fingerprint],
      );
      await recordPromoUse(client, id, promo);

      log.info('order.created', {
        order_id: id, sku, base_minor: base, discount_minor: discount,
        amount_minor: base - discount, promocode: promo?.code ?? null,
      });
      return { order: rows[0], reused: false, promo_applied: Boolean(promo), promo_requested: Boolean(promocode) };
    });
  } catch (err) {
    if (isUniqueViolation(err) && idempotencyKey) {
      const { rows } = await pool.query('SELECT * FROM orders WHERE idempotency_key = $1', [idempotencyKey]);
      if (rows.length) {
        if (rows[0].idempotency_fingerprint && rows[0].idempotency_fingerprint !== fingerprint) {
          log.warn('order.idempotency_conflict', { order_id: rows[0].id, idempotency_key: idempotencyKey });
          throw new ApiError(409, 'idempotency_conflict',
            'Этот Idempotency-Key уже использован для другого запроса');
        }
        log.info('order.idempotent_hit', { order_id: rows[0].id, idempotency_key: idempotencyKey });
        return { order: rows[0], reused: true, promo_applied: Boolean(rows[0].promocode), promo_requested: Boolean(promocode) };
      }
    }
    if (isUniqueViolation(err)) {
      const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
      if (rows.length) return { order: rows[0], reused: true, promo_applied: Boolean(rows[0].promocode), promo_requested: Boolean(promocode) };
    }
    throw err;
  }
}

export async function getOrder(id) {
  const { rows } = await pool.query(
    `SELECT o.*, p.name AS product_name, p.image AS product_image, k.code AS delivery_code, k.issued_at
       FROM orders o
       JOIN products p ON p.sku = o.sku
       LEFT JOIN stock_keys k ON k.order_id = o.id
      WHERE o.id = $1`,
    [id],
  );
  if (rows.length === 0) throw new ApiError(404, 'order_not_found', `Заказ ${id} не найден`);
  return rows[0];
}

/** Код показываем только когда он реально выдан этому заказу. */
export function serializeOrder(row) {
  return {
    id: row.id,
    sku: row.sku,
    product_name: row.product_name,
    product_image: row.product_image,
    amount: Number(row.amount_minor),
    base_amount: Number(row.base_amount_minor),
    discount: Number(row.discount_minor),
    promocode: row.promocode,
    currency: row.currency,
    status: row.status,
    created_at: row.created_at,
    paid_at: row.paid_at,
    delivered_at: row.delivered_at,
    attempts: row.attempts,
    last_error: row.last_error,
    delivery: row.delivery_code ? { code: row.delivery_code, issued_at: row.issued_at } : null,
  };
}

export async function markRecoverable(orderId, status, error, delayMs) {
  await pool.query(
    `UPDATE orders
        SET status = $2, last_error = $3,
            next_attempt_at = now() + ($4 || ' milliseconds')::interval,
            updated_at = now()
      WHERE id = $1 AND status <> 'delivered'`,
    [orderId, status, error, String(delayMs)],
  );
  log.warn('order.recoverable', { order_id: orderId, status, error, retry_in_ms: delayMs });
}
