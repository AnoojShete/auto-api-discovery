import { getDb } from '../db/schema';
import { addReplayDependency } from './models';
import { recordReplayDiagnostic } from './metrics';
import { classifyToken } from './classify';

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
// Heuristic Functions
// ────────────────────────────────────────────────────────────────

function inferAuthToken(source: any, target: any, deps: InferredDependency[]) {
  const targetAuth = getHeaderValue(target.request_headers, 'authorization');
  if (!targetAuth || !targetAuth.toLowerCase().startsWith('bearer ')) return;

  const token = targetAuth.substring(7).trim();
  if (token.length < 10) return;

  const sourceBodyTokens = extractPotentialTokens(source.response_body, 'body');
  for (const t of sourceBodyTokens) {
    if (t.value === token) {
      const cls = classifyToken(token, 'authorization');
      let baseConf = 0.95;
      deps.push({
        sourceRequestId: source.id,
        targetRequestId: target.id,
        type: 'token',
        confidence: Math.max(0.0, Math.min(1.0, baseConf + cls.confidence_modifier)),
        evidence: { match_type: 'body_to_header', source_path: t.path, target_header: 'Authorization', classification: cls }
      });
      return;
    }
  }
}

function inferCookies(source: any, target: any, deps: InferredDependency[]) {
  const setCookie = getHeaderValue(source.response_headers, 'set-cookie');
  const targetCookie = getHeaderValue(target.request_headers, 'cookie');

  if (setCookie && targetCookie) {
    // Very basic matching for demonstration
    const setParts = setCookie.split(';')[0].split('=');
    if (setParts.length >= 2) {
      const cookieName = setParts[0].trim();
      const cookieVal = setParts[1].trim();
      
      if (targetCookie.includes(`${cookieName}=${cookieVal}`)) {
        const cls = classifyToken(cookieVal, 'cookie');
        let baseConf = 0.9;
        deps.push({
          sourceRequestId: source.id,
          targetRequestId: target.id,
          type: 'cookie',
          confidence: Math.max(0.0, Math.min(1.0, baseConf + cls.confidence_modifier)),
          evidence: { match_type: 'cookie', cookie_name: cookieName, classification: cls }
        });
      }
    }
  }
}

function inferCsrfToken(source: any, target: any, deps: InferredDependency[]) {
  const csrfHeader = getHeaderValue(target.request_headers, 'x-csrf-token') || getHeaderValue(target.request_headers, 'csrf-token');
  if (csrfHeader && csrfHeader.length > 8) {
    const sourceTokens = extractPotentialTokens(source.response_body, 'body');
    for (const t of sourceTokens) {
      if (t.value === csrfHeader) {
        const cls = classifyToken(t.value, 'csrf');
        let baseConf = 0.85;
        deps.push({
          sourceRequestId: source.id,
          targetRequestId: target.id,
          type: 'csrf',
          confidence: Math.max(0.0, Math.min(1.0, baseConf + cls.confidence_modifier)),
          evidence: { match_type: 'body_to_header', source_path: t.path, target_header: 'x-csrf-token', classification: cls }
        });
        return;
      }
    }
  }
}

function inferPathParam(source: any, target: any, deps: InferredDependency[]) {
  if (!target.path) return;
  const sourceTokens = extractPotentialTokens(source.response_body, 'body');
  for (const t of sourceTokens) {
    // If target URL path contains this token (e.g. /users/123456789)
    if (target.path.includes(t.value)) {
      const cls = classifyToken(t.value, 'path');
      let baseConf = 0.7; // Lower confidence due to accidental matches
      deps.push({
        sourceRequestId: source.id,
        targetRequestId: target.id,
        type: 'path_param',
        confidence: Math.max(0.0, Math.min(1.0, baseConf + cls.confidence_modifier)),
        evidence: { match_type: 'body_to_path', source_path: t.path, value: t.value, classification: cls }
      });
      return;
    }
  }
}

function inferQueryParam(source: any, target: any, deps: InferredDependency[]) {
  if (!target.query_raw) return;
  const sourceTokens = extractPotentialTokens(source.response_body, 'body');
  
  for (const t of sourceTokens) {
    if (target.query_raw.includes(t.value)) {
      const cls = classifyToken(t.value, 'query');
      let baseConf = 0.75;
      deps.push({
        sourceRequestId: source.id,
        targetRequestId: target.id,
        type: 'query_param',
        confidence: Math.max(0.0, Math.min(1.0, baseConf + cls.confidence_modifier)),
        evidence: { match_type: 'body_to_query', source_path: t.path, value: t.value, classification: cls }
      });
      return;
    }
  }
}

function inferGraphQLVariable(source: any, target: any, deps: InferredDependency[]) {
  if (!target.url?.includes('graphql') && !target.path?.includes('graphql')) return;
  
  const vars = extractPotentialTokens(target.request_body?.variables || {}, 'variables');
  if (vars.length === 0) return;

  const sourceTokens = extractPotentialTokens(source.response_body, 'body');
  
  for (const t of sourceTokens) {
    for (const v of vars) {
      if (t.value === v.value) {
        const cls = classifyToken(t.value, 'graphql_var');
        let baseConf = 0.85;
        deps.push({
          sourceRequestId: source.id,
          targetRequestId: target.id,
          type: 'graphql_var',
          confidence: Math.max(0.0, Math.min(1.0, baseConf + cls.confidence_modifier)),
          evidence: { match_type: 'body_to_gql_var', source_path: t.path, target_path: v.path, classification: cls }
        });
        return;
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────
// Main Inference Engine
// ────────────────────────────────────────────────────────────────

export function inferFromRequests(requests: any[]): InferredDependency[] {
  const deps: InferredDependency[] = [];

  // O(N^2) backward comparison
  for (let i = 0; i < requests.length; i++) {
    const target = requests[i];
    
    for (let j = 0; j < i; j++) {
      const source = requests[j];
      
      // Limit to same session to avoid cross-pollination
      if (source.session_id !== target.session_id) continue;

      inferAuthToken(source, target, deps);
      inferCookies(source, target, deps);
      inferCsrfToken(source, target, deps);
      inferPathParam(source, target, deps);
      inferQueryParam(source, target, deps);
      inferGraphQLVariable(source, target, deps);
    }
  }

  // Deduplicate and filter dependencies
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
