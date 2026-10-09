-- Run this once in Cloudflare D1 Console for the database bound as VIEWS_DB.
CREATE TABLE IF NOT EXISTS video_views (
  video_id TEXT PRIMARY KEY NOT NULL,
  views INTEGER NOT NULL DEFAULT 0 CHECK (views >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
