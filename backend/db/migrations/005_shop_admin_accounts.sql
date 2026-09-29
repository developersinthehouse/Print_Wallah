CREATE TABLE shop_admin_users (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shop_profiles(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ,
  UNIQUE (shop_id, email)
);

CREATE INDEX shop_admin_users_email_idx
  ON shop_admin_users (email)
  WHERE active = TRUE;
