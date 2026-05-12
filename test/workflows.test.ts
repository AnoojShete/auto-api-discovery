import { describe, it, expect } from 'vitest';
import { ReplayGraph } from '../src/replay/graph';
import { WorkflowSynthesizer } from '../src/replay/workflows';

describe('WorkflowSynthesizer', () => {
  it('synthesizes an authentication workflow safely replayable', () => {
    const graph = new ReplayGraph();
    graph.addNode({ id: 'login', type: 'request', data: { url: '/api/auth/login', method: 'POST', trustState: 'observed' } });
    graph.addNode({ id: 'getProfile', type: 'request', data: { url: '/api/user/profile', method: 'GET', trustState: 'observed' } });
    
    graph.addEdge({
      sourceId: 'login', targetId: 'getProfile',
      dependencyType: 'token', confidence: 0.9, provenance: 'runtime', heuristicSource: '', temporalDistanceMs: 100
    });

    const synthesizer = new WorkflowSynthesizer(graph);
    const workflows = synthesizer.synthesize();
    
    expect(workflows.length).toBe(1);
    expect(workflows[0].type).toBe('authentication');
    expect(workflows[0].entrypoints).toEqual(['login']);
    expect(workflows[0].criticalPaths).toEqual(['login', 'getProfile']);
    expect(workflows[0].replayViability).toBe('safely replayable');
  });

  it('detects high-risk replay CRUD workflows', () => {
    const graph = new ReplayGraph();
    graph.addNode({ id: 'listItems', type: 'request', data: { url: '/api/items', method: 'GET', trustState: 'observed' } });
    graph.addNode({ id: 'deleteItem', type: 'request', data: { url: '/api/items/123', method: 'DELETE', trustState: 'observed' } });
    
    graph.addEdge({
      sourceId: 'listItems', targetId: 'deleteItem',
      dependencyType: 'path_param', confidence: 0.9, provenance: 'runtime', heuristicSource: '', temporalDistanceMs: 500
    });

    const synthesizer = new WorkflowSynthesizer(graph);
    const workflows = synthesizer.synthesize();
    
    expect(workflows.length).toBe(1);
    expect(workflows[0].type).toBe('CRUD');
    expect(workflows[0].replayViability).toBe('high-risk replay');
  });

  it('synthesizes pagination workflows and optional branching', () => {
    const graph = new ReplayGraph();
    graph.addNode({ id: 'p1', type: 'request', data: { url: '/api/feed?page=1', method: 'GET', trustState: 'observed' } });
    graph.addNode({ id: 'p2', type: 'request', data: { url: '/api/feed?page=2', method: 'GET', trustState: 'observed' } });
    graph.addNode({ id: 'fetchImage', type: 'request', data: { url: '/img/1.png', method: 'GET', trustState: 'observed' } });

    // Critical path is p1 -> p2
    graph.addEdge({ sourceId: 'p1', targetId: 'p2', dependencyType: 'query_param', confidence: 0.8, provenance: 'r', heuristicSource: '', temporalDistanceMs: 1000 });
    // Branching from p1
    graph.addEdge({ sourceId: 'p1', targetId: 'fetchImage', dependencyType: 'response_body', confidence: 0.5, provenance: 'r', heuristicSource: '', temporalDistanceMs: 50 });

    const synthesizer = new WorkflowSynthesizer(graph);
    const workflows = synthesizer.synthesize();
    
    expect(workflows.length).toBe(1);
    expect(workflows[0].type).toBe('pagination');
    // critical path could be [p1, p2] or [p1, fetchImage]
    expect(workflows[0].criticalPaths).toContain('p1');
    expect(workflows[0].optionalBranches.length).toBe(1);
    expect(workflows[0].optionalBranches).toContain(workflows[0].criticalPaths.includes('p2') ? 'fetchImage' : 'p2');
  });

  it('classifies cycle participation', () => {
    const graph = new ReplayGraph();
    graph.addNode({ id: 'poll1', type: 'request', data: { url: '/api/status', method: 'GET', trustState: 'observed' } });
    graph.addNode({ id: 'poll2', type: 'request', data: { url: '/api/status', method: 'GET', trustState: 'observed' } });
    
    graph.addEdge({ sourceId: 'poll1', targetId: 'poll2', dependencyType: 'none', confidence: 0.9, provenance: 'r', heuristicSource: '', temporalDistanceMs: 100 });
    graph.addEdge({ sourceId: 'poll2', targetId: 'poll1', dependencyType: 'none', confidence: 0.9, provenance: 'r', heuristicSource: '', temporalDistanceMs: 100 });

    const synthesizer = new WorkflowSynthesizer(graph);
    const workflows = synthesizer.synthesize();
    
    expect(workflows[0].cycleParticipation).toBe(true);
  });
});
