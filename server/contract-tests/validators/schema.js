/**
 * Schema validator — confirms each tool's input_schema is structurally
 * valid. Keeps the dependency surface minimal (no ajv required) by running
 * a light JSON-Schema sanity check manually; upgrade to ajv later if more
 * depth is needed.
 */

const VALID_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']);

function walk(node, path, errors) {
  if (!node || typeof node !== 'object') return;
  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    for (const t of types) {
      if (!VALID_TYPES.has(t)) errors.push(`${path}.type = "${t}" is not a valid JSON Schema type`);
    }
  }
  if (node.properties && typeof node.properties === 'object') {
    for (const [k, sub] of Object.entries(node.properties)) {
      walk(sub, `${path}.properties.${k}`, errors);
    }
  }
  if (node.items) walk(node.items, `${path}.items`, errors);
  if (Array.isArray(node.required)) {
    const propKeys = new Set(Object.keys(node.properties || {}));
    for (const r of node.required) {
      if (!propKeys.has(r)) errors.push(`${path}.required references "${r}" not in properties`);
    }
  }
}

async function run(tool) {
  const errors = [];
  const schema = tool.schema;
  if (!schema || typeof schema !== 'object') {
    errors.push('input_schema missing or not an object');
  } else {
    if (schema.type !== 'object') errors.push(`top-level type should be "object", got "${schema.type}"`);
    walk(schema, 'input_schema', errors);
  }
  return {
    validator: 'schema',
    tool: tool.name,
    surface: tool.surface,
    pass: errors.length === 0,
    severity: errors.length ? 'critical' : 'info',
    errors,
  };
}

module.exports = { run };
