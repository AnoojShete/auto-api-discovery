/**
 * JSON Schema inference engine (Phase 1 / L6 foundation).
 * 
 * Converts observed JSON values into proper JSON Schema fragments.
 * Detects common formats: uuid, date-time, email, uri, ipv4.
 */

/** Format detection patterns */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URI_RE = /^https?:\/\//i;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

export interface JSONSchemaFragment {
  type?: string;
  format?: string;
  nullable?: boolean;
  items?: JSONSchemaFragment;
  properties?: Record<string, JSONSchemaFragment>;
  required?: string[];
  enum?: any[];
  oneOf?: JSONSchemaFragment[];
  description?: string;
}

/**
 * Infer a JSON Schema fragment from an observed value.
 */
export function inferSchema(value: unknown): JSONSchemaFragment {
  if (value === null) {
    return { nullable: true };
  }

  if (typeof value === 'boolean') {
    return { type: 'boolean' };
  }

  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { type: 'integer' }
      : { type: 'number' };
  }

  if (typeof value === 'string') {
    const schema: JSONSchemaFragment = { type: 'string' };

    // Detect common formats
    if (UUID_RE.test(value)) {
      schema.format = 'uuid';
    } else if (ISO_DATE_RE.test(value) && !isNaN(Date.parse(value))) {
      schema.format = value.includes('T') ? 'date-time' : 'date';
    } else if (EMAIL_RE.test(value)) {
      schema.format = 'email';
    } else if (URI_RE.test(value)) {
      schema.format = 'uri';
    } else if (IPV4_RE.test(value)) {
      schema.format = 'ipv4';
    }

    return schema;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { type: 'array', items: {} };
    }

    // Infer schema from all items and merge them
    const itemSchemas = value.map(inferSchema);
    const mergedItems = mergeSchemaList(itemSchemas);

    return { type: 'array', items: mergedItems };
  }

  if (typeof value === 'object' && value !== null) {
    const properties: Record<string, JSONSchemaFragment> = {};
    const keys = Object.keys(value as Record<string, unknown>);

    for (const key of keys) {
      properties[key] = inferSchema((value as Record<string, unknown>)[key]);
    }

    return {
      type: 'object',
      properties,
      required: keys, // All observed keys are required on first observation
    };
  }

  return {};
}

/**
 * Merge two JSON Schema fragments. Used when multiple observations
 * of the same endpoint produce slightly different shapes.
 */
export function mergeSchemas(a: JSONSchemaFragment, b: JSONSchemaFragment): JSONSchemaFragment {
  // If either is empty/unknown, take the other
  if (!a.type && !a.oneOf) return { ...b };
  if (!b.type && !b.oneOf) return { ...a };

  // Same type — merge deeply
  if (a.type === b.type) {
    if (a.type === 'object' && a.properties && b.properties) {
      return mergeObjectSchemas(a, b);
    }

    if (a.type === 'array' && a.items && b.items) {
      return {
        type: 'array',
        items: mergeSchemas(a.items, b.items),
      };
    }

    // Same primitive type — keep format if both agree
    if (a.format === b.format) return { ...a };
    // Different formats on same type — drop format
    return { type: a.type };
  }

  // Different types — emit oneOf
  return {
    oneOf: [a, b],
  };
}

/**
 * Merge two object schemas:
 * - Union all property keys
 * - Required = intersection (field must appear in both to be required)
 * - Recursively merge shared properties
 */
function mergeObjectSchemas(a: JSONSchemaFragment, b: JSONSchemaFragment): JSONSchemaFragment {
  const allKeys = new Set([
    ...Object.keys(a.properties || {}),
    ...Object.keys(b.properties || {}),
  ]);

  const aRequired = new Set(a.required || []);
  const bRequired = new Set(b.required || []);

  const mergedProps: Record<string, JSONSchemaFragment> = {};
  const mergedRequired: string[] = [];

  for (const key of allKeys) {
    const aProp = a.properties?.[key];
    const bProp = b.properties?.[key];

    if (aProp && bProp) {
      mergedProps[key] = mergeSchemas(aProp, bProp);
      // Required only if required in both
      if (aRequired.has(key) && bRequired.has(key)) {
        mergedRequired.push(key);
      }
    } else {
      // Only in one — include but not required
      mergedProps[key] = aProp || bProp!;
    }
  }

  return {
    type: 'object',
    properties: mergedProps,
    ...(mergedRequired.length > 0 ? { required: mergedRequired } : {}),
  };
}

/**
 * Merge a list of schemas into one (used for array items).
 */
function mergeSchemaList(schemas: JSONSchemaFragment[]): JSONSchemaFragment {
  if (schemas.length === 0) return {};
  return schemas.reduce((acc, s) => mergeSchemas(acc, s));
}
