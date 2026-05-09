import { describe, expect, it } from 'vitest';
import { inferSchema, mergeSchemas } from '../src/schema/infer';

describe('schema inference', () => {
  it('infers and merges schemas consistently', () => {
    const a = inferSchema({ id: 1, email: 'a@example.com', active: true });
    const b = inferSchema({ id: 2, email: 'b@example.com', active: false, tags: ['x'] });
    const c = inferSchema({ id: '3', email: 'c@example.com', active: true, tags: [] });

    const merged = mergeSchemas(mergeSchemas(a, b), c);
    expect(merged).toMatchSnapshot();
  });
});
