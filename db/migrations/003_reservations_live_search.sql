-- Второй этап: живая витрина, честная покупка последней единицы, бронь с таймером,
-- устойчивость покупки и мгновенный поиск по большому каталогу.
--
-- Миграция эволюционная: первый этап не переписывается, к нему добавляются бронь,
-- уведомления об изменениях и индексы под поиск.

-- ---------------------------------------------------------------------------
-- Бронь ключа под заказ
-- ---------------------------------------------------------------------------
--
-- Ключ бронируется в момент оформления, ДО оплаты. Это и есть честная развязка гонки
-- за последнюю единицу: победитель уходит на оплату, проигравший сразу получает отказ
-- и ничего не платит, вместо того чтобы оплатить и остаться без товара.

ALTER TABLE stock_keys ADD COLUMN IF NOT EXISTS reserved_by_order TEXT REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE stock_keys ADD COLUMN IF NOT EXISTS reserved_until    TIMESTAMPTZ;

-- Один ключ не может быть забронирован под два заказа, и один заказ не держит два ключа.
CREATE UNIQUE INDEX IF NOT EXISTS stock_keys_reserved_order_uidx
  ON stock_keys (reserved_by_order) WHERE reserved_by_order IS NOT NULL;

-- Поиск свободного ключа под бронь: сама свежесть брони проверяется в запросе,
-- потому что предикат с now() в индексе недопустим.
CREATE INDEX IF NOT EXISTS stock_keys_reservable_idx
  ON stock_keys (sku, reserved_until, id) WHERE order_id IS NULL;

-- Срок брони на уровне заказа: по нему рисуется обратный отсчёт и по нему снимается бронь.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ;

-- expired: бронь истекла, оплата не пришла, товар вернулся в продажу.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN (
  'created', 'paid', 'delivering', 'delivered',
  'payment_failed', 'out_of_stock', 'delivery_failed', 'expired'));

CREATE INDEX IF NOT EXISTS orders_reservation_idx
  ON orders (reserved_until) WHERE status = 'created';

-- ---------------------------------------------------------------------------
-- Живая витрина: уведомления об изменениях наличия и цены
-- ---------------------------------------------------------------------------
--
-- Уведомление шлёт БАЗА, а не прикладной код. Иначе изменение, сделанное в обход приложения
-- (миграция, ручной UPDATE, вторая копия сервиса), не доехало бы до открытых вкладок,
-- и витрина показывала бы неправду до перезагрузки страницы.

CREATE OR REPLACE FUNCTION notify_stock_change() RETURNS TRIGGER AS $$
DECLARE
  changed_sku TEXT;
BEGIN
  changed_sku := COALESCE(NEW.sku, OLD.sku);
  -- В канал уходит только SKU: подписчик сам прочитает актуальный остаток одним запросом.
  -- Так уведомление остаётся дешёвым и не зависит от того, сколько строк изменилось.
  PERFORM pg_notify('shop_stock', changed_sku);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS stock_keys_notify ON stock_keys;
CREATE TRIGGER stock_keys_notify
  AFTER INSERT OR UPDATE OF order_id, reserved_by_order, reserved_until OR DELETE ON stock_keys
  FOR EACH ROW EXECUTE FUNCTION notify_stock_change();

CREATE OR REPLACE FUNCTION notify_product_change() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('shop_product', NEW.sku);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS products_notify ON products;
CREATE TRIGGER products_notify
  AFTER UPDATE OF price_minor, old_price_minor, is_active ON products
  FOR EACH ROW EXECUTE FUNCTION notify_product_change();

-- ---------------------------------------------------------------------------
-- Мгновенный поиск по каталогу в тысячи позиций
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Поиск по подстроке: обычный btree тут бесполезен, нужен триграммный индекс.
-- По артикулу тоже: покупатели ищут и по нему, а без индекса весь запрос уйдёт в скан таблицы,
-- потому что условия объединены через OR.
CREATE INDEX IF NOT EXISTS products_name_trgm_idx ON products USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS products_sku_trgm_idx ON products USING gin (sku gin_trgm_ops);

-- Фильтры и сортировка витрины: тип, цена, популярность.
CREATE INDEX IF NOT EXISTS products_type_price_idx ON products (type, price_minor) WHERE is_active;
CREATE INDEX IF NOT EXISTS products_price_idx ON products (price_minor, sku) WHERE is_active;
CREATE INDEX IF NOT EXISTS products_popularity_idx ON products (popularity DESC, sku) WHERE is_active;

-- Денормализованный остаток: считать наличие по stock_keys на каждый запрос поиска
-- по каталогу в тысячи позиций слишком дорого, а витрине наличие нужно всегда.
CREATE TABLE IF NOT EXISTS product_stock (
  sku        TEXT PRIMARY KEY REFERENCES products(sku) ON DELETE CASCADE,
  available  INTEGER NOT NULL DEFAULT 0 CHECK (available >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_stock_available_idx ON product_stock (available) WHERE available > 0;

/**
 * Пересчёт остатка одного товара.
 * Свободным считается ключ, который не выдан и не забронирован живой бронью.
 */
CREATE OR REPLACE FUNCTION refresh_product_stock(target_sku TEXT) RETURNS INTEGER AS $$
DECLARE
  free_count INTEGER;
BEGIN
  SELECT count(*)::int INTO free_count
    FROM stock_keys
   WHERE sku = target_sku
     AND order_id IS NULL
     AND (reserved_by_order IS NULL OR reserved_until IS NULL OR reserved_until <= now());

  INSERT INTO product_stock (sku, available) VALUES (target_sku, free_count)
  ON CONFLICT (sku) DO UPDATE SET available = EXCLUDED.available, updated_at = now();

  RETURN free_count;
END;
$$ LANGUAGE plpgsql;

-- Проекция остатка обновляется той же транзакцией, что и изменение ключей:
-- витрина не должна показывать наличие, которого уже нет.
CREATE OR REPLACE FUNCTION sync_product_stock() RETURNS TRIGGER AS $$
BEGIN
  PERFORM refresh_product_stock(COALESCE(NEW.sku, OLD.sku));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS stock_keys_project ON stock_keys;
CREATE TRIGGER stock_keys_project
  AFTER INSERT OR UPDATE OF order_id, reserved_by_order, reserved_until OR DELETE ON stock_keys
  FOR EACH ROW EXECUTE FUNCTION sync_product_stock();

-- Первичное наполнение проекции по уже существующим ключам.
INSERT INTO product_stock (sku, available)
SELECT p.sku, COALESCE(k.free, 0)
  FROM products p
  LEFT JOIN (
    SELECT sku, count(*)::int AS free
      FROM stock_keys
     WHERE order_id IS NULL AND (reserved_by_order IS NULL OR reserved_until IS NULL OR reserved_until <= now())
     GROUP BY sku) k ON k.sku = p.sku
ON CONFLICT (sku) DO UPDATE SET available = EXCLUDED.available, updated_at = now();

-- ---------------------------------------------------------------------------
-- Устойчивость оплаты к повторам
-- ---------------------------------------------------------------------------
--
-- Двойной клик по "Оплатить", кнопка "Назад" и обрыв связи не должны приводить ко второму
-- платежу. Ключ идемпотентности платежа хранится рядом с заказом: повтор возвращает тот же итог.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_key_uidx
  ON orders (payment_idempotency_key) WHERE payment_idempotency_key IS NOT NULL;
