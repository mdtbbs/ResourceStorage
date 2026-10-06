CREATE TABLE objects (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL UNIQUE CHECK (length(sha256) = 64),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  mime_type TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('verified', 'missing', 'corrupt', 'quarantined')),
  created_at TEXT NOT NULL,
  verified_at TEXT
);

CREATE INDEX objects_state_created_idx ON objects(state, created_at);

CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  expected_sha256 TEXT CHECK (expected_sha256 IS NULL OR length(expected_sha256) = 64),
  expected_size INTEGER NOT NULL CHECK (expected_size >= 0),
  mime_type TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  purpose TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'uploading', 'completed', 'failed', 'expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX upload_sessions_expiry_state_idx ON upload_sessions(state, expires_at);

CREATE TABLE object_bindings (
  id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  created_at TEXT NOT NULL,
  UNIQUE(namespace, owner_type, owner_id)
);

CREATE INDEX object_bindings_object_visibility_idx ON object_bindings(object_id, visibility);

CREATE TABLE private_download_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  object_id TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX private_download_tokens_expiry_idx ON private_download_tokens(expires_at);
CREATE INDEX private_download_tokens_object_expiry_idx ON private_download_tokens(object_id, expires_at);

CREATE TABLE access_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  object_id TEXT REFERENCES objects(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  bytes_sent INTEGER NOT NULL DEFAULT 0 CHECK (bytes_sent >= 0),
  request_id TEXT
);

CREATE INDEX access_logs_created_idx ON access_logs(created_at);
CREATE INDEX access_logs_object_created_idx ON access_logs(object_id, created_at);
