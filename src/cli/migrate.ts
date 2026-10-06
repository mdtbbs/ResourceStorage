import { loadConfig } from '../config';
import { openDatabase } from '../db';

const config = loadConfig();
const db = openDatabase(config);
try {
  const migrations = db.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version').all();
  process.stdout.write(`${JSON.stringify({ applied: migrations.length, migrations }, null, 2)}\n`);
} finally {
  db.close();
}
