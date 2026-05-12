import { upsertEndpoint } from '../db/endpoints';
import { recordParseDiagnostic } from '../db/diagnostics';
import { logEvent } from '../observability/logger';
import { ReplayGraph } from '../replay/graph';

export type BundleProvenance = 'static_bundle' | 'source_map' | 'inferred_route' | 'runtime_confirmed';
export type ExtractionMethod = 'ast' | 'regex' | 'string_analysis' | 'source_map';

export interface ExtractedEndpoint {
  method: string;
  url: string; 
  sourceFile: string;
  byteOffset: number;
  extractionMethod: ExtractionMethod;
  confidence: number;
  isMinified: boolean;
  provenance: BundleProvenance;
  type: 'rest' | 'graphql' | 'websocket' | 'route';
}

export class BundleExtractor {
  private graph: ReplayGraph | null = null;

  constructor(graph?: ReplayGraph) {
    this.graph = graph || null;
  }

  public attachGraph(graph: ReplayGraph) {
    this.graph = graph;
  }

  public extractFromSource(sourceCode: string, fileName: string, isSourceMap: boolean = false): ExtractedEndpoint[] {
    const endpoints: ExtractedEndpoint[] = [];
    const isMinified = !isSourceMap && this.detectMinification(sourceCode);

    try {
      // 1. Regex fallback / String analysis (simulating AST when full parse isn't feasible)
      const regexResults = this.extractViaRegex(sourceCode, fileName, isMinified, isSourceMap);
      endpoints.push(...regexResults);

      // 2. We could do AST parsing here if an AST library was present.
      // For now, regex provides our string_analysis and regex fallback extraction methods.
      
    } catch (e: any) {
      recordParseDiagnostic('graphql', fileName, `Bundle parse failure: ${e.message}`);
      logEvent('bundle.parse_failure', { file: fileName, error: e.message });
    }

    const deduplicated = this.deduplicateAndResolveConflicts(endpoints, fileName);

    // Integrate into endpoints registry and graph (without tightly coupling to capture)
    for (const ep of deduplicated) {
      if (ep.type === 'rest' || ep.type === 'graphql') {
        const id = upsertEndpoint(ep.method, ep.url, '', ep.provenance);
        
        if (this.graph) {
          this.graph.addNode({
            id: `static_${id}`,
            type: ep.type === 'graphql' ? 'graphql_operation' : 'request',
            data: { url: ep.url, method: ep.method, provenance: ep.provenance, sourceFile: ep.sourceFile }
          });
        }
      }
    }

    return deduplicated;
  }

  private detectMinification(sourceCode: string): boolean {
    const lines = sourceCode.split('\n');
    if (lines.length < 5 && sourceCode.length > 500) return true;
    const avgLineLength = sourceCode.length / (lines.length || 1);
    return avgLineLength > 150;
  }

  private extractViaRegex(sourceCode: string, fileName: string, isMinified: boolean, isSourceMap: boolean): ExtractedEndpoint[] {
    const results: ExtractedEndpoint[] = [];
    const method: ExtractionMethod = isSourceMap ? 'source_map' : (isMinified ? 'regex' : 'string_analysis');
    const provenance: BundleProvenance = isSourceMap ? 'source_map' : 'static_bundle';

    // fetch/axios APIs
    const apiRegex = /(?:fetch|axios\.(get|post|put|delete|patch)?)\s*\(\s*["'`](\/[a-zA-Z0-9\-\/_]+)["'`]/gi;
    let match;
    while ((match = apiRegex.exec(sourceCode)) !== null) {
      const url = match[2];
      const httpMethod = match[1] ? match[1].toUpperCase() : 'GET';
      
      const type = url.toLowerCase().includes('graphql') ? 'graphql' : 'rest';
      results.push({
        method: httpMethod,
        url,
        sourceFile: fileName,
        byteOffset: match.index,
        extractionMethod: method,
        confidence: isMinified ? 0.6 : 0.8,
        isMinified,
        provenance,
        type
      });
    }

    // XHR
    const xhrRegex = /\.open\(\s*["'`](GET|POST|PUT|DELETE|PATCH)["'`]\s*,\s*["'`](\/[a-zA-Z0-9\-\/_]+)["'`]/gi;
    while ((match = xhrRegex.exec(sourceCode)) !== null) {
      results.push({
        method: match[1].toUpperCase(),
        url: match[2],
        sourceFile: fileName,
        byteOffset: match.index,
        extractionMethod: method,
        confidence: isMinified ? 0.6 : 0.8,
        isMinified,
        provenance,
        type: 'rest'
      });
    }

    // Websockets
    const wsRegex = /new\s+WebSocket\(\s*["'`]((?:ws|wss):\/\/[^"'`]+)["'`]\s*\)/g;
    while ((match = wsRegex.exec(sourceCode)) !== null) {
      results.push({
        method: 'WS',
        url: match[1],
        sourceFile: fileName,
        byteOffset: match.index,
        extractionMethod: method,
        confidence: 0.9,
        isMinified,
        provenance,
        type: 'websocket'
      });
    }

    // Frontend routes (React/Vue/Angular paths)
    const routeRegex = /(?:path|route):\s*["'`](\/[a-zA-Z0-9\-\/_:\*]+)["'`]/g;
    while ((match = routeRegex.exec(sourceCode)) !== null) {
      results.push({
        method: 'GET',
        url: match[1],
        sourceFile: fileName,
        byteOffset: match.index,
        extractionMethod: method,
        confidence: 0.7,
        isMinified,
        provenance: 'inferred_route',
        type: 'route'
      });
    }

    return results;
  }

  private deduplicateAndResolveConflicts(endpoints: ExtractedEndpoint[], fileName: string): ExtractedEndpoint[] {
    const unique = new Map<string, ExtractedEndpoint>();
    
    for (const ep of endpoints) {
      const key = `${ep.method}:${ep.url}`;
      if (unique.has(key)) {
        const existing = unique.get(key)!;
        
        // Check for conflict (e.g. same URL detected as REST and GraphQL)
        if (existing.type !== ep.type && existing.type !== 'route' && ep.type !== 'route') {
           logEvent('bundle.conflict', { url: ep.url, types: [existing.type, ep.type] });
           recordParseDiagnostic('graphql', fileName, `Conflicting endpoint candidate types for ${ep.url}`);
        }
        
        if (ep.confidence > existing.confidence) {
          unique.set(key, ep);
        }
      } else {
        unique.set(key, ep);
      }
    }

    return Array.from(unique.values());
  }
}
