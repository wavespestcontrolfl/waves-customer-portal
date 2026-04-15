/**
 * Execute smoke test — invokes tool.execute with a schema-valid minimal
 * input and confirms the result is an awaited object, not null/undefined
 * or a Knex builder.
 *
 * Skips:
 *   - tools with no local executor (managed agents without a local fn)
 *   - tools flagged sideEffects
 *   - tools flagged sonnetBacked
 */

function buildMinimalInput(schema) {
  if (!schema || typeof schema !== 'object') return {};
  const out = {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const props = schema.properties || {};
  for (const r of required) {
    const p = props[r] || {};
    out[r] = defaultFor(p);
  }
  return out;
}

function defaultFor(prop) {
  const t = Array.isArray(prop.type) ? prop.type[0] : prop.type;
  if (prop.enum && prop.enum.length) return prop.enum[0];
  switch (t) {
    case 'string':  return prop.default ?? 'test';
    case 'number':
    case 'integer': return prop.default ?? 0;
    case 'boolean': return prop.default ?? false;
    case 'array':   return [];
    case 'object':  return {};
    default:        return null;
  }
}

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    Promise.resolve(p).then(v => { clearTimeout(to); resolve(v); }, e => { clearTimeout(to); reject(e); });
  });
}

async function run(tool) {
  if (!tool.execute) {
    return { validator: 'execute-smoke', tool: tool.name, surface: tool.surface, pass: true, severity: 'info', errors: [], notes: ['no local executor — skipped'] };
  }
  if (tool.sideEffects) {
    return { validator: 'execute-smoke', tool: tool.name, surface: tool.surface, pass: true, severity: 'info', errors: [], notes: ['sideEffects flagged — skipped'] };
  }
  if (tool.sonnetBacked) {
    return { validator: 'execute-smoke', tool: tool.name, surface: tool.surface, pass: true, severity: 'info', errors: [], notes: ['sonnet-backed — skipped'] };
  }

  const input = buildMinimalInput(tool.schema);
  const errors = [];
  let result;
  try {
    result = await withTimeout(tool.execute(input), 10000);
  } catch (e) {
    errors.push(`execute threw: ${e.message}`);
    return { validator: 'execute-smoke', tool: tool.name, surface: tool.surface, pass: false, severity: 'warning', errors };
  }

  if (result === undefined || result === null) errors.push('result is null/undefined');
  else if (typeof result !== 'object') errors.push(`result is ${typeof result}, expected object`);
  else if (typeof result.then === 'function') errors.push('result is a pending Promise (likely forgot to await a Knex query)');

  return {
    validator: 'execute-smoke',
    tool: tool.name,
    surface: tool.surface,
    pass: errors.length === 0,
    severity: errors.length ? 'warning' : 'info',
    errors,
  };
}

module.exports = { run };
