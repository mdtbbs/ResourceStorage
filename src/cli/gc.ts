import { loadConfig } from '../config';
import { openDatabase } from '../db';
import { runGarbageCollection } from '../maintenance';

const args = process.argv.slice(2);
async function main(): Promise<void> {
  if (args.some((argument) => argument !== '--dry-run')) {
    process.stderr.write('Usage: npm run gc -- [--dry-run]\n');
    process.exitCode = 2;
    return;
  }
  const config = loadConfig();
  const db = openDatabase(config);
  try {
    const result = await runGarbageCollection(db, config, args.includes('--dry-run'));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.failed > 0) process.exitCode = 1;
  } finally {
    db.close();
  }
}

void main();
