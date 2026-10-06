import { loadConfig } from '../config';
import { openDatabase } from '../db';
import { runGarbageCollection } from '../maintenance';

const args = process.argv.slice(2);
async function main(): Promise<void> {
  const objectIds: string[] = [];
  let dryRun = false;
  let confirm = false;
  let limit = 50;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') dryRun = true;
    else if (argument === '--confirm') confirm = true;
    else if (argument === '--object-id') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        process.stderr.write('--object-id requires an object ID\n');
        process.exitCode = 2;
        return;
      }
      objectIds.push(value);
      index += 1;
    } else if (argument === '--limit') {
      const value = args[index + 1];
      if (!value || !/^[1-9]\d{0,2}$/.test(value)) {
        process.stderr.write('--limit must be an integer between 1 and 100\n');
        process.exitCode = 2;
        return;
      }
      limit = Number(value);
      index += 1;
    } else {
      process.stderr.write('Usage: npm run gc -- [--dry-run] --object-id <id> [--object-id <id> ...] [--limit <1-100>] [--confirm]\n');
      process.exitCode = 2;
      return;
    }
  }
  if (limit > 100 || objectIds.length === 0 || objectIds.length > 100 || new Set(objectIds).size !== objectIds.length || (!dryRun && !confirm)) {
    process.stderr.write('GC requires 1 to 100 unique --object-id values; deleting also requires --confirm.\n');
    process.exitCode = 2;
    return;
  }
  const config = loadConfig();
  const db = openDatabase(config);
  try {
    const result = await runGarbageCollection(db, config, { dryRun, limit, objectIds, confirm });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.failed > 0) process.exitCode = 1;
  } finally {
    db.close();
  }
}

void main();
