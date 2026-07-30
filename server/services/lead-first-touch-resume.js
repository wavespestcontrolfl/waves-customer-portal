/**
 * Release engine for HELD first-touch email sends (2026-07-30 lane).
 *
 * The call pipeline holds BOTH first-touch emails while an email read-back
 * card is live — the new_lead drip and the newsletter double-opt-in — and
 * records the hold in the durable `first_touch_holds` ledger: what was held,
 * for which address (the post-correction value Step 6 actually withheld),
 * for which call and customer. This module settles that row from every path
 * where the question resolves:
 *
 *   - Triage Inbox resolve / call-level ACCEPT verdict → release as-held.
 *   - Operator email correction (customer-email-fanout via Customer 360 or
 *     the Intelligence Bar) → release to the CORRECTED address — works even
 *     when the review cards were already resolved earlier (e.g. by a deny
 *     verdict), because the ledger row, not the card, carries the pending
 *     state.
 *   - End-of-run reconciliation for a card resolved mid-processing.
 *
 * Consent is re-checked at release: a do-not-contact veto marks the hold
 * 'blocked' (terminal). Every transient failure keeps the row 'pending'
 * with last_error, so each failure mode stays retryable by the next release
 * trigger. The newsletter DOI cannot be rolled back, so transactional
 * callers defer it: the payload is returned for post-commit execution, and
 * released_newsletter is set only when the confirmation actually sent.
 * Never throws into a caller.
 */

const db = require('../models/db');
const logger = require('./logger');

const EMAIL_REVIEW_REASON_CODES = ['email_unverified', 'email_invalid'];
// Same permissive-but-real syntax class the fanout uses — releases are also
// triggered when an email_invalid card is resolved as-is, and enrollCustomer
// performs no syntax validation of its own.
const RESUME_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function customerCallDoNotContact(customerId, dbh) {
  const row = await dbh('call_log')
    .where({ customer_id: customerId })
    .whereRaw("ai_extraction_enriched->'consent'->>'do_not_contact_request' = 'true'")
    .first('id');
  return !!row;
}

// Canonical suppression semantics: only a suppression the automation lane
// itself would honor blocks the release — a group-scoped suppression for an
// unrelated stream (e.g. service_operational) must not bury it.
async function emailSuppressedForNewLead(email, dbh) {
  if (!(await dbh.schema.hasTable('email_suppressions'))) return false;
  const rows = await dbh('email_suppressions')
    .whereRaw('LOWER(email) = ?', [String(email).trim().toLowerCase()])
    .where({ status: 'active' });
  if (!rows.length) return false;
  const { automationSuppressionMatches } = require('./automation-runner');
  const template = await dbh('automation_templates').where({ key: 'new_lead' }).first();
  return rows.some((row) => automationSuppressionMatches(template || {}, row));
}

async function findPendingHold({ callLogId = null, customerId = null, dbh }) {
  if (!(await dbh.schema.hasTable('first_touch_holds'))) return null;
  let q = dbh('first_touch_holds').where({ status: 'pending' });
  if (callLogId) q = q.where({ call_log_id: callLogId });
  else if (customerId) q = q.where({ customer_id: customerId });
  else return null;
  return q.orderBy('created_at', 'desc').first('*');
}

async function settleHold(holdId, patch, dbh) {
  await dbh('first_touch_holds').where({ id: holdId }).update({ ...patch, updated_at: new Date() });
}

// Delivered = the DOI confirmation actually went out, or the helper
// deliberately skipped (unsubscribed/invalid — nothing left to retry). A
// created subscriber whose confirmation SEND failed keeps the hold
// retryable (Codex #3084 r6).
function newsletterDelivered(outcome) {
  if (!outcome) return false;
  if (outcome.skipped) return true;
  return outcome.confirmationEmailSent !== false;
}

async function runNewsletterResume(payload) {
  const CRP = require('./call-recording-processor');
  if (typeof CRP.resumeNewsletterForCallCustomer !== 'function') return null;
  return CRP.resumeNewsletterForCallCustomer(payload);
}

/**
 * Release the pending first-touch hold for a call (triage paths) or a
 * customer (email-correction paths). `email` (a corrected address) overrides
 * the ledger's held_email; the customer's STORED email is deliberately never
 * used — for a matched existing customer it can be a different, stale
 * address than the one confirmed on the call.
 */
async function resumeHeldFirstTouch({
  customerId = null,
  callLogId = null,
  email = null,
  dbh = db,
  source = 'email_review_resolved',
  deferNewsletter = false,
} = {}) {
  const result = { resumed: false, enrolled: false, newsletter: null, newsletterResume: null, skipped: null };
  try {
    const hold = await findPendingHold({ callLogId, customerId, dbh });
    if (!hold) return { ...result, skipped: 'no_pending_hold' };

    const holdCustomerId = hold.customer_id || customerId;
    if (!holdCustomerId) {
      await settleHold(hold.id, { last_error: 'no_customer_linked' }, dbh);
      return { ...result, skipped: 'no_customer' };
    }
    const customer = await dbh('customers')
      .where({ id: holdCustomerId })
      .first('id', 'first_name', 'last_name');
    if (!customer) {
      await settleHold(hold.id, { last_error: 'customer_not_found' }, dbh);
      return { ...result, skipped: 'customer_not_found' };
    }

    const resumeEmail = String(email || hold.held_email || '').trim().toLowerCase();
    if (!resumeEmail || !RESUME_EMAIL_RE.test(resumeEmail)) {
      // Stays pending: a later correction releases it.
      await settleHold(hold.id, { last_error: 'invalid_email' }, dbh);
      return { ...result, skipped: 'invalid_email' };
    }

    if (await customerCallDoNotContact(holdCustomerId, dbh)) {
      await settleHold(hold.id, { status: 'blocked', last_error: 'do_not_contact' }, dbh);
      logger.info(`[first-touch-resume] customer ${holdCustomerId}: do-not-contact veto — hold blocked (${source})`);
      return { ...result, skipped: 'do_not_contact' };
    }
    if (await emailSuppressedForNewLead(resumeEmail, dbh)) {
      // Pending, not blocked: a corrected address after a bounce releases it.
      await settleHold(hold.id, { last_error: 'email_suppressed' }, dbh);
      logger.info(`[first-touch-resume] customer ${holdCustomerId}: address suppressed — hold stays pending (${source})`);
      return { ...result, skipped: 'email_suppressed' };
    }

    const patch = {};
    if (hold.held_drip && !hold.released_drip) {
      try {
        const AutomationRunner = require('./automation-runner');
        const enroll = await AutomationRunner.enrollCustomer({
          templateKey: 'new_lead',
          customer: {
            email: resumeEmail,
            first_name: customer.first_name || null,
            last_name: customer.last_name || null,
            id: holdCustomerId,
          },
          dbh,
        });
        result.enrolled = !!enroll?.enrolled;
        patch.released_drip = true;
      } catch (enrollErr) {
        // Stays pending — the ledger row IS the retryable release.
        await settleHold(hold.id, { last_error: `enroll_failed: ${String(enrollErr.message).slice(0, 200)}` }, dbh);
        logger.warn(`[first-touch-resume] enroll failed for customer ${holdCustomerId} — hold stays pending: ${enrollErr.message}`);
        return { ...result, skipped: 'enroll_failed' };
      }
    }

    let newsletterSettled = !hold.held_newsletter || hold.released_newsletter;
    if (hold.held_newsletter && !hold.released_newsletter) {
      if (deferNewsletter) {
        // Transactional caller: DOI executes post-commit via
        // resumeHeldNewsletterPostCommit, which settles the flag itself.
        result.newsletterResume = {
          holdId: hold.id,
          customerId: holdCustomerId,
          email: resumeEmail,
          firstName: customer.first_name || null,
          lastName: customer.last_name || null,
        };
      } else {
        result.newsletter = await runNewsletterResume({
          customerId: holdCustomerId,
          email: resumeEmail,
          firstName: customer.first_name || null,
          lastName: customer.last_name || null,
        });
        if (newsletterDelivered(result.newsletter)) {
          patch.released_newsletter = true;
          newsletterSettled = true;
        } else {
          patch.last_error = 'newsletter_doi_not_confirmed';
        }
      }
    }

    const dripSettled = !hold.held_drip || hold.released_drip || patch.released_drip;
    if (dripSettled && newsletterSettled) {
      patch.status = 'released';
      patch.released_at = new Date();
      patch.last_error = null;
    }
    if (Object.keys(patch).length) await settleHold(hold.id, patch, dbh);

    result.resumed = result.enrolled || newsletterDelivered(result.newsletter) || !!result.newsletterResume;
    if (result.resumed) {
      logger.info(`[first-touch-resume] customer ${holdCustomerId}: first-touch released (${source}; enrolled=${result.enrolled})`);
    }
    return result;
  } catch (err) {
    logger.warn(`[first-touch-resume] failed (${source}): ${err.message}`);
    return { ...result, skipped: 'error' };
  }
}

// Post-commit companion for transactional callers (same contract as the
// fanout's resendPendingConfirmation): execute the deferred newsletter DOI
// after the edit commits, then settle the ledger. Never throws.
async function resumeHeldNewsletterPostCommit(payload, dbh = db) {
  if (!payload) return null;
  try {
    const outcome = await runNewsletterResume(payload);
    if (payload.holdId) {
      if (newsletterDelivered(outcome)) {
        const hold = await dbh('first_touch_holds').where({ id: payload.holdId }).first('held_drip', 'released_drip');
        const dripSettled = !hold || !hold.held_drip || hold.released_drip;
        await dbh('first_touch_holds').where({ id: payload.holdId }).update({
          released_newsletter: true,
          ...(dripSettled ? { status: 'released', released_at: new Date(), last_error: null } : {}),
          updated_at: new Date(),
        });
      } else {
        await dbh('first_touch_holds').where({ id: payload.holdId })
          .update({ last_error: 'newsletter_doi_not_confirmed', updated_at: new Date() });
      }
    }
    return outcome;
  } catch (err) {
    logger.warn(`[first-touch-resume] post-commit newsletter resume failed for customer ${payload.customerId}: ${err.message}`);
    return null;
  }
}

/**
 * Record (or re-pend) the hold — called by the processor at hold time with
 * the address it ACTUALLY withheld (post dictation-decoder / arbiter /
 * domain-correction, which can differ from the persisted extraction).
 * Idempotent per call; a force-reprocess refreshes the row to pending with
 * the fresh address, and held flags accumulate (drip and newsletter holds
 * are recorded at different steps of the same run).
 */
async function recordFirstTouchHold({ callLogId, customerId = null, heldEmail, heldDrip = false, heldNewsletter = false, dbh = db }) {
  try {
    if (!(await dbh.schema.hasTable('first_touch_holds'))) return null;
    const now = new Date();
    await dbh('first_touch_holds')
      .insert({
        call_log_id: callLogId,
        customer_id: customerId,
        held_email: String(heldEmail || '').trim().toLowerCase(),
        held_drip: heldDrip,
        held_newsletter: heldNewsletter,
        status: 'pending',
        created_at: now,
        updated_at: now,
      })
      .onConflict('call_log_id')
      .merge({
        customer_id: customerId,
        held_email: String(heldEmail || '').trim().toLowerCase(),
        held_drip: dbh.raw('first_touch_holds.held_drip OR excluded.held_drip'),
        held_newsletter: dbh.raw('first_touch_holds.held_newsletter OR excluded.held_newsletter'),
        status: 'pending',
        updated_at: now,
      });
    return true;
  } catch (err) {
    logger.warn(`[first-touch-resume] hold record failed for call ${callLogId}: ${err.message}`);
    return null;
  }
}

module.exports = {
  resumeHeldFirstTouch,
  resumeHeldNewsletterPostCommit,
  recordFirstTouchHold,
  EMAIL_REVIEW_REASON_CODES,
};
