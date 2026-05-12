import { logEvent } from '../observability/logger';
import { getReplaySuccessRate } from '../db/diagnostics';
import { getDb } from '../db/schema';

export function recordReplayDiagnostic(jobId: string, errorKind: string, message: string, requestId?: string): void {
  logEvent('replay.diagnostic', {
    job_id: jobId,
    error_kind: errorKind,
    message,
    request_id: requestId
  }, 'error');
}

export function getReplayMetrics(): any {
  const { total, success } = getReplaySuccessRate();
  const db = getDb();
  
  let totalJobs = 0;
  let totalDependencies = 0;
  
  try {
    const jobsRow = db.prepare('SELECT COUNT(*) as c FROM replay_jobs').get() as any;
    totalJobs = jobsRow?.c ?? 0;
    
    const depsRow = db.prepare('SELECT COUNT(*) as c FROM replay_dependencies').get() as any;
    totalDependencies = depsRow?.c ?? 0;
  } catch {
    // Database might not be initialized
  }

  return {
    totalEvents: total,
    successfulEvents: success,
    successRate: total > 0 ? (success / total) * 100 : 0,
    totalJobs,
    totalDependencies
  };
}

export function emitReplayJobStatusChange(jobId: string, oldStatus: string, newStatus: string): void {
  logEvent('replay.job_status', {
    job_id: jobId,
    old_status: oldStatus,
    new_status: newStatus
  });
}

export function recordIndexedInferenceMetrics(metrics: any): void {
  logEvent('replay.inference.indexed_metrics', metrics);
}
