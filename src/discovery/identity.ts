import { ReplayGraph, GraphNode, GraphEdge } from '../replay/graph';
import { logEvent } from '../observability/logger';
import { recordParseDiagnostic } from '../db/diagnostics';

export type TrustState = 'observed' | 'discovered' | 'inferred' | 'unresolved';
export type ProtocolType = 'http' | 'https' | 'ws' | 'wss' | 'unknown';

export interface CanonicalEndpoint {
  id: string; // Deterministic canonical ID
  normalizedOrigin: string;
  normalizedPath: string;
  method: string;
  protocolType: ProtocolType;
  trustState: TrustState;
  provenanceSet: Set<string>;
  isGraphQL: boolean;
  metadata: any;
  confidence: number;
}

export class IdentityResolver {
  private canonicalRegistry: Map<string, CanonicalEndpoint> = new Map();

  constructor() {}

  public getRegistry(): Map<string, CanonicalEndpoint> {
    return this.canonicalRegistry;
  }

  private computeTrustState(provenances: Set<string>): TrustState {
    if (provenances.has('runtime_capture') || provenances.has('runtime_confirmed') || provenances.has('network')) return 'observed';
    if (provenances.has('static_bundle') || provenances.has('source_map') || provenances.has('persisted_query')) return 'discovered';
    if (provenances.has('inferred_route') || provenances.has('inferred_operation')) return 'inferred';
    return 'unresolved';
  }

  public normalizeOrigin(urlOrOrigin: string): { origin: string; protocol: ProtocolType } {
    let origin = urlOrOrigin.trim();
    let protocol: ProtocolType = 'unknown';

    try {
      if (origin.startsWith('http') || origin.startsWith('ws')) {
        const url = new URL(origin);
        protocol = (url.protocol.replace(':', '') as ProtocolType);
        origin = url.origin;
      } else {
        origin = '';
      }
    } catch {
      origin = '';
    }

    return { origin, protocol };
  }

  public normalizePath(path: string): string {
    let folded = path.split('?')[0]; 
    if (folded.endsWith('/')) folded = folded.slice(0, -1);
    if (!folded.startsWith('/')) folded = '/' + folded;

    // Route folding heuristics: Replace UUIDs and numeric IDs
    folded = folded.replace(/\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '/:id');
    folded = folded.replace(/\/\d+$/g, '/:id');
    folded = folded.replace(/\/\d+\//g, '/:id/');
    
    return folded;
  }

  public computeCanonicalId(method: string, normalizedPath: string): string {
    return `${method.toUpperCase()}#${normalizedPath}`;
  }

  public resolveEndpoint(
    method: string,
    urlOrPath: string,
    provenance: string,
    isGraphQL: boolean = false,
    confidence: number = 0.5,
    metadata: any = {}
  ): CanonicalEndpoint {
    const { origin, protocol } = this.normalizeOrigin(urlOrPath);
    
    let path = urlOrPath;
    try {
      if (urlOrPath.startsWith('http') || urlOrPath.startsWith('ws')) {
         path = new URL(urlOrPath).pathname;
      }
    } catch {}

    const normalizedPath = this.normalizePath(path);
    
    // GraphQL Equivalence
    const finalPath = (isGraphQL || normalizedPath.endsWith('/graphql')) ? '/graphql' : normalizedPath;
    const finalMethod = isGraphQL ? 'POST' : method.toUpperCase();
    
    // WebSocket Equivalence
    if (protocol === 'ws' || protocol === 'wss') {
       isGraphQL = false;
    }

    // Canonical ID structurally unifies nodes (e.g. static relative paths with runtime absolute paths)
    const id = this.computeCanonicalId(finalMethod, finalPath);

    if (this.canonicalRegistry.has(id)) {
      const existing = this.canonicalRegistry.get(id)!;
      existing.provenanceSet.add(provenance);
      existing.trustState = this.computeTrustState(existing.provenanceSet);
      existing.confidence = Math.max(existing.confidence, confidence);
      existing.isGraphQL = existing.isGraphQL || isGraphQL;
      
      // Protocol conflicts
      if (existing.protocolType === 'unknown' && protocol !== 'unknown') {
        existing.protocolType = protocol;
      } else if (existing.protocolType !== 'unknown' && protocol !== 'unknown' && existing.protocolType !== protocol) {
        logEvent('identity.protocol_conflict', { id, p1: existing.protocolType, p2: protocol });
        if (protocol === 'https' || protocol === 'wss') {
           existing.protocolType = protocol; // Upgrade to secure protocol
        }
      }

      // Origin ambiguity
      if (existing.normalizedOrigin !== origin && existing.normalizedOrigin !== '' && origin !== '') {
        logEvent('identity.origin_ambiguity', { id, origin1: existing.normalizedOrigin, origin2: origin });
        recordParseDiagnostic('graphql', undefined, `Origin ambiguity for endpoint ${finalPath}: ${existing.normalizedOrigin} vs ${origin}`);
      }
      
      // If the existing origin was empty, update it with the new discovered origin
      if (existing.normalizedOrigin === '' && origin !== '') {
         existing.normalizedOrigin = origin;
      }

      existing.metadata = { ...existing.metadata, ...metadata };
      return existing;
    } else {
      const ep: CanonicalEndpoint = {
        id,
        normalizedOrigin: origin,
        normalizedPath: finalPath,
        method: finalMethod,
        protocolType: protocol,
        trustState: this.computeTrustState(new Set([provenance])),
        provenanceSet: new Set([provenance]),
        isGraphQL,
        metadata,
        confidence
      };
      this.canonicalRegistry.set(id, ep);
      return ep;
    }
  }

  /**
   * Graph unification: merge duplicate nodes based on identity resolution.
   */
  public unifyGraph(graph: ReplayGraph): void {
    const nodes = graph.getNodes();
    // node ID -> canonical node ID mapping
    const mergeMap: Map<string, string> = new Map();

    for (const node of nodes) {
      if (node.type === 'request' || node.type === 'graphql_operation' || node.type === 'websocket') {
        const url = node.data?.url || node.data?.path || '';
        const method = node.data?.method || 'GET';
        const provenance = node.data?.provenance || 'runtime_capture';
        const isGraphQL = node.type === 'graphql_operation';

        if (url) {
          const canonical = this.resolveEndpoint(method, url, provenance, isGraphQL, 1.0, node.data);
          mergeMap.set(node.id, `canonical_${canonical.id}`);
        }
      }
    }

    // Perform actual graph merge
    const handledCanonicalNodes = new Set<string>();

    for (const [oldId, canonicalId] of mergeMap.entries()) {
      const oldNode = graph.getNode(oldId)!;
      
      if (!handledCanonicalNodes.has(canonicalId)) {
        // Create canonical node
        const canonicalEp = this.canonicalRegistry.get(canonicalId.replace('canonical_', ''))!;
        graph.addNode({
          id: canonicalId,
          type: canonicalEp.isGraphQL ? 'graphql_operation' : 'request',
          data: {
            url: canonicalEp.normalizedPath,
            method: canonicalEp.method,
            trustState: canonicalEp.trustState,
            provenanceSet: Array.from(canonicalEp.provenanceSet),
            mergedFrom: [oldId],
            metadata: canonicalEp.metadata
          }
        });
        handledCanonicalNodes.add(canonicalId);
      } else {
        // Append to existing
        const cNode = graph.getNode(canonicalId)!;
        if (!cNode.data.mergedFrom) cNode.data.mergedFrom = [];
        cNode.data.mergedFrom.push(oldId);
      }

      // Re-wire edges
      const outs = graph.getOutboundEdges(oldId);
      for (const e of outs) {
        graph.addEdge({
          ...e,
          sourceId: canonicalId,
          targetId: mergeMap.get(e.targetId) || e.targetId
        });
      }

      const ins = graph.getInboundEdges(oldId);
      for (const e of ins) {
        graph.addEdge({
          ...e,
          sourceId: mergeMap.get(e.sourceId) || e.sourceId,
          targetId: canonicalId
        });
      }

      // Remove the old node now that its edges are re-wired to canonical node
      graph.removeNode(oldId);
    }
  }
}
