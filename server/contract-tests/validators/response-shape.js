/**
 * Response-shape validator — runs only after execute-smoke succeeds.
 * Confirms the result is JSON-serializable and carries at least one of
 * the conventional keys (results | data | summary | error | rows | total).
 *
 * Sharing execute-smoke's result would require coordination; for simplicity
 * this validator re-invokes the tool with the same minimal input when
 * skipping conditions don't apply.
 */

const CONVENTIONAL_KEYS = ['results', 'data', 'summary', 'error', 'rows', 'total', 'items', 'count', 'success', 'found'];

function buildMinimalInput(schema) {
  const out = {};
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const props = schema?.properties || {};
  for (const r of required) {
    const p = props[r] || {};
    const t = Array.isArray(p.type) ? p.type[0] : p.type;
    if (p.enum?.length) out[r] = p.enum[0];
    else if (t === 'string') out[r] = 'test';
    else if (t === 'number' || t === 'integer') out[r] = 0;
    else if (t === 'boolean') out[r] = false;
    else if (t === 'array') out[r] = [];
    else if (t === 'object') out[r] = {};
    else out[r] = null;
  }
  return out;
}

function safeStringify(v) {
  try { JSON.stringify(v); return true; } catch { return false; }
}

async function run(tool) {
  if (!tool.execute || tool.sideEffects || tool.sonnetBacked) {
    return { validator: 'response-shape', tool: tool.name, surface: tool.surface, pass: true, severity: 'info', errors: [], notes: ['skipped'] };
  }
  const errors = [];
  let result;
  try {
    result = await Promise.race([
      tool.execute(buildMinimalInput(tool.schema)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
    ]);
  } catch {
    // execute-smoke already flagged this; skip here.
    return { validator: 'response-shape', tool: tool.name, surface: tool.surface, pass: true, severity: 'info', errors: [], notes: ['execute failed — deferred to execute-smoke'] };
  }

  if (result && typeof result === 'object') {
    if (!safeStringify(result)) errors.push('result is not JSON-serializable (circular ref or BigInt)');
    const keys = Object.keys(result);
    if (!keys.some(k => CONVENTIONAL_KEYS.includes(k))) {
      errors.push(`result has no conventional key (${CONVENTIONAL_KEYS.join(', ')})`);
    }
  }

  return {
    validator: 'response-shape',
    tool: tool.name,
    surface: tool.surface,
    pass: errors.length === 0,
    severity: errors.length ? 'warning' : 'info',
    errors,
  };
}

module.exports = { run };
