CREATE TABLE admin_gc_runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  dry_run INTEGER NOT NULL CHECK (dry_run IN (0, 1)),
  requested_limit INTEGER NOT NULL CHECK (requested_limit BETWEEN 1 AND 100),
  requested_object_ids TEXT NOT NULL,
  candidates INTEGER NOT NULL DEFAULT 0 CHECK (candidates >= 0),
  bytes_reclaimable INTEGER NOT NULL DEFAULT 0 CHECK (bytes_reclaimable >= 0),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted >= 0),
  skipped INTEGER NOT NULL DEFAULT 0 CHECK (skipped >= 0),
  failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0)
);

CREATE INDEX admin_gc_runs_created_idx ON admin_gc_runs(created_at DESC, id DESC);

CREATE TABLE admin_gc_run_items (
  run_id TEXT NOT NULL REFERENCES admin_gc_runs(id) ON DELETE CASCADE,
  object_id TEXT NOT NULL,
  object_public_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('eligible', 'deleted', 'skipped', 'failed')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, object_id)
);

CREATE INDEX admin_gc_run_items_object_idx ON admin_gc_run_items(object_id, created_at DESC);
