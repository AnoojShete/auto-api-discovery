// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export type TokenType =
  | 'jwt'
  | 'uuid'
  | 'ulid'
  | 'mongo_object_id'
  | 'csrf_token'
  | 'session_cookie'
  | 'graphql_cursor'
  | 'numeric_id'
  | 'timestamp'
  | 'hash'
  | 'opaque_token'
  | 'unknown';

export type EntropyLevel = 'low' | 'medium' | 'high';

export interface TokenMetadata {
  length: number;
  charset: string;
  encodingHints: string[];
  delimiterPatterns: string[];
}

export interface SemanticClassification {
  type: TokenType;
  entropy: EntropyLevel;
  confidence_modifier: number;
  metadata: TokenMetadata;
}

// ────────────────────────────────────────────────────────────────
// Regular Expressions
// ────────────────────────────────────────────────────────────────

const RE_JWT = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RE_ULID = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i;
const RE_MONGO_ID = /^[0-9a-f]{24}$/i;
const RE_NUMERIC = /^\d+$/;
const RE_HASH_MD5 = /^[0-9a-f]{32}$/i;
const RE_HASH_SHA1 = /^[0-9a-f]{40}$/i;
const RE_HASH_SHA256 = /^[0-9a-f]{64}$/i;
const RE_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function calculateEntropy(val: string): EntropyLevel {
  if (val.length < 8) return 'low';
  
  // Very rough entropy estimation based on character variety
  const uniqueChars = new Set(val.split('')).size;
  if (uniqueChars < 5 || (RE_NUMERIC.test(val) && val.length < 10)) {
    return 'low';
  }
  if (uniqueChars >= 16 && val.length >= 20) {
    return 'high';
  }
  return 'medium';
}

function detectCharset(val: string): string {
  if (RE_NUMERIC.test(val)) return 'numeric';
  if (/^[a-z]+$/.test(val)) return 'alpha_lower';
  if (/^[A-Z]+$/.test(val)) return 'alpha_upper';
  if (/^[A-Za-z]+$/.test(val)) return 'alpha';
  if (/^[0-9a-f]+$/i.test(val)) return 'hex';
  if (/^[0-9a-z]+$/i.test(val)) return 'alphanumeric';
  return 'mixed';
}

// ────────────────────────────────────────────────────────────────
// Main Classifier
// ────────────────────────────────────────────────────────────────

/**
 * Classifies a token to determine its semantic meaning, entropy, and reliability for replay dependencies.
 * @param value The token value
 * @param contextHint Optional hint (e.g. 'Authorization', 'set-cookie', 'x-csrf-token')
 */
export function classifyToken(value: string, contextHint?: string): SemanticClassification {
  const metadata: TokenMetadata = {
    length: value.length,
    charset: detectCharset(value),
    encodingHints: [],
    delimiterPatterns: []
  };

  const entropy = calculateEntropy(value);
  const hintLower = contextHint?.toLowerCase() || '';

  // Extract delimiters
  const delimiters = value.match(/[-_.:|]/g);
  if (delimiters) {
    metadata.delimiterPatterns = Array.from(new Set(delimiters));
  }

  // Base64 encoding hint (only if it's not purely numeric or hex and length > 16)
  if (value.length >= 16 && metadata.charset !== 'numeric' && metadata.charset !== 'hex' && RE_BASE64.test(value)) {
    metadata.encodingHints.push('base64');
  }

  let type: TokenType = 'unknown';
  let confidence_modifier = 0.0;

  // 1. JWT
  if (RE_JWT.test(value)) {
    type = 'jwt';
    metadata.encodingHints.push('base64url');
    // JWTs are highly reliable dependencies
    confidence_modifier = +0.2;
    if (hintLower.includes('authorization')) confidence_modifier += 0.1;
  }
  // 2. UUID
  else if (RE_UUID.test(value)) {
    type = 'uuid';
    // Common UUIDs might be hardcoded, but generally decent
    confidence_modifier = +0.05;
  }
  // 3. ULID
  else if (RE_ULID.test(value)) {
    type = 'ulid';
    confidence_modifier = +0.05;
  }
  // 4. Mongo Object ID
  else if (RE_MONGO_ID.test(value)) {
    type = 'mongo_object_id';
    confidence_modifier = +0.05;
  }
  // 5. Hash (MD5, SHA1, SHA256)
  else if (RE_HASH_MD5.test(value) || RE_HASH_SHA1.test(value) || RE_HASH_SHA256.test(value)) {
    type = 'hash';
    // Hashes are often checksums, which could be brittle to replay verbatim if inputs change
    confidence_modifier = -0.1;
  }
  // 6. Numeric / Timestamp
  else if (RE_NUMERIC.test(value)) {
    const num = parseInt(value, 10);
    // Is it a reasonable unix timestamp? (between year 2000 and 2050)
    if ((value.length === 10 && num > 946684800 && num < 2524608000) ||
        (value.length === 13 && num > 946684800000 && num < 2524608000000)) {
      type = 'timestamp';
      // Timestamps change constantly. Very bad dependency.
      confidence_modifier = -0.4;
    } else {
      type = 'numeric_id';
      // Short numeric IDs are prone to false positives (e.g. user ID '1' reused by coincidence)
      if (value.length < 5) confidence_modifier = -0.2;
    }
  }
  // 7. Context-based tokens (CSRF, Cookie, GraphQL Cursor)
  else {
    if (hintLower.includes('csrf')) {
      type = 'csrf_token';
      confidence_modifier = +0.1;
    } else if (hintLower.includes('cookie') || hintLower.includes('session')) {
      type = 'session_cookie';
      confidence_modifier = +0.1;
    } else if (hintLower.includes('cursor') || hintLower.includes('after') || hintLower.includes('before')) {
      type = 'graphql_cursor';
      // Cursors are good, but base64 hints help
      if (metadata.encodingHints.includes('base64')) confidence_modifier = +0.05;
    } else {
      // Opaque token fallback for high entropy strings
      if (entropy === 'high') {
        type = 'opaque_token';
        confidence_modifier = +0.05;
      } else {
        type = 'unknown';
        confidence_modifier = -0.1;
      }
    }
  }

  // Final entropy adjustments
  if (entropy === 'low') confidence_modifier -= 0.15;

  return {
    type,
    entropy,
    confidence_modifier,
    metadata
  };
}
