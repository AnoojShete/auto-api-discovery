import { ReplayGraph, GraphNode } from './graph';
import { logEvent } from '../observability/logger';
import { recordParseDiagnostic } from '../db/diagnostics';

export type WorkflowType = 'authentication' | 'CRUD' | 'pagination' | 'realtime' | 'upload' | 'admin' | 'unknown';
export type ReplayViability = 'safely replayable' | 'partially replayable' | 'high-risk replay' | 'unresolved replay';

export interface WorkflowModel {
  id: string;
  type: WorkflowType;
  entrypoints: string[];
  authBoundaries: string[];
  criticalPaths: string[];
  optionalBranches: string[];
  cycleParticipation: boolean;
  confidence: number;
  replayViability: ReplayViability;
}

export class WorkflowSynthesizer {
  private graph: ReplayGraph;

  constructor(graph: ReplayGraph) {
    this.graph = graph;
  }

  public synthesize(): WorkflowModel[] {
    const workflows: WorkflowModel[] = [];
    const components = this.graph.getConnectedComponents();

    components.forEach((comp, idx) => {
      const workflow = this.synthesizeComponent(comp, `wf_${idx + 1}`);
      if (workflow) {
        workflows.push(workflow);
      }
    });

    this.emitDiagnostics(workflows);

    return workflows;
  }

  private synthesizeComponent(nodeIds: string[], wfId: string): WorkflowModel | null {
    if (nodeIds.length === 0) return null;

    // Entrypoints: nodes with no incoming edges within the component
    const entrypoints = nodeIds.filter(id => {
      const ins = this.graph.getInboundEdges(id);
      return ins.every(e => !nodeIds.includes(e.sourceId));
    });

    if (entrypoints.length === 0) {
      entrypoints.push(nodeIds[0]); // fallback for cycles
    }

    // Auth boundaries
    const authBoundaries = nodeIds.filter(id => {
      const node = this.graph.getNode(id);
      const url = (node?.data?.url || '').toLowerCase();
      return node?.type === 'auth' || url.includes('login') || url.includes('auth') || url.includes('token');
    });

    // Cycle participation
    const cycles = this.graph.classifyCycles();
    const cycleParticipation = cycles.some(c => c.path.some(id => nodeIds.includes(id)));

    // Critical Path: Longest downstream path from entrypoints
    let criticalPaths: string[] = [];
    
    const getLongestPath = (nodeId: string, visited: Set<string>): string[] => {
      if (visited.has(nodeId)) return [];
      visited.add(nodeId);
      
      const outs = this.graph.getOutboundEdges(nodeId);
      let maxSubPath: string[] = [];
      
      for (const e of outs) {
        const subPath = getLongestPath(e.targetId, new Set(visited));
        if (subPath.length > maxSubPath.length) {
          maxSubPath = subPath;
        }
      }
      
      return [nodeId, ...maxSubPath];
    };

    let maxDepth = 0;
    entrypoints.forEach(ep => {
      const path = getLongestPath(ep, new Set());
      if (path.length > maxDepth) {
        maxDepth = path.length;
        criticalPaths = path;
      }
    });

    // Deduplicate critical paths to be safe
    criticalPaths = Array.from(new Set(criticalPaths));

    // Optional branches: nodes in component not in critical path
    const optionalBranches = nodeIds.filter(id => !criticalPaths.includes(id));

    // Type inference
    const type = this.inferWorkflowType(nodeIds);

    // Confidence scoring
    let confidence = 0.5;
    if (entrypoints.length === 1 && criticalPaths.length > 1) confidence += 0.2;
    if (authBoundaries.length > 0) confidence += 0.1;
    if (type !== 'unknown') confidence += 0.1;
    if (cycleParticipation) confidence += 0.05;

    confidence = Math.min(1.0, confidence);

    // Replay viability scoring
    let replayViability: ReplayViability = 'unresolved replay';
    const isHighRisk = nodeIds.some(id => {
      const n = this.graph.getNode(id);
      const m = (n?.data?.method || '').toUpperCase();
      return m === 'DELETE' || m === 'PUT' || m === 'PATCH';
    });

    const hasUnresolved = nodeIds.some(id => this.graph.getNode(id)?.data?.trustState === 'unresolved');

    if (hasUnresolved) {
      replayViability = 'unresolved replay';
    } else if (isHighRisk) {
      replayViability = 'high-risk replay';
    } else if (confidence >= 0.8 && entrypoints.length <= 2 && criticalPaths.length > 1) {
      replayViability = 'safely replayable';
    } else if (confidence >= 0.6) {
      replayViability = 'partially replayable';
    }

    return {
      id: wfId,
      type,
      entrypoints,
      authBoundaries,
      criticalPaths,
      optionalBranches,
      cycleParticipation,
      confidence,
      replayViability
    };
  }

  private inferWorkflowType(nodeIds: string[]): WorkflowType {
    let hasGet = false;
    let hasPost = false;
    let hasDelete = false;

    for (const id of nodeIds) {
      const node = this.graph.getNode(id);
      if (!node) continue;
      
      const url = (node.data?.url || '').toLowerCase();
      const method = (node.data?.method || '').toUpperCase();

      if (url.includes('login') || url.includes('auth') || url.includes('token') || node.type === 'auth') {
        return 'authentication';
      }
      if (url.includes('upload') || url.includes('file')) {
        return 'upload';
      }
      if (url.includes('admin')) {
        return 'admin';
      }
      if (url.includes('limit=') || url.includes('offset=') || url.includes('page=')) {
        return 'pagination';
      }
      if (node.type === 'websocket' || url.startsWith('ws') || url.includes('stream')) {
        return 'realtime';
      }
      
      if (method === 'GET') hasGet = true;
      if (method === 'POST') hasPost = true;
      if (method === 'DELETE' || method === 'PUT') hasDelete = true;
    }

    if ((hasGet && hasPost) || hasDelete) {
      return 'CRUD';
    }

    return 'unknown';
  }

  private emitDiagnostics(workflows: WorkflowModel[]) {
    workflows.forEach(wf => {
      // Ambiguous entrypoints
      if (wf.entrypoints.length > 3) {
        logEvent('workflow.ambiguous_entrypoints', { wfId: wf.id, count: wf.entrypoints.length });
        recordParseDiagnostic('graphql', undefined, `Workflow ${wf.id} has ambiguous entrypoints (${wf.entrypoints.length})`);
      }
      // Excessive graph fanout
      if (wf.criticalPaths.length > 0 && wf.optionalBranches.length > wf.criticalPaths.length * 3) {
        logEvent('workflow.excessive_fanout', { wfId: wf.id });
        recordParseDiagnostic('graphql', undefined, `Workflow ${wf.id} has excessive graph fanout`);
      }
      // Fragmented workflows
      if (wf.entrypoints.length === 0 || (wf.criticalPaths.length <= 1 && wf.optionalBranches.length === 0)) {
        logEvent('workflow.fragmented', { wfId: wf.id });
      }
      // Unresolved branches
      const hasUnresolved = wf.optionalBranches.some(id => this.graph.getNode(id)?.data?.trustState === 'unresolved');
      if (hasUnresolved) {
        logEvent('workflow.unresolved_branches', { wfId: wf.id });
      }
    });
  }
}
