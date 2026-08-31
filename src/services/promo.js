import { pool } from '../db.js';
import { log } from '../logger.js';

/**
 * Промокоды.
 *
 * Лимит использований соблюдается под параллельными запросами за счёт условного UPDATE:
 *   UPDATE promocodes SET used_count = used_count + 1 WHERE code = $1 AND used_count < max_uses
 * Строка блокируется на время инкремента, поэтому N параллельных попыток дадут ровно
 * min(N, max_uses) успехов. Дополнительно тот же инвариант закреплён CHECK (used_count <= max_uses).
 *
 * Скидку всегда считает сервер: с клиента приходит только код.
 */

/** Расчёт скидки по правилам кода. Скидка никогда не превышает цену. */
export function calcDiscount(promo, baseAmountMinor) {
  const raw = promo.type === 'percent'
    ? Math.floor((baseAmountMinor * Number(promo.value)) / 100)
    : Number(promo.value);
  return Math.max(0, Math.min(raw, baseAmountMinor));
}

/** Предпросмотр для витрины: код не расходуется. */
export async function quotePromo(code, baseAmountMinor) {
  if (!code) return { applied: false };
  const { rows } = await pool.query(
    'SELECT code, type, value, currency, max_uses, used_count, is_active FROM promocodes WHERE upper(code) = upper($1)',
    [code],
  );
  if (rows.length === 0) return { applied: false, reason: 'not_found' };
  const promo = rows[0];
  if (!promo.is_active) return { applied: false, reason: 'inactive' };
  if (promo.used_count >= promo.max_uses) return { applied: false, reason: 'limit_reached' };

  const discount = calcDiscount(promo, baseAmountMinor);
  return {
    applied: true,
    code: promo.code,
    type: promo.type,
    value: Number(promo.value),
    discount_minor: discount,
    total_minor: baseAmountMinor - discount,
    uses_left: promo.max_uses - promo.used_count,
  };
}

/**
 * Захват использования внутри транзакции создания заказа.
 * Возвращает null, если код нельзя применить (нет такого, выключен, лимит исчерпан).
 * Саму строку использования пишет recordPromoUse уже после вставки заказа:
 * promocode_uses ссылается на orders, поэтому порядок важен.
 */
export async function claimPromo(client, code, baseAmountMinor, orderId) {
  if (!code) return null;

  const { rows } = await client.query(
    `UPDATE promocodes
        SET used_count = used_count + 1
      WHERE upper(code) = upper($1)
        AND is_active
        AND used_count < max_uses
      RETURNING code, type, value, max_uses, used_count`,
    [code],
  );
  if (rows.length === 0) {
    log.info('promo.rejected', { code, order_id: orderId });
    return null;
  }

  const promo = rows[0];
  const discount = calcDiscount(promo, baseAmountMinor);
  log.info('promo.claimed', { code: promo.code, order_id: orderId, discount_minor: discount, used: promo.used_count });
  return { code: promo.code, discount_minor: discount };
}

/** Фиксация использования. Вызывается сразу после вставки заказа, в той же транзакции. */
export async function recordPromoUse(client, orderId, promo) {
  if (!promo) return;
  await client.query(
    'INSERT INTO promocode_uses (order_id, code, discount_minor) VALUES ($1, $2, $3)',
    [orderId, promo.code, promo.discount_minor],
  );
}

/**
 * Возврата использования при неуспешной оплате намеренно НЕТ.
 *
 * Освобождение лимита по событию failed открывает обход: код освобождается, его занимает
 * другой заказ, а запоздавший paid оживляет первый заказ, у которого скидка уже записана.
 * В результате код с лимитом 1 оплачивают двое. Возврат использования это часть отмены заказа,
 * а отмены в контуре задания нет.
 */
