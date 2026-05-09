import { ReplayDependencyRecord } from './models';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface ReplayGroup {
  id: string;
  name: string;
  requests: string[]; // List of request IDs in this group
}

export interface AuthPropagationPlan {
  sourceRequestId: string;
  targetRequestIds: string[];
  extractionRule: {
    sourceField: string; // e.g., 'response.body.token'
    targetHeader?: string; // e.g., 'Authorization'
    targetCookie?: string;
  };
}

export interface ReplayPlan {
  jobId: string;
  groups: ReplayGroup[];
  executionOrder: string[]; // Ordered list of request IDs to execute
  authPropagation: AuthPropagationPlan[];
}

// ────────────────────────────────────────────────────────────────
// Planner Abstractions
// ────────────────────────────────────────────────────────────────

/**
 * Replay Planner Abstraction (Phase 3 Foundation)
 * 
 * Responsible for determining the correct execution order of requests
 * based on inferred dependencies, and planning authentication state propagation.
 * Execution is intentionally omitted here.
 */
export class ReplayPlanner {
  private dependencies: ReplayDependencyRecord[] = [];

  constructor(dependencies: ReplayDependencyRecord[] = []) {
    this.dependencies = dependencies;
  }

  /**
   * Performs topological sort to determine correct execution order
   * based on dependencies.
   */
  public determineExecutionOrder(requestIds: string[]): string[] {
    const graph = new Map<string, string[]>();
    const inDegree = new Map<string, number>();

    // Initialize graph
    for (const reqId of requestIds) {
      graph.set(reqId, []);
      inDegree.set(reqId, 0);
    }

    // Build edges from dependencies
    for (const dep of this.dependencies) {
      if (graph.has(dep.source_request_id) && graph.has(dep.target_request_id)) {
        graph.get(dep.source_request_id)!.push(dep.target_request_id);
        inDegree.set(dep.target_request_id, inDegree.get(dep.target_request_id)! + 1);
      }
    }

    // Topological Sort (Kahn's Algorithm)
    const queue: string[] = [];
    for (const [reqId, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(reqId);
    }

    const order: string[] = [];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      order.push(curr);

      for (const neighbor of graph.get(curr)!) {
        inDegree.set(neighbor, inDegree.get(neighbor)! - 1);
        if (inDegree.get(neighbor) === 0) {
          queue.push(neighbor);
        }
      }
    }

    // If order length != requestIds length, there's a cycle, but we return what we can for now.
    // Unconnected or cyclic nodes are handled gracefully by returning partial/best-effort ordering.
    const missing = requestIds.filter(id => !order.includes(id));
    return [...order, ...missing];
  }

  /**
   * Plans how authentication tokens/cookies move between requests.
   */
  public planAuthPropagation(requestIds: string[]): AuthPropagationPlan[] {
    const plans: AuthPropagationPlan[] = [];
    
    // Group auth dependencies by source request
    const authDeps = this.dependencies.filter(d => d.dependency_type === 'token' || d.dependency_type === 'cookie');
    
    const sourceMap = new Map<string, string[]>();
    for (const dep of authDeps) {
      if (requestIds.includes(dep.source_request_id) && requestIds.includes(dep.target_request_id)) {
        if (!sourceMap.has(dep.source_request_id)) sourceMap.set(dep.source_request_id, []);
        sourceMap.get(dep.source_request_id)!.push(dep.target_request_id);
      }
    }

    for (const [sourceId, targets] of sourceMap.entries()) {
      plans.push({
        sourceRequestId: sourceId,
        targetRequestIds: targets,
        extractionRule: {
          sourceField: 'response.body.token', // Stubbed for foundational structure
          targetHeader: 'Authorization'
        }
      });
    }

    return plans;
  }

  /**
   * Groups related requests together (e.g. all requests belonging to a specific user flow).
   */
  public groupRequests(requestIds: string[]): ReplayGroup[] {
    // Stub grouping for foundational structure
    return [
      {
        id: 'group_default',
        name: 'Default Execution Group',
        requests: requestIds
      }
    ];
  }

  /**
   * Generates a complete replay plan.
   */
  public generatePlan(jobId: string, requestIds: string[]): ReplayPlan {
    const order = this.determineExecutionOrder(requestIds);
    const auth = this.planAuthPropagation(requestIds);
    const groups = this.groupRequests(requestIds);

    return {
      jobId,
      executionOrder: order,
      authPropagation: auth,
      groups
    };
  }
}
