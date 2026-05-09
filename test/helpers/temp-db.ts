import fs from 'fs';
import path from 'path';
import os from 'os';
import { closeDb } from '../../src/db/schema';

export function withTempCwd<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-test-'));
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return fn(dir);
  } finally {
    closeDb();
    process.chdir(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
