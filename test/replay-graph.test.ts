import { describe, it, expect } from 'vitest';
import { ReplayGraph } from '../src/replay/graph';

describe('ReplayGraph', () => {
  it('Graph traversal tests (BFS, DFS, shortest path, tracing)', () => {
    const graph = new ReplayGraph();
    graph.addNode({ id: 'req1', type: 'request' });
    graph.addNode({ id: 'req2', type: 'request' });
    graph.addNode({ id: 'req3', type: 'request' });
    graph.addNode({ id: 'req4', type: 'request' });

    graph.addEdge({
      sourceId: 'req1', targetId: 'req2',
      dependencyType: 'path_param', confidence: 0.9, provenance: 'inferred',
      heuristicSource: 'path', temporalDistanceMs: 100
    });
    graph.addEdge({
      sourceId: 'req2', targetId: 'req3',
      dependencyType: 'cookie', confidence: 0.9, provenance: 'inferred',
      heuristicSource: 'cookie', temporalDistanceMs: 200
    });
    graph.addEdge({
      sourceId: 'req1', targetId: 'req4',
      dependencyType: 'token', confidence: 0.95, provenance: 'inferred',
      heuristicSource: 'body', temporalDistanceMs: 300
    });

    const bfs = graph.bfs('req1');
    expect(bfs).toEqual(['req1', 'req2', 'req4', 'req3']);

    const dfs = graph.dfs('req1');
    expect(dfs.length).toBe(4);

    const path = graph.getShortestPath('req1', 'req3');
    expect(path).toEqual(['req1', 'req2', 'req3']);

    const upstream = graph.traceUpstream('req3');
    expect(upstream).toEqual(['req3', 'req2', 'req1']);
  });

  it('Clustering & workflow extraction tests', () => {
    const graph = new ReplayGraph();
    // GraphQL group
    graph.addNode({ id: 'g1', type: 'graphql_operation' });
    graph.addNode({ id: 'g2', type: 'graphql_operation' });
    graph.addEdge({ sourceId: 'g1', targetId: 'g2', dependencyType: 'graphql_var', confidence: 0.9, provenance: 'inferred', heuristicSource: '', temporalDistanceMs: 100 });

    // Route family group
    graph.addNode({ id: 'r1', type: 'request', data: { path: '/api/users/list' } });
    graph.addNode({ id: 'r2', type: 'request', data: { path: '/api/users/delete' } });
    graph.addEdge({ sourceId: 'r1', targetId: 'r2', dependencyType: 'path_param', confidence: 0.9, provenance: 'inferred', heuristicSource: '', temporalDistanceMs: 100 });

    // Auth boundary
    graph.addNode({ id: 'auth1', type: 'auth' });
    graph.addNode({ id: 't1', type: 'request' });
    graph.addEdge({ sourceId: 'auth1', targetId: 't1', dependencyType: 'token', confidence: 0.9, provenance: 'inferred', heuristicSource: '', temporalDistanceMs: 100 });

    const clusters = graph.clusterWorkflows();
    
    // Check if clusters keys contain graphql, auth_boundary, and route_family
    const keys = Object.keys(clusters);
    expect(keys.some(k => k.includes('graphql'))).toBe(true);
    expect(keys.some(k => k.includes('route_family'))).toBe(true);
    expect(keys.some(k => k.includes('auth_boundary'))).toBe(true);
  });

  it('Cycle tests (classification)', () => {
    const graph = new ReplayGraph();
    // Polling cycle
    graph.addNode({ id: 'p1', type: 'request' });
    graph.addNode({ id: 'p2', type: 'request' });
    graph.addEdge({ sourceId: 'p1', targetId: 'p2', dependencyType: 'query_param', confidence: 0.9, provenance: 'inferred', heuristicSource: '', temporalDistanceMs: 1000 });
    graph.addEdge({ sourceId: 'p2', targetId: 'p1', dependencyType: 'query_param', confidence: 0.9, provenance: 'inferred', heuristicSource: '', temporalDistanceMs: 1000 });

    // Auth refresh
    graph.addNode({ id: 'a1', type: 'auth' });
    graph.addNode({ id: 'a2', type: 'request' });
    graph.addEdge({ sourceId: 'a1', targetId: 'a2', dependencyType: 'token', confidence: 0.9, provenance: 'inferred', heuristicSource: '', temporalDistanceMs: 500 });
    graph.addEdge({ sourceId: 'a2', targetId: 'a1', dependencyType: 'token', confidence: 0.9, provenance: 'inferred', heuristicSource: '', temporalDistanceMs: 500 });

    const cycles = graph.classifyCycles();
    expect(cycles.length).toBeGreaterThanOrEqual(2);
    expect(cycles.some(c => c.type === 'polling')).toBe(true);
    expect(cycles.some(c => c.type === 'auth_refresh')).toBe(true);
  });

  it('Graph metrics generation', () => {
    const graph = new ReplayGraph();
    graph.addNode({ id: '1', type: 'auth' });
    graph.addNode({ id: '2', type: 'request' });
    graph.addNode({ id: '3', type: 'request' });
    
    graph.addEdge({ sourceId: '1', targetId: '2', dependencyType: 'token', confidence: 0.9, provenance: 'inferred', heuristicSource: '', temporalDistanceMs: 100 });
    graph.addEdge({ sourceId: '2', targetId: '3', dependencyType: 'token', confidence: 0.9, provenance: 'inferred', heuristicSource: '', temporalDistanceMs: 100 });

    const metrics = graph.getMetrics();
    expect(metrics.nodeCount).toBe(3);
    expect(metrics.edgeCount).toBe(2);
    expect(metrics.authChainCount).toBe(1);
    expect(metrics.connectedComponents).toBe(1);
    expect(metrics.averageChainDepth).toBe(3);
  });
});
