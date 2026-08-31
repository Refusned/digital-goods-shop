-- Схема магазина цифровых товаров.
-- Инварианты денег и выдачи держатся ограничениями БД, а не аккуратностью кода.

CREATE TABLE IF NOT EXISTS products (
  sku          TEXT PRIMARY KEY,
  name         TEXT   NOT NULL,
  type         TEXT   NOT NULL CHECK (type IN ('topup', 'key', 'subscription', 'giftcard')),
  price_minor  BIGINT NOT NULL CHECK (price_minor > 0),
  old_price_minor BIGINT,
  currency     TEXT   NOT NULL DEFAULT 'RUB',
  image        TEXT,
  section      TEXT   NOT NULL DEFAULT 'popular',  -- ряд витрины: popular | recommended | other
  popularity   INTEGER NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS products_showcase_idx
  ON products (section, popularity DESC, sku) WHERE is_active;

CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  sku             TEXT   NOT NULL REFERENCES products(sku),
  amount_minor    BIGINT NOT NULL CHECK (amount_minor >= 0),   -- сумма к оплате, уже со скидкой
  base_amount_minor BIGINT NOT NULL CHECK (base_amount_minor > 0),
  discount_minor  BIGINT NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  promocode       TEXT,
  currency        TEXT   NOT NULL,
  status          TEXT   NOT NULL CHECK (status IN (
                    'created', 'paid', 'delivering', 'delivered',
                    'payment_failed', 'out_of_stock', 'delivery_failed')),
  idempotency_key TEXT UNIQUE,           -- двойной клик "Купить" даёт один заказ
  paid_at         TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  last_payment_event_at TIMESTAMPTZ,     -- защита от вебхуков не по порядку
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_recovery_idx
  ON orders (next_attempt_at)
  WHERE status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed');

CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);

-- Пул ключей. Ключ уходит ровно в один заказ: order_id UNIQUE в обе стороны
-- (одна строка на ключ, и не больше одной строки на заказ).
CREATE TABLE IF NOT EXISTS stock_keys (
  id        BIGSERIAL PRIMARY KEY,
  sku       TEXT NOT NULL REFERENCES products(sku) ON DELETE CASCADE,
  code      TEXT NOT NULL,
  order_id  TEXT REFERENCES orders(id) ON DELETE SET NULL,
  issued_at TIMESTAMPTZ,
  UNIQUE (sku, code)
);

-- Главный инвариант выдачи: один заказ не может получить два ключа.
CREATE UNIQUE INDEX IF NOT EXISTS stock_keys_order_uidx ON stock_keys (order_id) WHERE order_id IS NOT NULL;

-- Быстрый доступ к свободным ключам нужного товара.
CREATE INDEX IF NOT EXISTS stock_keys_free_idx ON stock_keys (sku, id) WHERE order_id IS NULL;

-- События платёжной системы. order_id намеренно без внешнего ключа:
-- вебхук может прийти раньше, чем создан заказ.
CREATE TABLE IF NOT EXISTS payment_events (
  event_id     TEXT PRIMARY KEY,
  order_id     TEXT   NOT NULL,
  status       TEXT   NOT NULL CHECK (status IN ('paid', 'failed')),
  amount_minor BIGINT,
  currency     TEXT,
  occurred_at  TIMESTAMPTZ NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  outcome      TEXT
);

CREATE INDEX IF NOT EXISTS payment_events_pending_idx
  ON payment_events (order_id) WHERE processed_at IS NULL;

-- Промокоды. Лимит использований держит сама БД: used_count не может превысить max_uses.
CREATE TABLE IF NOT EXISTS promocodes (
  code       TEXT PRIMARY KEY,
  type       TEXT   NOT NULL CHECK (type IN ('percent', 'amount')),
  value      BIGINT NOT NULL CHECK (value > 0),
  currency   TEXT,
  max_uses   INTEGER NOT NULL CHECK (max_uses > 0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT promocodes_limit_check CHECK (used_count <= max_uses)
);

CREATE TABLE IF NOT EXISTS promocode_uses (
  order_id       TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  code           TEXT NOT NULL REFERENCES promocodes(code),
  discount_minor BIGINT NOT NULL CHECK (discount_minor >= 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS promocode_uses_code_idx ON promocode_uses (code);

-- Журнал денежных движений, двойная запись. Сумма дебета всегда равна сумме кредита.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id           BIGSERIAL PRIMARY KEY,
  txn_id       TEXT   NOT NULL,
  order_id     TEXT   NOT NULL,
  account      TEXT   NOT NULL CHECK (account IN ('cash', 'deferred_revenue', 'revenue', 'discounts')),
  direction    TEXT   NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ledger_txn_account_uidx ON ledger_entries (txn_id, account, direction);
CREATE INDEX IF NOT EXISTS ledger_order_idx ON ledger_entries (order_id);
