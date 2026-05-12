import { DetectedGqlOperation } from '../capture/graphql';
import { recordParseDiagnostic } from '../db/diagnostics';
import { logEvent } from '../observability/logger';

export type ProvenanceType = 'runtime_capture' | 'persisted_query' | 'static_bundle' | 'inferred_operation';

export interface RecoveredPersistedOperation {
  operationName: string | null;
  queryHash: string | null;
  document: string | null;
  variables: any;
  extensions: any;
  provenance: ProvenanceType;
  confidence: number;
}

export class PersistedGraphQLRecovery {
  private knownQueries: Map<string, string> = new Map();

  constructor() {}

  public registerKnownQuery(hash: string, document: string) {
    if (this.knownQueries.has(hash) && this.knownQueries.get(hash) !== document) {
      // Diagnostic: hash collision
      recordParseDiagnostic('graphql', undefined, `Hash collision detected for query hash: ${hash}`);
      logEvent('gql.persisted.hash_collision', { hash });
    }
    this.knownQueries.set(hash, document);
  }

  public recoverFromPayloads(payloads: any | any[]): RecoveredPersistedOperation[] {
    const items = Array.isArray(payloads) ? payloads : [payloads];
    const results: RecoveredPersistedOperation[] = [];

    for (const item of items) {
      const recovered = this.recoverFromPayload(item);
      if (recovered) results.push(recovered);
    }

    return results;
  }

  public recoverFromPayload(payload: any): RecoveredPersistedOperation | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    let operationName = payload.operationName || null;
    let queryHash: string | null = null;
    let isApollo = false;
    let isRelay = false;

    // Apollo signature: extensions.persistedQuery.sha256Hash
    if (payload.extensions?.persistedQuery?.sha256Hash) {
      queryHash = payload.extensions.persistedQuery.sha256Hash;
      isApollo = true;
    }

    // Relay signature: id or doc_id
    if (!queryHash && (payload.id || payload.doc_id)) {
      queryHash = payload.id || payload.doc_id;
      isRelay = true;
    }

    if (!isApollo && !isRelay) {
      // Malformed if it has operationName/variables/extensions but no query
      if (!payload.query && (payload.operationName || payload.variables || payload.extensions)) {
        // Diagnostic: malformed operation payload
        recordParseDiagnostic('graphql', undefined, `Malformed GraphQL operation payload: missing query or hash`);
        logEvent('gql.persisted.malformed_payload', { payloadKeys: Object.keys(payload) });
      }
      return null;
    }

    const document = queryHash ? (this.knownQueries.get(queryHash) || null) : null;
    let confidence = 0.5;

    if (document) {
      // We found the actual document text matching the hash.
      confidence = 1.0;
    } else {
      // We have a hash but no document body yet (unresolved).
      // Diagnostic: unresolved persisted query
      recordParseDiagnostic('graphql', undefined, `Unresolved persisted query hash: ${queryHash}`);
      logEvent('gql.persisted.unresolved', { hash: queryHash, operationName });
      
      // Moderate confidence if we know the operation name
      confidence = operationName ? 0.8 : 0.4;
    }

    return {
      operationName,
      queryHash,
      document,
      variables: payload.variables || null,
      extensions: payload.extensions || null,
      provenance: 'persisted_query',
      confidence
    };
  }

  /**
   * Integrates the recovered persisted operation into the existing AST infrastructure
   * without modifying the replay graph architecture.
   */
  public enrichDetectedOperation(detected: DetectedGqlOperation, recovered: RecoveredPersistedOperation): DetectedGqlOperation {
    return {
      ...detected,
      operationName: detected.operationName || recovered.operationName,
      document: recovered.document || detected.document || '',
      isPersistedQuery: true
    };
  }
}
