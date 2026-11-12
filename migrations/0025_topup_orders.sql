-- 0025: the orders this plane created at checkout (fc#2052).
--
-- A verified PayPal webhook proves PayPal sent the event. It does not prove the order is one this
-- plane created, nor that its tenant and amount are the ones the plane asked for: the merchant account
-- can carry orders from other integrations, and the tenant on the event is a reference read back off
-- the event. A settlement is credited only when its order id, tenant and amount match a row here.
CREATE TABLE IF NOT EXISTS topup_orders (
  rail TEXT NOT NULL,
  order_ref TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  amount_micro_usd INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (rail, order_ref)
);
