import { describe, expect, it } from 'vitest';
import { withTempCwd } from './helpers/temp-db';
import { upsertEndpoint, getAllEndpoints } from '../src/db/endpoints';

describe('endpoint deduplication', () => {
  it('increments observation count for duplicates', () => {
    withTempCwd(() => {
      upsertEndpoint('GET', '/users/{userId}', 'http://localhost:4000', 'network');
      upsertEndpoint('GET', '/users/{userId}', 'http://localhost:4000', 'network');
      upsertEndpoint('GET', '/users/{userId}', 'http://localhost:4000', 'network');

      const endpoints = getAllEndpoints();
      expect(endpoints).toHaveLength(1);
      expect(endpoints[0].observation_count).toBe(3);
    });
  });
});
