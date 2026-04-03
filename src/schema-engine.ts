import { EndpointData } from './db';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;
const INTEGER_REGEX = /^\d+$/;

function isDynamicToken(token: string): boolean {
  if (UUID_REGEX.test(token)) return true;
  if (OBJECT_ID_REGEX.test(token)) return true;
  if (INTEGER_REGEX.test(token)) return true;
  return false;
}

export function foldUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    let paramCounter = 1;
    const foldedParts = parts.map(part => {
      if (isDynamicToken(part)) {
        return `{param${paramCounter++}}`;
      }
      return part;
    });
    return `/${foldedParts.join('/')}`;
  } catch {
    return url;
  }
}

export function inferSchema(data: any): any {
  if (data === null) return 'null';
  if (typeof data === 'string') return 'string';
  if (typeof data === 'number') return 'number';
  if (typeof data === 'boolean') return 'boolean';

  if (Array.isArray(data)) {
    if (data.length === 0) return ['any'];
    return [inferSchema(data[0])];
  }

  if (typeof data === 'object') {
    const schema: Record<string, any> = {};
    for (const key of Object.keys(data)) {
      schema[key] = inferSchema(data[key]);
    }
    return schema;
  }

  return 'unknown';
}

export interface MapEntry {
  method: string;
  foldedUrl: string;
  responseSchemas: Record<number, any>;
}

export function generateSchemaMap(endpoints: EndpointData[]): Record<string, MapEntry> {
  const map: Record<string, MapEntry> = {};

  for (const ep of endpoints) {
    const foldedUrl = foldUrl(ep.url);
    const key = `${ep.method} ${foldedUrl}`;

    if (!map[key]) {
      map[key] = {
        method: ep.method,
        foldedUrl,
        responseSchemas: {},
      };
    }

    if (ep.response_status === 200 && ep.response_body) {
      let bodyData = ep.response_body;
      if (typeof bodyData === 'string') {
        try {
          bodyData = JSON.parse(bodyData);
        } catch { }
      }

      if (bodyData && typeof bodyData === 'object') {
        const schema = inferSchema(bodyData);
        map[key].responseSchemas[200] = schema;
      }
    }
  }

  return map;
}
