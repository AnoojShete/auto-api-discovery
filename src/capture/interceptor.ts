/**
 * Refactored capture interceptor (Phase 1.1).
 * 
 * Uses Playwright's non-blocking page.on('request')/page.on('response') event pair.
 * Captures headers + body without modifying the request flow.
 * Content-addressed IDs prevent duplicate rows on re-runs.
 */

import { Page, Response } from 'playwright';
import chalk from 'chalk';
import { randomUUID } from 'crypto';
import { insertRequest } from '../db/requests';
import { upsertEndpoint, linkRequestToEndpoint } from '../db/endpoints';
import { foldPath } from '../schema/path-folder';
import { storeTextObject } from '../storage/object-store';
import { logEvent } from '../observability/logger';
import { shouldDropTelemetry, FilterOptions } from './telemetry-filter';
import { recordTelemetryDrop } from '../db/telemetry';
import { recordParseDiagnostic } from '../db/diagnostics';
import { isGraphQLRequest, extractGqlOperation, upsertGqlOperation } from './graphql';

/** Resource types we care about */
const API_RESOURCE_TYPES = new Set(['xhr', 'fetch']);

/** Static asset extensions to skip */
const ASSET_REGEX = /\.(png|jpg|jpeg|gif|webp|css|woff2?|woff|ttf|eot|js|ico|svg|map)$/i;

const BODY_STORE_THRESHOLD_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Check if a response is an API call we should capture.
 */
function isApiRequest(url: string, resourceType: string): boolean {
  // Only capture fetch/XHR
  if (!API_RESOURCE_TYPES.has(resourceType)) return false;

  // Skip static assets
  if (ASSET_REGEX.test(url)) return false;

  return true;
}

/**
 * Safely read response body. Can throw on binary/streaming responses — returns null on failure.
 * Caps body read at 500KB to prevent memory issues.
 */
/** Check if a content-type header represents a JSON-like payload */
function isJsonLikeContentType(contentType: string): boolean {
  if (contentType.includes('application/json')) return true;
  if (contentType.includes('application/graphql+json')) return true;
  if (contentType.includes('application/problem+json')) return true;
  if (contentType.includes('application/ld+json')) return true;
  if (contentType.includes('text/')) return true;
  // Catch any vendor/custom +json suffix (e.g. application/vnd.api+json)
  if (/\+json/i.test(contentType)) return true;
  return false;
}

async function safeBody(response: Response): Promise<{ text: string | null; size: number; truncated: boolean }> {
  try {
    const contentType = response.headers()['content-type'] || '';

    // Only attempt to read JSON-like or text responses
    if (!isJsonLikeContentType(contentType)) {
      return { text: null, size: 0, truncated: false };
    }

    const buffer = await response.body();
    const truncated = buffer.length > MAX_BODY_BYTES;
    const safeBuffer = truncated ? buffer.slice(0, MAX_BODY_BYTES) : buffer;
    return { text: safeBuffer.toString('utf-8'), size: buffer.length, truncated };
  } catch {
    return { text: null, size: 0, truncated: false };
  }
}

/**
 * Parse a string body into JSON if possible.
 */
function tryParseJson(str: string | null, kind: 'request_body' | 'response_body', url: string): any {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch (err: any) {
    recordParseDiagnostic(kind, url, err?.message || 'json_parse_failed');
    return str;
  }
}

function getFilterOptions(): FilterOptions {
  const allowSameOrigin = process.env.APIGEN_ALLOW_SAME_ORIGIN === '1';
  const allowPathsRaw = process.env.APIGEN_ALLOW_PATH_PREFIXES || '';
  const allowPathPrefixes = allowPathsRaw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return { allowSameOrigin, allowPathPrefixes };
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
  // postData is cached eagerly here to prevent race conditions where
  // fast responses arrive before postData() can be read
  const requestTimestamps = new Map<string, { start: number; traceId: string; postData: string | null }>();
  const filterOptions = getFilterOptions();

  page.on('request', (req) => {
    const traceId = randomUUID();
    // Eagerly capture postData in the request event — by the time the response
    // fires, the request object's postData() may have already been GC'd or
    // the underlying frame may be gone for fast requests.
    let postDataEarly: string | null = null;
    try {
      postDataEarly = req.postData() || null;
    } catch {}
    requestTimestamps.set(req.url() + req.method(), { start: Date.now(), traceId, postData: postDataEarly });
    logEvent('request.start', {
      trace_id: traceId,
      method: req.method(),
      url: req.url(),
    });
  });

  page.on('response', async (response: Response) => {
    const request = response.request();
    const method = request.method();
    const url = request.url();
    const resourceType = request.resourceType();

    // Filter: OPTIONS, non-API, noise
    if (method === 'OPTIONS') return;
    if (!isApiRequest(url, resourceType)) return;

    const origin = request.frame()?.url() || undefined;
    const telemetryDecision = shouldDropTelemetry(url, filterOptions, origin);
    if (telemetryDecision.drop) {
      recordTelemetryDrop(url, telemetryDecision.reason);
      logEvent('telemetry.drop', { url, reason: telemetryDecision.reason });
      return;
    }

    try {
      const status = response.status();
      const reqHeaders = request.headers();
      const resHeaders = response.headers();

      // Read bodies safely — prefer the eagerly cached postData from the request event
      const traceInfo = requestTimestamps.get(url + method);
      const postData = traceInfo?.postData ?? request.postData() ?? null;
      const reqBody = tryParseJson(postData, 'request_body', url);
      const resBodyResult = await safeBody(response);
      if (resBodyResult.truncated) {
        logEvent('body.truncated', { url, size: resBodyResult.size, max_bytes: MAX_BODY_BYTES });
      }
      const resBody = tryParseJson(resBodyResult.text, 'response_body', url);

      // Calculate response time (traceInfo already read above)
      const responseTime = traceInfo ? Date.now() - traceInfo.start : null;
      const traceId = traceInfo?.traceId ?? randomUUID();
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
      const requestBodySize = postData ? Buffer.byteLength(postData, 'utf-8') : null;
      const responseBodySize = resBodyResult.size || null;
      let requestBodyPath: string | null = null;
      let responseBodyPath: string | null = null;

      if (postData && requestBodySize !== null && requestBodySize > BODY_STORE_THRESHOLD_BYTES) {
        const stored = storeTextObject('req', postData);
        requestBodyPath = stored.path;
      }

      if (resBodyResult.text && responseBodySize !== null && responseBodySize > BODY_STORE_THRESHOLD_BYTES) {
        const stored = storeTextObject('res', resBodyResult.text);
        responseBodyPath = stored.path;
      }

      const requestId = insertRequest({
        session_id: sessionId,
        method,
        url,
        path: parsedPath,
        query_raw: queryRaw,
        request_headers: reqHeaders,
        request_body: requestBodyPath ? null : reqBody,
        request_body_path: requestBodyPath,
        request_body_size: requestBodySize,
        response_status: status,
        response_headers: resHeaders,
        response_body: responseBodyPath ? null : resBody,
        response_body_path: responseBodyPath,
        response_body_size: responseBodySize,
        response_time_ms: responseTime,
        source: resourceType,
        trace_id: traceId,
      });

      // Upsert endpoint (deduplicated by method + template + base_url)
      const endpointId = upsertEndpoint(method, pathTemplate, baseUrl, 'network');

      // Link request → endpoint
      linkRequestToEndpoint(requestId, endpointId);

      // GraphQL detection: index operations in gql_operations table
      if (reqBody && typeof reqBody === 'object' && isGraphQLRequest(parsedPath, reqBody)) {
        const gqlOps = extractGqlOperation(reqBody, url);
        for (const op of gqlOps) {
          upsertGqlOperation(op, sessionId, url, 'network');
        }
      }

      // Console output
      if (!quiet) {
        const statusColor = status >= 400 ? chalk.red : chalk.green;
        console.log(
          `${chalk.cyan(`[${method}]`)} ${statusColor(status)} ${chalk.gray(`${responseTime ?? '?'}ms`)} ${url}`
        );
      }

      logEvent('request.response', {
        trace_id: traceId,
        method,
        url,
        status,
        response_time_ms: responseTime,
        request_body_size: requestBodySize,
        response_body_size: responseBodySize,
      });

      // Callback
      if (onCapture) {
        onCapture({ requestId, endpointId, method, url, pathTemplate, status });
      }
    } catch (err) {
      if (!quiet) {
        console.error(chalk.red('[Interceptor Error]'), err);
      }
      logEvent('request.error', { message: (err as any)?.message || 'unknown_error' }, 'error');
    }
  });
}
