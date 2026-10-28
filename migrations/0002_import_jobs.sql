-- Telegram update de-duplication. No message content is stored.
CREATE TABLE telegram_updates (
  update_id INTEGER PRIMARY KEY,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Import queue for a single outbound-polling Pi agent.
CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_digest TEXT,
  lease_expires_at TEXT,
  episode_id TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (episode_id) REFERENCES episodes(id)
);
CREATE INDEX idx_import_jobs_claim ON import_jobs(status, created_at);
CREATE INDEX idx_import_jobs_lease ON import_jobs(lease_expires_at);
