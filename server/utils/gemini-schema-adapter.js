/**
 * Adapts a canonical JSON Schema for use as Gemini's response_schema.
 *
 * Policy: JSON-Schema-first. We preserve as much of the canonical schema
 * as Gemini accepts. Only strip fields that the current API actually rejects.
 *
 * Current Gemini 2.5 docs say response_schema accepts JSON Schema with:
 *   - type: ["string", "null"]  for nullable  (preserved)
 *   - additionalProperties       for objects   (preserved)
 *   - format keywords             (kept but not enforced by Gemini)
 *
 * We strip only:
 *   - $schema, $id              (meta-identifiers Gemini doesn't consume)
 *   - const → single-value enum (Gemini doesn't support const keyword)
 *   - description               (optional: strip to reduce token overhead)
 *
 * If the live contract test reveals Gemini rejects additional features,
 * add targeted transforms here — don't over-convert preemptively.
 */

let _cached = null;

function toGeminiResponseSchema(jsonSchema, opts = {}) {
  if (_cached && !opts.noCache) return _cached;
  const result = transformNode(JSON.parse(JSON.stringify(jsonSchema)));
  if (!opts.noCache) _cached = result;
  return result;
}

function transformNode(node) {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(transformNode);

  const out = {};

  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema' || key === '$id') continue;

    if (key === 'const') {
      out.enum = [value];
      continue;
    }

    if (key === 'description') continue;

    if (key === 'properties' && typeof value === 'object') {
      out.properties = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        out.properties[propName] = transformNode(propSchema);
      }
      continue;
    }

    if (key === 'items') {
      out.items = transformNode(value);
      continue;
    }

    if (key === 'oneOf' || key === 'anyOf' || key === 'allOf') {
      out[key] = value.map(transformNode);
      continue;
    }

    out[key] = value;
  }

  return out;
}

function clearCache() {
  _cached = null;
}

module.exports = { toGeminiResponseSchema, clearCache };
