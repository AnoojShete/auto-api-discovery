import { describe, expect, it } from 'vitest';
import { withTempCwd } from './helpers/temp-db';
import { insertRequest } from '../src/db/requests';
import { upsertEndpoint, linkRequestToEndpoint } from '../src/db/endpoints';
import { generateOpenAPISpec } from '../src/export/openapi';

function seedRequest(sessionId: string, method: string, url: string, path: string, body: any, status: number) {
  const requestId = insertRequest({
    session_id: sessionId,
    method,
    url,
    path,
    request_headers: { 'content-type': 'application/json' },
    request_body: { input: true },
    response_status: status,
    response_headers: { 'content-type': 'application/json' },
    response_body: body,
    response_time_ms: 12,
    source: 'fetch',
  });

  const endpointId = upsertEndpoint(method, path, 'http://localhost:4000', 'network');
  linkRequestToEndpoint(requestId, endpointId);
}

describe('openapi export', () => {
  it('generates a stable spec snapshot', () => {
    withTempCwd(() => {
      seedRequest('s1', 'GET', 'http://localhost:4000/users/1', '/users/1', { id: 1, name: 'Ada' }, 200);
      seedRequest('s1', 'GET', 'http://localhost:4000/users/2', '/users/2', { id: 2, name: 'Grace' }, 200);
      seedRequest('s1', 'POST', 'http://localhost:4000/users', '/users', { id: 3, name: 'Lin' }, 201);

      const spec = generateOpenAPISpec({
        baseUrl: 'http://localhost:4000',
        title: 'Fixture API',
        version: '1.0.0',
      });

      expect(spec).toMatchSnapshot();
    });
  });
});
