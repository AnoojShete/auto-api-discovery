import { describe, it, expect } from 'vitest';
import { extractGqlOperation, isGraphQLRequest } from '../src/capture/graphql';

describe('GraphQL AST Extraction', () => {
  it('detects single and batched requests', () => {
    expect(isGraphQLRequest('/graphql', { query: '{ ping }' })).toBe(true);
    expect(isGraphQLRequest('/api', [{ query: '{ ping }' }, { query: '{ pong }' }])).toBe(true);
    expect(isGraphQLRequest('/api', { notQuery: 1 })).toBe(false);
  });

  it('extracts anonymous queries', () => {
    const ops = extractGqlOperation({ query: '{ hello }' });
    expect(ops).toHaveLength(1);
    expect(ops[0].operationType).toBe('query');
    expect(ops[0].operationName).toBeNull();
    expect(ops[0].complexity).toBe(1);
    expect(ops[0].hasFragments).toBe(false);
  });

  it('extracts named mutations with variables', () => {
    const ops = extractGqlOperation({
      query: 'mutation AddUser($name: String!) { addUser(name: $name) { id } }',
      operationName: 'AddUser',
      variables: { name: 'Alice' }
    });
    expect(ops).toHaveLength(1);
    expect(ops[0].operationType).toBe('mutation');
    expect(ops[0].operationName).toBe('AddUser');
    expect(ops[0].complexity).toBe(2); // addUser, id
  });

  it('handles fragments and inline fragments', () => {
    const ops = extractGqlOperation({
      query: `
        query GetUser {
          user {
            ...UserFields
            ... on Admin { role }
          }
        }
        fragment UserFields on User { id name }
      `
    });
    expect(ops).toHaveLength(1);
    expect(ops[0].hasFragments).toBe(true);
    expect(ops[0].fragments).toContain('UserFields');
    expect(ops[0].complexity).toBe(4); // user, role, id, name
  });

  it('extracts batched requests', () => {
    const ops = extractGqlOperation([
      { query: 'query Q1 { a }', operationName: 'Q1' },
      { query: 'query Q2 { b c }', operationName: 'Q2' }
    ]);
    expect(ops).toHaveLength(2);
    expect(ops[0].operationName).toBe('Q1');
    expect(ops[0].complexity).toBe(1);
    expect(ops[1].operationName).toBe('Q2');
    expect(ops[1].complexity).toBe(2);
  });

  it('handles malformed GraphQL gracefully', () => {
    const ops = extractGqlOperation({ query: 'query { invalid syntax' });
    expect(ops).toHaveLength(0);
  });

  it('handles subscriptions over WS payload', () => {
    const ops = extractGqlOperation({
      query: 'subscription OnMessage { messageAdded { id text } }'
    });
    expect(ops).toHaveLength(1);
    expect(ops[0].operationType).toBe('subscription');
    expect(ops[0].operationName).toBe('OnMessage');
  });

  it('detects persisted queries', () => {
    const ops = extractGqlOperation({
      extensions: { persistedQuery: { version: 1, sha256Hash: 'xyz' } }
    });
    expect(ops).toHaveLength(1);
    expect(ops[0].isPersistedQuery).toBe(true);
    expect(ops[0].document).toBe('');
    expect(ops[0].operationType).toBe('query');
  });
});
