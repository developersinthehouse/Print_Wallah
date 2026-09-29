CREATE TABLE shop_agent_tokens (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shop_profiles(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX shop_agent_tokens_active_idx
  ON shop_agent_tokens (shop_id, expires_at)
  WHERE revoked_at IS NULL;
