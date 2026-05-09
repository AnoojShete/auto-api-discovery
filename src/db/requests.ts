/**
 * Request CRUD operations.
 * Content-addressed IDs: sha256(method + url + body_hash) prevents duplicates.
 */

import { createHash } from 'crypto';
import { getDb } from './schema';

export interface RequestData {
  session_id: string;
  method: string;
  url: string;
  path: string;
  query_raw?: string | null;
  request_headers?: Record<string, string> | null;
  request_body?: any;
  request_body_path?: string | null;
  request_body_size?: number | null;
  response_status?: number | null;
  response_headers?: Record<string, string> | null;
  response_body?: any;
  response_body_path?: string | null;
  response_body_size?: number | null;
  response_time_ms?: number | null;
  source?: string;
  trace_id?: string | null;
}

/** Generate a content-addressed ID from method + path + body */
export function computeRequestId(method: string, url: string, body: any): string {
  const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
  const bodyHash = createHash('sha256').update(bodyStr).digest('hex').slice(0, 16);
  return createHash('sha256')
    .update(`${method}:${url}:${bodyHash}`)
    .digest('hex');
}

/** Insert a request. Uses UPSERT so re-runs don't create duplicates. */
export function insertRequest(data: RequestData): string {
  const db = getDb();
  const id = computeRequestId(data.method, data.url, data.request_body);
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO requests (
      id, session_id, captured_at, method, url, path, query_raw,
      request_headers, request_body, request_body_path, request_body_size,
      response_status, response_headers, response_body, response_body_path,
      response_body_size, response_time_ms, source, trace_id
    ) VALUES (
      @id, @session_id, @captured_at, @method, @url, @path, @query_raw,
      @request_headers, @request_body, @request_body_path, @request_body_size,
      @response_status, @response_headers, @response_body, @response_body_path,
      @response_body_size, @response_time_ms, @source, @trace_id
    ) ON CONFLICT(id) DO UPDATE SET
      response_status = excluded.response_status,
      response_body = excluded.response_body,
      response_body_path = excluded.response_body_path,
      response_body_size = excluded.response_body_size,
      response_headers = excluded.response_headers,
      response_time_ms = excluded.response_time_ms,
      captured_at = excluded.captured_at
  `);

  try {
    stmt.run({
      id,
      session_id: data.session_id,
      captured_at: now,
      method: data.method,
      url: data.url,
      path: data.path,
      query_raw: data.query_raw ?? null,
      request_headers: data.request_headers ? JSON.stringify(data.request_headers) : null,
      request_body: data.request_body ? JSON.stringify(data.request_body) : null,
      request_body_path: data.request_body_path ?? null,
      request_body_size: data.request_body_size ?? null,
      response_status: data.response_status ?? null,
      response_headers: data.response_headers ? JSON.stringify(data.response_headers) : null,
      response_body: data.response_body ? JSON.stringify(data.response_body) : null,
      response_body_path: data.response_body_path ?? null,
      response_body_size: data.response_body_size ?? null,
      response_time_ms: data.response_time_ms ?? null,
      source: data.source ?? 'fetch',
      trace_id: data.trace_id ?? null,
    });
  } catch (err) {
    // Silently skip — WAL contention can cause transient errors
  }

  return id;
}

/** Get all requests, optionally filtered by session */
export function getRequests(sessionId?: string): any[] {
  const db = getDb();
  if (sessionId) {
    return db.prepare('SELECT * FROM requests WHERE session_id = ? ORDER BY captured_at DESC').all(sessionId);
  }
  return db.prepare('SELECT * FROM requests ORDER BY captured_at DESC').all();
}

/** Get a single request by ID */
export function getRequest(id: string): any | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
}

/** Count requests */
export function getRequestCount(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM requests').get() as any;
  return row?.count ?? 0;
}

export function getResponseBodyText(row: any): string | null {
  if (!row) return null;
  if (row.response_body) {
    return typeof row.response_body === 'string' ? row.response_body : JSON.stringify(row.response_body);
  }
  return null;
}
