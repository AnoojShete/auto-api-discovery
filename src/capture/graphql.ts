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

import { parse, visit, OperationDefinitionNode, FragmentDefinitionNode } from 'graphql';
import { recordParseDiagnostic } from '../db/diagnostics';

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
  complexity: number;
  has_fragments: number;
  is_persisted_query: number;
  fragments: string | null;
}

export interface DetectedGqlOperation {
  operationType: string | null;   // query | mutation | subscription
  operationName: string | null;
  document: string;
  variables: any;
  complexity: number;
  hasFragments: boolean;
  isPersistedQuery: boolean;
  fragments: string[];
}

// ────────────────────────────────────────────────────────────────
// Detection helpers
// ────────────────────────────────────────────────────────────────

const GQL_PATH_RE = /\/graphql/i;

/**
 * Determine if an intercepted request is a GraphQL call.
 * Checks:  1) path contains "graphql"
 *          2) JSON body has a `query` string field, or it's an array of such objects (batched)
 */
export function isGraphQLRequest(path: string, body: any): boolean {
  if (GQL_PATH_RE.test(path)) return true;
  if (!body) return false;
  const items = Array.isArray(body) ? body : [body];
  if (items.length === 0) return false;
  return items.every(item => item && typeof item === 'object' && (typeof item.query === 'string' || (item.extensions && item.extensions.persistedQuery)));
}

// ────────────────────────────────────────────────────────────────
// Extraction (AST-based)
// ────────────────────────────────────────────────────────────────

/**
 * Extract operation metadata from a GraphQL request body.
 * Uses graphql-js to parse the AST. Handles batched requests.
 */
export function extractGqlOperation(body: any, url?: string): DetectedGqlOperation[] {
  if (!body || typeof body !== 'object') return [];

  const items = Array.isArray(body) ? body : [body];
  const results: DetectedGqlOperation[] = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;

    const queryStr: string | undefined = item.query;
    const isPersistedQuery = !!(item.extensions && item.extensions.persistedQuery);

    if (!isPersistedQuery && (typeof queryStr !== 'string' || queryStr.trim().length === 0)) {
      continue;
    }

    // Handle persisted query with no document
    if (isPersistedQuery && (!queryStr || queryStr.trim().length === 0)) {
      results.push({
        operationType: 'query', // Assume query for persisted without doc
        operationName: item.operationName || null,
        document: '',
        variables: item.variables ?? null,
        complexity: 0,
        hasFragments: false,
        isPersistedQuery: true,
        fragments: [],
      });
      continue;
    }

    let ast;
    try {
      ast = parse(queryStr!);
    } catch (error: any) {
      recordParseDiagnostic('graphql', url, error.message);
      continue;
    }

    let operationType: string | null = null;
    let operationName: string | null = item.operationName || null;
    let complexity = 0;
    const fragments: string[] = [];
    let hasFragments = false;

    visit(ast, {
      OperationDefinition(node: OperationDefinitionNode) {
        // If operationName is specified in request, look for that specific operation
        if (item.operationName) {
          if (node.name && node.name.value === item.operationName) {
            operationType = node.operation;
          }
        } else if (!operationType) {
          // If no operationName in request, just take the first operation found
          operationType = node.operation;
          if (!operationName && node.name) {
            operationName = node.name.value;
          }
        }
      },
      FragmentDefinition(node: FragmentDefinitionNode) {
        hasFragments = true;
        fragments.push(node.name.value);
      },
      Field() {
        complexity++;
      },
      InlineFragment() {
        hasFragments = true;
      },
      FragmentSpread() {
        hasFragments = true;
      }
    });

    results.push({
      operationType: operationType || 'query',
      operationName,
      document: queryStr!,
      variables: item.variables ?? null,
      complexity,
      hasFragments,
      isPersistedQuery,
      fragments,
    });
  }

  return results;
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
        document, variables, source, endpoint_url, captured_at,
        complexity, has_fragments, is_persisted_query, fragments
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      op.complexity,
      op.hasFragments ? 1 : 0,
      op.isPersistedQuery ? 1 : 0,
      op.fragments.length > 0 ? JSON.stringify(op.fragments) : null
    );

    logEvent('gql.operation.new', {
      id,
      operation_type: op.operationType,
      operation_name: op.operationName,
      source,
      complexity: op.complexity,
      has_fragments: op.hasFragments,
      is_persisted_query: op.isPersistedQuery
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
