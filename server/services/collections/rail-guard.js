/**
 * Shared collections-policy consult for outbound balance rails (PR A).
 *
 * Enforced ONLY while GATE_COLLECTIONS_POLICY is exactly 'true' — gate
 * off/unset returns true WITHOUT loading the policy module, so every wired
 * rail stays byte-identical dark (pinned per rail). When the gate is on:
 *
 *   - the verdict must allow the channel (channels are independent:
 *     do_not_text blocks only sms, do_not_email only email);
 *   - when the rail has a TARGET invoice, that invoice must be in the
 *     verdict's eligible set — an allowed verdict about a sibling invoice is
 *     not permission. A frozen aggregate passes invoiceIds so every quoted
 *     invoice must remain eligible; dues-only aggregates pass an empty set.
 *
 * evaluate() fails closed internally (an error is a denial), so a policy
 * blip skips the send rather than bypassing the policy.
 *
 * late-payment-checker.js and invoice-followups.js predate this module and
 * carry equivalent local helpers; consolidation onto this one is deliberate
 * follow-up, not done here (touch-what-you're-asked).
 */

const logger = require('../logger');

// Shadow-spacing inputs are forwarded only when set, so every existing
// caller's evaluate() arguments stay exactly as they were.
function shadowSpacingArgs(source, spacingExcludeKey, spacingExcludeEventKey) {
  return {
    ...(source ? { source } : {}),
    ...(spacingExcludeKey ? { spacingExcludeKey } : {}),
    ...(spacingExcludeEventKey ? { spacingExcludeEventKey } : {}),
  };
}

// GATE_DUNNING_SPACING_SHADOW observes inside ContactPolicy.evaluate, which
// the rails only reach while GATE_COLLECTIONS_POLICY is on (Codex #5189 r6):
// the shadow needs both. Say so once per process instead of recording
// nothing silently.
let shadowWithoutPolicyWarned = false;
function warnShadowWithoutPolicy() {
  if (shadowWithoutPolicyWarned || process.env.GATE_DUNNING_SPACING_SHADOW !== 'true') return;
  shadowWithoutPolicyWarned = true;
  logger.warn('[rail-guard] GATE_DUNNING_SPACING_SHADOW is on but GATE_COLLECTIONS_POLICY is not — the spacing shadow records nothing until both are on');
}

/**
 * Active collections DISPUTE hold on the customer (owner ruling 2026-09-30:
 * while it stands no pay link reaches them, and the Day 3-90 ladder and every
 * other reminder rail wait, then start after the release). Consulted by every
 * dunning/reminder rail through THESE two functions, independent of
 * GATE_COLLECTIONS_POLICY: the gate's policy-flag denial only applies when it
 * is on, and it reads as a durable stop. This is a transient wait - the owed
 * touch stays pending and fires after the release. Fail closed: a lookup that
 * cannot answer holds it too. Reads on `database` when given (savepoint on a
 * transaction).
 */
async function disputeHoldHolds(customerId, database, holdExempt = null) {
  // Only a deliberate operator send (owner ruling 2026-09-30) skips the dispute-hold wait;
  // every automated rail still waits. The policy gate's own verdict is unaffected.
  if (holdExempt === 'operator') return false;
  if (!customerId) return false;
  const { held } = await require('./collection-hold').dueInvoiceHeldByDisputeHold(customerId, database || undefined);
  return held;
}

/**
 * Verdict-returning consult (codex r8): aggregate rails that quote a SET of
 * invoices must restrict that set to the policy's eligible ids — a boolean
 * alone lets an excluded invoice (payer re-resolved, dunning-stopped) ride
 * along inside an allowed aggregate. Gate off ⇒ { permitted: true,
 * eligibleInvoiceIds: null } WITHOUT consulting (null = "no filtering",
 * byte-identical dark). A consult failure is a denial with an empty set.
 */
async function collectionsChannelVerdict({
  customerId,
  channel,
  purpose,
  now = new Date(),
  offLedgerBalanceCents = 0,
  excludeCollectionCaseId = null,
  excludeLedgerIds = [],
  source = null,
  spacingExcludeKey = null,
  spacingExcludeEventKey = null,
  logTag = 'collections',
  holdExempt = null,
  database,
}) {
  if (await disputeHoldHolds(customerId, database, holdExempt)) {
    logger.info(`[${logTag}] dispute hold: ${channel} for customer ${customerId} deferred until it is released`);
    return { permitted: false, eligibleInvoiceIds: [], hold: true };
  }
  if (process.env.GATE_COLLECTIONS_POLICY !== 'true') {
    warnShadowWithoutPolicy();
    return { permitted: true, eligibleInvoiceIds: null };
  }
  let verdict;
  try {
    const ContactPolicy = require('./contact-policy');
    verdict = await ContactPolicy.evaluate(customerId, {
      channel, purpose, now, offLedgerBalanceCents, excludeCollectionCaseId, excludeLedgerIds,
      ...(database ? { database } : {}),
      ...shadowSpacingArgs(source, spacingExcludeKey, spacingExcludeEventKey),
    });
  } catch (err) {
    logger.warn(`[${logTag}] collections policy consult failed for customer ${customerId}: ${err.message} — denying`);
    return {
      permitted: false,
      eligibleInvoiceIds: [],
      balanceIncomplete: 'policy evaluation failed',
    };
  }
  const incomplete = verdict.balanceIncomplete
    ? { balanceIncomplete: verdict.balanceIncomplete }
    : {};
  if (!verdict.allowed) {
    logger.info(`[${logTag}] collections policy denied ${channel} for customer ${customerId}: ${verdict.denialReasons.join(', ')}`);
    return { permitted: false, eligibleInvoiceIds: verdict.eligibleInvoiceIds || [], ...incomplete };
  }
  return { permitted: true, eligibleInvoiceIds: verdict.eligibleInvoiceIds || [], ...incomplete };
}

function includesQuotedInvoices(eligibleInvoiceIds, invoiceId, invoiceIds) {
  const targets = invoiceIds ?? (invoiceId == null ? [] : [invoiceId]);
  const eligible = new Set((eligibleInvoiceIds || []).map(String));
  return Array.isArray(targets) && targets.every((id) => eligible.has(String(id)));
}

async function collectionsChannelPermitted({
  customerId,
  invoiceId = null,
  invoiceIds = null,
  channel,
  purpose,
  now = new Date(),
  offLedgerBalanceCents = 0,
  excludeCollectionCaseId = null,
  excludeLedgerIds = [],
  // Shadow spacing only (dunning-spacing.js): the rail sending, and a
  // reservation key the rail's own retry may already have written.
  source = null,
  spacingExcludeKey = null,
  spacingExcludeEventKey = null,
  logTag = 'collections',
  detail = false,
  holdExempt = null,
  database,
}) {
  const answer = (allowed, durable = false, balanceIncomplete = false) => (detail
    ? { allowed, durable, ...(balanceIncomplete ? { balanceIncomplete } : {}) }
    : allowed);
  if (await disputeHoldHolds(customerId, database, holdExempt)) {
    logger.info(`[${logTag}] dispute hold: ${channel} for customer ${customerId} deferred until it is released`);
    return detail ? { allowed: false, durable: false, hold: true } : false;
  }
  if (process.env.GATE_COLLECTIONS_POLICY !== 'true') {
    warnShadowWithoutPolicy();
    return answer(true);
  }
  let verdict;
  try {
    const ContactPolicy = require('./contact-policy');
    verdict = await ContactPolicy.evaluate(customerId, {
      channel, purpose, now, offLedgerBalanceCents, excludeCollectionCaseId, excludeLedgerIds,
      ...(database ? { database } : {}),
      ...shadowSpacingArgs(source, spacingExcludeKey, spacingExcludeEventKey),
    });
  } catch (err) {
    // evaluate() is documented never to throw (it denies internally), but a
    // guard-level surprise must read as a denial, not abort a sweep loop.
    logger.warn(`[${logTag}] collections policy consult failed for customer ${customerId}: ${err.message} — denying`);
    return answer(false);
  }
  const member = includesQuotedInvoices(verdict.eligibleInvoiceIds, invoiceId, invoiceIds);
  if (!verdict.allowed || !member) {
    const why = !verdict.allowed ? verdict.denialReasons.join(', ') : 'invoice_not_eligible';
    logger.info(`[${logTag}] collections policy denied ${channel} for customer ${customerId}${invoiceId ? ` invoice ${invoiceId}` : ''}: ${why}`);
    return answer(false, !verdict.allowed && verdict.denialReasons.some(isDurableDenial),
      verdict.balanceIncomplete);
  }
  return answer(true, false, verdict.balanceIncomplete);
}

// A denial that will not lift on its own schedule: an operator flag, a
// suppression, the account's standing (archived, commercial, language,
// line type, missing consent). Spacing windows, call windows and read
// failures are transient and keep an owed leg pending.
const DURABLE_DENIALS = new Set([
  'customer_not_found', 'customer_archived', 'commercial_customer', 'customer_prefers_spanish',
  'line_type_not_mobile', 'consent_no_evidence', 'unknown_channel', 'unknown_purpose',
]);
function isDurableDenial(reason) {
  return DURABLE_DENIALS.has(reason) || /^(flag|suppression)_/.test(reason);
}

module.exports = {
  collectionsChannelPermitted, collectionsChannelVerdict, isDurableDenial,
};
