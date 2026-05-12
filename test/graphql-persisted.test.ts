import { describe, it, expect } from 'vitest';
import { PersistedGraphQLRecovery } from '../src/discovery/graphql-persisted';

describe('PersistedGraphQLRecovery', () => {
  it('recovers Apollo persisted query', () => {
    const recovery = new PersistedGraphQLRecovery();
    const payload = {
      operationName: 'GetUser',
      variables: { id: 1 },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: 'cq21abc123'
        }
      }
    };
    
    const rec = recovery.recoverFromPayload(payload);
    expect(rec).not.toBeNull();
    expect(rec!.queryHash).toBe('cq21abc123');
    expect(rec!.operationName).toBe('GetUser');
    expect(rec!.confidence).toBe(0.8);
    expect(rec!.provenance).toBe('persisted_query');
  });

  it('recovers Relay persisted query', () => {
    const recovery = new PersistedGraphQLRecovery();
    const payload = {
      doc_id: 'relay_hash_999',
      variables: { foo: 'bar' }
    };
    
    const rec = recovery.recoverFromPayload(payload);
    expect(rec).not.toBeNull();
    expect(rec!.queryHash).toBe('relay_hash_999');
    expect(rec!.confidence).toBe(0.4);
  });

  it('recovers full document when registered', () => {
    const recovery = new PersistedGraphQLRecovery();
    recovery.registerKnownQuery('hash_123', 'query GetUser { user { id } }');
    
    const payload = {
      id: 'hash_123',
      variables: {}
    };
    
    const rec = recovery.recoverFromPayload(payload);
    expect(rec!.document).toBe('query GetUser { user { id } }');
    expect(rec!.confidence).toBe(1.0);
  });

  it('detects hash collisions', () => {
    const recovery = new PersistedGraphQLRecovery();
    recovery.registerKnownQuery('hash_123', 'query A { a }');
    recovery.registerKnownQuery('hash_123', 'query B { b }'); // should overwrite and log
    
    const payload = { id: 'hash_123', variables: {} };
    const rec = recovery.recoverFromPayload(payload);
    expect(rec!.document).toBe('query B { b }');
  });

  it('detects malformed payloads', () => {
    const recovery = new PersistedGraphQLRecovery();
    const payload = {
      operationName: 'MissingQueryOrHash',
      variables: {}
    };
    const rec = recovery.recoverFromPayload(payload);
    expect(rec).toBeNull();
  });

  it('integrates with existing AST infrastructure', () => {
    const recovery = new PersistedGraphQLRecovery();
    recovery.registerKnownQuery('apollo_hash', 'query GetUser { id }');
    
    const payload = {
      operationName: 'GetUser',
      variables: {},
      extensions: { persistedQuery: { sha256Hash: 'apollo_hash' } }
    };
    
    const recovered = recovery.recoverFromPayload(payload)!;
    
    // Simulate object structure returned by existing AST extractor
    const detected = {
      operationType: 'query',
      operationName: 'GetUser',
      document: '',
      variables: null,
      complexity: 0,
      hasFragments: false,
      isPersistedQuery: true,
      fragments: [],
    };
    
    const enriched = recovery.enrichDetectedOperation(detected, recovered);
    expect(enriched.document).toBe('query GetUser { id }');
    expect(enriched.isPersistedQuery).toBe(true);
  });
  
  it('minified payload tests', () => {
    const recovery = new PersistedGraphQLRecovery();
    const minified = { id: 'm1' }; // Relay minified
    const rec = recovery.recoverFromPayload(minified);
    expect(rec).not.toBeNull();
    expect(rec!.queryHash).toBe('m1');
    expect(rec!.confidence).toBe(0.4);
  });

  it('batch payload handling', () => {
    const recovery = new PersistedGraphQLRecovery();
    const payloads = [
      { id: 'hash1' },
      { id: 'hash2' }
    ];
    const recs = recovery.recoverFromPayloads(payloads);
    expect(recs.length).toBe(2);
    expect(recs[0].queryHash).toBe('hash1');
    expect(recs[1].queryHash).toBe('hash2');
  });
});
