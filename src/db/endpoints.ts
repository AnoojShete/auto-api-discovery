/**
 * Endpoint CRUD + deduplication.
 * Endpoints are unique on (method, path_template, base_url).
 */

import { createHash } from 'crypto';
import { getDb } from './schema';

export interface EndpointRecord {
  id: string;
  method: string;
  path_template: string;
  base_url: string;
  provenance?: string | null;
  tag?: string | null;
  status?: string;
  deprecated?: boolean;
  first_seen_at: number;
  last_seen_at: number;
  observation_count: number;
}

/** Generate a deterministic endpoint ID */
export function computeEndpointId(method: string, pathTemplate: string, baseUrl: string): string {
  return createHash('sha256')
    .update(`${method}:${pathTemplate}:${baseUrl}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Upsert an endpoint. If it already exists, increments observation_count
 * and updates last_seen_at.
 */
export function upsertEndpoint(
  method: string,
  pathTemplate: string,
  baseUrl: string,
  provenance: string = 'network'
): string {
  const db = getDb();
  const id = computeEndpointId(method, pathTemplate, baseUrl);
  const now = Date.now();

  const existing = db.prepare('SELECT id FROM endpoints WHERE id = ?').get(id);

  if (existing) {
    db.prepare(`
      UPDATE endpoints
      SET last_seen_at = ?, observation_count = observation_count + 1
      WHERE id = ?
    `).run(now, id);
  } else {
    db.prepare(`
      INSERT INTO endpoints (id, method, path_template, base_url, provenance, first_seen_at, last_seen_at, observation_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(id, method, pathTemplate, baseUrl, provenance, now, now);
  }

  return id;
}

/** Link a request to its endpoint */
export function linkRequestToEndpoint(requestId: string, endpointId: string): void {
  const db = getDb();
  try {
    db.prepare(`
      INSERT OR IGNORE INTO request_endpoint_map (request_id, endpoint_id)
      VALUES (?, ?)
    `).run(requestId, endpointId);
  } catch {
    // Ignore constraint violations
  }
}

/** Get all endpoints */
export function getAllEndpoints(): EndpointRecord[] {
  const db = getDb();
  return db.prepare('SELECT * FROM endpoints ORDER BY path_template').all() as EndpointRecord[];
}

/** Get endpoints with their observation counts */
export function getEndpointsWithStats(): any[] {
  const db = getDb();
  return db.prepare(`
    SELECT e.*, COUNT(rem.request_id) as request_count
    FROM endpoints e
    LEFT JOIN request_endpoint_map rem ON e.id = rem.endpoint_id
    GROUP BY e.id
    ORDER BY e.path_template
  `).all();
}

/** Get endpoint by ID */
export function getEndpoint(id: string): EndpointRecord | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM endpoints WHERE id = ?').get(id) as EndpointRecord | undefined;
}

/** Update endpoint tag */
export function setEndpointTag(id: string, tag: string): void {
  const db = getDb();
  db.prepare('UPDATE endpoints SET tag = ? WHERE id = ?').run(tag, id);
}

/** Update endpoint status */
export function setEndpointStatus(id: string, status: string): void {
  const db = getDb();
  db.prepare('UPDATE endpoints SET status = ? WHERE id = ?').run(status, id);
}
