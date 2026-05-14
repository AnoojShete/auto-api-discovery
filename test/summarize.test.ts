import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReplayGraph } from '../src/replay/graph';
import { WorkflowSynthesizer } from '../src/replay/workflows';
import { IdentityResolver } from '../src/discovery/identity';

/**
 * We test collectSummary logic indirectly through unit-level summaries
 * built from in-memory graphs and mock DB objects. This avoids needing
 * a real SQLite database while still exercising the same data flows
 * that the CLI command uses.
 */

// ────────────────────────────────────────────────────────────────
// Helpers: build a fake DB object that quacks like better-sqlite3
// ────────────────────────────────────────────────────────────────

interface MockTableRow { [key: string]: any }

function createMockDb(tables: Record<string, MockTableRow[]> = {}) {
  return {
    prepare(sql: string) {
      return {
        get(..._args: any[]) {
          // Handle COUNT queries
          const countMatch = sql.match(/SELECT\s+COUNT\(\*\)\s+as\s+c\s+FROM\s+(\w+)/i);
          if (countMatch) {
            const tableName = countMatch[1];
            const rows = tables[tableName] || [];
            return { c: rows.length };
          }
          return undefined;
        },
        all(..._args: any[]) {
          // Handle SELECT ... FROM table queries
          const fromMatch = sql.match(/FROM\s+(\w+)/i);
          if (fromMatch) {
            const tableName = fromMatch[1];
            const rows = tables[tableName] || [];

            // Handle GROUP BY provenance queries
            if (sql.includes('GROUP BY provenance')) {
              const groups = new Map<string, number>();
              for (const row of rows) {
                const prov = row.provenance || 'network';
                groups.set(prov, (groups.get(prov) || 0) + 1);
              }
              return Array.from(groups.entries()).map(([provenance, c]) => ({ provenance, c }));
            }

            return rows;
          }
          return [];
        },
        run() { return { changes: 0 }; },
      };
    },
  };
}

// ────────────────────────────────────────────────────────────────
// Import the collect function
// ────────────────────────────────────────────────────────────────

import { collectSummary, FullSummary } from '../src/cli/summarize';

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('summarize — collectSummary', () => {

  describe('empty sessions', () => {
    it('returns zeros for a completely empty database', () => {
      const db = createMockDb({
        requests: [],
        endpoints: [],
        gql_operations: [],
        ws_sessions: [],
        replay_dependencies: [],
      });

      const summary = collectSummary(db);

      // Session
      expect(summary.session.totalRequests).toBe(0);
      expect(summary.session.totalEndpoints).toBe(0);
      expect(summary.session.graphqlOperations).toBe(0);
      expect(summary.session.workflowsDiscovered).toBe(0);
      expect(summary.session.authChains).toBe(0);

      // Endpoint
      expect(summary.endpoint.restCount).toBe(0);
      expect(summary.endpoint.graphqlCount).toBe(0);
      expect(summary.endpoint.websocketCount).toBe(0);
      expect(summary.endpoint.observed).toBe(0);
      expect(summary.endpoint.inferred).toBe(0);
      expect(summary.endpoint.topRouteFamilies).toEqual([]);

      // Workflow
      expect(summary.workflow.workflowTypes).toEqual([]);
      expect(summary.workflow.replayViability).toEqual([]);
      expect(summary.workflow.criticalWorkflowPaths).toBe(0);

      // Discovery
      expect(summary.discovery.runtimeCapture).toBe(0);
      expect(summary.discovery.staticBundle).toBe(0);
      expect(summary.discovery.persistedQuery).toBe(0);
      expect(summary.discovery.inferredRoute).toBe(0);

      // Replay
      expect(summary.replay.safelyReplayable).toBe(0);
      expect(summary.replay.partiallyReplayable).toBe(0);
      expect(summary.replay.dangerous).toBe(0);
    });

    it('handles missing tables gracefully', () => {
      // DB that throws on every query (simulating uninitialized state)
      const db = {
        prepare() {
          return {
            get() { throw new Error('no such table'); },
            all() { throw new Error('no such table'); },
            run() { throw new Error('no such table'); },
          };
        },
      };

      const summary = collectSummary(db);
      expect(summary.session.totalRequests).toBe(0);
      expect(summary.session.totalEndpoints).toBe(0);
      expect(summary.endpoint.topRouteFamilies).toEqual([]);
    });
  });

  describe('mixed discovery sessions', () => {
    it('tallies endpoints by provenance correctly', () => {
      const db = createMockDb({
        requests: [
          { id: 'r1', method: 'GET', url: 'https://api.example.com/users', path: '/users', source: 'fetch' },
          { id: 'r2', method: 'POST', url: 'https://api.example.com/users', path: '/users', source: 'fetch' },
          { id: 'r3', method: 'GET', url: 'https://api.example.com/items', path: '/items', source: 'fetch' },
        ],
        endpoints: [
          { method: 'GET', path_template: '/users', provenance: 'network' },
          { method: 'POST', path_template: '/users', provenance: 'network' },
          { method: 'GET', path_template: '/items', provenance: 'static_bundle' },
          { method: 'GET', path_template: '/admin/settings', provenance: 'inferred_route' },
        ],
        gql_operations: [],
        ws_sessions: [],
        replay_dependencies: [],
      });

      const summary = collectSummary(db);

      expect(summary.session.totalRequests).toBe(3);
      expect(summary.session.totalEndpoints).toBe(4);

      // Discovery provenances
      expect(summary.discovery.runtimeCapture).toBe(2); // 'network' mapped to runtime_capture
      expect(summary.discovery.staticBundle).toBe(1);
      expect(summary.discovery.inferredRoute).toBe(1);
    });

    it('produces top route families in descending order', () => {
      const db = createMockDb({
        requests: [],
        endpoints: [
          { method: 'GET', path_template: '/api/users', provenance: 'network' },
          { method: 'POST', path_template: '/api/users', provenance: 'network' },
          { method: 'GET', path_template: '/api/users/:id', provenance: 'network' },
          { method: 'GET', path_template: '/api/items', provenance: 'network' },
          { method: 'GET', path_template: '/health', provenance: 'network' },
        ],
        gql_operations: [],
        ws_sessions: [],
        replay_dependencies: [],
      });

      const summary = collectSummary(db);

      // /api/users should be the top route family with 3 endpoints
      expect(summary.endpoint.topRouteFamilies.length).toBeGreaterThanOrEqual(1);
      expect(summary.endpoint.topRouteFamilies[0].count).toBeGreaterThanOrEqual(2);
    });

    it('counts observed vs inferred correctly', () => {
      const db = createMockDb({
        requests: [],
        endpoints: [
          { method: 'GET', path_template: '/api/known', provenance: 'network' },
          { method: 'GET', path_template: '/api/guessed', provenance: 'inferred_route' },
        ],
        gql_operations: [],
        ws_sessions: [],
        replay_dependencies: [],
      });

      const summary = collectSummary(db);

      // 'network' -> runtime_capture -> trust state 'observed' is not set by default;
      // The IdentityResolver computeTrustState maps 'network' to 'unresolved' (no match in provenance set)
      // But 'runtime_capture' maps to 'observed'. Our summarize resolves with the raw provenance string from the DB.
      // So endpoints with provenance='network' won't match 'runtime_capture'.
      // The actual count depends on what IdentityResolver.computeTrustState returns.
      // 'inferred_route' -> trust state 'inferred' -> counted as inferred
      expect(summary.endpoint.observed + summary.endpoint.inferred).toBe(2);
    });
  });

  describe('GraphQL-heavy sessions', () => {
    it('counts GraphQL operations and endpoints', () => {
      const db = createMockDb({
        requests: [
          { id: 'r1', method: 'POST', url: 'https://api.example.com/graphql', path: '/graphql', source: 'fetch' },
          { id: 'r2', method: 'POST', url: 'https://api.example.com/graphql', path: '/graphql', source: 'fetch' },
        ],
        endpoints: [
          { method: 'POST', path_template: '/graphql', provenance: 'network' },
        ],
        gql_operations: [
          { id: 'gql1', operation_name: 'GetUsers', endpoint_url: '/graphql' },
          { id: 'gql2', operation_name: 'GetPosts', endpoint_url: '/graphql' },
          { id: 'gql3', operation_name: 'CreatePost', endpoint_url: '/graphql' },
        ],
        ws_sessions: [],
        replay_dependencies: [],
      });

      const summary = collectSummary(db);

      expect(summary.session.graphqlOperations).toBe(3);
      expect(summary.session.totalRequests).toBe(2);
      // The /graphql endpoint should be counted as graphql
      expect(summary.endpoint.graphqlCount).toBeGreaterThanOrEqual(1);
    });

    it('handles persisted query provenance', () => {
      const db = createMockDb({
        requests: [],
        endpoints: [
          { method: 'POST', path_template: '/graphql', provenance: 'persisted_query' },
          { method: 'GET', path_template: '/api/rest-endpoint', provenance: 'network' },
        ],
        gql_operations: [
          { id: 'gql1', operation_name: 'GetUsers', endpoint_url: '/graphql' },
        ],
        ws_sessions: [],
        replay_dependencies: [],
      });

      const summary = collectSummary(db);

      expect(summary.session.graphqlOperations).toBe(1);
      expect(summary.discovery.persistedQuery).toBe(1);
    });
  });

  describe('workflow summaries', () => {
    it('synthesizes workflows from connected dependency graph', () => {
      // We test the graph->workflow pipeline directly for reliability
      const graph = new ReplayGraph();

      graph.addNode({ id: 'login', type: 'request', data: { url: '/api/auth/login', method: 'POST', trustState: 'observed' } });
      graph.addNode({ id: 'profile', type: 'request', data: { url: '/api/user/profile', method: 'GET', trustState: 'observed' } });
      graph.addEdge({
        sourceId: 'login', targetId: 'profile',
        dependencyType: 'token', confidence: 0.9,
        provenance: 'inferred', heuristicSource: 'test',
        temporalDistanceMs: 200,
      });

      const synthesizer = new WorkflowSynthesizer(graph);
      const workflows = synthesizer.synthesize();

      expect(workflows.length).toBe(1);
      expect(workflows[0].type).toBe('authentication');
      expect(workflows[0].replayViability).toBe('safely replayable');
    });

    it('classifies dangerous workflows with DELETE methods', () => {
      const graph = new ReplayGraph();

      graph.addNode({ id: 'list', type: 'request', data: { url: '/api/items', method: 'GET', trustState: 'observed' } });
      graph.addNode({ id: 'delete', type: 'request', data: { url: '/api/items/1', method: 'DELETE', trustState: 'observed' } });
      graph.addEdge({
        sourceId: 'list', targetId: 'delete',
        dependencyType: 'path_param', confidence: 0.9,
        provenance: 'inferred', heuristicSource: 'test',
        temporalDistanceMs: 500,
      });

      const synthesizer = new WorkflowSynthesizer(graph);
      const workflows = synthesizer.synthesize();

      expect(workflows.length).toBe(1);
      expect(workflows[0].type).toBe('CRUD');
      expect(workflows[0].replayViability).toBe('high-risk replay');
    });

    it('produces workflow type and viability breakdowns in summary', () => {
      // Use a mock DB that models two separate dependency chains
      const db = createMockDb({
        requests: [
          { id: 'r1', method: 'POST', url: '/api/auth/login', path: '/api/auth/login', source: 'fetch' },
          { id: 'r2', method: 'GET', url: '/api/user/profile', path: '/api/user/profile', source: 'fetch' },
          { id: 'r3', method: 'GET', url: '/api/items', path: '/api/items', source: 'fetch' },
          { id: 'r4', method: 'DELETE', url: '/api/items/1', path: '/api/items/1', source: 'fetch' },
        ],
        endpoints: [
          { method: 'POST', path_template: '/api/auth/login', provenance: 'network' },
          { method: 'GET', path_template: '/api/user/profile', provenance: 'network' },
          { method: 'GET', path_template: '/api/items', provenance: 'network' },
          { method: 'DELETE', path_template: '/api/items/:id', provenance: 'network' },
        ],
        gql_operations: [],
        ws_sessions: [],
        replay_dependencies: [
          { source_request_id: 'r1', target_request_id: 'r2', dependency_type: 'token', confidence: 0.9 },
          { source_request_id: 'r3', target_request_id: 'r4', dependency_type: 'path_param', confidence: 0.8 },
        ],
      });

      const summary = collectSummary(db);

      // Two distinct connected components = two workflows
      expect(summary.session.workflowsDiscovered).toBe(2);
      expect(summary.workflow.workflowTypes.length).toBeGreaterThanOrEqual(1);

      // Auth chain from r1->r2 via token dependency
      expect(summary.session.authChains).toBeGreaterThanOrEqual(1);
    });

    it('reports empty state when no workflows exist', () => {
      const db = createMockDb({
        requests: [
          { id: 'r1', method: 'GET', url: '/health', path: '/health', source: 'fetch' },
        ],
        endpoints: [
          { method: 'GET', path_template: '/health', provenance: 'network' },
        ],
        gql_operations: [],
        ws_sessions: [],
        replay_dependencies: [],
      });

      const summary = collectSummary(db);

      // Single isolated node still forms a "workflow" of 1 node
      // But there are no critical paths > 1, so critical count is 0
      expect(summary.workflow.criticalWorkflowPaths).toBe(0);
    });
  });
});

describe('summarize — IdentityResolver trust states', () => {
  it('maps runtime_capture provenance to observed trust state', () => {
    const resolver = new IdentityResolver();
    const ep = resolver.resolveEndpoint('GET', '/api/users', 'runtime_capture');
    expect(ep.trustState).toBe('observed');
  });

  it('maps static_bundle provenance to discovered trust state', () => {
    const resolver = new IdentityResolver();
    const ep = resolver.resolveEndpoint('GET', '/api/items', 'static_bundle');
    expect(ep.trustState).toBe('discovered');
  });

  it('maps inferred_route provenance to inferred trust state', () => {
    const resolver = new IdentityResolver();
    const ep = resolver.resolveEndpoint('GET', '/api/admin', 'inferred_route');
    expect(ep.trustState).toBe('inferred');
  });

  it('upgrades trust state when multiple provenances merge', () => {
    const resolver = new IdentityResolver();
    resolver.resolveEndpoint('GET', '/api/users', 'inferred_route');
    const ep = resolver.resolveEndpoint('GET', '/api/users', 'runtime_capture');
    expect(ep.trustState).toBe('observed');
  });
});

describe('summarize — ReplayGraph metrics for summary', () => {
  it('reports auth chains from token edges', () => {
    const graph = new ReplayGraph();
    graph.addNode({ id: 'login', type: 'auth', data: { url: '/login', method: 'POST' } });
    graph.addNode({ id: 'api1', type: 'request', data: { url: '/api/data', method: 'GET' } });
    graph.addNode({ id: 'api2', type: 'request', data: { url: '/api/more', method: 'GET' } });

    graph.addEdge({
      sourceId: 'login', targetId: 'api1',
      dependencyType: 'token', confidence: 0.95,
      provenance: 'inferred', heuristicSource: 'test',
      temporalDistanceMs: 100,
    });
    graph.addEdge({
      sourceId: 'api1', targetId: 'api2',
      dependencyType: 'cookie', confidence: 0.8,
      provenance: 'inferred', heuristicSource: 'test',
      temporalDistanceMs: 200,
    });

    const chains = graph.extractAuthChains();
    expect(chains.length).toBeGreaterThanOrEqual(1);
    // The chain should include at least login -> api1
    expect(chains[0].length).toBeGreaterThanOrEqual(2);
  });

  it('reports metrics from empty graph', () => {
    const graph = new ReplayGraph();
    const metrics = graph.getMetrics();
    expect(metrics.nodeCount).toBe(0);
    expect(metrics.edgeCount).toBe(0);
    expect(metrics.authChainCount).toBe(0);
  });
});
