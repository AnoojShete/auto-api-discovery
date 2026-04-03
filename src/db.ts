import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.resolve(process.cwd(), 'apigen.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS endpoints (
    id TEXT PRIMARY KEY,
    method TEXT NOT NULL,
    url TEXT NOT NULL,
    path_pattern TEXT NOT NULL,
    request_headers TEXT,
    request_body TEXT,
    response_status INTEGER,
    response_body TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

export interface EndpointData {
  id: string;
  method: string;
  url: string;
  path_pattern: string;
  request_headers: Record<string, string>;
  request_body: any;
  response_status: number;
  response_body: any;
}

const insertStmt = db.prepare(`
  INSERT INTO endpoints (
    id, method, url, path_pattern, request_headers, request_body, response_status, response_body
  ) VALUES (
    @id, @method, @url, @path_pattern, @request_headers, @request_body, @response_status, @response_body
  )
`);

export function insertEndpoint(data: EndpointData) {
  try {
    insertStmt.run({
      id: data.id,
      method: data.method,
      url: data.url,
      path_pattern: data.path_pattern,
      request_headers: JSON.stringify(data.request_headers),
      request_body: data.request_body ? JSON.stringify(data.request_body) : null,
      response_status: data.response_status,
      response_body: data.response_body ? JSON.stringify(data.response_body) : null,
    });
  } catch (error) {
    console.error('Failed to insert endpoint into database:', error);
  }
}

export function getAllEndpoints(): EndpointData[] {
  try {
    return db.prepare('SELECT * FROM endpoints').all() as EndpointData[];
  } catch (error) {
    console.error('Failed to get endpoints from database:', error);
    return [];
  }
}
