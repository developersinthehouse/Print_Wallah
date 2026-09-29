CREATE TABLE shop_admin_credentials (
  shop_id TEXT PRIMARY KEY REFERENCES shop_profiles(id) ON DELETE CASCADE,
  password_hash TEXT,
  setup_token_hash TEXT,
  setup_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (password_hash IS NOT NULL OR setup_token_hash IS NOT NULL)
);

CREATE INDEX shop_admin_credentials_setup_expiry_idx
  ON shop_admin_credentials (setup_expires_at)
  WHERE setup_token_hash IS NOT NULL;