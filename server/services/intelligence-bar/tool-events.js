/**
 * Tool health event recorder.
 * Fire-and-forget — never throws, never blocks the caller.
 */

const db = require('../../models/db');
const logger = require('../logger');

function recordToolEvent({ source, context, toolName, success, durationMs, circuitOpen, errorMessage }) {
  // Never await at the call site — this must not slow down tool loops.
  db('tool_health_events').insert({
    source: source || 'unknown',
    context: context || null,
    tool_name: toolName,
    success: !!success,
    duration_ms: durationMs ?? null,
    circuit_open: !!circuitOpen,
    error_message: errorMessage ? String(errorMessage).slice(0, 1000) : null,
    created_at: new Date(),
  }).catch(err => {
    logger.warn(`[tool-events] record failed: ${err.message}`);
  });
}

module.exports = { recordToolEvent };
