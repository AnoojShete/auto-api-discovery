/**
 * CLI command: summarize
 * Usage: apigen summarize
 *
 * MVP visibility layer — produces a clean, terminal-friendly summary
 * of the current discovery session by reusing existing subsystems:
 *   - ReplayGraph & GraphMetrics
 *   - WorkflowSynthesizer & WorkflowModel
 *   - IdentityResolver & CanonicalEndpoint
 *   - Replay metrics (replay events, dependencies, jobs)
 *   - Database tables (requests, endpoints, gql_operations, etc.)
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { getDb } from '../db/schema';
import { ReplayGraph } from '../replay/graph';
import { WorkflowSynthesizer, WorkflowType, ReplayViability } from '../replay/workflows';
import { IdentityResolver, TrustState } from '../discovery/identity';
import { getReplayMetrics } from '../replay/metrics';

// ────────────────────────────────────────────────────────────────
// Data collection (pure functions for testability)
// ────────────────────────────────────────────────────────────────

export interface SessionSummary {
  totalRequests: number;
  totalEndpoints: number;
  graphqlOperations: number;
  workflowsDiscovered: number;
  authChains: number;
}

export interface EndpointSummary {
  topRouteFamilies: { route: string; count: number }[];
  restCount: number;
  graphqlCount: number;
  websocketCount: number;
  observed: number;
  inferred: number;
}

export interface WorkflowSummary {
  workflowTypes: { type: WorkflowType; count: number }[];
  replayViability: { viability: ReplayViability; count: number }[];
  criticalWorkflowPaths: number;
}

export interface DiscoverySummary {
  runtimeCapture: number;
  staticBundle: number;
  persistedQuery: number;
  inferredRoute: number;
}

export interface ReplaySummary {
  safelyReplayable: number;
  partiallyReplayable: number;
  dangerous: number;
}

export interface FullSummary {
  session: SessionSummary;
  endpoint: EndpointSummary;
  workflow: WorkflowSummary;
  discovery: DiscoverySummary;
  replay: ReplaySummary;
}

/** Safe count helper — returns 0 if the table doesn't exist */
function safeCount(db: any, table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Collect all summary data from the database and in-memory graph systems.
 * This function is exported for testing.
 */
export function collectSummary(db: any): FullSummary {
  // ── Session Overview ─────────────────────────────────────────
  const totalRequests = safeCount(db, 'requests');
  const totalEndpoints = safeCount(db, 'endpoints');
  const graphqlOperations = safeCount(db, 'gql_operations');

  // Build a ReplayGraph from the database's replay_dependencies + requests
  const graph = buildReplayGraphFromDb(db);
  const synthesizer = new WorkflowSynthesizer(graph);
  const workflows = synthesizer.synthesize();
  const authChains = graph.extractAuthChains();

  // ── Endpoint Overview ────────────────────────────────────────
  const endpoints = queryEndpoints(db);
  const resolver = new IdentityResolver();

  // Resolve all endpoints through the identity resolver to get trust states
  for (const ep of endpoints) {
    resolver.resolveEndpoint(
      ep.method,
      ep.path_template,
      ep.provenance || 'runtime_capture',
      ep.path_template.endsWith('/graphql'),
      1.0,
      {}
    );
  }

  const registry = resolver.getRegistry();
  const routeFamilyMap = new Map<string, number>();
  let restCount = 0;
  let graphqlEndpointCount = 0;
  let websocketCount = 0;
  let observed = 0;
  let inferred = 0;

  for (const canonical of registry.values()) {
    // Route family: first two segments
    const segments = canonical.normalizedPath.split('/').filter(Boolean);
    const family = '/' + (segments.slice(0, 2).join('/') || segments[0] || '');
    routeFamilyMap.set(family, (routeFamilyMap.get(family) || 0) + 1);

    // Protocol counts
    if (canonical.isGraphQL) {
      graphqlEndpointCount++;
    } else if (canonical.protocolType === 'ws' || canonical.protocolType === 'wss') {
      websocketCount++;
    } else {
      restCount++;
    }

    // Trust state
    if (canonical.trustState === 'observed' || canonical.trustState === 'discovered') {
      observed++;
    } else {
      inferred++;
    }
  }

  // Also count WS sessions from the database
  const wsSessionCount = safeCount(db, 'ws_sessions');
  websocketCount = Math.max(websocketCount, wsSessionCount > 0 ? 1 : 0);

  // Sort route families by count, top 5
  const topRouteFamilies = Array.from(routeFamilyMap.entries())
    .map(([route, count]) => ({ route, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // ── Workflow Overview ────────────────────────────────────────
  const workflowTypeMap = new Map<WorkflowType, number>();
  const viabilityMap = new Map<ReplayViability, number>();
  let criticalWorkflowPaths = 0;

  for (const wf of workflows) {
    workflowTypeMap.set(wf.type, (workflowTypeMap.get(wf.type) || 0) + 1);
    viabilityMap.set(wf.replayViability, (viabilityMap.get(wf.replayViability) || 0) + 1);
    if (wf.criticalPaths.length > 1) criticalWorkflowPaths++;
  }

  const workflowTypes = Array.from(workflowTypeMap.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);

  const replayViability = Array.from(viabilityMap.entries())
    .map(([viability, count]) => ({ viability, count }))
    .sort((a, b) => b.count - a.count);

  // ── Discovery Overview ───────────────────────────────────────
  const discoveryCountMap = countDiscoveryProvenances(db);

  // ── Replay Overview ──────────────────────────────────────────
  const safelyReplayable = viabilityMap.get('safely replayable') || 0;
  const partiallyReplayable = viabilityMap.get('partially replayable') || 0;
  const dangerous = (viabilityMap.get('high-risk replay') || 0) + (viabilityMap.get('unresolved replay') || 0);

  return {
    session: {
      totalRequests,
      totalEndpoints,
      graphqlOperations,
      workflowsDiscovered: workflows.length,
      authChains: authChains.length,
    },
    endpoint: {
      topRouteFamilies,
      restCount,
      graphqlCount: graphqlEndpointCount,
      websocketCount,
      observed,
      inferred,
    },
    workflow: {
      workflowTypes,
      replayViability,
      criticalWorkflowPaths,
    },
    discovery: {
      runtimeCapture: discoveryCountMap.get('runtime_capture') || discoveryCountMap.get('network') || 0,
      staticBundle: discoveryCountMap.get('static_bundle') || 0,
      persistedQuery: discoveryCountMap.get('persisted_query') || 0,
      inferredRoute: discoveryCountMap.get('inferred_route') || 0,
    },
    replay: {
      safelyReplayable,
      partiallyReplayable,
      dangerous,
    },
  };
}

// ────────────────────────────────────────────────────────────────
// DB helpers
// ────────────────────────────────────────────────────────────────

interface EndpointRow {
  method: string;
  path_template: string;
  provenance: string | null;
}

function queryEndpoints(db: any): EndpointRow[] {
  try {
    return db.prepare('SELECT method, path_template, provenance FROM endpoints').all() as EndpointRow[];
  } catch {
    return [];
  }
}

function countDiscoveryProvenances(db: any): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const rows = db.prepare(`
      SELECT provenance, COUNT(*) as c FROM endpoints GROUP BY provenance
    `).all() as any[];
    for (const row of rows) {
      if (row.provenance) {
        map.set(row.provenance, row.c);
      }
    }
  } catch {
    // database might not exist
  }
  return map;
}

function buildReplayGraphFromDb(db: any): ReplayGraph {
  const graph = new ReplayGraph();

  try {
    // Add request nodes
    const requests = db.prepare(`
      SELECT id, method, url, path, source FROM requests ORDER BY captured_at ASC
    `).all() as any[];

    for (const req of requests) {
      const isWs = req.url?.startsWith('ws://') || req.url?.startsWith('wss://');
      graph.addNode({
        id: req.id,
        type: isWs ? 'websocket' : 'request',
        data: {
          url: req.url,
          path: req.path,
          method: req.method,
          provenance: 'runtime_capture',
        },
      });
    }

    // Add GraphQL operation nodes
    const gqlOps = db.prepare(`
      SELECT id, operation_name, endpoint_url FROM gql_operations
    `).all() as any[];

    for (const op of gqlOps) {
      graph.addNode({
        id: `gql_${op.id}`,
        type: 'graphql_operation',
        data: {
          url: op.endpoint_url || '/graphql',
          method: 'POST',
          operationName: op.operation_name,
          provenance: 'runtime_capture',
        },
      });
    }

    // Add dependency edges
    const deps = db.prepare(`
      SELECT source_request_id, target_request_id, dependency_type, confidence
      FROM replay_dependencies
    `).all() as any[];

    for (const dep of deps) {
      // Only add edges where both nodes exist
      if (graph.getNode(dep.source_request_id) && graph.getNode(dep.target_request_id)) {
        graph.addEdge({
          sourceId: dep.source_request_id,
          targetId: dep.target_request_id,
          dependencyType: dep.dependency_type,
          confidence: dep.confidence,
          provenance: 'inferred',
          heuristicSource: 'db',
          temporalDistanceMs: 0,
        });
      }
    }
  } catch {
    // Graph from empty/missing DB is fine — empty graph
  }

  return graph;
}

// ────────────────────────────────────────────────────────────────
// Rendering
// ────────────────────────────────────────────────────────────────

const DIVIDER = chalk.gray('─'.repeat(52));
const SECTION_ICON = {
  session: '📊',
  endpoint: '🔗',
  workflow: '🔄',
  discovery: '🔍',
  replay: '▶️',
};

function renderValue(val: number): string {
  return val > 0 ? chalk.green(val.toString()) : chalk.gray('0');
}

function renderLabel(label: string, width: number = 28): string {
  return chalk.white(label.padEnd(width));
}

function renderEmptyState(msg: string): void {
  console.log(`  ${chalk.italic.gray(msg)}`);
}

export function renderSummary(summary: FullSummary): void {
  console.log('');
  console.log(chalk.bold.cyan('  ApiGen — Session Summary'));
  console.log(DIVIDER);

  // ── Session Overview ──
  console.log('');
  console.log(chalk.bold.white(`  ${SECTION_ICON.session}  Session Overview`));
  console.log('');

  if (summary.session.totalRequests === 0) {
    renderEmptyState('No requests captured yet. Run apigen capture or crawl first.');
  } else {
    console.log(`  ${renderLabel('Total requests')}${renderValue(summary.session.totalRequests)}`);
    console.log(`  ${renderLabel('Total endpoints')}${renderValue(summary.session.totalEndpoints)}`);
    console.log(`  ${renderLabel('GraphQL operations')}${renderValue(summary.session.graphqlOperations)}`);
    console.log(`  ${renderLabel('Workflows discovered')}${renderValue(summary.session.workflowsDiscovered)}`);
    console.log(`  ${renderLabel('Auth chains')}${renderValue(summary.session.authChains)}`);
  }

  console.log('');
  console.log(DIVIDER);

  // ── Endpoint Overview ──
  console.log('');
  console.log(chalk.bold.white(`  ${SECTION_ICON.endpoint}  Endpoint Overview`));
  console.log('');

  if (summary.endpoint.restCount === 0 && summary.endpoint.graphqlCount === 0 && summary.endpoint.websocketCount === 0) {
    renderEmptyState('No endpoints discovered yet.');
  } else {
    console.log(`  ${renderLabel('REST endpoints')}${renderValue(summary.endpoint.restCount)}`);
    console.log(`  ${renderLabel('GraphQL endpoints')}${renderValue(summary.endpoint.graphqlCount)}`);
    console.log(`  ${renderLabel('WebSocket endpoints')}${renderValue(summary.endpoint.websocketCount)}`);
    console.log(`  ${renderLabel('Observed')}${renderValue(summary.endpoint.observed)}`);
    console.log(`  ${renderLabel('Inferred')}${renderValue(summary.endpoint.inferred)}`);

    if (summary.endpoint.topRouteFamilies.length > 0) {
      console.log('');
      console.log(chalk.white('  Top route families:'));
      for (const rf of summary.endpoint.topRouteFamilies) {
        console.log(`    ${chalk.cyan(rf.route.padEnd(30))} ${chalk.gray(`(${rf.count} endpoint${rf.count !== 1 ? 's' : ''})`)}`);
      }
    }
  }

  console.log('');
  console.log(DIVIDER);

  // ── Workflow Overview ──
  console.log('');
  console.log(chalk.bold.white(`  ${SECTION_ICON.workflow}  Workflow Overview`));
  console.log('');

  if (summary.workflow.workflowTypes.length === 0) {
    renderEmptyState('No workflows discovered yet.');
  } else {
    for (const wt of summary.workflow.workflowTypes) {
      console.log(`  ${renderLabel(wt.type)}${renderValue(wt.count)}`);
    }
    console.log('');
    console.log(chalk.white('  Replay viability:'));
    for (const rv of summary.workflow.replayViability) {
      const color = rv.viability === 'safely replayable' ? chalk.green
        : rv.viability === 'partially replayable' ? chalk.yellow
        : chalk.red;
      console.log(`    ${color(rv.viability.padEnd(28))} ${chalk.white(rv.count.toString())}`);
    }
    console.log('');
    console.log(`  ${renderLabel('Critical workflow paths')}${renderValue(summary.workflow.criticalWorkflowPaths)}`);
  }

  console.log('');
  console.log(DIVIDER);

  // ── Discovery Overview ──
  console.log('');
  console.log(chalk.bold.white(`  ${SECTION_ICON.discovery}  Discovery Overview`));
  console.log('');

  const totalDiscovery = summary.discovery.runtimeCapture
    + summary.discovery.staticBundle
    + summary.discovery.persistedQuery
    + summary.discovery.inferredRoute;

  if (totalDiscovery === 0) {
    renderEmptyState('No discovery sources recorded yet.');
  } else {
    console.log(`  ${renderLabel('runtime_capture')}${renderValue(summary.discovery.runtimeCapture)}`);
    console.log(`  ${renderLabel('static_bundle')}${renderValue(summary.discovery.staticBundle)}`);
    console.log(`  ${renderLabel('persisted_query')}${renderValue(summary.discovery.persistedQuery)}`);
    console.log(`  ${renderLabel('inferred_route')}${renderValue(summary.discovery.inferredRoute)}`);
  }

  console.log('');
  console.log(DIVIDER);

  // ── Replay Overview ──
  console.log('');
  console.log(chalk.bold.white(`  ${SECTION_ICON.replay}  Replay Overview`));
  console.log('');

  const totalReplay = summary.replay.safelyReplayable
    + summary.replay.partiallyReplayable
    + summary.replay.dangerous;

  if (totalReplay === 0) {
    renderEmptyState('No replayable workflows identified yet.');
  } else {
    console.log(`  ${renderLabel('Safely replayable')}${chalk.green(summary.replay.safelyReplayable.toString())}`);
    console.log(`  ${renderLabel('Partially replayable')}${chalk.yellow(summary.replay.partiallyReplayable.toString())}`);
    console.log(`  ${renderLabel('Dangerous')}${chalk.red(summary.replay.dangerous.toString())}`);
  }

  console.log('');
  console.log(DIVIDER);
  console.log('');
}

// ────────────────────────────────────────────────────────────────
// Command Registration
// ────────────────────────────────────────────────────────────────

export function registerSummarizeCommand(program: Command): void {
  program
    .command('summarize')
    .description('Show a comprehensive summary of the current discovery session')
    .option('--json', 'Output raw summary as JSON')
    .action((options: { json?: boolean }) => {
      try {
        const db = getDb();
        const summary = collectSummary(db);

        if (options.json) {
          console.log(JSON.stringify(summary, null, 2));
        } else {
          renderSummary(summary);
        }
      } catch {
        console.log(chalk.red('  No database found. Run apigen capture or crawl first.\n'));
      }
    });
}
