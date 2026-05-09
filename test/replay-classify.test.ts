import { describe, it, expect } from 'vitest';
import { classifyToken } from '../src/replay/classify';

describe('Semantic State Classifier', () => {
  it('classifies JWT tokens accurately', () => {
    // Basic JWT shape
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const cls = classifyToken(jwt, 'Authorization');
    
    expect(cls.type).toBe('jwt');
    expect(cls.entropy).toBe('high');
    expect(cls.metadata.encodingHints).toContain('base64url');
    // base +0.2 + 0.1 (auth hint)
    expect(cls.confidence_modifier).toBeGreaterThanOrEqual(0.3);
  });

  it('classifies UUIDs correctly', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    const cls = classifyToken(uuid);
    
    expect(cls.type).toBe('uuid');
    expect(cls.metadata.length).toBe(36);
    expect(cls.metadata.delimiterPatterns).toContain('-');
    expect(cls.confidence_modifier).toBeGreaterThan(0);
  });

  it('classifies timestamps and penalizes confidence', () => {
    const timestampMs = '1622548800000'; // Unix timestamp in ms
    const cls = classifyToken(timestampMs);
    
    expect(cls.type).toBe('timestamp');
    expect(cls.metadata.charset).toBe('numeric');
    // Timestamps are terrible replay dependencies
    expect(cls.confidence_modifier).toBeLessThan(0);
  });

  it('classifies short numeric IDs', () => {
    const cls = classifyToken('42');
    
    expect(cls.type).toBe('numeric_id');
    expect(cls.entropy).toBe('low');
    // Short ID + low entropy
    expect(cls.confidence_modifier).toBeLessThan(-0.2);
  });

  it('classifies CSRF tokens via context hint', () => {
    // Random high entropy string
    const csrf = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';
    const cls = classifyToken(csrf, 'x-csrf-token');
    
    expect(cls.type).toBe('csrf_token');
    expect(cls.entropy).toBe('high');
    expect(cls.confidence_modifier).toBeGreaterThan(0);
  });

  it('classifies GraphQL cursors with base64 hint', () => {
    const cursor = 'YXJyYXljb25uZWN0aW9uOjA='; // "arrayconnection:0"
    const cls = classifyToken(cursor, 'after');
    
    expect(cls.type).toBe('graphql_cursor');
    expect(cls.metadata.encodingHints).toContain('base64');
    // Should get a bonus for base64
    expect(cls.confidence_modifier).toBeGreaterThan(0);
  });

  it('falls back to opaque_token for high entropy unknown strings', () => {
    const opaque = 'v3ryL0ngAndC0mpl3xStr1ngW1thN00bvi0usPatt3rn';
    const cls = classifyToken(opaque);
    
    expect(cls.type).toBe('opaque_token');
    expect(cls.entropy).toBe('high');
    expect(cls.confidence_modifier).toBeGreaterThan(0);
  });

  it('falls back to unknown for medium entropy unknown strings', () => {
    const unknown = 'some_random_word';
    const cls = classifyToken(unknown);
    
    expect(cls.type).toBe('unknown');
    expect(cls.entropy).toBe('medium');
    expect(cls.confidence_modifier).toBeLessThan(0); // Penalized for being unknown
  });

  it('handles malformed or empty tokens gracefully', () => {
    const cls = classifyToken('');
    
    expect(cls.type).toBe('unknown');
    expect(cls.entropy).toBe('low');
    expect(cls.metadata.length).toBe(0);
    expect(cls.confidence_modifier).toBeLessThan(0);
  });

  it('detects hashes correctly', () => {
    // SHA256 length hash
    const hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const cls = classifyToken(hash);

    expect(cls.type).toBe('hash');
    expect(cls.metadata.charset).toBe('hex');
    // Hashes are usually brittle
    expect(cls.confidence_modifier).toBeLessThan(0);
  });
});
