ALTER TABLE shop_profiles
  ADD COLUMN document_print_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN photo_print_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN photo_print_price NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (photo_print_price >= 0),
  ADD COLUMN glossy_print_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN glossy_surcharge_per_page NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (glossy_surcharge_per_page >= 0);

ALTER TABLE print_jobs
  ADD COLUMN queue_position BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN print_type TEXT NOT NULL DEFAULT 'document' CHECK (print_type IN ('document', 'photo')),
  ADD COLUMN paper_finish TEXT NOT NULL DEFAULT 'plain' CHECK (paper_finish IN ('plain', 'glossy'));

CREATE INDEX print_jobs_shop_queue_idx
  ON print_jobs (shop_id, queue_position, created_at)
  WHERE status = 'READY_TO_PRINT' AND payment_status = 'CONFIRMED';