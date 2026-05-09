/**
 * Telemetry filtering records.
 */

import { randomUUID } from 'crypto';
import { getDb } from './schema';

export function recordTelemetryDrop(url: string, reason?: string): void {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  try {
    db.prepare(`
      INSERT INTO telemetry_drops (id, captured_at, url, reason)
      VALUES (?, ?, ?, ?)
    `).run(id, now, url, reason ?? null);
  } catch {
    // Best-effort only.
  }
}

export function getTelemetryDropCount(): number {
  const db = getDb();
  try {
    const row = db.prepare('SELECT COUNT(*) as c FROM telemetry_drops').get() as any;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}
