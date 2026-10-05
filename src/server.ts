import { loadConfig } from './config';
import { createApp } from './app';
import { openDatabase } from './db';
import { startRetentionScheduler } from './maintenance';

const config = loadConfig();
const db = openDatabase(config);
const app = createApp(config, db);
const stopRetention = startRetentionScheduler(db, config);
const server = app.listen(config.port, '0.0.0.0', () => {
  process.stdout.write(`ResourceStorage listening on port ${config.port}\n`);
});
server.requestTimeout = 30 * 60 * 1000;
server.headersTimeout = 65 * 1000;

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`Received ${signal}; shutting down\n`);
  stopRetention();
  server.close(() => {
    try {
      db.close();
    } finally {
      process.exit(0);
    }
  });
  setTimeout(() => process.exit(1), 15_000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
