-- Encrypt replies with APP_HMAC_SECRET-derived AES-GCM keys. No plaintext
-- tokens or command text are stored. Legacy processed rows remain deduped.
ALTER TABLE telegram_updates ADD COLUMN reply_ciphertext TEXT;
ALTER TABLE telegram_updates ADD COLUMN reply_sent_at TEXT;
ALTER TABLE telegram_updates ADD COLUMN operation_id TEXT;
