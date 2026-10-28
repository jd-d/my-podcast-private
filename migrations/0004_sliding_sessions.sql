-- Preserve usable legacy sessions and counters while replacing provisional
-- markers with atomically charged sessions and an inactivity expiry.
ALTER TABLE download_sessions RENAME TO legacy_download_sessions;

CREATE TABLE download_sessions (
  recipient_id INTEGER NOT NULL,
  episode_id TEXT NOT NULL,
  client_digest TEXT NOT NULL,
  session_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (recipient_id, episode_id, client_digest),
  FOREIGN KEY (recipient_id) REFERENCES recipients(id) ON DELETE CASCADE,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);

INSERT INTO download_sessions
  (recipient_id, episode_id, client_digest, session_id, expires_at)
SELECT recipient_id, episode_id, client_digest, 'legacy',
       MAX(unixepoch(created_at) + 1800)
FROM legacy_download_sessions
WHERE counted = 1 AND unixepoch(created_at) + 1800 > unixepoch()
GROUP BY recipient_id, episode_id, client_digest;

DROP TABLE legacy_download_sessions;
CREATE INDEX idx_download_sessions_expiry ON download_sessions(expires_at);
