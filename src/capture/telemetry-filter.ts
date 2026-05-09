/**
 * Telemetry and noise filtering helpers.
 */

export interface FilterOptions {
  allowSameOrigin?: boolean;
  allowPathPrefixes?: string[];
}

const NOISE_DOMAINS = [
  'google-analytics.com',
  'googletagmanager.com',
  'facebook.com/tr',
  'doubleclick.net',
  'hotjar.com',
  'segment.io',
  'sentry.io',
  'cdn.amplitude.com',
  'mixpanel.com',
  'logrocket',
  'lr-ingest',
  'datadoghq',
  'newrelic',
  'fullstory',
  'clarity.ms',
  'launchdarkly',
  'posthog',
  'intercom',
  'rudderstack',
  'bugsnag',
  'heapanalytics',
  'statsig',
  'snowplowanalytics',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdnjs.cloudflare.com',
  'unpkg.com',
  'cdn.jsdelivr.net',
];

const NOISE_PATH_PATTERNS = [
  '/analytics',
  '/telemetry',
  '/metrics',
  '/events',
  '/track',
  '/collect',
  '/monitoring',
  '/session-replay',
];

function matchesNoiseDomain(url: string): boolean {
  return NOISE_DOMAINS.some(domain => url.includes(domain));
}

function matchesNoisePath(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return NOISE_PATH_PATTERNS.some(p => path.includes(p));
  } catch {
    return false;
  }
}

function isAllowedByPrefix(url: string, prefixes: string[]): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return prefixes.some(p => path.startsWith(p.toLowerCase()));
  } catch {
    return false;
  }
}

export function shouldDropTelemetry(url: string, options?: FilterOptions, origin?: string): { drop: boolean; reason?: string } {
  if (matchesNoiseDomain(url)) return { drop: true, reason: 'noise_domain' };
  if (matchesNoisePath(url)) return { drop: true, reason: 'noise_path' };

  if (options?.allowSameOrigin && origin) {
    try {
      const parsed = new URL(url);
      const originUrl = new URL(origin);
      if (parsed.origin !== originUrl.origin) {
        return { drop: true, reason: 'allow_same_origin' };
      }
    } catch {
      return { drop: true, reason: 'allow_same_origin' };
    }
  }

  if (options?.allowPathPrefixes && options.allowPathPrefixes.length > 0) {
    if (!isAllowedByPrefix(url, options.allowPathPrefixes)) {
      return { drop: true, reason: 'allow_path_prefix' };
    }
  }

  return { drop: false };
}
