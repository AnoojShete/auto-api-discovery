import { describe, expect, it } from 'vitest';
import { foldPath } from '../src/schema/path-folder';

describe('foldPath', () => {
  it('folds dynamic segments with semantic names', () => {
    const inputs = [
      '/users/123',
      '/users/123/posts/abc123',
      '/teams/9d8c7b6a5f4e3d2c1b0a/roles/42',
      '/projects/alpha/tasks/987',
      '/orgs/acme/users/550e8400-e29b-41d4-a716-446655440000',
    ];

    const results = inputs.map(foldPath);
    expect(results).toMatchSnapshot();
  });
});
