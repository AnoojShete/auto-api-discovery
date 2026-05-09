import { randomUUID } from 'crypto';
import { getDb } from '../db/schema';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export type ReplayJobStatus = 'queued' | 'running' | 'completed' | 'failed';
export type ReplayProvenance = 'manual' | 'inferred' | 'workflow' | 'auth-chain';

export interface ReplayJobRecord {
  id: string;
  status: ReplayJobStatus;
  created_at: number;
  updated_at: number;
}

export interface ReplayEventRecord {
  id: string;
  job_id: string;
  original_request_id: string;
  replay_request_id: string | null;
  status_code: number | null;
  success: boolean;
  latency_ms: number | null;
  captured_at: number;
  provenance: ReplayProvenance;
}

export interface ReplayDependencyRecord {
  id: string;
  source_request_id: string; // The request providing the value (e.g., login)
  target_request_id: string; // The request consuming the value
  dependency_type: string;   // e.g., 'token', 'csrf', 'path_param'
  confidence: number;
  evidence: string | null;
}

// ────────────────────────────────────────────────────────────────
// Database Operations
// ────────────────────────────────────────────────────────────────

export function createReplayJob(): string {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO replay_jobs (id, status, created_at, updated_at)
    VALUES (?, 'queued', ?, ?)
  `).run(id, now, now);
  return id;
}

export function updateReplayJobStatus(id: string, status: ReplayJobStatus): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    UPDATE replay_jobs SET status = ?, updated_at = ? WHERE id = ?
  `).run(status, now, id);
}

export function recordReplayEvent(
  jobId: string,
  originalRequestId: string,
  provenance: ReplayProvenance,
  details: {
    replayRequestId?: string;
    statusCode?: number;
    success: boolean;
    latencyMs?: number;
  }
): string {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO replay_events (
      id, job_id, original_request_id, replay_request_id,
      status_code, success, latency_ms, captured_at, provenance
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    jobId,
    originalRequestId,
    details.replayRequestId ?? null,
    details.statusCode ?? null,
    details.success ? 1 : 0,
    details.latencyMs ?? null,
    now,
    provenance
  );
  return id;
}

export function addReplayDependency(
  sourceRequestId: string,
  targetRequestId: string,
  dependencyType: string,
  confidence: number = 1.0,
  evidence: any = null
): string {
  const db = getDb();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO replay_dependencies (id, source_request_id, target_request_id, dependency_type, confidence, evidence)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, sourceRequestId, targetRequestId, dependencyType, confidence, evidence ? JSON.stringify(evidence) : null);
  return id;
}

export function getReplayDependenciesForTarget(targetRequestId: string): ReplayDependencyRecord[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM replay_dependencies WHERE target_request_id = ?
  `).all(targetRequestId) as ReplayDependencyRecord[];
}
