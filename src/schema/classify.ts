/**
 * Query parameter semantic classification.
 * 
 * Classifies observed query parameters into semantic categories:
 *   pagination, sorting, filter, field selection, identifier, temporal, boolean
 */

export type ParamClassification =
  | 'pagination'
  | 'sorting'
  | 'filter'
  | 'field_selection'
  | 'identifier'
  | 'temporal'
  | 'boolean'
  | 'unknown';

/** Name-based classification patterns */
const NAME_PATTERNS: [RegExp, ParamClassification][] = [
  // Pagination
  [/^(page|offset|skip|from|start|cursor|after|before)$/i, 'pagination'],
  [/^(limit|per_page|pageSize|page_size|size|count|take|first|last)$/i, 'pagination'],

  // Sorting
  [/^(sort|sort_by|order_by|order|sortBy|orderBy|direction|sort_order)$/i, 'sorting'],

  // Filter
  [/^(q|query|search|filter|keyword|keywords|where|find)$/i, 'filter'],

  // Field selection
  [/^(fields|select|include|exclude|expand|embed|populate|projection)$/i, 'field_selection'],
];

/** UUID pattern for value-based detection */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ISO date/time pattern */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

/**
 * Classify a query parameter by its name and value.
 */
export function classifyParam(name: string, value: string): ParamClassification {
  // Name-based classification (highest priority)
  for (const [pattern, classification] of NAME_PATTERNS) {
    if (pattern.test(name)) return classification;
  }

  // Value-based classification
  if (UUID_RE.test(value)) return 'identifier';
  if (ISO_DATE_RE.test(value) && !isNaN(Date.parse(value))) return 'temporal';
  if (value === 'true' || value === 'false') return 'boolean';

  return 'unknown';
}

/**
 * Classify all query parameters from a raw query string.
 */
export function classifyQueryParams(queryRaw: string): Record<string, ParamClassification> {
  const result: Record<string, ParamClassification> = {};

  const params = new URLSearchParams(queryRaw);
  for (const [name, value] of params) {
    result[name] = classifyParam(name, value);
  }

  return result;
}
