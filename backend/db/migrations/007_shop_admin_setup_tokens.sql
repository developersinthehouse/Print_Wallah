ALTER TABLE shop_admin_users
  ALTER COLUMN password_hash DROP NOT NULL,
  ADD COLUMN setup_token_hash TEXT,
  ADD COLUMN setup_expires_at TIMESTAMPTZ,
  ADD CONSTRAINT shop_admin_users_credential_check
    CHECK (password_hash IS NOT NULL OR setup_token_hash IS NOT NULL),
  ADD CONSTRAINT shop_admin_users_setup_expiry_check
    CHECK ((setup_token_hash IS NULL) = (setup_expires_at IS NULL));

CREATE INDEX shop_admin_users_setup_expiry_idx
  ON shop_admin_users (setup_expires_at)
  WHERE setup_token_hash IS NOT NULL;
