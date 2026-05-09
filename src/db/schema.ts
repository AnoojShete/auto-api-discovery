/**
 * Database schema definition and migration system for ApiGen.
 * All discovery state lives in a single SQLite file (.apigen/db.sqlite).
 * 
 * Tables:
 *   requests        — Raw network observations
 *   endpoints       — Deduplicated endpoints (folded paths, normalized)
 *   schemas         — Schema snapshots per endpoint
 *   gql_operations  — GraphQL operations
 *   bundle_findings — Static analysis results
 *   sessions        — Session / auth state
 *   corrections     — Human corrections from L7
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

let _db: Database.Database | null = null;

/** Resolve the .apigen directory and ensure it exists */
export function getApigenDir(): string {
  const dir = path.resolve(process.cwd(), '.apigen');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Get or create the shared database instance */
export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = path.join(getApigenDir(), 'db.sqlite');
  _db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  _db.pragma('journal_mode = WAL');
  // Foreign keys enforcement
  _db.pragma('foreign_keys = ON');

  runMigrations(_db);
  return _db;
}

/** Close the database connection (for clean shutdown) */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** Apply all schema migrations in order */
function runMigrations(db: Database.Database): void {
  // Migration tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id    INTEGER PRIMARY KEY,
      name  TEXT NOT NULL,
      applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    )
  `);

  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map((r: any) => r.name)
  );

  for (const migration of MIGRATIONS) {
    if (!applied.has(migration.name)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(migration.name);
    }
  }
}

/** Ordered list of migrations */
const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: '001_initial_schema',
    sql: `
      -- Raw network observations
      CREATE TABLE IF NOT EXISTS requests (
        id               TEXT PRIMARY KEY,
        session_id       TEXT NOT NULL,
        captured_at      INTEGER NOT NULL,
        method           TEXT NOT NULL,
        url              TEXT NOT NULL,
        path             TEXT NOT NULL,
        query_raw        TEXT,
        request_headers  TEXT,
        request_body     TEXT,
        response_status  INTEGER,
        response_headers TEXT,
        response_body    TEXT,
        response_time_ms INTEGER,
        source           TEXT DEFAULT 'fetch'
      );

      CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id);
      CREATE INDEX IF NOT EXISTS idx_requests_path    ON requests(path);
      CREATE INDEX IF NOT EXISTS idx_requests_method  ON requests(method);

      -- Deduplicated endpoints (folded paths, normalized)
      CREATE TABLE IF NOT EXISTS endpoints (
        id             TEXT PRIMARY KEY,
        method         TEXT NOT NULL,
        path_template  TEXT NOT NULL,
        base_url       TEXT NOT NULL,
        tag            TEXT,
        status         TEXT DEFAULT 'unreviewed',
        deprecated     INTEGER DEFAULT 0,
        first_seen_at  INTEGER NOT NULL,
        last_seen_at   INTEGER NOT NULL,
        observation_count INTEGER DEFAULT 1,
        UNIQUE(method, path_template, base_url)
      );

      -- Schema snapshots per endpoint
      CREATE TABLE IF NOT EXISTS schemas (
        id            TEXT PRIMARY KEY,
        endpoint_id   TEXT REFERENCES endpoints(id),
        direction     TEXT NOT NULL,
        status_code   INTEGER,
        content_type  TEXT,
        schema_json   TEXT NOT NULL,
        sample_count  INTEGER DEFAULT 1,
        merged        INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_schemas_endpoint ON schemas(endpoint_id);

      -- GraphQL operations
      CREATE TABLE IF NOT EXISTS gql_operations (
        id              TEXT PRIMARY KEY,
        session_id      TEXT,
        operation_type  TEXT,
        operation_name  TEXT,
        document        TEXT NOT NULL,
        variables       TEXT,
        source          TEXT DEFAULT 'network'
      );

      -- Static analysis results
      CREATE TABLE IF NOT EXISTS bundle_findings (
        id          TEXT PRIMARY KEY,
        bundle_url  TEXT,
        kind        TEXT,
        value       TEXT NOT NULL,
        confidence  REAL,
        context     TEXT
      );

      -- Session / auth state
      CREATE TABLE IF NOT EXISTS sessions (
        id             TEXT PRIMARY KEY,
        created_at     INTEGER NOT NULL,
        cookies        TEXT,
        local_storage  TEXT,
        label          TEXT
      );

      -- Human corrections from L7
      CREATE TABLE IF NOT EXISTS corrections (
        id            TEXT PRIMARY KEY,
        target_type   TEXT,
        target_id     TEXT,
        field         TEXT,
        old_value     TEXT,
        new_value     TEXT NOT NULL,
        corrected_at  INTEGER NOT NULL
      );

      -- Link requests to their discovered endpoint
      CREATE TABLE IF NOT EXISTS request_endpoint_map (
        request_id   TEXT REFERENCES requests(id),
        endpoint_id  TEXT REFERENCES endpoints(id),
        PRIMARY KEY (request_id, endpoint_id)
      );
    `,
  },
  {
    name: '002_observability_and_storage',
    sql: `
      ALTER TABLE requests ADD COLUMN request_body_path TEXT;
      ALTER TABLE requests ADD COLUMN response_body_path TEXT;
      ALTER TABLE requests ADD COLUMN request_body_size INTEGER;
      ALTER TABLE requests ADD COLUMN response_body_size INTEGER;
      ALTER TABLE requests ADD COLUMN trace_id TEXT;

      ALTER TABLE endpoints ADD COLUMN provenance TEXT DEFAULT 'network';
      UPDATE endpoints SET provenance = 'network' WHERE provenance IS NULL;

      CREATE TABLE IF NOT EXISTS telemetry_drops (
        id           TEXT PRIMARY KEY,
        captured_at  INTEGER NOT NULL,
        url          TEXT NOT NULL,
        reason       TEXT
      );

      CREATE TABLE IF NOT EXISTS parser_diagnostics (
        id           TEXT PRIMARY KEY,
        captured_at  INTEGER NOT NULL,
        kind         TEXT NOT NULL,
        url          TEXT,
        message      TEXT
      );

      CREATE TABLE IF NOT EXISTS replay_events (
        id           TEXT PRIMARY KEY,
        captured_at  INTEGER NOT NULL,
        request_id   TEXT,
        success      INTEGER NOT NULL,
        status_code  INTEGER
      );
    `,
  },
];
