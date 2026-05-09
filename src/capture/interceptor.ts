/**
 * Refactored capture interceptor (Phase 1.1).
 * 
 * Uses Playwright's non-blocking page.on('request')/page.on('response') event pair.
 * Captures headers + body without modifying the request flow.
 * Content-addressed IDs prevent duplicate rows on re-runs.
 */

import { Page, Response } from 'playwright';
import chalk from 'chalk';
import { insertRequest } from '../db/requests';
import { upsertEndpoint, linkRequestToEndpoint } from '../db/endpoints';
import { foldPath } from '../schema/path-folder';

/** Resource types we care about */
const API_RESOURCE_TYPES = new Set(['xhr', 'fetch']);

/** Known noise domains to skip */
const NOISE_PATTERNS = [
  'google-analytics.com',
  'googletagmanager.com',
  'facebook.com/tr',
  'doubleclick.net',
  'hotjar.com',
  'segment.io',
  'sentry.io',
  'cdn.amplitude.com',
  'mixpanel.com',
];

/** Static asset extensions to skip */
const ASSET_REGEX = /\.(png|jpg|jpeg|gif|webp|css|woff2?|woff|ttf|eot|js|ico|svg|map)$/i;

/**
 * Check if a response is an API call we should capture.
 */
function isApiRequest(url: string, resourceType: string): boolean {
  // Only capture fetch/XHR
  if (!API_RESOURCE_TYPES.has(resourceType)) return false;

  // Skip known noise domains
  if (NOISE_PATTERNS.some(p => url.includes(p))) return false;

  // Skip static assets
  if (ASSET_REGEX.test(url)) return false;

  return true;
}

/**
 * Safely read response body. Can throw on binary/streaming responses — returns null on failure.
 * Caps body read at 500KB to prevent memory issues.
 */
async function safeBody(response: Response): Promise<string | null> {
  try {
    const contentType = response.headers()['content-type'] || '';

    // Only attempt to read JSON or text responses
    if (!contentType.includes('application/json') && !contentType.includes('text/')) {
      return null;
    }

    const buffer = await response.body();

    // Cap at 500KB
    if (buffer.length > 512 * 1024) {
      return buffer.slice(0, 512 * 1024).toString('utf-8');
    }

    return buffer.toString('utf-8');
  } catch {
    return null;
  }
}

/**
 * Parse a string body into JSON if possible.
 */
function tryParseJson(str: string | null): any {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

export interface InterceptorOptions {
  /** Session ID for this capture run */
  sessionId: string;
  /** If true, suppress console output */
  quiet?: boolean;
  /** Callback invoked on each captured request */
  onCapture?: (info: CapturedRequest) => void;
}

export interface CapturedRequest {
  requestId: string;
  endpointId: string;
  method: string;
  url: string;
  pathTemplate: string;
  status: number;
}

/**
 * Attach the passive network interceptor to a Playwright page.
 * Non-blocking — uses event listeners, not route interception.
 */
export function attachInterceptor(page: Page, options: InterceptorOptions): void {
  const { sessionId, quiet = false, onCapture } = options;

  // Cache requests so we can correlate with responses
  const requestTimestamps = new Map<string, number>();

  page.on('request', (req) => {
    requestTimestamps.set(req.url() + req.method(), Date.now());
  });

  page.on('response', async (response: Response) => {
    const request = response.request();
    const method = request.method();
    const url = request.url();
    const resourceType = request.resourceType();

    // Filter: OPTIONS, non-API, noise
    if (method === 'OPTIONS') return;
    if (!isApiRequest(url, resourceType)) return;

    try {
      const status = response.status();
      const reqHeaders = request.headers();
      const resHeaders = response.headers();

      // Read bodies safely
      const postData = request.postData();
      const reqBody = tryParseJson(postData);
      const resBodyStr = await safeBody(response);
      const resBody = tryParseJson(resBodyStr);

      // Calculate response time
      const startTime = requestTimestamps.get(url + method);
      const responseTime = startTime ? Date.now() - startTime : null;
      requestTimestamps.delete(url + method);

      // Parse URL parts
      let parsedPath = '/';
      let queryRaw: string | null = null;
      let baseUrl = '';
      try {
        const parsed = new URL(url);
        parsedPath = parsed.pathname;
        queryRaw = parsed.search || null;
        baseUrl = `${parsed.protocol}//${parsed.host}`;
      } catch {}

      // Fold path into template
      const pathTemplate = foldPath(parsedPath);

      // Insert into requests table (content-addressed dedup)
      const requestId = insertRequest({
        session_id: sessionId,
        method,
        url,
        path: parsedPath,
        query_raw: queryRaw,
        request_headers: reqHeaders,
        request_body: reqBody,
        response_status: status,
        response_headers: resHeaders,
        response_body: resBody,
        response_time_ms: responseTime,
        source: resourceType,
      });

      // Upsert endpoint (deduplicated by method + template + base_url)
      const endpointId = upsertEndpoint(method, pathTemplate, baseUrl);

      // Link request → endpoint
      linkRequestToEndpoint(requestId, endpointId);

      // Console output
      if (!quiet) {
        const statusColor = status >= 400 ? chalk.red : chalk.green;
        console.log(
          `${chalk.cyan(`[${method}]`)} ${statusColor(status)} ${chalk.gray(`${responseTime ?? '?'}ms`)} ${url}`
        );
      }

      // Callback
      if (onCapture) {
        onCapture({ requestId, endpointId, method, url, pathTemplate, status });
      }
    } catch (err) {
      if (!quiet) {
        console.error(chalk.red('[Interceptor Error]'), err);
      }
    }
  });
}
