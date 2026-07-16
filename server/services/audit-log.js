const db = require('../models/db');
const logger = require('./logger');

const DATA_HYGIENE_AGENT_ACTOR_ID = '0d0c4979-b8b8-5a37-a82b-5a7d8f7a7c2f';

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
  trx = null,
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

  const auditDb = trx || db;
  if (critical) {
    const [inserted] = await auditDb('audit_log')
      .insert(row)
      .returning(['id']);
    return inserted?.id || null;
  }

  try {
    await auditDb('audit_log').insert(row);
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

/**
 * Manual payment reconciliation. Called from POST /api/admin/payments/reconcile
 * after the admin marks an invoice paid via Tap to Pay (Path A) or via a
 * cash/check/off-platform collection. CRITICAL audit — a missing row here
 * makes a charged-but-not-paid drift impossible to trace later. Caller awaits
 * and lets failures bubble.
 */
async function auditPaymentReconcile({
  tech_user_id, invoice_id, invoice_number, collected_via,
  stripe_charge_id, amount, ip_address, user_agent,
}) {
  return recordAuditEvent({
    actor_type: 'technician',
    actor_id: tech_user_id || null,
    action: 'payment.reconcile',
    resource_type: 'invoice',
    resource_id: invoice_id,
    metadata: { invoice_number, collected_via, stripe_charge_id: stripe_charge_id || null, amount: amount ?? null },
    ip_address,
    user_agent,
    critical: true,
  });
}

async function auditServiceCatalogChange({
  tech_user_id, service_id, change_type, changed_fields,
  before, after, references, ip_address, user_agent,
  trx = null,
}) {
  return recordAuditEvent({
    actor_type: 'technician',
    actor_id: tech_user_id || null,
    action: `service_catalog.${change_type}`,
    resource_type: 'service',
    resource_id: service_id || null,
    metadata: {
      changed_fields: changed_fields || [],
      before: before || null,
      after: after || null,
      references: references || null,
    },
    ip_address,
    user_agent,
    critical: true,
    trx,
  });
}

async function auditDiscountCatalogChange({
  tech_user_id, discount_id, change_type, changed_fields,
  before, after, ip_address, user_agent, trx = null,
}) {
  return recordAuditEvent({
    actor_type: 'technician',
    actor_id: tech_user_id || null,
    action: `discount_catalog.${change_type}`,
    resource_type: 'discount',
    resource_id: discount_id || null,
    metadata: {
      changed_fields: changed_fields || [],
      before: before || null,
      after: after || null,
    },
    ip_address,
    user_agent,
    critical: true,
    trx,
  });
}

async function auditServicePackageChange({
  tech_user_id, package_id, change_type, changed_fields,
  before, after, ip_address, user_agent, trx = null,
}) {
  return recordAuditEvent({
    actor_type: 'technician',
    actor_id: tech_user_id || null,
    action: `service_package.${change_type}`,
    resource_type: 'service_package',
    resource_id: package_id || null,
    metadata: {
      changed_fields: changed_fields || [],
      before: before || null,
      after: after || null,
    },
    ip_address,
    user_agent,
    critical: true,
    trx,
  });
}

/**
 * Pest Pressure config change. Called from PUT /api/admin/pest-pressure/config
 * after validation passes. CRITICAL audit — the config drives customer-facing
 * scores; a silent edit (e.g. weight knob swap) would otherwise be hard to
 * trace if a customer disputes the score they see on a report. Caller
 * awaits and lets failures bubble.
 *
 * `before` and `after` are the full config snapshots so the audit row alone
 * is sufficient to explain any historical recalculation.
 */
async function auditPestPressureConfigChange({
  tech_user_id, config_id, scope, changed_fields, before, after,
  ip_address, user_agent, trx = null,
}) {
  return recordAuditEvent({
    actor_type: 'technician',
    actor_id: tech_user_id || null,
    action: 'pest_pressure.config.update',
    resource_type: 'pest_pressure_config',
    resource_id: config_id || null,
    metadata: {
      scope: scope || 'global',
      changed_fields: changed_fields || [],
      before: before || null,
      after: after || null,
    },
    ip_address,
    user_agent,
    critical: true,
    trx,
  });
}

/**
 * Pest Pressure manual override on a calculated score. Called from
 * PUT /api/admin/pest-pressure/scores/:id/override (Phase 4). CRITICAL
 * audit — overrides change what a customer sees on their report and
 * must be traceable to an actor + reason.
 */
async function auditPestPressureScoreOverride({
  tech_user_id, score_id, service_record_id, customer_id,
  original_calculated_score, displayed_score, override_reason,
  action_type = 'set',
  ip_address, user_agent, trx = null,
}) {
  return recordAuditEvent({
    actor_type: 'technician',
    actor_id: tech_user_id || null,
    action: `pest_pressure.score.override.${action_type}`,
    resource_type: 'pest_pressure_score',
    resource_id: score_id || null,
    metadata: {
      service_record_id: service_record_id || null,
      customer_id: customer_id || null,
      original_calculated_score,
      displayed_score,
      override_reason: override_reason || null,
    },
    ip_address,
    user_agent,
    critical: true,
    trx,
  });
}

/**
 * Data Hygiene Agent — proposal lifecycle events.
 *
 * Four typed helpers, one per proposal-lifecycle transition. Two are CRITICAL
 * (apply / revert — they mutate live customer data; a missing audit row would
 * make a wrong write untraceable later) and two are fire-and-forget (create /
 * reject — the proposal row itself is the primary record).
 *
 * The CRITICAL helpers take a `trx` so the audit row commits in the same
 * transaction as the underlying UPDATE. If the audit insert fails, the whole
 * apply rolls back — no orphaned mutation.
 *
 * Metadata shape is consistent across all four so BI queries do not have to
 * guess at field names. Every event gets:
 * { proposal_id, rule_id, rule_version, source, field, scope_type, scope_id,
 *   is_sensitive, reviewed_via }.
 *
 * Apply/revert store `before_redacted` / `after_redacted` plus hashes and
 * `vault_id`. For non-sensitive proposals the redacted values are simply the
 * raw values and vault_id is null. Sensitive raw values never live in
 * audit_log; the apply/revert path stores them in data_hygiene_sensitive_vault.
 */
async function auditHygieneProposalCreate({
  proposal_id, rule_id, rule_version, source, tier, confidence, is_sensitive,
  resource_type, resource_id, scope_type, scope_id, field,
  reviewed_via = 'agent', evidence_summary = null,
}) {
  return recordAuditEvent({
    actor_type: 'agent',
    actor_id: DATA_HYGIENE_AGENT_ACTOR_ID,
    action: 'data_hygiene.proposal.create',
    resource_type,
    resource_id: resource_id || null,
    metadata: {
      proposal_id, rule_id, rule_version, source, tier, confidence,
      is_sensitive: !!is_sensitive,
      scope_type, scope_id, field,
      reviewed_via,
      evidence_summary,
    },
  });
}

async function auditHygieneProposalApply({
  trx, proposal_id, rule_id, rule_version, source, field,
  resource_type, resource_id, scope_type, scope_id,
  before_redacted, after_redacted, before_hash = null, after_hash = null,
  vault_id = null, reviewer_id, reviewed_via, is_sensitive,
}) {
  return recordAuditEvent({
    actor_type: reviewed_via === 'auto' ? 'agent' : 'technician',
    actor_id: reviewed_via === 'auto' ? DATA_HYGIENE_AGENT_ACTOR_ID : (reviewer_id || null),
    action: 'data_hygiene.proposal.apply',
    resource_type,
    resource_id: resource_id || null,
    metadata: {
      proposal_id, rule_id, rule_version, source, field,
      scope_type, scope_id,
      is_sensitive: !!is_sensitive,
      reviewed_via,
      before_redacted,
      after_redacted,
      before_hash,
      after_hash,
      vault_id: vault_id || null,
      reviewer_id: reviewer_id || null,
    },
    critical: true,
    trx,
  });
}

async function auditHygieneProposalReject({
  proposal_id, rule_id, rule_version, source, field,
  resource_type, resource_id, scope_type, scope_id,
  reject_reason, reviewer_id, reviewed_via = 'ui', is_sensitive,
  evidence_summary = null,
}) {
  return recordAuditEvent({
    actor_type: 'technician',
    actor_id: reviewer_id || null,
    action: 'data_hygiene.proposal.reject',
    resource_type,
    resource_id: resource_id || null,
    metadata: {
      proposal_id, rule_id, rule_version, source, field,
      scope_type, scope_id,
      is_sensitive: !!is_sensitive,
      reviewed_via,
      reject_reason,
      reviewer_id: reviewer_id || null,
      evidence_summary,
    },
  });
}

async function auditHygieneProposalRevert({
  trx, proposal_id, rule_id, rule_version, source, field,
  resource_type, resource_id, scope_type, scope_id,
  before_redacted, after_redacted, before_hash = null, after_hash = null,
  vault_id = null, original_audit_id, reverted_by, is_sensitive,
  reviewed_via = 'ui',
}) {
  return recordAuditEvent({
    actor_type: 'technician',
    actor_id: reverted_by || null,
    action: 'data_hygiene.proposal.revert',
    resource_type,
    resource_id: resource_id || null,
    metadata: {
      proposal_id, rule_id, rule_version, source, field,
      scope_type, scope_id,
      is_sensitive: !!is_sensitive,
      reviewed_via,
      before_redacted,
      after_redacted,
      before_hash,
      after_hash,
      vault_id: vault_id || null,
      original_audit_id: original_audit_id || null,
      reverted_by: reverted_by || null,
    },
    critical: true,
    trx,
  });
}

async function auditNotificationTemplateIssue({
  channel = 'sms',
  template_key,
  event_type,
  workflow = null,
  entity_type = null,
  entity_id = null,
  reason,
  unresolved_placeholders = null,
}) {
  return recordAuditEvent({
    actor_type: 'system',
    action: `notification_template.${channel}.render_issue`,
    resource_type: 'notification_template',
    resource_id: null,
    metadata: {
      channel,
      template_key,
      event_type,
      workflow,
      entity_type,
      entity_id,
      reason,
      unresolved_placeholders,
    },
  });
}

async function auditInternalAdminAlertDeliveryIssue({
  outcome,
  message_type = null,
  to_masked = null,
  body_length = 0,
  title = null,
  link = null,
  reason = null,
  stats = null,
}) {
  return recordAuditEvent({
    actor_type: 'system',
    action: 'notification.internal_admin_alert.delivery_issue',
    resource_type: 'notification',
    resource_id: null,
    metadata: {
      outcome,
      message_type,
      to_masked,
      body_length,
      title,
      link,
      reason,
      stats,
    },
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
  auditPaymentReconcile,
  auditServiceCatalogChange,
  auditDiscountCatalogChange,
  auditServicePackageChange,
  auditPestPressureConfigChange,
  auditPestPressureScoreOverride,
  auditHygieneProposalCreate,
  auditHygieneProposalApply,
  auditHygieneProposalReject,
  auditHygieneProposalRevert,
  auditNotificationTemplateIssue,
  auditInternalAdminAlertDeliveryIssue,
  ipFromReq,
  uaFromReq,
};
