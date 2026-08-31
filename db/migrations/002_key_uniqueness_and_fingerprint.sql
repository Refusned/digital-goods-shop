-- Один код не может уйти в два заказа даже через два разных SKU:
-- прежний UNIQUE (sku, code) этого не запрещал.
CREATE UNIQUE INDEX IF NOT EXISTS stock_keys_code_uidx ON stock_keys (code);

-- Идемпотентность создания заказа должна означать повтор ТОГО ЖЕ действия,
-- поэтому рядом с ключом храним отпечаток запроса.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_fingerprint TEXT;
