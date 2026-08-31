import { pool } from '../db.js';
import { ledgerBalance } from './ledger.js';

/** Сверка для админки: что оплачено и не выдано, что выдано и не оплачено, сходятся ли деньги. */
export async function reconciliationReport({ limit = 100 } = {}) {
  const paidNotDelivered = await pool.query(
    `SELECT o.id, o.sku, p.name AS product_name, o.status, o.amount_minor, o.paid_at,
            o.attempts, o.last_error, o.next_attempt_at
       FROM orders o
       JOIN products p ON p.sku = o.sku
       LEFT JOIN stock_keys k ON k.order_id = o.id
      WHERE o.paid_at IS NOT NULL AND k.id IS NULL AND o.status <> 'payment_failed'
      ORDER BY o.paid_at
      LIMIT $1`,
    [limit],
  );

  const deliveredNotPaid = await pool.query(
    `SELECT o.id, o.sku, o.status, o.amount_minor, k.code, k.issued_at
       FROM stock_keys k
       JOIN orders o ON o.id = k.order_id
      WHERE o.paid_at IS NULL AND o.amount_minor > 0
      ORDER BY k.issued_at
      LIMIT $1`,
    [limit],
  );

  const orphanEvents = await pool.query(
    `SELECT event_id, order_id, status, amount_minor, occurred_at, received_at
       FROM payment_events WHERE processed_at IS NULL
      ORDER BY received_at LIMIT $1`,
    [limit],
  );

  const stock = await pool.query(
    `SELECT p.sku, p.name,
            count(*) FILTER (WHERE k.order_id IS NULL)::int AS free,
            count(*)::int AS total
       FROM products p LEFT JOIN stock_keys k ON k.sku = p.sku
      GROUP BY p.sku, p.name
      ORDER BY free, p.sku`,
  );

  const promo = await pool.query(
    'SELECT code, type, value, max_uses, used_count FROM promocodes ORDER BY code');

  const money = await ledgerBalance(pool);

  return {
    generated_at: new Date().toISOString(),
    paid_not_delivered: { count: paidNotDelivered.rowCount, items: paidNotDelivered.rows },
    delivered_not_paid: { count: deliveredNotPaid.rowCount, items: deliveredNotPaid.rows },
    payment_events_without_order: { count: orphanEvents.rowCount, items: orphanEvents.rows },
    stock: stock.rows,
    promocodes: promo.rows,
    ledger: money,
    healthy: deliveredNotPaid.rowCount === 0 && money.balanced,
  };
}
