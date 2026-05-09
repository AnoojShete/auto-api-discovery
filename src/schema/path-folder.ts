/**
 * Path template folding (Phase 1.2).
 * 
 * Classifies URL path segments to distinguish dynamic identifiers from static resources.
 * Rules applied in priority order:
 *   1. UUID pattern → {id}
 *   2. Numeric-only segment → {id}
 *   3. Hex string ≥ 12 chars → {id}
 *   4. MongoDB ObjectID (24 hex chars) → {id}
 *   5. Base64-ish long strings → {id}
 *   6. Everything else → kept literal
 * 
 * Semantic naming: uses the preceding segment to name the parameter.
 *   /users/123 → /users/{userId}
 *   /posts/abc-def → /posts/{postId}  (if slug detected)
 */

/** UUID v1-v5 pattern */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Numeric-only */
const NUMERIC_RE = /^\d+$/;

/** Hex string ≥ 12 characters */
const HEX_LONG_RE = /^[0-9a-f]{12,}$/i;

/** MongoDB ObjectID (exactly 24 hex chars) */
const OBJECTID_RE = /^[0-9a-f]{24}$/i;

/** Base64 URL-safe, at least 16 chars with mixed case/digits */
const BASE64_RE = /^[A-Za-z0-9_-]{16,}$/;

/** Common resource nouns (singular) for semantic parameter naming */
const RESOURCE_NOUNS = new Set([
  'user', 'users', 'post', 'posts', 'comment', 'comments',
  'article', 'articles', 'product', 'products', 'item', 'items',
  'order', 'orders', 'category', 'categories', 'tag', 'tags',
  'project', 'projects', 'team', 'teams', 'org', 'orgs',
  'organization', 'organizations', 'repo', 'repos', 'repository',
  'file', 'files', 'folder', 'folders', 'message', 'messages',
  'notification', 'notifications', 'event', 'events',
  'session', 'sessions', 'account', 'accounts', 'group', 'groups',
  'role', 'roles', 'permission', 'permissions', 'workspace', 'workspaces',
  'channel', 'channels', 'thread', 'threads', 'task', 'tasks',
  'invoice', 'invoices', 'payment', 'payments', 'subscription', 'subscriptions',
]);

/**
 * Check if a path segment is a dynamic identifier.
 */
function isDynamic(segment: string): boolean {
  if (UUID_RE.test(segment)) return true;
  if (OBJECTID_RE.test(segment)) return true;
  if (NUMERIC_RE.test(segment)) return true;
  if (HEX_LONG_RE.test(segment)) return true;
  // Long base64-ish strings that contain mixed characters (likely tokens/IDs)
  if (segment.length >= 20 && BASE64_RE.test(segment)) return true;
  return false;
}

/**
 * Derive a semantic parameter name from the preceding path segment.
 * /users/{?} → {userId}
 * /posts/{?}/comments/{?} → {postId}, {commentId}
 */
function deriveParamName(precedingSegment: string | null): string {
  if (!precedingSegment) return 'id';

  // Singularize common plurals
  let singular = precedingSegment;
  if (singular.endsWith('ies')) {
    singular = singular.slice(0, -3) + 'y'; // categories → category
  } else if (singular.endsWith('ses')) {
    singular = singular.slice(0, -2); // addresses → address... close enough
  } else if (singular.endsWith('s') && !singular.endsWith('ss')) {
    singular = singular.slice(0, -1); // users → user
  }

  // If it's a known resource noun, use semantic name
  if (RESOURCE_NOUNS.has(precedingSegment) || RESOURCE_NOUNS.has(singular)) {
    return `${singular}Id`;
  }

  // Fallback: just use the preceding segment + Id
  return `${singular}Id`;
}

/**
 * Fold a raw URL path into a parameterized path template.
 * 
 * @param rawPath - The raw pathname (e.g., "/users/123/posts/abc")
 * @returns The folded template (e.g., "/users/{userId}/posts/{postId}")
 */
export function foldPath(rawPath: string): string {
  const segments = rawPath.split('/').filter(Boolean);
  if (segments.length === 0) return '/';

  const folded: string[] = [];
  const usedNames = new Set<string>();

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    if (isDynamic(segment)) {
      const preceding = i > 0 ? segments[i - 1] : null;
      let paramName = deriveParamName(preceding);

      // Avoid duplicate parameter names
      if (usedNames.has(paramName)) {
        let counter = 2;
        while (usedNames.has(`${paramName}${counter}`)) counter++;
        paramName = `${paramName}${counter}`;
      }

      usedNames.add(paramName);
      folded.push(`{${paramName}}`);
    } else {
      folded.push(segment);
    }
  }

  return '/' + folded.join('/');
}

/**
 * Extract parameter names from a path template.
 * "/users/{userId}/posts/{postId}" → ["userId", "postId"]
 */
export function extractPathParams(template: string): string[] {
  const matches = template.match(/\{([^}]+)\}/g);
  if (!matches) return [];
  return matches.map(m => m.slice(1, -1));
}
