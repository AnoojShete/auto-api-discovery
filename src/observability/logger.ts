/**
 * JSONL logger for internal observability.
 */

import fs from 'fs';
import path from 'path';
import { getApigenDir } from '../db/schema';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEvent {
  ts: string;
  level: LogLevel;
  event: string;
  data?: Record<string, unknown>;
}

function getLogDir(): string {
  const dir = path.join(getApigenDir(), 'logs');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getLogFilePath(): string {
  const date = new Date();
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return path.join(getLogDir(), `apigen-${y}${m}${d}.jsonl`);
}

export function logEvent(event: string, data?: Record<string, unknown>, level: LogLevel = 'info'): void {
  const payload: LogEvent = {
    ts: new Date().toISOString(),
    level,
    event,
    data,
  };

  try {
    fs.appendFileSync(getLogFilePath(), JSON.stringify(payload) + '\n', 'utf-8');
  } catch {
    // Best-effort logging only.
  }
}
