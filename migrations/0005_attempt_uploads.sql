-- Each successful claim gets a new immutable object namespace. A stale
-- attempt cannot overwrite the object published by a newer lease holder.
ALTER TABLE import_jobs ADD COLUMN upload_prefix TEXT;
