ALTER TABLE objects ADD COLUMN unbound_at TEXT;

UPDATE objects
SET unbound_at = CASE
  WHEN EXISTS (SELECT 1 FROM object_bindings b WHERE b.object_id = objects.id) THEN NULL
  ELSE created_at
END;

CREATE INDEX objects_unbound_state_idx ON objects(unbound_at, state);

CREATE TRIGGER object_bindings_after_insert_unbound
AFTER INSERT ON object_bindings
BEGIN
  UPDATE objects SET unbound_at = NULL WHERE id = NEW.object_id;
END;

CREATE TRIGGER object_bindings_after_update_object_unbound
AFTER UPDATE OF object_id ON object_bindings
WHEN OLD.object_id <> NEW.object_id
BEGIN
  UPDATE objects
  SET unbound_at = CASE
    WHEN EXISTS (SELECT 1 FROM object_bindings b WHERE b.object_id = OLD.object_id) THEN NULL
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  END
  WHERE id = OLD.object_id;

  UPDATE objects SET unbound_at = NULL WHERE id = NEW.object_id;
END;

CREATE TRIGGER object_bindings_after_delete_unbound
AFTER DELETE ON object_bindings
BEGIN
  UPDATE objects
  SET unbound_at = CASE
    WHEN EXISTS (SELECT 1 FROM object_bindings b WHERE b.object_id = OLD.object_id) THEN NULL
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  END
  WHERE id = OLD.object_id;
END;
