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
 *     not permission (pass invoiceId: null only for aggregate-balance rails
 *     with no single target, e.g. the previsit dues reminder).
 *
 * evaluate() fails closed internally (an error is a denial), so a policy
 * blip skips the send rather than bypassing the policy.
 *
 * late-payment-checker.js and invoice-followups.js predate this module and
 * carry equivalent local helpers; consolidation onto this one is deliberate
 * follow-up, not done here (touch-what-you're-asked).
 */

const logger = require('../logger');

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
  logTag = 'collections',
}) {
  if (process.env.GATE_COLLECTIONS_POLICY !== 'true') {
    return { permitted: true, eligibleInvoiceIds: null };
  }
  let verdict;
  try {
    const ContactPolicy = require('./contact-policy');
    verdict = await ContactPolicy.evaluate(customerId, { channel, purpose, now, offLedgerBalanceCents, excludeCollectionCaseId, excludeLedgerIds });
  } catch (err) {
    logger.warn(`[${logTag}] collections policy consult failed for customer ${customerId}: ${err.message} — denying`);
    return { permitted: false, eligibleInvoiceIds: [] };
  }
  if (!verdict.allowed) {
    logger.info(`[${logTag}] collections policy denied ${channel} for customer ${customerId}: ${verdict.denialReasons.join(', ')}`);
    return { permitted: false, eligibleInvoiceIds: verdict.eligibleInvoiceIds || [] };
  }
  return { permitted: true, eligibleInvoiceIds: verdict.eligibleInvoiceIds || [] };
}

async function collectionsChannelPermitted({
  customerId,
  invoiceId = null,
  channel,
  purpose,
  now = new Date(),
  offLedgerBalanceCents = 0,
  excludeCollectionCaseId = null,
  excludeLedgerIds = [],
  logTag = 'collections',
}) {
  if (process.env.GATE_COLLECTIONS_POLICY !== 'true') return true;
  let verdict;
  try {
    const ContactPolicy = require('./contact-policy');
    verdict = await ContactPolicy.evaluate(customerId, { channel, purpose, now, offLedgerBalanceCents, excludeCollectionCaseId, excludeLedgerIds });
  } catch (err) {
    // evaluate() is documented never to throw (it denies internally), but a
    // guard-level surprise must read as a denial, not abort a sweep loop.
    logger.warn(`[${logTag}] collections policy consult failed for customer ${customerId}: ${err.message} — denying`);
    return false;
  }
  const member = invoiceId == null
    ? true
    : (verdict.eligibleInvoiceIds || []).map(String).includes(String(invoiceId));
  if (!verdict.allowed || !member) {
    const why = !verdict.allowed ? verdict.denialReasons.join(', ') : 'invoice_not_eligible';
    logger.info(`[${logTag}] collections policy denied ${channel} for customer ${customerId}${invoiceId ? ` invoice ${invoiceId}` : ''}: ${why}`);
    return false;
  }
  return true;
}

module.exports = { collectionsChannelPermitted, collectionsChannelVerdict };
