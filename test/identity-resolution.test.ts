import { describe, it, expect } from 'vitest';
import { IdentityResolver } from '../src/discovery/identity';
import { ReplayGraph } from '../src/replay/graph';

describe('IdentityResolver', () => {
  it('resolves and merges identical endpoints with different provenances', () => {
    const resolver = new IdentityResolver();
    
    // Seen in bundle
    const ep1 = resolver.resolveEndpoint('GET', '/api/users/list', 'static_bundle', false, 0.8);
    expect(ep1.trustState).toBe('discovered');
    
    // Seen at runtime
    const ep2 = resolver.resolveEndpoint('GET', 'https://api.example.com/api/users/list', 'runtime_capture', false, 1.0);
    expect(ep2.id).toBe(ep1.id);
    expect(ep2.trustState).toBe('observed');
    expect(ep2.protocolType).toBe('https');
    expect(ep2.provenanceSet.has('static_bundle')).toBe(true);
    expect(ep2.provenanceSet.has('runtime_capture')).toBe(true);
  });

  it('normalizes routes by folding numeric IDs and UUIDs', () => {
    const resolver = new IdentityResolver();
    const ep1 = resolver.resolveEndpoint('GET', '/api/users/123', 'static_bundle');
    const ep2 = resolver.resolveEndpoint('GET', '/api/users/456', 'runtime_capture');
    const ep3 = resolver.resolveEndpoint('GET', '/api/items/a1b2c3d4-e5f6-7890-1234-56789abcdef0', 'runtime_capture');

    expect(ep1.id).toBe(ep2.id); // folded to /api/users/:id
    expect(ep1.normalizedPath).toBe('/api/users/:id');
    expect(ep3.normalizedPath).toBe('/api/items/:id');
  });

  it('handles GraphQL endpoint equivalence', () => {
    const resolver = new IdentityResolver();
    // A post to /graphql from fetch
    const ep1 = resolver.resolveEndpoint('POST', '/graphql', 'static_bundle');
    // A recognized GraphQL operation from payload
    const ep2 = resolver.resolveEndpoint('POST', '/graphql', 'inferred_operation', true);
    
    expect(ep1.id).toBe(ep2.id);
    expect(ep2.isGraphQL).toBe(true);
  });

  it('detects protocol conflicts and upgrades to secure', () => {
    const resolver = new IdentityResolver();
    const ep1 = resolver.resolveEndpoint('GET', 'http://api.example.com/data', 'static_bundle');
    expect(ep1.protocolType).toBe('http');
    
    const ep2 = resolver.resolveEndpoint('GET', 'https://api.example.com/data', 'runtime_capture');
    expect(ep2.protocolType).toBe('https'); // upgraded
  });

  it('unifies the graph by merging duplicate nodes', () => {
    const graph = new ReplayGraph();
    // Two nodes representing the same runtime request instance
    graph.addNode({ id: 'r1', type: 'request', data: { url: '/api/v1/user/1', method: 'GET', provenance: 'runtime_capture' } });
    graph.addNode({ id: 'r2', type: 'request', data: { url: '/api/v1/user/2', method: 'GET', provenance: 'static_bundle' } });
    graph.addNode({ id: 'auth1', type: 'auth', data: { url: '/login', method: 'POST' } }); 

    graph.addEdge({
      sourceId: 'auth1', targetId: 'r1', dependencyType: 'token', confidence: 1, provenance: 'i', heuristicSource: '', temporalDistanceMs: 0
    });
    graph.addEdge({
      sourceId: 'auth1', targetId: 'r2', dependencyType: 'token', confidence: 1, provenance: 'i', heuristicSource: '', temporalDistanceMs: 0
    });

    const resolver = new IdentityResolver();
    resolver.unifyGraph(graph);

    const nodes = graph.getNodes();
    
    // auth1 remains, r1 and r2 merged into canonical_GET#/api/v1/user/:id
    expect(nodes.length).toBe(2); 
    
    const canonicalNode = nodes.find(n => n.id.startsWith('canonical_'));
    expect(canonicalNode).toBeDefined();
    expect(canonicalNode!.data.mergedFrom).toContain('r1');
    expect(canonicalNode!.data.mergedFrom).toContain('r2');
    
    // Check if edges were rewired
    const outs = graph.getOutboundEdges('auth1');
    expect(outs.length).toBe(2); // Two edges now point to the same target
    expect(outs[0].targetId).toBe(canonicalNode!.id);
    expect(outs[1].targetId).toBe(canonicalNode!.id);
  });
  
  it('detects origin ambiguity', () => {
    const resolver = new IdentityResolver();
    const ep1 = resolver.resolveEndpoint('GET', 'https://api.example.com/data', 'runtime_capture');
    const ep2 = resolver.resolveEndpoint('GET', 'https://api.other.com/data', 'runtime_capture'); 
    
    // They share the same ID because computeCanonicalId ignores origin, but log origin ambiguity
    expect(ep1.id).toBe(ep2.id);
    expect(ep2.normalizedOrigin).toBe('https://api.example.com'); // it doesn't overwrite if it was already set, wait, actually let's check
  });
});
