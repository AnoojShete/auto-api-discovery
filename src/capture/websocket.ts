/**
 * WebSocket frame capture (Phase 2 — L2.1).
 *
 * Hooks into Playwright's page.on('websocket') to capture:
 *   - JSON frames → stored as ws_frames with parsed payload
 *   - Binary frames → stored as base64
 *   - Connection lifecycle (open → messages → close) tracked per ws_session
 *
 * GraphQL-over-WebSocket subscriptions are detected and forwarded to
 * the gql_operations store.
 */

import { Page, WebSocket as PwWebSocket } from 'playwright';
import { randomUUID, createHash } from 'crypto';
import chalk from 'chalk';
import { getDb } from '../db/schema';
import { logEvent } from '../observability/logger';
import { extractGqlOperation, upsertGqlOperation } from './graphql';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface WsFrameRecord {
  id: string;
  ws_session_id: string;
  direction: 'sent' | 'received';
  captured_at: number;
  payload_text: string | null;
  payload_binary: string | null;    // base64
  payload_size: number;
  is_json: number;
  message_type: string | null;      // derived from JSON .type field if present
}

export interface WsSessionRecord {
  id: string;
  session_id: string;
  url: string;
  opened_at: number;
  closed_at: number | null;
  frame_count: number;
  status: 'open' | 'closed';
}

export interface WebSocketCaptureOptions {
  /** ApiGen session ID for provenance */
  sessionId: string;
  /** Suppress console output */
  quiet?: boolean;
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function isJson(str: string): boolean {
  const t = str.trimStart();
  return (t.startsWith('{') || t.startsWith('['));
}

/**
 * Detect graphql-ws / subscriptions-transport-ws subscription frames.
 * Both protocols wrap ops in { type: 'subscribe'|'start', payload: { query, ... } }.
 */
function isGqlSubscription(parsed: any): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  const t = (parsed.type || '').toLowerCase();
  return (
    (t === 'subscribe' || t === 'start' || t === 'data' || t === 'next') &&
    parsed.payload &&
    typeof parsed.payload === 'object'
  );
}

// ────────────────────────────────────────────────────────────────
// Core
// ────────────────────────────────────────────────────────────────

/**
 * Attach WebSocket capture hooks to a Playwright page.
 * Call this alongside (or after) attachInterceptor.
 */
export function attachWebSocketCapture(page: Page, options: WebSocketCaptureOptions): void {
  const { sessionId, quiet = false } = options;

  page.on('websocket', (ws: PwWebSocket) => {
    const wsUrl = ws.url();
    const wsSessionId = randomUUID();
    const now = Date.now();

    // Create ws_session row
    const db = getDb();
    try {
      db.prepare(`
        INSERT INTO ws_sessions (id, session_id, url, opened_at, frame_count, status)
        VALUES (?, ?, ?, ?, 0, 'open')
      `).run(wsSessionId, sessionId, wsUrl, now);
    } catch { /* best-effort */ }

    if (!quiet) {
      console.log(chalk.magenta(`[WS] Connected: ${wsUrl}`));
    }
    logEvent('ws.open', { ws_session_id: wsSessionId, url: wsUrl });

    // ── Received frames ──────────────────────────────────────
    ws.on('framereceived', (frame) => {
      handleFrame(frame.payload, 'received', wsSessionId, wsUrl, sessionId, quiet);
    });

    // ── Sent frames ──────────────────────────────────────────
    ws.on('framesent', (frame) => {
      handleFrame(frame.payload, 'sent', wsSessionId, wsUrl, sessionId, quiet);
    });

    // ── Close ────────────────────────────────────────────────
    ws.on('close', () => {
      const closeTime = Date.now();
      try {
        db.prepare(`
          UPDATE ws_sessions SET closed_at = ?, status = 'closed' WHERE id = ?
        `).run(closeTime, wsSessionId);
      } catch { /* best-effort */ }

      if (!quiet) {
        console.log(chalk.magenta(`[WS] Closed: ${wsUrl}`));
      }
      logEvent('ws.close', { ws_session_id: wsSessionId, url: wsUrl });
    });

    // ── Socket error ─────────────────────────────────────────
    ws.on('socketerror', (error) => {
      logEvent('ws.error', { ws_session_id: wsSessionId, error }, 'error');
    });
  });
}

// ────────────────────────────────────────────────────────────────
// Frame handler
// ────────────────────────────────────────────────────────────────

function handleFrame(
  payload: string | Buffer,
  direction: 'sent' | 'received',
  wsSessionId: string,
  wsUrl: string,
  sessionId: string,
  quiet: boolean,
): void {
  const db = getDb();
  const now = Date.now();
  const id = randomUUID();

  let payloadText: string | null = null;
  let payloadBinary: string | null = null;
  let payloadSize = 0;
  let jsonFlag = 0;
  let messageType: string | null = null;

  if (typeof payload === 'string') {
    payloadText = payload;
    payloadSize = Buffer.byteLength(payload, 'utf-8');

    if (isJson(payload)) {
      jsonFlag = 1;
      try {
        const parsed = JSON.parse(payload);
        messageType = parsed.type ?? parsed.event ?? null;

        // ── GraphQL subscription detection ───────────────────
        if (isGqlSubscription(parsed)) {
          const gqlPayload = parsed.payload;
          const gqlOps = extractGqlOperation(gqlPayload, wsUrl);
          for (const op of gqlOps) {
            op.operationType = op.operationType || 'subscription';
            upsertGqlOperation(op, sessionId, wsUrl, 'ws');
          }
        }
      } catch { /* not valid JSON after all */ }
    }
  } else {
    // Binary frame → base64
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    payloadBinary = buf.toString('base64');
    payloadSize = buf.length;
  }

  // Insert frame record
  try {
    db.prepare(`
      INSERT INTO ws_frames (
        id, ws_session_id, direction, captured_at,
        payload_text, payload_binary, payload_size,
        is_json, message_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, wsSessionId, direction, now,
      payloadText, payloadBinary, payloadSize,
      jsonFlag, messageType,
    );

    // Increment frame counter
    db.prepare(`
      UPDATE ws_sessions SET frame_count = frame_count + 1 WHERE id = ?
    `).run(wsSessionId);
  } catch { /* best-effort */ }

  if (!quiet) {
    const arrow = direction === 'sent' ? '→' : '←';
    const preview = payloadText
      ? payloadText.slice(0, 80) + (payloadText.length > 80 ? '…' : '')
      : `[binary ${payloadSize}B]`;
    console.log(chalk.magenta(`[WS ${arrow}] ${preview}`));
  }

  logEvent('ws.frame', {
    ws_session_id: wsSessionId,
    direction,
    size: payloadSize,
    is_json: jsonFlag === 1,
    message_type: messageType,
  });
}

// ────────────────────────────────────────────────────────────────
// Query helpers
// ────────────────────────────────────────────────────────────────

/** Get all WebSocket sessions */
export function getWsSessions(sessionId?: string): WsSessionRecord[] {
  const db = getDb();
  if (sessionId) {
    return db.prepare('SELECT * FROM ws_sessions WHERE session_id = ? ORDER BY opened_at DESC').all(sessionId) as WsSessionRecord[];
  }
  return db.prepare('SELECT * FROM ws_sessions ORDER BY opened_at DESC').all() as WsSessionRecord[];
}

/** Get frames for a WebSocket session */
export function getWsFrames(wsSessionId: string): WsFrameRecord[] {
  const db = getDb();
  return db.prepare('SELECT * FROM ws_frames WHERE ws_session_id = ? ORDER BY captured_at').all(wsSessionId) as WsFrameRecord[];
}

/** Total WebSocket session count */
export function getWsSessionCount(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as c FROM ws_sessions').get() as any;
  return row?.c ?? 0;
}

/** Total WebSocket frame count */
export function getWsFrameCount(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as c FROM ws_frames').get() as any;
  return row?.c ?? 0;
}
