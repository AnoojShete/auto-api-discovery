import { describe, it, expect } from 'vitest';
import { inferFromRequests } from '../src/replay/inference';

describe('Replay Dependency Inference Engine', () => {
  it('infers auth token reuse', () => {
    const requests = [
      {
        id: 'req_1',
        session_id: 'session_a',
        response_body: { token: 'supersecrettoken123' },
        request_headers: {}
      },
      {
        id: 'req_2',
        session_id: 'session_a',
        response_body: {},
        request_headers: { Authorization: 'Bearer supersecrettoken123' }
      }
    ];

    const deps = inferFromRequests(requests);
    expect(deps).toHaveLength(1);
    expect(deps[0].type).toBe('token');
    expect(deps[0].sourceRequestId).toBe('req_1');
    expect(deps[0].targetRequestId).toBe('req_2');
    expect(deps[0].confidence).toBeGreaterThan(0.8);
  });

  it('infers cookie propagation', () => {
    const requests = [
      {
        id: 'req_1',
        session_id: 'session_a',
        response_headers: { 'Set-Cookie': 'session_id=abcdef123456789; Path=/' },
        request_headers: {}
      },
      {
        id: 'req_2',
        session_id: 'session_a',
        response_headers: {},
        request_headers: { Cookie: 'session_id=abcdef123456789; other=1' }
      }
    ];

    const deps = inferFromRequests(requests);
    expect(deps).toHaveLength(1);
    expect(deps[0].type).toBe('cookie');
    expect(deps[0].sourceRequestId).toBe('req_1');
    expect(deps[0].targetRequestId).toBe('req_2');
    expect(deps[0].confidence).toBeGreaterThan(0.8);
  });

  it('infers csrf token flow', () => {
    const requests = [
      {
        id: 'req_1',
        session_id: 'session_a',
        response_body: { csrf_token: '123456789_csrf' },
        request_headers: {}
      },
      {
        id: 'req_2',
        session_id: 'session_a',
        response_body: {},
        request_headers: { 'X-CSRF-Token': '123456789_csrf' }
      }
    ];

    const deps = inferFromRequests(requests);
    expect(deps).toHaveLength(1);
    expect(deps[0].type).toBe('csrf');
    expect(deps[0].sourceRequestId).toBe('req_1');
    expect(deps[0].targetRequestId).toBe('req_2');
  });

  it('infers path parameter reuse', () => {
    const requests = [
      {
        id: 'req_1',
        session_id: 'session_a',
        response_body: { id: 'user_123456789' },
        path: '/api/users'
      },
      {
        id: 'req_2',
        session_id: 'session_a',
        response_body: {},
        path: '/api/users/user_123456789'
      }
    ];

    const deps = inferFromRequests(requests);
    expect(deps).toHaveLength(1);
    expect(deps[0].type).toBe('path_param');
    expect(deps[0].sourceRequestId).toBe('req_1');
    expect(deps[0].targetRequestId).toBe('req_2');
  });

  it('infers query parameter reuse', () => {
    const requests = [
      {
        id: 'req_1',
        session_id: 'session_a',
        response_body: { search_id: 'search_987654321' },
      },
      {
        id: 'req_2',
        session_id: 'session_a',
        query_raw: 'q=hello&id=search_987654321',
      }
    ];

    const deps = inferFromRequests(requests);
    expect(deps).toHaveLength(1);
    expect(deps[0].type).toBe('query_param');
    expect(deps[0].sourceRequestId).toBe('req_1');
    expect(deps[0].targetRequestId).toBe('req_2');
  });

  it('infers GraphQL variable reuse', () => {
    const requests = [
      {
        id: 'req_1',
        session_id: 'session_a',
        response_body: { data: { createItem: { id: 'item_123456789' } } },
      },
      {
        id: 'req_2',
        session_id: 'session_a',
        url: 'http://localhost/graphql',
        path: '/graphql',
        request_body: {
          variables: { itemId: 'item_123456789' }
        }
      }
    ];

    const deps = inferFromRequests(requests);
    expect(deps).toHaveLength(1);
    expect(deps[0].type).toBe('graphql_var');
    expect(deps[0].sourceRequestId).toBe('req_1');
    expect(deps[0].targetRequestId).toBe('req_2');
  });

  it('does not cross-pollinate sessions', () => {
    const requests = [
      {
        id: 'req_1',
        session_id: 'session_a',
        response_body: { token: 'supersecrettoken123' },
      },
      {
        id: 'req_2',
        session_id: 'session_b',
        request_headers: { Authorization: 'Bearer supersecrettoken123' }
      }
    ];

    const deps = inferFromRequests(requests);
    expect(deps).toHaveLength(0); // Different sessions
  });
});
