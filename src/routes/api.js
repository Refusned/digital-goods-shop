import { Router } from 'express';
import { pool } from '../db.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { createOrder, getOrder, serializeOrder } from '../services/orders.js';
import { applyPendingEvents, handlePaymentWebhook } from '../services/payments.js';
import { deliverOrder } from '../services/delivery.js';
import { quotePromo } from '../services/promo.js';
import { reconciliationReport } from '../services/reconcile.js';

export const apiRouter = Router();

// --- Витрина ----------------------------------------------------------------

apiRouter.get('/api/catalog', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 24, 100);
    const section = req.query.section || null;
    const { rows } = section
      ? await pool.query(
          `SELECT p.sku, p.name, p.type, p.price_minor, p.old_price_minor, p.currency, p.image, p.section,
                  count(k.id) FILTER (WHERE k.order_id IS NULL)::int AS available
             FROM products p LEFT JOIN stock_keys k ON k.sku = p.sku
            WHERE p.is_active AND p.section = $1
            GROUP BY p.sku
            ORDER BY p.popularity DESC, p.sku
            LIMIT $2`,
          [section, limit],
        )
      : await pool.query(
          `SELECT p.sku, p.name, p.type, p.price_minor, p.old_price_minor, p.currency, p.image, p.section,
                  count(k.id) FILTER (WHERE k.order_id IS NULL)::int AS available
             FROM products p LEFT JOIN stock_keys k ON k.sku = p.sku
            WHERE p.is_active
            GROUP BY p.sku
            ORDER BY p.popularity DESC, p.sku
            LIMIT $1`,
          [limit],
        );

    res.json({
      items: rows.map((r) => ({
        sku: r.sku, name: r.name, type: r.type, section: r.section,
        price: Number(r.price_minor), old_price: r.old_price_minor ? Number(r.old_price_minor) : null,
        currency: r.currency, image: r.image, available: r.available,
      })),
    });
  } catch (err) { next(err); }
});

// --- Промокод: предпросмотр, код не расходуется ------------------------------

apiRouter.post('/api/promo/quote', async (req, res, next) => {
  try {
    const { code, sku } = req.body || {};
    const product = await pool.query('SELECT price_minor FROM products WHERE sku = $1', [sku]);
    if (product.rowCount === 0) return res.status(404).json({ error: 'product_not_found' });
    res.json(await quotePromo(code, Number(product.rows[0].price_minor)));
  } catch (err) { next(err); }
});

// --- Заказы -----------------------------------------------------------------

apiRouter.post('/api/orders', async (req, res, next) => {
  try {
    const idempotencyKey = req.get('Idempotency-Key') || req.body?.idempotency_key || null;
    const created = await createOrder({
      sku: req.body?.sku,
      promocode: req.body?.promocode ?? null,
      idempotencyKey,
      orderId: req.body?.order_id ?? null,
    });

    // Вебхук мог прийти раньше заказа: применяем накопленные события сразу.
    const applied = await applyPendingEvents(created.order.id);
    if (applied.some((r) => r.deliver)) deliverOrder(created.order.id, { trigger: 'order.created' }).catch(() => {});

    const fresh = await getOrder(created.order.id);
    res.status(created.reused ? 200 : 201).json({
      ...serializeOrder(fresh),
      promo_applied: created.promo_applied,
      promo_rejected: created.promo_requested && !created.promo_applied,
    });
  } catch (err) { next(err); }
});

apiRouter.get('/api/orders/:id', async (req, res, next) => {
  try {
    res.json(serializeOrder(await getOrder(req.params.id)));
  } catch (err) { next(err); }
});

/**
 * Эмуляция оплаты вместо эквайринга: шлёт вебхук по контракту на наш же эндпоинт,
 * ровно так же, как это делала бы платёжная система.
 */
apiRouter.post('/api/orders/:id/simulate-payment', async (req, res, next) => {
  try {
    const order = await getOrder(req.params.id);
    const success = req.body?.success !== false;
    const payload = {
      event_id: `evt_${Math.random().toString(36).slice(2, 12)}`,
      order_id: order.id,
      status: success ? 'paid' : 'failed',
      amount: Number(order.amount_minor),
      currency: order.currency,
      created_at: new Date().toISOString(),
    };

    const hook = await fetch(`http://127.0.0.1:${req.socket.localPort}/webhook/payment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((r) => r.json()).catch((e) => ({ error: e.message }));

    res.json({ sent: payload, webhook_response: hook });
  } catch (err) { next(err); }
});

// --- Вебхук платёжной системы -----------------------------------------------

apiRouter.post('/webhook/payment', async (req, res, next) => {
  try {
    const result = await handlePaymentWebhook(req.body);
    res.status(200).json({ received: true, outcome: result.outcome });
    if (result.deliver && result.orderId) deliverOrder(result.orderId, { trigger: 'webhook' }).catch(() => {});
  } catch (err) { next(err); }
});

// --- Админка ----------------------------------------------------------------

function requireAdmin(req, res, next) {
  if (!config.adminToken) return next();          // токен не задан: админка открыта
  const token = req.get('X-Admin-Token') || req.query.token;
  if (token === config.adminToken) return next();
  res.status(401).json({ error: 'unauthorized' });
}

apiRouter.get('/api/admin/reconciliation', requireAdmin, async (req, res, next) => {
  try {
    res.json(await reconciliationReport({ limit: Math.min(Number(req.query.limit) || 100, 500) }));
  } catch (err) { next(err); }
});

/** Ручная повторная выдача. Идемпотентна: на выданном заказе ничего не меняет. */
apiRouter.post('/api/admin/orders/:id/deliver', requireAdmin, async (req, res, next) => {
  try {
    const result = await deliverOrder(req.params.id, { trigger: 'admin' });
    res.json({ result, order: serializeOrder(await getOrder(req.params.id)) });
  } catch (err) { next(err); }
});

/** Пополнение пула ключей. Дубли кодов игнорируются. */
apiRouter.post('/api/admin/stock/:sku/restock', requireAdmin, async (req, res, next) => {
  try {
    const codes = Array.isArray(req.body?.codes) && req.body.codes.length
      ? req.body.codes
      : Array.from({ length: Number(req.body?.count ?? 1) }, () =>
          `RESTOCK-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`);

    // Код глобально уникален: тот же код в другом SKU это тот же товарный ключ,
    // и он не должен уйти во второй заказ.
    let added = 0;
    const rejected = [];
    for (const code of codes) {
      const r = await pool.query(
        'INSERT INTO stock_keys (sku, code) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING RETURNING id',
        [req.params.sku, code],
      );
      if (r.rowCount === 1) added += 1;
      else rejected.push(code);
    }
    log.info('stock.restocked', { sku: req.params.sku, added, rejected: rejected.length });
    res.status(rejected.length && added === 0 ? 409 : 200)
       .json({ sku: req.params.sku, added, rejected });
  } catch (err) { next(err); }
});
