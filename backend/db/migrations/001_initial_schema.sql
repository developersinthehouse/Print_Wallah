CREATE TABLE shop_profiles (
  id TEXT PRIMARY KEY,
  shop_name TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  black_and_white_per_page NUMERIC(10, 2) NOT NULL CHECK (black_and_white_per_page >= 0),
  color_per_page NUMERIC(10, 2) NOT NULL CHECK (color_per_page >= 0),
  subscription_expiry_date TIMESTAMPTZ NOT NULL,
  subscription_status TEXT NOT NULL CHECK (subscription_status IN ('ACTIVE', 'EXPIRED', 'LOCKED')),
  subscription_lock_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE print_jobs (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shop_profiles(id) ON DELETE CASCADE,
  document_name TEXT,
  file_name TEXT,
  file_url TEXT NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  status TEXT NOT NULL CHECK (status IN ('READY_TO_PRINT', 'PRINTED', 'PRINT_FAILED')),
  print_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  printed_at TIMESTAMPTZ
);

CREATE TABLE subscription_logs (
  id BIGSERIAL PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shop_profiles(id) ON DELETE CASCADE,
  payment_id TEXT UNIQUE,
  event_type TEXT NOT NULL,
  plan_id TEXT,
  previous_expiry TIMESTAMPTZ,
  new_expiry TIMESTAMPTZ,
  admin_id TEXT,
  reason TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE admin_audit (
  id BIGSERIAL PRIMARY KEY,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,
  shop_id TEXT REFERENCES shop_profiles(id) ON DELETE SET NULL,
  reason TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX shop_profiles_expiry_status_idx
  ON shop_profiles (subscription_expiry_date, subscription_status);
CREATE INDEX print_jobs_shop_created_idx
  ON print_jobs (shop_id, created_at DESC);
CREATE INDEX print_jobs_shop_status_idx
  ON print_jobs (shop_id, status);
CREATE INDEX subscription_logs_shop_created_idx
  ON subscription_logs (shop_id, created_at DESC);
CREATE INDEX admin_audit_shop_created_idx
  ON admin_audit (shop_id, created_at DESC);