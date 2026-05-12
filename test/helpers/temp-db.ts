import fs from 'fs';
import path from 'path';
import os from 'os';
import { closeDb } from '../../src/db/schema';

export function withTempCwd<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-test-'));
  const previous = process.env.APIGEN_CWD;
  process.env.APIGEN_CWD = dir;
  try {
    return fn(dir);
  } finally {
    closeDb();
    if (previous === undefined) {
      delete process.env.APIGEN_CWD;
    } else {
      process.env.APIGEN_CWD = previous;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
