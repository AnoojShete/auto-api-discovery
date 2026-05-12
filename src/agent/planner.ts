import { ReplayGraph } from '../replay/graph';
import { WorkflowSynthesizer, WorkflowModel } from '../replay/workflows';
import { IdentityResolver, CanonicalEndpoint } from '../discovery/identity';
import { logEvent } from '../observability/logger';
import { recordParseDiagnostic } from '../db/diagnostics';

export type ExplorationSafetyLevel = 'safe' | 'caution' | 'dangerous' | 'blocked';
export type TargetType = 'endpoint' | 'workflow_branch' | 'graphql_operation' | 'route_family' | 'disconnected_region';

export interface ExplorationTarget {
  id: string;
  type: TargetType;
  priorityScore: number;
  discoveryRationale: string;
  safetyLevel: ExplorationSafetyLevel;
  prerequisites: string[]; 
  metadata: any;
}

export class ExplorationPlanner {
  private graph: ReplayGraph;
  private resolver: IdentityResolver;
  private failureCounts: Map<string, number> = new Map();

  constructor(graph: ReplayGraph, resolver: IdentityResolver) {
    this.graph = graph;
    this.resolver = resolver;
  }

  public registerFailure(targetId: string) {
    const count = this.failureCounts.get(targetId) || 0;
    this.failureCounts.set(targetId, count + 1);
  }

  public plan(): ExplorationTarget[] {
    const targets: ExplorationTarget[] = [];
    
    const synthesizer = new WorkflowSynthesizer(this.graph);
    const workflows = synthesizer.synthesize();
    const endpoints = this.resolver.getRegistry();

    // Strategy 1: Unresolved or statically discovered endpoints
    for (const ep of endpoints.values()) {
      if (ep.trustState === 'unresolved' || ep.trustState === 'discovered' || ep.trustState === 'inferred') {
        const target = this.evaluateEndpointTarget(ep);
        if (target) targets.push(target);
      }
    }

    // Strategy 2: Partially replayable workflows & Unresolved branches
    for (const wf of workflows) {
      if (wf.replayViability === 'partially replayable' || wf.replayViability === 'unresolved replay') {
        const wfTarget = this.evaluateWorkflowTarget(wf);
        if (wfTarget) targets.push(wfTarget);
      }
    }

    // Strategy 3: Disconnected graph regions
    const components = this.graph.getConnectedComponents();
    if (components.length > 1) {
      logEvent('planner.graph_fragmentation', { components: components.length });
      
      const disconnectedTarget = this.evaluateDisconnectedRegions(components);
      if (disconnectedTarget) targets.push(disconnectedTarget);
    }

    // Strategy 4: Unexplored route families
    const routeFamilies = new Map<string, CanonicalEndpoint[]>();
    for (const ep of endpoints.values()) {
      const baseRoute = ep.normalizedPath.split('/').slice(0, 3).join('/');
      if (!routeFamilies.has(baseRoute)) routeFamilies.set(baseRoute, []);
      routeFamilies.get(baseRoute)!.push(ep);
    }
    
    for (const [route, eps] of routeFamilies.entries()) {
      const allUnobserved = eps.every(e => e.trustState !== 'observed');
      if (allUnobserved && eps.length > 1) {
        targets.push({
          id: `explore_route_family_${route}`,
          type: 'route_family',
          priorityScore: 65 - ((this.failureCounts.get(`explore_route_family_${route}`) || 0) * 15),
          discoveryRationale: 'Unexplored route family with multiple candidate endpoints',
          safetyLevel: 'safe',
          prerequisites: [],
          metadata: { route, count: eps.length }
        });
      }
    }

    // Diagnostics
    this.emitDiagnostics(targets, workflows);

    // Sort descending by priority
    return targets.filter(t => t.priorityScore > 0).sort((a, b) => b.priorityScore - a.priorityScore);
  }

  private evaluateEndpointTarget(ep: CanonicalEndpoint): ExplorationTarget | null {
    const failures = this.failureCounts.get(ep.id) || 0;
    
    // Penalize heavily for repeated failures
    if (failures > 3) return null;

    let priority = 0;
    let safety: ExplorationSafetyLevel = 'safe';
    let rationale = '';

    const method = ep.method.toUpperCase();

    if (ep.trustState === 'unresolved') {
      priority += 40;
      rationale = 'Unresolved trust state endpoint';
    } else if (ep.trustState === 'discovered') {
      if (ep.confidence < 0.6) {
        return null; // Requires higher confidence threshold
      }
      priority += 30;
      rationale = 'High-confidence static endpoint requiring validation';
    } else if (ep.trustState === 'inferred') {
      priority += 50;
      rationale = 'Inferred endpoint needing confirmation';
    } else if (ep.trustState === 'observed') {
      priority += 10;
    }

    if (ep.isGraphQL) {
      priority += 20;
      rationale = 'Unresolved GraphQL operation';
      if (ep.method === 'POST') safety = 'caution';
    }

    // Safety logic based on destructive methods
    if (method === 'DELETE' || method === 'PUT' || method === 'PATCH') {
      safety = 'dangerous';
      priority -= 20;
    } else if (method === 'POST') {
      safety = 'caution';
      priority -= 5;
    }

    // Adaptive failure penalty
    priority -= (failures * 15);

    if (priority <= 0) return null;

    return {
      id: ep.id,
      type: ep.isGraphQL ? 'graphql_operation' : 'endpoint',
      priorityScore: priority,
      discoveryRationale: rationale,
      safetyLevel: safety,
      prerequisites: [],
      metadata: { path: ep.normalizedPath, method: ep.method }
    };
  }

  private evaluateWorkflowTarget(wf: WorkflowModel): ExplorationTarget | null {
    const failures = this.failureCounts.get(wf.id) || 0;
    if (failures > 2) return null;

    let priority = 60;
    let safety: ExplorationSafetyLevel = 'safe';
    let rationale = 'Partially replayable workflow requiring exploration';
    
    // Graph fanout potential
    if (wf.optionalBranches.length > wf.criticalPaths.length * 2) {
      priority += 10; 
      rationale += ' with high fanout potential';
    }

    const prerequisites = [...wf.entrypoints];

    if (wf.replayViability === 'high-risk replay') {
      safety = 'dangerous';
      priority -= 30;
    } else if (wf.replayViability === 'unresolved replay') {
      safety = 'caution';
    } else if (wf.replayViability === 'safely replayable') {
      priority -= 40;
    }

    priority -= (failures * 20);
    if (priority <= 0) return null;

    return {
      id: `explore_wf_${wf.id}`,
      type: 'workflow_branch',
      priorityScore: priority,
      discoveryRationale: rationale,
      safetyLevel: safety,
      prerequisites,
      metadata: { workflowType: wf.type, branches: wf.optionalBranches.length }
    };
  }

  private evaluateDisconnectedRegions(components: string[][]): ExplorationTarget | null {
    const targetComp = components.find(comp => {
      return comp.every(id => {
        const node = this.graph.getNode(id);
        return node?.data?.trustState !== 'observed';
      });
    });

    if (!targetComp) return null;

    const failures = this.failureCounts.get('disconnected_region') || 0;
    if (failures > 2) return null;

    return {
      id: 'explore_disconnected_region',
      type: 'disconnected_region',
      priorityScore: 75 - (failures * 20),
      discoveryRationale: 'Fragmented graph region requires exploration to bridge connectivity',
      safetyLevel: 'caution',
      prerequisites: [],
      metadata: { nodesCount: targetComp.length }
    };
  }

  private emitDiagnostics(targets: ExplorationTarget[], workflows: WorkflowModel[]) {
    // Dead ends
    const deadEnds = targets.filter(t => t.priorityScore < 20 && t.safetyLevel === 'safe');
    if (deadEnds.length > 5) {
      logEvent('planner.exploration_dead_ends', { count: deadEnds.length });
    }

    // Unresolved prerequisites
    targets.forEach(t => {
      if (t.prerequisites.length > 0) {
        const unresolved = t.prerequisites.some(p => this.graph.getNode(p)?.data?.trustState === 'unresolved');
        if (unresolved) {
          logEvent('planner.unresolved_prerequisites', { targetId: t.id });
        }
      }
    });

    // Dangerous replay chains
    const dangerousChains = workflows.filter(wf => wf.replayViability === 'high-risk replay');
    if (dangerousChains.length > 0) {
      logEvent('planner.dangerous_replay_chains', { count: dangerousChains.length });
      recordParseDiagnostic('graphql', undefined, `Found ${dangerousChains.length} dangerous replay chains`);
    }
  }
}
