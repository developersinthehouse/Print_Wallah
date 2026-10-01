CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS shops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  admin_email TEXT NOT NULL UNIQUE,
  admin_password_hash TEXT NOT NULL,
  pricing JSONB NOT NULL DEFAULT '{"bw_a4":2,"color_a4":10,"bw_a3":4,"color_a3":20,"glossy_a4":15,"photo_sheet":30}'::jsonb,
  print_config JSONB NOT NULL DEFAULT '{"paperSizes":["A4","A3"],"paperTypes":["normal","glossy"],"color":true,"duplex":true,"photo":true,"defaultPaper":"A4"}'::jsonb,
  upi_id TEXT,
  upi_name TEXT,
  access_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  access_end TIMESTAMPTZ NOT NULL,
  manually_locked BOOLEAN NOT NULL DEFAULT false,
  agent_token_hash TEXT,
  agent_name TEXT,
  agent_last_seen TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shops_status_idx ON shops (manually_locked, access_end);
CREATE INDEX IF NOT EXISTS shops_created_idx ON shops (created_at DESC);

CREATE TABLE IF NOT EXISTS uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_token TEXT NOT NULL UNIQUE,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL,
  page_count INTEGER NOT NULL CHECK (page_count > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS uploads_expiry_idx ON uploads (expires_at);
CREATE INDEX IF NOT EXISTS uploads_shop_idx ON uploads (shop_id, created_at DESC);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_code TEXT NOT NULL UNIQUE,
  shop_id UUID NOT NULL REFERENCES shops(id),
  upload_id UUID NOT NULL UNIQUE REFERENCES uploads(id),
  print_file_name TEXT,
  customer_name TEXT,
  customer_phone TEXT,
  config JSONB NOT NULL,
  page_count INTEGER NOT NULL CHECK (page_count > 0),
  copies INTEGER NOT NULL CHECK (copies BETWEEN 1 AND 500),
  amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','upi')),
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','verified','failed','cancelled')),
  order_status TEXT NOT NULL DEFAULT 'pending_payment' CHECK (order_status IN ('pending_payment','cash_confirmation_pending','payment_review','print_queued','printing','completed','failed','cancelled')),
  print_status TEXT NOT NULL DEFAULT 'not_ready' CHECK (print_status IN ('not_ready','queued','claimed','printing','completed','failed')),
  payment_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS orders_shop_created_idx ON orders (shop_id, created_at DESC);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS print_file_name TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS orders_upload_unique_idx ON orders (upload_id);
CREATE INDEX IF NOT EXISTS orders_queue_idx ON orders (shop_id, print_status, created_at);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (shop_id, order_status, created_at DESC);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  shop_id UUID NOT NULL REFERENCES shops(id),
  provider TEXT NOT NULL DEFAULT 'upi_manual',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','failed','cancelled')),
  amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  reference TEXT,
  verified_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_shop_idx ON payments (shop_id, created_at DESC);

CREATE TABLE IF NOT EXISTS print_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  shop_id UUID NOT NULL REFERENCES shops(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','claimed','printing','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS print_jobs_queue_idx ON print_jobs (shop_id, status, created_at);

CREATE TABLE IF NOT EXISTS access_extensions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  days INTEGER NOT NULL CHECK (days > 0),
  previous_expiry TIMESTAMPTZ NOT NULL,
  new_expiry TIMESTAMPTZ NOT NULL,
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  shop_id UUID REFERENCES shops(id) ON DELETE SET NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_shop_idx ON audit_log (shop_id, created_at DESC);

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS shops_touch_updated_at ON shops;
CREATE TRIGGER shops_touch_updated_at BEFORE UPDATE ON shops FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS orders_touch_updated_at ON orders;
CREATE TRIGGER orders_touch_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS payments_touch_updated_at ON payments;
CREATE TRIGGER payments_touch_updated_at BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS print_jobs_touch_updated_at ON print_jobs;
CREATE TRIGGER print_jobs_touch_updated_at BEFORE UPDATE ON print_jobs FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- v2: UPI payment flow, multi-photo sheets, payment event log.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_claimed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS orders_code_idx ON orders (order_code);

CREATE TABLE IF NOT EXISTS order_uploads (
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  upload_id UUID NOT NULL REFERENCES uploads(id),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 500),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (order_id, upload_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS order_uploads_upload_idx ON order_uploads (upload_id);

CREATE TABLE IF NOT EXISTS payment_events (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  order_code TEXT,
  outcome TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);
