import { ReplayProvenance } from './models';

export type GraphNodeType = 'request' | 'auth' | 'workflow' | 'graphql_operation' | 'websocket';

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  data?: any; // For storing url, path, captured_at, etc.
}

export interface GraphEdge {
  sourceId: string;
  targetId: string;
  dependencyType: string;
  confidence: number;
  provenance: ReplayProvenance | string;
  heuristicSource: string;
  temporalDistanceMs: number;
}

export interface CycleInfo {
  path: string[];
  type: 'auth_refresh' | 'polling' | 'websocket_stream' | 'unknown';
}

export interface GraphMetrics {
  nodeCount: number;
  edgeCount: number;
  graphDensity: number;
  averageChainDepth: number;
  authChainCount: number;
  cycleCount: number;
  connectedComponents: number;
}

export class ReplayGraph {
  private nodes: Map<string, GraphNode> = new Map();
  private edges: Map<string, GraphEdge[]> = new Map();
  private reverseEdges: Map<string, GraphEdge[]> = new Map();

  constructor() {}

  public addNode(node: GraphNode) {
    if (!this.nodes.has(node.id)) {
      this.nodes.set(node.id, node);
    }
  }

  public getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  public getNodes(): GraphNode[] {
    return Array.from(this.nodes.values());
  }

  public getOutboundEdges(nodeId: string): GraphEdge[] {
    return this.edges.get(nodeId) || [];
  }

  public getInboundEdges(nodeId: string): GraphEdge[] {
    return this.reverseEdges.get(nodeId) || [];
  }

  public removeNode(nodeId: string) {
    this.nodes.delete(nodeId);
    this.edges.delete(nodeId);
    this.reverseEdges.delete(nodeId);
    
    // Also remove any edge referencing this node
    for (const [src, outs] of this.edges.entries()) {
      this.edges.set(src, outs.filter(e => e.targetId !== nodeId));
    }
    for (const [tgt, ins] of this.reverseEdges.entries()) {
      this.reverseEdges.set(tgt, ins.filter(e => e.sourceId !== nodeId));
    }
  }

  public addEdge(edge: GraphEdge) {
    if (!this.nodes.has(edge.sourceId)) this.addNode({ id: edge.sourceId, type: 'request' });
    if (!this.nodes.has(edge.targetId)) this.addNode({ id: edge.targetId, type: 'request' });

    const outs = this.edges.get(edge.sourceId) || [];
    outs.push(edge);
    this.edges.set(edge.sourceId, outs);

    const ins = this.reverseEdges.get(edge.targetId) || [];
    ins.push(edge);
    this.reverseEdges.set(edge.targetId, ins);
  }

  public bfs(startNodeId: string, direction: 'upstream' | 'downstream' = 'downstream'): string[] {
    const visited = new Set<string>();
    const queue: string[] = [startNodeId];
    const result: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      result.push(current);

      const adjacentEdges = direction === 'downstream' ? this.edges.get(current) || [] : this.reverseEdges.get(current) || [];
      for (const edge of adjacentEdges) {
        const nextId = direction === 'downstream' ? edge.targetId : edge.sourceId;
        if (!visited.has(nextId)) {
          queue.push(nextId);
        }
      }
    }
    return result;
  }

  public dfs(startNodeId: string, direction: 'upstream' | 'downstream' = 'downstream'): string[] {
    const visited = new Set<string>();
    const result: string[] = [];

    const traverse = (nodeId: string) => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      result.push(nodeId);

      const adjacentEdges = direction === 'downstream' ? this.edges.get(nodeId) || [] : this.reverseEdges.get(nodeId) || [];
      for (const edge of adjacentEdges) {
        const nextId = direction === 'downstream' ? edge.targetId : edge.sourceId;
        traverse(nextId);
      }
    };

    traverse(startNodeId);
    return result;
  }

  public getShortestPath(sourceId: string, targetId: string): string[] | null {
    if (sourceId === targetId) return [sourceId];
    const visited = new Set<string>();
    const queue: { id: string; path: string[] }[] = [{ id: sourceId, path: [sourceId] }];

    while (queue.length > 0) {
      const { id, path } = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);

      const outs = this.edges.get(id) || [];
      for (const edge of outs) {
        if (edge.targetId === targetId) {
          return [...path, targetId];
        }
        if (!visited.has(edge.targetId)) {
          queue.push({ id: edge.targetId, path: [...path, edge.targetId] });
        }
      }
    }
    return null;
  }

  public traceUpstream(nodeId: string): string[] {
    return this.bfs(nodeId, 'upstream');
  }

  public traceDownstream(nodeId: string): string[] {
    return this.bfs(nodeId, 'downstream');
  }

  public getConnectedComponents(): string[][] {
    const visited = new Set<string>();
    const components: string[][] = [];

    for (const nodeId of this.nodes.keys()) {
      if (!visited.has(nodeId)) {
        const comp = this.undirectedBfs(nodeId);
        components.push(comp);
        for (const id of comp) visited.add(id);
      }
    }
    return components;
  }

  private undirectedBfs(startNodeId: string): string[] {
    const visited = new Set<string>();
    const queue: string[] = [startNodeId];
    const result: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      result.push(current);

      const outs = this.edges.get(current) || [];
      for (const e of outs) {
        if (!visited.has(e.targetId)) queue.push(e.targetId);
      }
      const ins = this.reverseEdges.get(current) || [];
      for (const e of ins) {
        if (!visited.has(e.sourceId)) queue.push(e.sourceId);
      }
    }
    return result;
  }

  public extractAuthChains(): string[][] {
    const chains: string[][] = [];
    const visited = new Set<string>();

    for (const node of this.nodes.values()) {
      if (visited.has(node.id)) continue;
      const outs = this.edges.get(node.id) || [];
      const isAuthEdge = (e: GraphEdge) => ['token', 'cookie', 'session', 'authorization'].includes(e.dependencyType);
      
      if (outs.some(isAuthEdge) || node.type === 'auth') {
        const chain: string[] = [];
        let current: string | undefined = node.id;
        while (current) {
          if (visited.has(current)) break;
          visited.add(current);
          chain.push(current);
          const nextEdges: GraphEdge[] = (this.edges.get(current) || []).filter(isAuthEdge);
          if (nextEdges.length > 0) {
             current = nextEdges[0].targetId;
          } else {
             break;
          }
        }
        if (chain.length > 1 || node.type === 'auth') {
          chains.push(chain);
        }
      }
    }
    return chains;
  }

  public classifyCycles(): CycleInfo[] {
    const cycles: CycleInfo[] = [];
    const visited = new Set<string>();
    const recStack = new Set<string>();
    const path: string[] = [];

    const dfsCycle = (nodeId: string) => {
      visited.add(nodeId);
      recStack.add(nodeId);
      path.push(nodeId);

      const outs = this.edges.get(nodeId) || [];
      for (const edge of outs) {
        if (!visited.has(edge.targetId)) {
          dfsCycle(edge.targetId);
        } else if (recStack.has(edge.targetId)) {
          const cycleStartIdx = path.indexOf(edge.targetId);
          const cyclePath = path.slice(cycleStartIdx);
          
          let cycleType: CycleInfo['type'] = 'unknown';
          
          const targetNode = this.nodes.get(edge.targetId);
          const isWebSocket = targetNode?.data?.isWebSocket === true;
          
          if (targetNode?.type === 'auth' || edge.dependencyType === 'token') {
            cycleType = 'auth_refresh';
          } else if (isWebSocket) {
            cycleType = 'websocket_stream';
          } else if (edge.temporalDistanceMs >= 0 && edge.temporalDistanceMs < 15000 && cyclePath.length <= 3) {
            cycleType = 'polling';
          }
          
          cycles.push({ path: cyclePath, type: cycleType });
        }
      }

      recStack.delete(nodeId);
      path.pop();
    };

    for (const nodeId of this.nodes.keys()) {
      if (!visited.has(nodeId)) dfsCycle(nodeId);
    }
    return cycles;
  }

  public clusterWorkflows(): { [clusterId: string]: string[] } {
    const clusters: { [clusterId: string]: string[] } = {};
    const components = this.getConnectedComponents();
    
    let counter = 1;
    components.forEach((comp) => {
      const graphqlNodes = comp.filter(id => this.nodes.get(id)?.type === 'graphql_operation');
      if (graphqlNodes.length > 0) {
        clusters[`graphql_cluster_${counter++}`] = graphqlNodes;
        comp = comp.filter(id => !graphqlNodes.includes(id));
      }
      
      const authNodes = comp.filter(id => this.nodes.get(id)?.type === 'auth');
      if (authNodes.length > 0) {
        const authBoundaryGroup = [...authNodes];
        const added = new Set(authNodes);
        for (const aId of authNodes) {
          const downstream = this.traceDownstream(aId);
          for (const d of downstream) {
            if (!added.has(d) && comp.includes(d)) {
              authBoundaryGroup.push(d);
              added.add(d);
            }
          }
        }
        clusters[`auth_boundary_cluster_${counter++}`] = authBoundaryGroup;
        comp = comp.filter(id => !added.has(id));
      }
      
      // Group by route-family if nodes have data.path
      const routeFamilies: { [route: string]: string[] } = {};
      const remaining: string[] = [];
      
      for (const id of comp) {
        const node = this.nodes.get(id);
        if (node?.data?.path) {
          const baseRoute = node.data.path.split('/').slice(0, 3).join('/');
          if (!routeFamilies[baseRoute]) routeFamilies[baseRoute] = [];
          routeFamilies[baseRoute].push(id);
        } else {
          remaining.push(id);
        }
      }
      
      for (const [route, nodes] of Object.entries(routeFamilies)) {
        if (nodes.length > 1) {
          clusters[`route_family_cluster_${counter++}`] = nodes;
        } else {
          remaining.push(nodes[0]);
        }
      }
      
      if (remaining.length > 0) {
        clusters[`temporal_cluster_${counter++}`] = remaining;
      }
    });

    return clusters;
  }

  public getMetrics(): GraphMetrics {
    const nodeCount = this.nodes.size;
    let edgeCount = 0;
    this.edges.forEach(outs => edgeCount += outs.length);

    const graphDensity = nodeCount > 1 ? edgeCount / (nodeCount * (nodeCount - 1)) : 0;
    
    let totalDepth = 0;
    let rootNodes = 0;
    for (const nodeId of this.nodes.keys()) {
      if ((this.reverseEdges.get(nodeId) || []).length === 0) {
        rootNodes++;
        totalDepth += this.dfs(nodeId, 'downstream').length;
      }
    }
    const averageChainDepth = rootNodes > 0 ? totalDepth / rootNodes : 0;

    const authChains = this.extractAuthChains();
    const cycles = this.classifyCycles();
    const components = this.getConnectedComponents();

    return {
      nodeCount,
      edgeCount,
      graphDensity,
      averageChainDepth,
      authChainCount: authChains.length,
      cycleCount: cycles.length,
      connectedComponents: components.length
    };
  }
}
