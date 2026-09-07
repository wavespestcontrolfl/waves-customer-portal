/**
 * Tool health event recorder.
 * Fire-and-forget — never throws, never blocks the caller.
 */

const db = require('../../models/db');
const logger = require('../logger');

function recordToolEvent({ source, context, toolName, success, durationMs, circuitOpen, errorMessage, metadata }) {
  const row = {
    source: source || 'unknown',
    context: context || null,
    tool_name: toolName,
    success: !!success,
    duration_ms: durationMs ?? null,
    circuit_open: !!circuitOpen,
    error_message: errorMessage ? String(errorMessage).slice(0, 1000) : null,
    created_at: new Date(),
  };
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    row.metadata = JSON.stringify(metadata);
  }

  // Never await at the call site — this must not slow down tool loops.
  db('tool_health_events').insert(row).catch(err => {
    if (row.metadata && err?.code === '42703') {
      const fallback = { ...row };
      delete fallback.metadata;
      db('tool_health_events').insert(fallback).catch(retryErr => {
        logger.warn(`[tool-events] record failed (${retryErr.code || retryErr.name || 'error'})`);
      });
      return;
    }
    // code only: a knex message carries the compiled INSERT, and error_message
    // carries a tool's failure text (customer names / emails) — AGENTS.md: no PII in logs
    logger.warn(`[tool-events] record failed (${err.code || err.name || 'error'})`);
  });
}

module.exports = { recordToolEvent };
