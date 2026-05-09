/**
 * GraphQL detection, extraction, and introspection (Phase 2 — L2.2).
 *
 * Detects GraphQL requests by path or body shape, extracts operation metadata,
 * and optionally runs introspection against the endpoint.
 */

import chalk from 'chalk';
import { randomUUID, createHash } from 'crypto';
import { getDb } from '../db/schema';
import { logEvent } from '../observability/logger';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface GqlOperationRecord {
  id: string;
  session_id: string | null;
  operation_type: string | null;
  operation_name: string | null;
  document: string;
  variables: string | null;
  source: string;
  endpoint_url: string | null;
  captured_at: number;
  introspection_status: string | null;
}

export interface DetectedGqlOperation {
  operationType: string | null;   // query | mutation | subscription
  operationName: string | null;
  document: string;
  variables: any;
}

// ────────────────────────────────────────────────────────────────
// Detection helpers
// ────────────────────────────────────────────────────────────────

const GQL_PATH_RE = /\/graphql/i;

/**
 * Determine if an intercepted request is a GraphQL call.
 * Checks:  1) path contains "graphql"
 *          2) JSON body has a `query` string field
 */
export function isGraphQLRequest(path: string, body: any): boolean {
  if (GQL_PATH_RE.test(path)) return true;
  if (body && typeof body === 'object' && typeof body.query === 'string') return true;
  return false;
}

// ────────────────────────────────────────────────────────────────
// Extraction (lightweight — no graphql-js dependency)
// ────────────────────────────────────────────────────────────────

const OP_TYPE_RE = /^\s*(query|mutation|subscription)\b/i;
const OP_NAME_RE = /^\s*(?:query|mutation|subscription)\s+([A-Za-z_]\w*)/i;

/**
 * Extract operation metadata from a GraphQL request body.
 * This is a lightweight regex-based extractor that works without
 * the graphql-js parser so we keep dependencies minimal.
 */
export function extractGqlOperation(body: any): DetectedGqlOperation | null {
  if (!body || typeof body !== 'object') return null;

  const queryStr: string | undefined = body.query;
  if (typeof queryStr !== 'string' || queryStr.trim().length === 0) return null;

  // operationName may be supplied explicitly or derived from the document
  let operationType: string | null = null;
  let operationName: string | null = body.operationName || null;

  // Derive from the document text
  const typeMatch = queryStr.match(OP_TYPE_RE);
  if (typeMatch) {
    operationType = typeMatch[1].toLowerCase();
  } else {
    // Default: bare `{ field }` is a shorthand query
    operationType = 'query';
  }

  if (!operationName) {
    const nameMatch = queryStr.match(OP_NAME_RE);
    if (nameMatch) operationName = nameMatch[1];
  }

  return {
    operationType,
    operationName,
    document: queryStr,
    variables: body.variables ?? null,
  };
}

// ────────────────────────────────────────────────────────────────
// Persistence
// ────────────────────────────────────────────────────────────────

/**
 * Content-addressed ID for dedup (operation_type + operation_name + doc hash).
 */
function computeGqlId(doc: string, opName: string | null): string {
  return createHash('sha256')
    .update(`gql:${opName ?? ''}:${doc}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Upsert a GraphQL operation into the database.
 * Deduplicates on document hash + operation name.
 */
export function upsertGqlOperation(
  op: DetectedGqlOperation,
  sessionId: string,
  endpointUrl: string,
  source: string = 'network',
): string {
  const db = getDb();
  const id = computeGqlId(op.document, op.operationName);
  const now = Date.now();

  const existing = db.prepare('SELECT id FROM gql_operations WHERE id = ?').get(id);

  if (!existing) {
    db.prepare(`
      INSERT INTO gql_operations (
        id, session_id, operation_type, operation_name,
        document, variables, source, endpoint_url, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      sessionId,
      op.operationType,
      op.operationName,
      op.document,
      op.variables ? JSON.stringify(op.variables) : null,
      source,
      endpointUrl,
      now,
    );

    logEvent('gql.operation.new', {
      id,
      operation_type: op.operationType,
      operation_name: op.operationName,
      source,
    });
  }

  return id;
}

// ────────────────────────────────────────────────────────────────
// Query helpers
// ────────────────────────────────────────────────────────────────

/** List all captured GraphQL operations */
export function getAllGqlOperations(): GqlOperationRecord[] {
  const db = getDb();
  return db.prepare('SELECT * FROM gql_operations ORDER BY captured_at DESC').all() as GqlOperationRecord[];
}

/** Count GraphQL operations */
export function getGqlOperationCount(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as c FROM gql_operations').get() as any;
  return row?.c ?? 0;
}

/** Get breakdown by operation type */
export function getGqlOperationBreakdown(): { type: string; count: number }[] {
  const db = getDb();
  return db.prepare(`
    SELECT operation_type as type, COUNT(*) as count
    FROM gql_operations
    GROUP BY operation_type
    ORDER BY count DESC
  `).all() as any[];
}

// ────────────────────────────────────────────────────────────────
// Introspection
// ────────────────────────────────────────────────────────────────

const INTROSPECTION_QUERY = `{
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind
      name
      fields {
        name
        type { kind name ofType { kind name ofType { kind name } } }
      }
    }
  }
}`;

/**
 * Attempt a GraphQL introspection query against a discovered endpoint.
 * Returns the introspection result or null on failure.
 *
 * Requires `got` or a fetch implementation at runtime — we use
 * a simple https/http request to stay dependency-free.
 */
export async function attemptIntrospection(
  endpointUrl: string,
  cookies?: string,
): Promise<any | null> {
  try {
    const { default: http } = endpointUrl.startsWith('https')
      ? await import('https')
      : await import('http');

    return new Promise((resolve) => {
      const url = new URL(endpointUrl);
      const payload = JSON.stringify({ query: INTROSPECTION_QUERY });

      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            ...(cookies ? { Cookie: cookies } : {}),
          },
          timeout: 10_000,
        },
        (res: any) => {
          let body = '';
          res.on('data', (chunk: any) => { body += chunk; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body);
              if (parsed.data?.__schema) {
                logEvent('gql.introspection.success', { url: endpointUrl });
                resolve(parsed.data.__schema);
              } else {
                logEvent('gql.introspection.empty', { url: endpointUrl });
                resolve(null);
              }
            } catch {
              resolve(null);
            }
          });
        },
      );

      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(payload);
      req.end();
    });
  } catch {
    return null;
  }
}
