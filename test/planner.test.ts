import { describe, it, expect } from 'vitest';
import { ReplayGraph } from '../src/replay/graph';
import { IdentityResolver } from '../src/discovery/identity';
import { ExplorationPlanner } from '../src/agent/planner';

describe('ExplorationPlanner', () => {
  it('prioritizes unresolved trust-state endpoints', () => {
    const graph = new ReplayGraph();
    const resolver = new IdentityResolver();
    
    resolver.resolveEndpoint('GET', '/api/unresolved', 'inferred_route');
    
    const planner = new ExplorationPlanner(graph, resolver);
    const targets = planner.plan();
    
    const epTarget = targets.find(t => t.id.includes('/api/unresolved'));
    expect(epTarget).toBeDefined();
    expect(epTarget!.type).toBe('endpoint');
    expect(epTarget!.priorityScore).toBeGreaterThan(0);
    expect(epTarget!.safetyLevel).toBe('safe'); // GET is safe
  });

  it('deprioritizes static endpoints below confidence threshold', () => {
    const graph = new ReplayGraph();
    const resolver = new IdentityResolver();
    
    // Confidence 0.5 < 0.6 threshold for 'discovered' state
    resolver.resolveEndpoint('GET', '/api/static_low', 'static_bundle', false, 0.5);
    // Confidence 0.8 > 0.6 threshold
    resolver.resolveEndpoint('GET', '/api/static_high', 'static_bundle', false, 0.8);
    
    const planner = new ExplorationPlanner(graph, resolver);
    const targets = planner.plan();
    
    expect(targets.find(t => t.id.includes('/api/static_low'))).toBeUndefined();
    expect(targets.find(t => t.id.includes('/api/static_high'))).toBeDefined();
  });

  it('detects dangerous replay safety levels', () => {
    const graph = new ReplayGraph();
    const resolver = new IdentityResolver();
    
    resolver.resolveEndpoint('DELETE', '/api/users/123', 'static_bundle', false, 0.9);
    
    const planner = new ExplorationPlanner(graph, resolver);
    const targets = planner.plan();
    
    const target = targets.find(t => t.id.includes('DELETE'));
    expect(target).toBeDefined();
    expect(target!.safetyLevel).toBe('dangerous');
    expect(target!.priorityScore).toBeLessThan(50); // Deprioritized due to danger
  });

  it('lowers priority for repeated failures', () => {
    const graph = new ReplayGraph();
    const resolver = new IdentityResolver();
    
    const ep = resolver.resolveEndpoint('POST', '/api/try', 'inferred_route', false, 0.9);
    
    const planner = new ExplorationPlanner(graph, resolver);
    
    planner.registerFailure(ep.id);
    const targets1 = planner.plan();
    const score1 = targets1.find(t => t.id === ep.id)!.priorityScore;
    
    planner.registerFailure(ep.id);
    const targets2 = planner.plan();
    const score2 = targets2.find(t => t.id === ep.id)!.priorityScore;
    
    expect(score2).toBeLessThan(score1);
    
    // Fail heavily to remove target
    planner.registerFailure(ep.id);
    planner.registerFailure(ep.id);
    const targets3 = planner.plan();
    expect(targets3.find(t => t.id === ep.id)).toBeUndefined();
  });

  it('detects graph fragmentation and unexplored route families', () => {
    const graph = new ReplayGraph();
    const resolver = new IdentityResolver();
    
    // Add two static endpoints in the same route family
    resolver.resolveEndpoint('GET', '/api/family/member1', 'static_bundle', false, 0.9);
    resolver.resolveEndpoint('GET', '/api/family/member2', 'static_bundle', false, 0.9);
    
    // Add completely disconnected graph nodes
    graph.addNode({ id: 'd1', type: 'request', data: { url: '/isolated', trustState: 'discovered' } });
    graph.addNode({ id: 'd2', type: 'request', data: { url: '/isolated2', trustState: 'discovered' } });
    
    const planner = new ExplorationPlanner(graph, resolver);
    const targets = planner.plan();
    
    const routeFamilyTarget = targets.find(t => t.type === 'route_family');
    expect(routeFamilyTarget).toBeDefined();
    expect(routeFamilyTarget!.metadata.route).toBe('/api/family');
    
    const disconnectedTarget = targets.find(t => t.type === 'disconnected_region');
    expect(disconnectedTarget).toBeDefined();
  });

  it('prioritizes GraphQL operations safely', () => {
    const graph = new ReplayGraph();
    const resolver = new IdentityResolver();
    
    resolver.resolveEndpoint('POST', '/graphql', 'static_bundle', true, 0.8);
    
    const planner = new ExplorationPlanner(graph, resolver);
    const targets = planner.plan();
    
    const gqlTarget = targets.find(t => t.type === 'graphql_operation');
    expect(gqlTarget).toBeDefined();
    expect(gqlTarget!.safetyLevel).toBe('caution'); // POST GraphQL is caution, not strictly dangerous unless mutating explicitly (which is hard to know without AST)
  });
});
