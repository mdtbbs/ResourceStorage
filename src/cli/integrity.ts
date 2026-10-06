import { loadConfig } from '../config';
import { openDatabase } from '../db';
import { scanIntegrity } from '../maintenance';

const args = process.argv.slice(2);
async function main(): Promise<void> {
  if (args.length > 0) {
    process.stderr.write('Usage: npm run integrity\n');
    process.exitCode = 2;
    return;
  }
  const config = loadConfig();
  const db = openDatabase(config);
  try {
    const result = await scanIntegrity(db, config);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.failed > 0) process.exitCode = 1;
  } finally {
    db.close();
  }
}

void main();
