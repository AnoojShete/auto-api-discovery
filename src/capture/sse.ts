/**
 * Server-Sent Events (SSE) capture (Phase 2 — L2.3).
 *
 * SSE responses have Content-Type: text/event-stream.
 * Playwright's response.body() blocks on streaming responses,
 * so we cap capture at MAX_SSE_BYTES or MAX_SSE_MS, whichever
 * comes first, then flush what was collected.
 *
 * Each SSE stream is stored as one row in sse_streams;
 * individual parsed events go into sse_events.
 */

import { Page, Response } from 'playwright';
import { randomUUID } from 'crypto';
import chalk from 'chalk';
import { getDb } from '../db/schema';
import { logEvent } from '../observability/logger';

// ────────────────────────────────────────────────────────────────
// Limits
// ────────────────────────────────────────────────────────────────

const MAX_SSE_BYTES = 1024 * 1024;    // 1 MB
const MAX_SSE_MS   = 60_000;          // 60 seconds

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface SseStreamRecord {
  id: string;
  session_id: string;
  url: string;
  started_at: number;
  ended_at: number | null;
  event_count: number;
  byte_count: number;
  truncated: number;
}

export interface SseEventRecord {
  id: string;
  stream_id: string;
  captured_at: number;
  event_type: string | null;
  data: string;
  event_id: string | null;
}

export interface SseCaptureOptions {
  sessionId: string;
  quiet?: boolean;
}

// ────────────────────────────────────────────────────────────────
// SSE Text Protocol Parser
// ────────────────────────────────────────────────────────────────

interface ParsedSseEvent {
  type: string | null;
  data: string;
  id: string | null;
}

/**
 * Parse raw SSE text into individual events.
 * Events are separated by blank lines (\n\n).
 */
function parseSseText(raw: string): ParsedSseEvent[] {
  const events: ParsedSseEvent[] = [];
  const blocks = raw.split(/\n\n+/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    let eventType: string | null = null;
    let dataLines: string[] = [];
    let eventId: string | null = null;

    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      } else if (line.startsWith('id:')) {
        eventId = line.slice(3).trim();
      }
      // Lines starting with ':' are comments — skip
    }

    if (dataLines.length > 0) {
      events.push({
        type: eventType,
        data: dataLines.join('\n'),
        id: eventId,
      });
    }
  }

  return events;
}

// ────────────────────────────────────────────────────────────────
// Core capture
// ────────────────────────────────────────────────────────────────

/**
 * Attach SSE capture to a Playwright page.
 * Listens for responses with Content-Type: text/event-stream,
 * reads the body with a timeout cap, then parses and stores events.
 */
export function attachSseCapture(page: Page, options: SseCaptureOptions): void {
  const { sessionId, quiet = false } = options;

  page.on('response', async (response: Response) => {
    const contentType = response.headers()['content-type'] || '';
    if (!contentType.includes('text/event-stream')) return;

    const url = response.url();
    const streamId = randomUUID();
    const startedAt = Date.now();

    if (!quiet) {
      console.log(chalk.yellow(`[SSE] Stream opened: ${url}`));
    }
    logEvent('sse.open', { stream_id: streamId, url });

    // Create stream row
    const db = getDb();
    try {
      db.prepare(`
        INSERT INTO sse_streams (
          id, session_id, url, started_at, event_count, byte_count, truncated
        ) VALUES (?, ?, ?, ?, 0, 0, 0)
      `).run(streamId, sessionId, url, startedAt);
    } catch { /* best-effort */ }

    // Read the body with a timeout race
    let rawText = '';
    let truncated = false;

    try {
      const bodyPromise = response.body().then(buf => buf.toString('utf-8'));
      const timeoutPromise = new Promise<null>(resolve =>
        setTimeout(() => resolve(null), MAX_SSE_MS)
      );

      const result = await Promise.race([bodyPromise, timeoutPromise]);

      if (result === null) {
        // Timeout — we can't abort Playwright's body read, but we move on
        truncated = true;
        logEvent('sse.timeout', { stream_id: streamId, url, max_ms: MAX_SSE_MS });
      } else {
        rawText = result;
        if (Buffer.byteLength(rawText, 'utf-8') > MAX_SSE_BYTES) {
          rawText = rawText.slice(0, MAX_SSE_BYTES);
          truncated = true;
          logEvent('sse.truncated', { stream_id: streamId, url, max_bytes: MAX_SSE_BYTES });
        }
      }
    } catch {
      // Body read failed (e.g. page navigated away)
      logEvent('sse.read_error', { stream_id: streamId, url }, 'warn');
    }

    // Parse and store events
    const events = parseSseText(rawText);
    const byteCount = Buffer.byteLength(rawText, 'utf-8');
    const endedAt = Date.now();

    const insertEvent = db.prepare(`
      INSERT INTO sse_events (id, stream_id, captured_at, event_type, data, event_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const evt of events) {
      try {
        insertEvent.run(
          randomUUID(),
          streamId,
          Date.now(),
          evt.type,
          evt.data,
          evt.id,
        );
      } catch { /* best-effort */ }
    }

    // Update stream row
    try {
      db.prepare(`
        UPDATE sse_streams
        SET ended_at = ?, event_count = ?, byte_count = ?, truncated = ?
        WHERE id = ?
      `).run(endedAt, events.length, byteCount, truncated ? 1 : 0, streamId);
    } catch { /* best-effort */ }

    if (!quiet) {
      console.log(chalk.yellow(
        `[SSE] Stream closed: ${events.length} events, ${byteCount}B${truncated ? ' (truncated)' : ''}`
      ));
    }

    logEvent('sse.close', {
      stream_id: streamId,
      url,
      event_count: events.length,
      byte_count: byteCount,
      truncated,
    });
  });
}

// ────────────────────────────────────────────────────────────────
// Query helpers
// ────────────────────────────────────────────────────────────────

export function getSseStreams(sessionId?: string): SseStreamRecord[] {
  const db = getDb();
  if (sessionId) {
    return db.prepare('SELECT * FROM sse_streams WHERE session_id = ? ORDER BY started_at DESC').all(sessionId) as SseStreamRecord[];
  }
  return db.prepare('SELECT * FROM sse_streams ORDER BY started_at DESC').all() as SseStreamRecord[];
}

export function getSseEvents(streamId: string): SseEventRecord[] {
  const db = getDb();
  return db.prepare('SELECT * FROM sse_events WHERE stream_id = ? ORDER BY captured_at').all(streamId) as SseEventRecord[];
}

export function getSseStreamCount(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as c FROM sse_streams').get() as any;
  return row?.c ?? 0;
}

export function getSseEventCount(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as c FROM sse_events').get() as any;
  return row?.c ?? 0;
}
