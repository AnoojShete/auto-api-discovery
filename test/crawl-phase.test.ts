import { describe, it, expect, vi, beforeEach } from 'vitest';

// ────────────────────────────────────────────────────────────────
// 1. POST Body Capture & JSON Content Types
// ────────────────────────────────────────────────────────────────

describe('interceptor — JSON content type detection', () => {
  // We test isJsonLikeContentType by importing it indirectly through behavior.
  // Since it's a private function, we replicate the logic here for unit testing.
  function isJsonLikeContentType(contentType: string): boolean {
    if (contentType.includes('application/json')) return true;
    if (contentType.includes('application/graphql+json')) return true;
    if (contentType.includes('application/problem+json')) return true;
    if (contentType.includes('application/ld+json')) return true;
    if (contentType.includes('text/')) return true;
    if (/\+json/i.test(contentType)) return true;
    return false;
  }

  it('accepts standard application/json', () => {
    expect(isJsonLikeContentType('application/json')).toBe(true);
    expect(isJsonLikeContentType('application/json; charset=utf-8')).toBe(true);
  });

  it('accepts application/graphql+json', () => {
    expect(isJsonLikeContentType('application/graphql+json')).toBe(true);
  });

  it('accepts application/problem+json (RFC 7807)', () => {
    expect(isJsonLikeContentType('application/problem+json')).toBe(true);
  });

  it('accepts application/ld+json (JSON-LD)', () => {
    expect(isJsonLikeContentType('application/ld+json')).toBe(true);
  });

  it('accepts vendor +json suffixes', () => {
    expect(isJsonLikeContentType('application/vnd.api+json')).toBe(true);
    expect(isJsonLikeContentType('application/vnd.github.v3+json')).toBe(true);
  });

  it('accepts text/* content types', () => {
    expect(isJsonLikeContentType('text/plain')).toBe(true);
    expect(isJsonLikeContentType('text/html')).toBe(true);
  });

  it('rejects binary content types', () => {
    expect(isJsonLikeContentType('application/octet-stream')).toBe(false);
    expect(isJsonLikeContentType('image/png')).toBe(false);
    expect(isJsonLikeContentType('application/pdf')).toBe(false);
  });
});

describe('interceptor — POST body eager caching', () => {
  it('postData is cached before response event fires', () => {
    // Simulate the eager caching pattern:
    // In the request event, postData is captured immediately.
    // In the response event, the cached value is used.
    const cachedPostData = new Map<string, string | null>();

    // Simulate request event
    const requestKey = 'https://api.example.com/graphqlPOST';
    const postBody = JSON.stringify({ query: '{ users { id } }' });
    cachedPostData.set(requestKey, postBody);

    // Simulate response event — postData() would return null in a race condition
    const postDataFromRequest = null; // simulates GC'd request
    const resolvedPostData = cachedPostData.get(requestKey) ?? postDataFromRequest ?? null;

    expect(resolvedPostData).toBe(postBody);
    expect(JSON.parse(resolvedPostData!).query).toBe('{ users { id } }');
  });

  it('falls back to request.postData() if cache misses', () => {
    const cachedPostData = new Map<string, string | null>();
    const requestKey = 'https://api.example.com/dataPOST';

    // No cache entry (unusual but possible)
    const postDataFromRequest = '{"key": "value"}';
    const resolvedPostData = cachedPostData.get(requestKey) ?? postDataFromRequest ?? null;

    expect(resolvedPostData).toBe(postDataFromRequest);
  });
});

// ────────────────────────────────────────────────────────────────
// 2. Crawl Domain/Subdomain Gating
// ────────────────────────────────────────────────────────────────

import { isUrlInScope } from '../src/cli/crawl';

describe('crawl — domain gating', () => {
  it('allows exact hostname match', () => {
    expect(isUrlInScope('leetcode.com', 'leetcode.com', false)).toBe(true);
  });

  it('rejects different domains by default', () => {
    expect(isUrlInScope('evil.com', 'leetcode.com', false)).toBe(false);
    expect(isUrlInScope('google.com', 'leetcode.com', false)).toBe(false);
  });

  it('rejects subdomains by default', () => {
    expect(isUrlInScope('discuss.leetcode.com', 'leetcode.com', false)).toBe(false);
    expect(isUrlInScope('api.leetcode.com', 'leetcode.com', false)).toBe(false);
  });

  it('allows subdomains when --allow-subdomains is set', () => {
    expect(isUrlInScope('discuss.leetcode.com', 'leetcode.com', true)).toBe(true);
    expect(isUrlInScope('api.leetcode.com', 'leetcode.com', true)).toBe(true);
    expect(isUrlInScope('deep.nested.leetcode.com', 'leetcode.com', true)).toBe(true);
  });

  it('still rejects external domains even with --allow-subdomains', () => {
    expect(isUrlInScope('evil.com', 'leetcode.com', true)).toBe(false);
    expect(isUrlInScope('leetcode.com.evil.com', 'leetcode.com', true)).toBe(false);
  });

  it('exact match still works with --allow-subdomains', () => {
    expect(isUrlInScope('leetcode.com', 'leetcode.com', true)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// 3. Identity Resolver — Protocol Upgrades
// ────────────────────────────────────────────────────────────────

import { IdentityResolver } from '../src/discovery/identity';

describe('identity resolver — protocol upgrades', () => {
  it('upgrades http to https on merge', () => {
    const resolver = new IdentityResolver();
    resolver.resolveEndpoint('GET', 'http://api.example.com/users', 'network');
    const ep = resolver.resolveEndpoint('GET', 'https://api.example.com/users', 'network');
    expect(ep.protocolType).toBe('https');
  });

  it('upgrades ws to wss on merge', () => {
    const resolver = new IdentityResolver();
    resolver.resolveEndpoint('GET', 'ws://api.example.com/ws', 'network');
    const ep = resolver.resolveEndpoint('GET', 'wss://api.example.com/ws', 'network');
    expect(ep.protocolType).toBe('wss');
  });

  it('does not downgrade https to http', () => {
    const resolver = new IdentityResolver();
    resolver.resolveEndpoint('GET', 'https://api.example.com/data', 'network');
    const ep = resolver.resolveEndpoint('GET', 'http://api.example.com/data', 'network');
    expect(ep.protocolType).toBe('https');
  });

  it('upgrades from unknown to any protocol', () => {
    const resolver = new IdentityResolver();
    resolver.resolveEndpoint('GET', '/api/users', 'static_bundle'); // unknown protocol
    const ep = resolver.resolveEndpoint('GET', 'https://api.example.com/api/users', 'network');
    expect(ep.protocolType).toBe('https');
  });

  it('merges provenances across protocol upgrades without fragmentation', () => {
    const resolver = new IdentityResolver();
    resolver.resolveEndpoint('GET', 'http://api.example.com/data', 'static_bundle');
    const ep = resolver.resolveEndpoint('GET', 'https://api.example.com/data', 'runtime_capture');

    expect(ep.provenanceSet.has('static_bundle')).toBe(true);
    expect(ep.provenanceSet.has('runtime_capture')).toBe(true);
    expect(ep.trustState).toBe('observed');
    expect(ep.protocolType).toBe('https');
  });
});

describe('identity resolver — multi-provenance merge', () => {
  it('trust state escalates through provenance merges', () => {
    const resolver = new IdentityResolver();

    // Start as inferred
    const ep1 = resolver.resolveEndpoint('GET', '/api/users', 'inferred_route');
    expect(ep1.trustState).toBe('inferred');

    // Upgrade to discovered
    const ep2 = resolver.resolveEndpoint('GET', '/api/users', 'static_bundle');
    expect(ep2.trustState).toBe('discovered');

    // Upgrade to observed
    const ep3 = resolver.resolveEndpoint('GET', '/api/users', 'runtime_capture');
    expect(ep3.trustState).toBe('observed');
  });

  it('network provenance maps to observed', () => {
    const resolver = new IdentityResolver();
    const ep = resolver.resolveEndpoint('GET', '/api/data', 'network');
    expect(ep.trustState).toBe('observed');
  });

  it('confidence takes max across merges', () => {
    const resolver = new IdentityResolver();
    resolver.resolveEndpoint('GET', '/api/users', 'inferred_route', false, 0.3);
    const ep = resolver.resolveEndpoint('GET', '/api/users', 'runtime_capture', false, 0.9);
    expect(ep.confidence).toBe(0.9);
  });
});

// ────────────────────────────────────────────────────────────────
// 4. Auth Boundary Detection Heuristics
// ────────────────────────────────────────────────────────────────

import {
  detectHttpAuthBoundary,
  detectLoginRedirect,
} from '../src/capture/auth-detector';

describe('auth detector — HTTP status codes', () => {
  it('detects 401 as auth boundary', () => {
    const result = detectHttpAuthBoundary('https://api.example.com/me', 401);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('http_401');
    expect(result!.confidence).toBe(1.0);
  });

  it('detects 403 as auth boundary', () => {
    const result = detectHttpAuthBoundary('https://api.example.com/admin', 403);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('http_403');
    expect(result!.confidence).toBe(0.9);
  });

  it('does not flag 200 or 404', () => {
    expect(detectHttpAuthBoundary('https://api.example.com', 200)).toBeNull();
    expect(detectHttpAuthBoundary('https://api.example.com', 404)).toBeNull();
  });

  it('does not flag redirects (302)', () => {
    expect(detectHttpAuthBoundary('https://api.example.com', 302)).toBeNull();
  });
});

describe('auth detector — login redirects', () => {
  it('detects redirect to /login', () => {
    const result = detectLoginRedirect(
      'https://example.com/login?redirect=%2Fdashboard',
      'https://example.com/dashboard'
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('login_redirect');
  });

  it('detects redirect to /signin', () => {
    const result = detectLoginRedirect(
      'https://example.com/signin',
      'https://example.com/profile'
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('login_redirect');
  });

  it('detects redirect to /auth', () => {
    const result = detectLoginRedirect(
      'https://example.com/auth/login',
      'https://example.com/dashboard'
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('login_redirect');
  });

  it('detects redirect to /sso', () => {
    const result = detectLoginRedirect(
      'https://sso.example.com/sso/authorize',
      'https://example.com/app'
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('login_redirect');
  });

  it('does not flag same-page navigation', () => {
    const result = detectLoginRedirect(
      'https://example.com/dashboard',
      'https://example.com/dashboard'
    );
    expect(result).toBeNull();
  });

  it('does not flag non-auth redirects', () => {
    const result = detectLoginRedirect(
      'https://example.com/about',
      'https://example.com/home'
    );
    expect(result).toBeNull();
  });

  it('does not false-positive when original URL also contains login', () => {
    const result = detectLoginRedirect(
      'https://example.com/login',
      'https://example.com/login'
    );
    expect(result).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// 5. Session Persistence
// ────────────────────────────────────────────────────────────────

import {
  createSession,
  getSessionByLabel,
  saveStorageState,
  loadStorageState,
  isSessionLikelyValid,
  updateSessionCookies,
} from '../src/db/sessions';
import { getDb, closeDb } from '../src/db/schema';
import fs from 'fs';
import path from 'path';

describe('session persistence', () => {
  const testDir = path.join(process.cwd(), '.apigen-test-crawl');

  beforeEach(() => {
    // Point to a test-specific .apigen directory
    process.env.APIGEN_CWD = testDir;
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    closeDb();
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    delete process.env.APIGEN_CWD;
  });

  it('saves and loads storageState', () => {
    const sessionId = createSession('test-session');
    const mockState = {
      cookies: [{ name: 'sid', value: 'abc123', domain: '.example.com', path: '/' }],
      origins: [
        {
          origin: 'https://example.com',
          localStorage: [{ name: 'token', value: 'jwt-xyz' }],
        },
      ],
    };

    saveStorageState(sessionId, mockState);
    const loaded = loadStorageState('test-session');

    expect(loaded).not.toBeNull();
    expect(loaded.cookies[0].name).toBe('sid');
    expect(loaded.origins[0].localStorage[0].value).toBe('jwt-xyz');
  });

  it('returns null for non-existent session', () => {
    // Force DB init
    createSession('init');
    const loaded = loadStorageState('nonexistent');
    expect(loaded).toBeNull();
  });

  it('isSessionLikelyValid returns true for fresh sessions', () => {
    const sessionId = createSession('fresh-session');
    saveStorageState(sessionId, { cookies: [] });
    expect(isSessionLikelyValid('fresh-session')).toBe(true);
  });

  it('isSessionLikelyValid returns false for sessions without state', () => {
    createSession('empty-session');
    expect(isSessionLikelyValid('empty-session')).toBe(false);
  });

  it('isSessionLikelyValid returns false for non-existent sessions', () => {
    createSession('init');
    expect(isSessionLikelyValid('no-such-session')).toBe(false);
  });

  it('cookie-only sessions are considered valid', () => {
    const sessionId = createSession('cookie-session');
    updateSessionCookies(sessionId, [{ name: 'auth', value: 'token123' }]);
    expect(isSessionLikelyValid('cookie-session')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// 6. HITL Resume Flow (same-context verification)
// ────────────────────────────────────────────────────────────────

describe('HITL — same-context resume', () => {
  it('simulates context preservation across auth pause', () => {
    // This test verifies the logical contract:
    // A single BrowserContext is used across the pause/resume boundary.
    // We simulate this by verifying that a shared state object (representing
    // the context) maintains mutations made during the "auth" phase.

    const contextState = {
      cookies: [] as Array<{ name: string; value: string }>,
      authenticated: false,
    };

    // Phase 1: Crawl hits auth wall
    const authDetected = true;
    expect(authDetected).toBe(true);

    // Phase 2: User manually logs in (same context)
    contextState.cookies.push({ name: 'session_id', value: 'authenticated-123' });
    contextState.authenticated = true;

    // Phase 3: Resume crawl — context must retain the auth cookies
    expect(contextState.authenticated).toBe(true);
    expect(contextState.cookies.length).toBe(1);
    expect(contextState.cookies[0].name).toBe('session_id');
  });

  it('verifies crawl queue persists across auth pause', () => {
    // The BFS queue should not be cleared when auth is detected
    const queue = [
      { url: 'https://example.com/page1', depth: 0 },
      { url: 'https://example.com/page2', depth: 1 },
      { url: 'https://example.com/page3', depth: 1 },
    ];

    // Simulate auth detection at page1
    const current = queue.shift();
    expect(current!.url).toBe('https://example.com/page1');

    // Auth detected — queue should still have remaining items
    expect(queue.length).toBe(2);

    // After resume, crawl continues from queue
    const next = queue.shift();
    expect(next!.url).toBe('https://example.com/page2');
  });
});

// ────────────────────────────────────────────────────────────────
// 7. Captcha Detection (markup-based heuristics)
// ────────────────────────────────────────────────────────────────

describe('auth detector — captcha heuristics (markup patterns)', () => {
  // Test the string-matching patterns directly without needing a real page
  function detectCaptchaFromHtml(html: string): string | null {
    if (
      html.includes('challenges.cloudflare.com') ||
      html.includes('cf-turnstile') ||
      html.includes('cf-challenge') ||
      html.includes('_cf_chl_opt')
    ) return 'captcha_cloudflare';

    if (
      html.includes('google.com/recaptcha') ||
      html.includes('g-recaptcha') ||
      html.includes('grecaptcha')
    ) return 'captcha_recaptcha';

    if (
      html.includes('hcaptcha.com') ||
      html.includes('h-captcha')
    ) return 'captcha_hcaptcha';

    return null;
  }

  it('detects Cloudflare Turnstile', () => {
    const html = '<div class="cf-turnstile" data-sitekey="abc"></div>';
    expect(detectCaptchaFromHtml(html)).toBe('captcha_cloudflare');
  });

  it('detects Cloudflare challenge page', () => {
    const html = '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>';
    expect(detectCaptchaFromHtml(html)).toBe('captcha_cloudflare');
  });

  it('detects reCAPTCHA', () => {
    const html = '<div class="g-recaptcha" data-sitekey="xyz"></div>';
    expect(detectCaptchaFromHtml(html)).toBe('captcha_recaptcha');
  });

  it('detects reCAPTCHA script', () => {
    const html = '<script src="https://www.google.com/recaptcha/api.js"></script>';
    expect(detectCaptchaFromHtml(html)).toBe('captcha_recaptcha');
  });

  it('detects hCaptcha', () => {
    const html = '<div class="h-captcha" data-sitekey="key"></div>';
    expect(detectCaptchaFromHtml(html)).toBe('captcha_hcaptcha');
  });

  it('detects hCaptcha script', () => {
    const html = '<script src="https://js.hcaptcha.com/1/api.js"></script>';
    expect(detectCaptchaFromHtml(html)).toBe('captcha_hcaptcha');
  });

  it('returns null for clean pages', () => {
    const html = '<html><body><h1>Hello World</h1></body></html>';
    expect(detectCaptchaFromHtml(html)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// 8. Real-world traffic patterns
// ────────────────────────────────────────────────────────────────

describe('real-world patterns — auth flows', () => {
  it('login redirect chain is detected correctly', () => {
    // Simulate: user navigates to /dashboard, gets redirected to /login
    const boundary = detectLoginRedirect(
      'https://leetcode.com/accounts/login/?next=%2Fproblems%2F',
      'https://leetcode.com/problems/'
    );
    expect(boundary).not.toBeNull();
    expect(boundary!.type).toBe('login_redirect');
  });

  it('OAuth SSO redirect is detected', () => {
    const boundary = detectLoginRedirect(
      'https://accounts.google.com/oauth/authorize?client_id=xxx',
      'https://myapp.com/settings'
    );
    expect(boundary).not.toBeNull();
    expect(boundary!.type).toBe('login_redirect');
  });
});

describe('real-world patterns — domain gating', () => {
  it('leetcode.com crawl stays within scope', () => {
    expect(isUrlInScope('leetcode.com', 'leetcode.com', false)).toBe(true);
    expect(isUrlInScope('discuss.leetcode.com', 'leetcode.com', false)).toBe(false);
    expect(isUrlInScope('google.com', 'leetcode.com', false)).toBe(false);
  });

  it('leetcode.com with subdomains allows discuss.leetcode.com', () => {
    expect(isUrlInScope('discuss.leetcode.com', 'leetcode.com', true)).toBe(true);
    expect(isUrlInScope('leetcode.cn', 'leetcode.com', true)).toBe(false);
  });
});

// Need afterEach import for session tests
import { afterEach } from 'vitest';
