ALTER TABLE print_jobs
  ADD COLUMN copies INTEGER NOT NULL DEFAULT 1 CHECK (copies BETWEEN 1 AND 100),
  ADD COLUMN color_mode TEXT NOT NULL DEFAULT 'bw',
  ADD COLUMN storage_key TEXT,
  ADD COLUMN expires_at TIMESTAMPTZ,
  ADD COLUMN payment_reference TEXT,
  ADD COLUMN payment_confirmed_at TIMESTAMPTZ,
  ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'CONFIRMED'
    CHECK (payment_status IN ('PENDING', 'CONFIRMED', 'EXPIRED'));

CREATE INDEX print_jobs_pending_payment_idx
  ON print_jobs (expires_at)
  WHERE payment_status = 'PENDING';
