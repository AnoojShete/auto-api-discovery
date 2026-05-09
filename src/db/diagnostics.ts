/**
 * Diagnostics records for parser and replay events.
 */

import { randomUUID } from 'crypto';
import { getDb } from './schema';

export type ParseDiagnosticKind = 'request_body' | 'response_body' | 'graphql';

export function recordParseDiagnostic(kind: ParseDiagnosticKind, url?: string, message?: string): void {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  try {
    db.prepare(`
      INSERT INTO parser_diagnostics (id, captured_at, kind, url, message)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, now, kind, url ?? null, message ?? null);
  } catch {
    // Best-effort only.
  }
}

export function getParseDiagnosticCount(): number {
  const db = getDb();
  try {
    const row = db.prepare('SELECT COUNT(*) as c FROM parser_diagnostics').get() as any;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

export function getReplaySuccessRate(): { total: number; success: number } {
  const db = getDb();
  try {
    const totalRow = db.prepare('SELECT COUNT(*) as c FROM replay_events').get() as any;
    const successRow = db.prepare('SELECT COUNT(*) as c FROM replay_events WHERE success = 1').get() as any;
    return { total: totalRow?.c ?? 0, success: successRow?.c ?? 0 };
  } catch {
    return { total: 0, success: 0 };
  }
}
