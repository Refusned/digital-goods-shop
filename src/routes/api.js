import { Router } from 'express';
import { pool } from '../db.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { createOrder, getOrder, serializeOrder } from '../services/orders.js';
import { applyPendingEvents, handlePaymentWebhook } from '../services/payments.js';
import { deliverOrder } from '../services/delivery.js';
import { quotePromo } from '../services/promo.js';
import { reconciliationReport } from '../services/reconcile.js';
import { searchProducts, countProducts, SORT_KEYS } from '../services/search.js';
import { addClient, clientCount } from '../services/live.js';
import { extendReservation, releaseReservation, sweepExpiredReservations } from '../services/reservations.js';

export const apiRouter = Router();

// --- Витрина ----------------------------------------------------------------

apiRouter.get('/api/catalog', async (req, res, next) => {
  try {
    const result = await searchProducts({
      section: req.query.section || null,
      type: req.query.type || null,
      limit: Math.min(Number(req.query.limit) || 24, 100),
      sort: 'popular',
    });
    res.json({ items: result.items });
  } catch (err) { next(err); }
});

/**
 * Поиск и фильтры по каталогу.
 * Отдельная ручка от витрины: у неё курсорная пагинация и свой набор фильтров,
 * а витрина это её частный случай с сортировкой по популярности.
 */
apiRouter.get('/api/search', async (req, res, next) => {
  try {
    const params = {
      q: req.query.q ?? '',
      type: req.query.type || null,
      section: req.query.section || null,
      minPrice: req.query.min_price ?? null,
      maxPrice: req.query.max_price ?? null,
      inStock: req.query.in_stock === '1' || req.query.in_stock === 'true',
      sort: SORT_KEYS.includes(req.query.sort) ? req.query.sort : 'popular',
      cursor: req.query.cursor || null,
      limit: req.query.limit,
    };
    const result = await searchProducts(params);
    // Общее число нужно только на первой странице: при листании оно не меняется.
    const counted = params.cursor ? null : await countProducts(params);
    res.json({ ...result, total: counted?.total, total_capped: counted?.capped });
  } catch (err) { next(err); }
});

/**
 * Живой канал витрины.
 *
 * Server-Sent Events: поток в одну сторону со встроенным переподключением на стороне браузера.
 * Заголовки отключают буферизацию, иначе прокси придержит события до заполнения буфера
 * и «сразу» превратится в «когда-нибудь».
 */
apiRouter.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ server_time: new Date().toISOString() })}\n\n`);

  const remove = addClient(res);
  req.on('close', () => { remove(); res.end(); });
});

apiRouter.get('/api/stream/stats', (_req, res) => res.json({ clients: clientCount() }));

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
    // Брошенные оформления не должны держать товар: перед попыткой брони снимаем просроченные.
    // Иначе покупатель видел бы "раскупили" там, где товар уже свободен.
    await sweepExpiredReservations({ limit: 20 });
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
 *
 * Устойчивость к повторам: event_id ДЕТЕРМИНИРОВАН по ключу идемпотентности платежа.
 * Двойной клик, кнопка "Назад", обновление страницы и повтор после обрыва связи дают
 * одно и то же событие, а повторное событие с тем же event_id платёжный контур уже умеет
 * отбрасывать. Без ключа поведение прежнее: каждое нажатие это отдельное событие.
 */
apiRouter.post('/api/orders/:id/simulate-payment', async (req, res, next) => {
  try {
    const order = await getOrder(req.params.id);
    const success = req.body?.success !== false;
    const key = req.get('Idempotency-Key') || req.body?.idempotency_key || null;

    if (key) {
      // Ключ платежа закрепляется за заказом: тот же ключ на другом заказе это ошибка клиента.
      const claim = await pool.query(
        `UPDATE orders SET payment_idempotency_key = $2, updated_at = now()
          WHERE id = $1 AND (payment_idempotency_key IS NULL OR payment_idempotency_key = $2)
        RETURNING payment_idempotency_key`,
        [order.id, key],
      ).catch((err) => (err.code === '23505' ? { rowCount: 0 } : Promise.reject(err)));
      if (claim.rowCount === 0) {
        return res.status(409).json({ error: 'payment_key_conflict', message: 'Этот ключ оплаты уже использован для другого заказа' });
      }
    }

    const payload = {
      event_id: key ? `evt_${key}`.slice(0, 128) : `evt_${Math.random().toString(36).slice(2, 12)}`,
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

    res.json({ sent: payload, webhook_response: hook, order: serializeOrder(await getOrder(order.id)) });
  } catch (err) { next(err); }
});

/**
 * Уход на оплату продлевает бронь.
 * Время, потраченное на оформление, не должно съедать время на оплату,
 * но и держать товар бесконечно нельзя: продление тоже ограничено сроком.
 */
apiRouter.post('/api/orders/:id/hold', async (req, res, next) => {
  try {
    const order = await getOrder(req.params.id);
    if (order.status !== 'created') {
      return res.json({ ...serializeOrder(order), extended: false });
    }
    const until = await extendReservation(order.id);
    res.json({ ...serializeOrder(await getOrder(order.id)), extended: Boolean(until) });
  } catch (err) { next(err); }
});

/** Отказ от оформления: товар возвращается в продажу сразу, не дожидаясь конца брони. */
apiRouter.post('/api/orders/:id/cancel', async (req, res, next) => {
  try {
    const order = await getOrder(req.params.id);
    if (order.status !== 'created') {
      return res.status(409).json({ error: 'not_cancellable', status: order.status });
    }
    await releaseReservation(pool, order.id);
    await pool.query(
      `UPDATE orders SET status = 'expired', last_error = 'cancelled_by_buyer', reserved_until = NULL, updated_at = now()
        WHERE id = $1 AND status = 'created'`,
      [order.id],
    );
    res.json(serializeOrder(await getOrder(order.id)));
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
    const product = await pool.query('SELECT 1 FROM products WHERE sku = $1', [req.params.sku]);
    if (product.rowCount === 0) return res.status(404).json({ error: 'product_not_found' });

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
