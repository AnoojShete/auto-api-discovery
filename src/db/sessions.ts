/**
 * Session CRUD operations.
 * Sessions track browser state (cookies, localStorage) for replay and multi-session crawling.
 */

import { randomUUID } from 'crypto';
import { getDb } from './schema';

export interface SessionRecord {
  id: string;
  created_at: number;
  cookies?: string | null;
  local_storage?: string | null;
  label?: string | null;
  storage_state?: string | null;
}

/** Create a new session and return its ID */
export function createSession(label?: string): string {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO sessions (id, created_at, label)
    VALUES (?, ?, ?)
  `).run(id, now, label ?? null);

  return id;
}

/** Update session cookies */
export function updateSessionCookies(id: string, cookies: any[]): void {
  const db = getDb();
  db.prepare('UPDATE sessions SET cookies = ? WHERE id = ?')
    .run(JSON.stringify(cookies), id);
}

/** Update session localStorage */
export function updateSessionStorage(id: string, storage: Record<string, string>): void {
  const db = getDb();
  db.prepare('UPDATE sessions SET local_storage = ? WHERE id = ?')
    .run(JSON.stringify(storage), id);
}

/** Save full Playwright storageState (cookies + localStorage + sessionStorage) */
export function saveStorageState(id: string, storageState: any): void {
  const db = getDb();
  db.prepare('UPDATE sessions SET storage_state = ? WHERE id = ?')
    .run(JSON.stringify(storageState), id);
}

/** Load full Playwright storageState for context restoration */
export function loadStorageState(label: string): any | null {
  const session = getSessionByLabel(label);
  if (!session?.storage_state) return null;
  try {
    return JSON.parse(session.storage_state);
  } catch {
    return null;
  }
}

/**
 * Check if a session is likely still valid.
 * Heuristic: sessions older than 24h are considered potentially expired.
 */
export function isSessionLikelyValid(label: string, maxAgeMs: number = 24 * 60 * 60 * 1000): boolean {
  const session = getSessionByLabel(label);
  if (!session) return false;
  if (!session.storage_state && !session.cookies) return false;
  const age = Date.now() - session.created_at;
  return age < maxAgeMs;
}

/** Get session by ID */
export function getSession(id: string): SessionRecord | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRecord | undefined;
}

/** Get session by label */
export function getSessionByLabel(label: string): SessionRecord | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM sessions WHERE label = ? ORDER BY created_at DESC LIMIT 1')
    .get(label) as SessionRecord | undefined;
}

/** List all sessions */
export function listSessions(): SessionRecord[] {
  const db = getDb();
  return db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all() as SessionRecord[];
}

/** Delete a session by label */
export function deleteSessionByLabel(label: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM sessions WHERE label = ?').run(label);
  return result.changes > 0;
}
