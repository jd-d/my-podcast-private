-- Differentiate an accepted, charged download session from one pending
-- quota accounting. Prevents parallel Range requests from treating a
-- still-unaccounted session as authorized.
ALTER TABLE download_sessions
ADD COLUMN counted INTEGER NOT NULL DEFAULT 1 CHECK (counted IN (0,1));
