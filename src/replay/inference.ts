import { getDb } from '../db/schema';
import { addReplayDependency } from './models';
import { recordReplayDiagnostic, recordIndexedInferenceMetrics } from './metrics';
import { classifyToken } from './classify';
import { DependencyIndexer } from './index';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface InferredDependency {
  sourceRequestId: string;
  targetRequestId: string;
  type: string; // 'token', 'cookie', 'csrf', 'path_param', 'query_param', 'graphql_var'
  confidence: number;
  evidence: any;
}

// ────────────────────────────────────────────────────────────────
// Extraction Helpers
// ────────────────────────────────────────────────────────────────

/** Recursively extracts all primitive values > 8 chars from an object/array */
function extractPotentialTokens(obj: any, path: string = ''): Array<{ path: string; value: string }> {
  let tokens: Array<{ path: string; value: string }> = [];
  if (!obj) return tokens;

  if (typeof obj === 'string') {
    if (obj.length > 8) tokens.push({ path, value: obj });
  } else if (typeof obj === 'number') {
    const str = obj.toString();
    if (str.length > 8) tokens.push({ path, value: str });
  } else if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      tokens = tokens.concat(extractPotentialTokens(obj[i], `${path}[${i}]`));
    }
  } else if (typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      const newPath = path ? `${path}.${key}` : key;
      tokens = tokens.concat(extractPotentialTokens(obj[key], newPath));
    }
  }

  return tokens;
}

function getHeaderValue(headers: any, key: string): string | null {
  if (!headers) return null;
  const lowerKey = key.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lowerKey) return String(v);
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// Target & Source Extraction
// ────────────────────────────────────────────────────────────────

function extractSourceTokens(source: any): Array<{ value: string; path: string; type: 'body' | 'header' }> {
  const tokens: Array<{ value: string; path: string; type: 'body' | 'header' }> = [];
  
  const bodyTokens = extractPotentialTokens(source.response_body, 'body');
  for (const t of bodyTokens) {
    tokens.push({ value: t.value, path: t.path, type: 'body' });
  }
  
  const setCookie = getHeaderValue(source.response_headers, 'set-cookie');
  if (setCookie) {
    const setParts = setCookie.split(';')[0].split('=');
    if (setParts.length >= 2) {
      tokens.push({ value: setParts[1].trim(), path: `set-cookie:${setParts[0].trim()}`, type: 'header' });
    }
  }
  
  return tokens;
}

function extractTargetTokens(target: any): Array<{ value: string; type: string; path: string }> {
  const tokens: Array<{ value: string; type: string; path: string }> = [];

  const auth = getHeaderValue(target.request_headers, 'authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.substring(7).trim();
    if (token.length >= 10) tokens.push({ value: token, type: 'token', path: 'Authorization' });
  }

  const cookieHeader = getHeaderValue(target.request_headers, 'cookie');
  if (cookieHeader) {
    const parts = cookieHeader.split(';');
    for (const p of parts) {
      const kv = p.split('=');
      if (kv.length >= 2) {
        const val = kv.slice(1).join('=').trim();
        if (val.length > 8) tokens.push({ value: val, type: 'cookie', path: `cookie:${kv[0].trim()}` });
      }
    }
  }

  const csrf = getHeaderValue(target.request_headers, 'x-csrf-token') || getHeaderValue(target.request_headers, 'csrf-token');
  if (csrf && csrf.length > 8) {
    tokens.push({ value: csrf, type: 'csrf', path: 'x-csrf-token' });
  }

  if (target.path) {
    const segments = target.path.split('/');
    for (const s of segments) {
      if (s.length > 8) tokens.push({ value: s, type: 'path_param', path: 'path' });
    }
  }

  if (target.query_raw) {
    const params = new URLSearchParams(target.query_raw);
    params.forEach((val, key) => {
      if (val.length > 8) tokens.push({ value: val, type: 'query_param', path: `query:${key}` });
    });
  }

  if (target.url?.includes('graphql') || target.path?.includes('graphql')) {
    const vars = extractPotentialTokens(target.request_body?.variables || {}, 'variables');
    for (const v of vars) {
      tokens.push({ value: v.value, type: 'graphql_var', path: v.path });
    }
  }

  return tokens;
}

// ────────────────────────────────────────────────────────────────
// Main Inference Engine
// ────────────────────────────────────────────────────────────────

export function inferFromRequests(requests: any[]): InferredDependency[] {
  const deps: InferredDependency[] = [];
  const indexer = new DependencyIndexer();
  
  for (const req of requests) {
    const sources = extractSourceTokens(req);
    indexer.indexSourceTokens(req, sources);
  }

  for (const target of requests) {
    const targetTokens = extractTargetTokens(target);
    
    for (const tt of targetTokens) {
      const sources = indexer.lookup(target.session_id, tt.value);
      
      for (const src of sources) {
        if (src.capturedAt !== undefined && target.captured_at !== undefined && src.capturedAt >= target.captured_at) continue;

        const cls = classifyToken(tt.value, tt.type);
        
        let baseConf = 0.8;
        if (tt.type === 'token') baseConf = 0.95;
        else if (tt.type === 'cookie') baseConf = 0.9;
        else if (tt.type === 'csrf') baseConf = 0.85;
        else if (tt.type === 'path_param') baseConf = 0.7;
        else if (tt.type === 'query_param') baseConf = 0.75;
        else if (tt.type === 'graphql_var') baseConf = 0.85;
        
        const confidence = indexer.calculateConfidence(baseConf, cls, src.capturedAt, target.captured_at, tt.value);
        
        deps.push({
          sourceRequestId: src.sourceRequestId,
          targetRequestId: target.id,
          type: tt.type,
          confidence,
          evidence: {
            match_type: `${src.sourceType}_to_${tt.type}`,
            source_path: src.path,
            target_path: tt.path,
            classification: cls
          }
        });
      }
    }
  }

  const metrics = indexer.getMetrics(requests.length);
  recordIndexedInferenceMetrics(metrics);

  const uniqueDeps = new Map<string, InferredDependency>();
  for (const d of deps) {
    const key = `${d.sourceRequestId}:${d.targetRequestId}:${d.type}`;
    if (!uniqueDeps.has(key) || uniqueDeps.get(key)!.confidence < d.confidence) {
      uniqueDeps.set(key, d);
    }
  }

  return Array.from(uniqueDeps.values());
}

/**
 * Automatically infers dependencies from captured traffic.
 * Analyzes request sequences to detect propagated state.
 */
export function inferDependencies(): InferredDependency[] {
  const db = getDb();
  
  const requests = db.prepare(`
    SELECT id, session_id, captured_at, method, url, path, query_raw,
           request_headers, request_body, response_status, response_headers, response_body
    FROM requests
    WHERE response_status >= 200 AND response_status < 400
    ORDER BY captured_at ASC
  `).all() as any[];

  // Parse JSON payloads
  for (const req of requests) {
    try { req.request_headers = JSON.parse(req.request_headers); } catch { req.request_headers = {}; }
    try { req.response_headers = JSON.parse(req.response_headers); } catch { req.response_headers = {}; }
    try { req.request_body = JSON.parse(req.request_body); } catch {}
    try { req.response_body = JSON.parse(req.response_body); } catch {}
  }

  const finalDeps = inferFromRequests(requests);

  // Persist into database
  for (const dep of finalDeps) {
    if (dep.confidence >= 0.5) {
      try {
        addReplayDependency(dep.sourceRequestId, dep.targetRequestId, dep.type, dep.confidence, dep.evidence);
      } catch { /* Ignore duplicates */ }
    } else {
      recordReplayDiagnostic(
        'system',
        'low_confidence_dependency',
        `Skipped ${dep.type} dependency inference (confidence: ${dep.confidence})`,
        dep.targetRequestId
      );
    }
  }

  return finalDeps;
}
