/**
 * Shared minimal-input builder for the smoke validators.
 *
 * Builds a schema-valid input covering only `required` params. Honors
 * JSON-Schema `format` so typed DB columns don't reject the probe value:
 * a uuid column fed the string 'test' throws "invalid input syntax for
 * type uuid" and used to leave the tool permanently un-smokeable.
 *
 * The nil UUID / epoch date are deliberate: valid syntax, guaranteed to
 * match no row, so smoke runs exercise the query path and return empty.
 */

function defaultFor(prop, name = '') {
  const t = Array.isArray(prop.type) ? prop.type[0] : prop.type;
  if (prop.enum && prop.enum.length) return prop.enum[0];
  switch (t) {
    case 'string':
      if (prop.default !== undefined) return prop.default;
      if (prop.format === 'uuid') return '00000000-0000-0000-0000-000000000000';
      if (prop.format === 'date') return '1970-01-01';
      if (prop.format === 'date-time') return '1970-01-01T00:00:00Z';
      // Undeclared id params ("customer_id", "id", "estimate_uuid"): most
      // feed uuid-typed columns where 'test' throws before the query path
      // runs — and the tool's catch turns that into a green-looking
      // { error } object. The nil UUID is safe for text columns too
      // (matches no row). Declaring format:'uuid' is still preferred.
      if (/(^|_)(id|uuid)$/i.test(name)) return '00000000-0000-0000-0000-000000000000';
      return 'test';
    case 'number':
    case 'integer': return prop.default ?? 0;
    case 'boolean': return prop.default ?? false;
    case 'array':   return [];
    case 'object':  return {};
    default:        return null;
  }
}

function buildMinimalInput(schema) {
  if (!schema || typeof schema !== 'object') return {};
  const out = {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const props = schema.properties || {};
  for (const r of required) {
    out[r] = defaultFor(props[r] || {}, r);
  }
  return out;
}

module.exports = { buildMinimalInput, defaultFor };
