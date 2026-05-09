/**
 * Simple filesystem object store for large request/response payloads.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { getApigenDir } from '../db/schema';

export interface StoredObject {
  path: string;
  size: number;
  hash: string;
}

function getObjectDir(): string {
  const dir = path.join(getApigenDir(), 'objects');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function storeTextObject(kind: string, text: string): StoredObject {
  const hash = createHash('sha256').update(text).digest('hex');
  const dir = getObjectDir();
  const filename = `${kind}-${hash}.txt`;
  const fullPath = path.join(dir, filename);

  if (!fs.existsSync(fullPath)) {
    fs.writeFileSync(fullPath, text, 'utf-8');
  }

  return { path: fullPath, size: Buffer.byteLength(text, 'utf-8'), hash };
}

export function readTextObject(objectPath: string): string | null {
  try {
    return fs.readFileSync(objectPath, 'utf-8');
  } catch {
    return null;
  }
}
