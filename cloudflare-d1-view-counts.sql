
-- Run this SQL in the Cloudflare D1 database bound to Worker as VIEWS_DB.
-- It preserves the existing video_views table and adds the site's own metadata database.
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  video_path TEXT NOT NULL DEFAULT '',
  thumbnail_path TEXT,
  views INTEGER NOT NULL DEFAULT 0 CHECK (views >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'published',
  is_short INTEGER NOT NULL DEFAULT 0 CHECK (is_short IN (0,1)),
  related_video_id TEXT
);

CREATE INDEX IF NOT EXISTS videos_created_at_idx
ON videos(created_at DESC);

CREATE INDEX IF NOT EXISTS videos_status_short_idx
ON videos(status, is_short);

CREATE TABLE IF NOT EXISTS video_views (
  video_id TEXT PRIMARY KEY NOT NULL,
  views INTEGER NOT NULL DEFAULT 0 CHECK (views >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS site_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  featured_video_id TEXT
);

INSERT OR IGNORE INTO site_settings (id, featured_video_id)
VALUES (1, NULL);
