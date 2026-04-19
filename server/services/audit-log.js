const db = require('../models/db');
const logger = require('./logger');

/**
 * Writer for the generic audit_log table.
 *
 * Two modes:
 *
 *   recordAuditEvent({...})
 *     Default fire-and-forget. Insert is awaited internally but failures are
 *     logged, not thrown. Use for high-volume, low-stakes events where a
 *     lost audit row is cheaper than failing the user request. Examples:
 *     handoff mints, page views, non-financial state transitions.
 *
 *   recordAuditEvent({..., critical: true})
 *     Awaits insert and propagates errors to the caller. Use when a lost
 *     audit row is worse than a failed request. Examples: WaveGuard tier
 *     changes, discount overrides, refund approvals, agent-initiated
 *     actions on customer data. Caller must await and handle errors.
 *
 * === Metadata shape discipline ===
 * Don't call recordAuditEvent() directly from routes in the long run. Wrap
 * it in a typed helper per action so the metadata shape stays consistent
 * across callers. `auditTerminalHandoffMint` below is the template.
 * Grep `audit*` before writing a new raw recordAuditEvent().
 */
async function recordAuditEvent({
  actor_type,
  actor_id = null,
  action,
  resource_type = null,
  resource_id = null,
  metadata = {},
  ip_address = null,
  user_agent = null,
  critical = false,
}) {
  const row = {
    actor_type,
    actor_id,
    action,
    resource_type,
    resource_id,
    metadata,
    ip_address,
    user_agent,
  };

  if (critical) {
    await db('audit_log').insert(row);
    return;
  }

  try {
    await db('audit_log').insert(row);
  } catch (err) {
    logger.error(`[audit-log] write failed for ${action}: ${err.message}`);
  }
}

// =============================================================================
// Typed helpers — one per audited action. Enforces a stable metadata shape
// so BI queries don't have to guess at field names.
// =============================================================================

/**
 * Tap to Pay handoff token mint. Called from POST /api/stripe/terminal/handoff.
 * Fire-and-forget: the terminal_handoff_tokens row + Stripe PI are the
 * primary record; audit_log is secondary forensics.
 */
async function auditTerminalHandoffMint({ tech_user_id, invoice_id, amount_cents, jti, ip_address, user_agent }) {
  return recordAuditEvent({
    actor_type: 'technician',
    actor_id: tech_user_id,
    action: 'terminal.handoff.mint',
    resource_type: 'invoice',
    resource_id: invoice_id,
    metadata: { amount_cents, jti },
    ip_address,
    user_agent,
  });
}

function ipFromReq(req) {
  return (req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null;
}

function uaFromReq(req) {
  return req.headers?.['user-agent'] || null;
}

module.exports = {
  recordAuditEvent,
  auditTerminalHandoffMint,
  ipFromReq,
  uaFromReq,
};
