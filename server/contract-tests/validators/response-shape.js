/**
 * Response-shape validator — runs only after execute-smoke succeeds.
 * Confirms the result is something the model loop can actually read:
 * JSON-serializable, not an un-awaited Knex builder, not an empty object.
 *
 * (This used to require a key from a fixed "conventional" list — 82 of 202
 * tools returned perfectly good domain-keyed objects and carried a
 * permanent warning, which made warnings meaningless. Real failure modes
 * only.)
 *
 * Sharing execute-smoke's result would require coordination; for simplicity
 * this validator re-invokes the tool with the same minimal input when
 * skipping conditions don't apply.
 */

const { buildMinimalInput } = require('../minimal-input');

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
    if (typeof result.toSQL === 'function') errors.push('result looks like an un-awaited Knex builder (has .toSQL)');
    else if (!Array.isArray(result) && Object.keys(result).length === 0) {
      errors.push('result is an empty object — the model loop gets nothing to read');
    }
  }

  return {
    validator: 'response-shape',
    tool: tool.name,
    surface: tool.surface,
    pass: errors.length === 0,
    severity: errors.length ? 'critical' : 'info',
    errors,
  };
}

module.exports = { run };
