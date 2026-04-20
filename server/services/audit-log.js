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
 * primary record; audit_log is secondary forensics. This is an intentional
 * choice, not a default — if the audit row is lost we can reconstruct the
 * mint event from the jti row (durable) + the eventual PI (Stripe), so a
 * failed audit write should not fail the user-facing request.
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

/**
 * Tap to Pay handoff mint rejected by rate limit. Called from the same
 * endpoint on the 429 path. Fire-and-forget matches the mint audit. A
 * spike in these rows means either a UX problem (tech fumbling the flow
 * and re-minting repeatedly) or an incident (leaked JWT, scripted abuse)
 * — worth surfacing in the Tool Health Dashboard once it exists.
 */
async function auditTerminalHandoffRateLimited({ tech_user_id, invoice_id, recent_count, retry_after_seconds, ip_address, user_agent }) {
  return recordAuditEvent({
    actor_type: 'technician',
    actor_id: tech_user_id,
    action: 'terminal.handoff.rate_limited',
    resource_type: 'invoice',
    resource_id: invoice_id,
    metadata: { recent_count, retry_after_seconds },
    ip_address,
    user_agent,
  });
}

/**
 * Tap to Pay handoff token validation attempt. Called from POST
 * /api/stripe/terminal/validate-handoff for every outcome — success
 * and every rejection. Outcome taxonomy:
 *
 *   'success'           — jti burned, invoice + amount + tech all clean
 *   'signature_invalid' — JWT verify failed (bad sig, wrong aud/iss, or
 *                         jti never minted). For forensics, claims are
 *                         parsed via jwt.decode() without verification —
 *                         they're untrusted; record them anyway so we
 *                         can see what tech_user_id an attacker tried to
 *                         forge against.
 *   'expired'           — JWT exp has passed, OR (rare) the JWT exp
 *                         passed but the DB row's expires_at triggered
 *                         first due to clock drift.
 *   'replay'            — jti exists but used_at is already set.
 *   'invoice_changed'   — jti burned cleanly, but invoice is now paid /
 *                         voided / refunded, or the total no longer
 *                         matches claims.amount_cents.
 *   'tech_inactive'     — jti burned, but the technician has been
 *                         deactivated between mint and validate.
 *
 * Mint-to-validate-success ratio and the failure-mode distribution are
 * the signals the Tool Health Dashboard will key off once it exists.
 */
async function auditTerminalHandoffValidate({ tech_user_id, invoice_id, jti, outcome, ip_address, user_agent }) {
  return recordAuditEvent({
    actor_type: 'technician',
    actor_id: tech_user_id || null,
    action: 'terminal.handoff.validate',
    resource_type: 'invoice',
    resource_id: invoice_id || null,
    metadata: { jti: jti || null, outcome },
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
  auditTerminalHandoffRateLimited,
  auditTerminalHandoffValidate,
  ipFromReq,
  uaFromReq,
};
