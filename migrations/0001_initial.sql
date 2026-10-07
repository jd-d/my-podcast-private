PRAGMA foreign_keys = ON;

CREATE TABLE recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias TEXT NOT NULL,
  token_digest TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  download_limit INTEGER NOT NULL DEFAULT 5 CHECK (download_limit >= 1),
  download_scope TEXT NOT NULL DEFAULT 'episode' CHECK (download_scope IN ('episode', 'recipient')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

CREATE INDEX idx_recipients_status ON recipients(status);

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  r2_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL DEFAULT 'audio/mpeg',
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  published_at TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_episodes_active_published
  ON episodes(is_active, published_at DESC);

CREATE TABLE recipient_activity (
  recipient_id INTEGER PRIMARY KEY,
  feed_requests INTEGER NOT NULL DEFAULT 0,
  audio_requests INTEGER NOT NULL DEFAULT 0,
  last_feed_at TEXT,
  last_audio_at TEXT,
  last_client_digest TEXT,
  FOREIGN KEY (recipient_id) REFERENCES recipients(id) ON DELETE CASCADE
);

CREATE TABLE recipient_usage (
  recipient_id INTEGER PRIMARY KEY,
  download_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (recipient_id) REFERENCES recipients(id) ON DELETE CASCADE
);

CREATE TABLE recipient_episode_usage (
  recipient_id INTEGER NOT NULL,
  episode_id TEXT NOT NULL,
  download_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (recipient_id, episode_id),
  FOREIGN KEY (recipient_id) REFERENCES recipients(id) ON DELETE CASCADE,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);

-- Dedupe Range requests/retries from the same apparent client into one
-- short-lived download session. No raw IP address or user-agent is stored.
CREATE TABLE download_sessions (
  recipient_id INTEGER NOT NULL,
  episode_id TEXT NOT NULL,
  client_digest TEXT NOT NULL,
  session_bucket INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (recipient_id, episode_id, client_digest, session_bucket),
  FOREIGN KEY (recipient_id) REFERENCES recipients(id) ON DELETE CASCADE,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);

CREATE INDEX idx_download_sessions_created
  ON download_sessions(created_at);
