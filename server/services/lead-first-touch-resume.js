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

// Every pending hold in scope (a customer can hold from multiple calls —
// an email edit must release ALL of them, Codex #3084 r7). A 'releasing'
// claim older than the stale window belongs to a dead worker and is
// reclaimable.
const STALE_CLAIM_MS = 10 * 60 * 1000;

async function findPendingHolds({ callLogId = null, customerId = null, dbh }) {
  if (!(await dbh.schema.hasTable('first_touch_holds'))) return [];
  let q = dbh('first_touch_holds').where(function scope() {
    this.where({ status: 'pending' })
      .orWhere(function stale() {
        this.where({ status: 'releasing' })
          .where('updated_at', '<', new Date(Date.now() - STALE_CLAIM_MS));
      });
  });
  if (callLogId) q = q.where({ call_log_id: callLogId });
  else if (customerId) q = q.where({ customer_id: customerId });
  else return [];
  return q.orderBy('created_at', 'asc').select('*');
}

// Atomic claim (Codex #3084 r7): two release paths racing the same hold —
// a triage verdict against the end-of-run reconciliation — must not both
// run the DOI side effect. The winner flips pending→releasing; the loser's
// conditional update affects 0 rows and skips. Failure paths revert to
// pending (retryable); terminal paths settle released/blocked.
async function claimHold(hold, dbh) {
  const claimed = await dbh('first_touch_holds')
    .where({ id: hold.id })
    .where(function claimable() {
      this.where({ status: 'pending' })
        .orWhere(function stale() {
          this.where({ status: 'releasing' })
            .where('updated_at', '<', new Date(Date.now() - STALE_CLAIM_MS));
        });
    })
    .update({ status: 'releasing', updated_at: new Date() });
  return claimed > 0;
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
 * Release EVERY pending first-touch hold in scope — a call (triage paths)
 * or a customer (email-correction paths; one customer can hold from several
 * calls). `email` (a corrected address) overrides each ledger row's
 * held_email; the customer's STORED email is deliberately never used — for
 * a matched existing customer it can be a different, stale address than the
 * one confirmed on the call.
 */
async function resumeHeldFirstTouch({
  customerId = null,
  callLogId = null,
  email = null,
  dbh = db,
  source = 'email_review_resolved',
  deferNewsletter = false,
} = {}) {
  const result = { resumed: false, enrolled: false, newsletter: null, newsletterResume: [], skipped: null };
  try {
    const holds = await findPendingHolds({ callLogId, customerId, dbh });
    if (!holds.length) return { ...result, newsletterResume: null, skipped: 'no_pending_hold' };

    for (const hold of holds) {
      if (!(await claimHold(hold, dbh))) continue; // another release path owns it

      const holdCustomerId = hold.customer_id || customerId;
      if (!holdCustomerId) {
        await settleHold(hold.id, { status: 'pending', last_error: 'no_customer_linked' }, dbh);
        continue;
      }
      const customer = await dbh('customers')
        .where({ id: holdCustomerId })
        .first('id', 'first_name', 'last_name');
      if (!customer) {
        await settleHold(hold.id, { status: 'pending', last_error: 'customer_not_found' }, dbh);
        continue;
      }

      const resumeEmail = String(email || hold.held_email || '').trim().toLowerCase();
      if (!resumeEmail || !RESUME_EMAIL_RE.test(resumeEmail)) {
        // Back to pending: a later correction releases it.
        await settleHold(hold.id, { status: 'pending', last_error: 'invalid_email' }, dbh);
        result.skipped = result.skipped || 'invalid_email';
        continue;
      }

      if (await customerCallDoNotContact(holdCustomerId, dbh)) {
        await settleHold(hold.id, { status: 'blocked', last_error: 'do_not_contact' }, dbh);
        logger.info(`[first-touch-resume] customer ${holdCustomerId}: do-not-contact veto — hold blocked (${source})`);
        result.skipped = result.skipped || 'do_not_contact';
        continue;
      }
      if (await emailSuppressedForNewLead(resumeEmail, dbh)) {
        // Back to pending: a corrected address after a bounce releases it.
        await settleHold(hold.id, { status: 'pending', last_error: 'email_suppressed' }, dbh);
        logger.info(`[first-touch-resume] customer ${holdCustomerId}: address suppressed — hold stays pending (${source})`);
        result.skipped = result.skipped || 'email_suppressed';
        continue;
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
          result.enrolled = result.enrolled || !!enroll?.enrolled;
          patch.released_drip = true;
        } catch (enrollErr) {
          // Back to pending — the ledger row IS the retryable release.
          await settleHold(hold.id, { status: 'pending', last_error: `enroll_failed: ${String(enrollErr.message).slice(0, 200)}` }, dbh);
          logger.warn(`[first-touch-resume] enroll failed for customer ${holdCustomerId} — hold stays pending: ${enrollErr.message}`);
          result.skipped = result.skipped || 'enroll_failed';
          continue;
        }
      }

      let newsletterSettled = !hold.held_newsletter || hold.released_newsletter;
      let deferredThisHold = false;
      if (hold.held_newsletter && !hold.released_newsletter) {
        if (deferNewsletter) {
          // Transactional caller: DOI executes post-commit via
          // resumeHeldNewsletterPostCommit, which settles the row itself.
          // The claim stays 'releasing' until then (stale-claim window
          // reclaims it if the process dies before commit).
          result.newsletterResume.push({
            holdId: hold.id,
            customerId: holdCustomerId,
            email: resumeEmail,
            firstName: customer.first_name || null,
            lastName: customer.last_name || null,
          });
          deferredThisHold = true;
        } else {
          const outcome = await runNewsletterResume({
            customerId: holdCustomerId,
            email: resumeEmail,
            firstName: customer.first_name || null,
            lastName: customer.last_name || null,
          });
          result.newsletter = outcome;
          if (newsletterDelivered(outcome)) {
            patch.released_newsletter = true;
            newsletterSettled = true;
          } else {
            patch.status = 'pending';
            patch.last_error = 'newsletter_doi_not_confirmed';
          }
        }
      }

      const dripSettled = !hold.held_drip || hold.released_drip || patch.released_drip;
      if (dripSettled && newsletterSettled && !deferredThisHold) {
        patch.status = 'released';
        patch.released_at = new Date();
        patch.last_error = null;
      } else if (!deferredThisHold && !patch.status) {
        patch.status = 'pending';
      }
      if (Object.keys(patch).length) await settleHold(hold.id, patch, dbh);

      result.resumed = result.resumed || result.enrolled
        || newsletterDelivered(result.newsletter) || deferredThisHold;
    }

    if (!result.newsletterResume.length) result.newsletterResume = null;
    if (result.resumed) {
      logger.info(`[first-touch-resume] released first-touch hold(s) (${source}; enrolled=${result.enrolled})`);
    }
    return result;
  } catch (err) {
    logger.warn(`[first-touch-resume] failed (${source}): ${err.message}`);
    return { ...result, newsletterResume: null, skipped: 'error' };
  }
}

// Post-commit companion for transactional callers (same contract as the
// fanout's resendPendingConfirmation): execute the deferred newsletter DOI
// after the edit commits, then settle the ledger. Never throws.
async function resumeHeldNewsletterPostCommit(payloadOrList, dbh = db) {
  if (!payloadOrList) return null;
  if (Array.isArray(payloadOrList)) {
    const outcomes = [];
    for (const p of payloadOrList) outcomes.push(await resumeHeldNewsletterPostCommit(p, dbh));
    return outcomes;
  }
  const payload = payloadOrList;
  try {
    const outcome = await runNewsletterResume(payload);
    if (payload.holdId) {
      if (newsletterDelivered(outcome)) {
        const hold = await dbh('first_touch_holds').where({ id: payload.holdId }).first('held_drip', 'released_drip');
        const dripSettled = !hold || !hold.held_drip || hold.released_drip;
        await dbh('first_touch_holds').where({ id: payload.holdId }).update({
          released_newsletter: true,
          status: dripSettled ? 'released' : 'pending',
          ...(dripSettled ? { released_at: new Date(), last_error: null } : {}),
          updated_at: new Date(),
        });
      } else {
        // Back to pending — the DOI never confirmed; the next release
        // trigger retries it.
        await dbh('first_touch_holds').where({ id: payload.holdId })
          .update({ status: 'pending', last_error: 'newsletter_doi_not_confirmed', updated_at: new Date() });
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
 *
 * Two force-reprocess/race guards when `runStartedAt` is passed:
 *   - A LIVE card minted by an earlier run means the operator is still
 *     reviewing the PREVIOUS address (triage inserts keep the old card via
 *     onConflict-ignore) — resolving that card must release the address it
 *     shows, so the existing held_email is preserved over the fresh guess.
 *   - A row RELEASED during this run means an operator settled the question
 *     mid-run (email correction / accept verdict) — that action's address is
 *     authoritative, so the new hold re-pends against the customer's stored
 *     address (which the correction fanout just wrote), never the stale
 *     in-memory candidate captured before it.
 *
 * The write retries transient failures — this row is the ONLY durable record
 * the release paths read, so processing must not finish without it.
 */
const HOLD_RECORD_ATTEMPTS = 3;

async function recordFirstTouchHold({ callLogId, customerId = null, heldEmail, heldDrip = false, heldNewsletter = false, runStartedAt = null, dbh = db }) {
  for (let attempt = 1; attempt <= HOLD_RECORD_ATTEMPTS; attempt++) {
    try {
      if (!(await dbh.schema.hasTable('first_touch_holds'))) return null;
      const now = new Date();
      let emailToRecord = String(heldEmail || '').trim().toLowerCase();
      if (runStartedAt) {
        const existing = await dbh('first_touch_holds')
          .where({ call_log_id: callLogId })
          .first('held_email', 'status', 'released_at');
        if (existing && existing.status === 'released'
            && existing.released_at && new Date(existing.released_at) >= runStartedAt) {
          const cust = customerId
            ? await dbh('customers').where({ id: customerId }).first('email')
            : null;
          const settledEmail = String(cust?.email || existing.held_email || '').trim().toLowerCase();
          if (settledEmail) emailToRecord = settledEmail;
        } else if (existing && existing.held_email) {
          const cardFromEarlierRun = await dbh('triage_items')
            .where({ call_log_id: callLogId })
            .whereIn('reason_code', EMAIL_REVIEW_REASON_CODES)
            .whereIn('status', ['open', 'in_progress'])
            .where('created_at', '<', runStartedAt)
            .first('id');
          if (cardFromEarlierRun) {
            emailToRecord = String(existing.held_email).trim().toLowerCase();
          }
        }
      }
      await dbh('first_touch_holds')
        .insert({
          call_log_id: callLogId,
          customer_id: customerId,
          held_email: emailToRecord,
          held_drip: heldDrip,
          held_newsletter: heldNewsletter,
          status: 'pending',
          created_at: now,
          updated_at: now,
        })
        .onConflict('call_log_id')
        .merge({
          customer_id: customerId,
          held_email: emailToRecord,
          held_drip: dbh.raw('first_touch_holds.held_drip OR excluded.held_drip'),
          held_newsletter: dbh.raw('first_touch_holds.held_newsletter OR excluded.held_newsletter'),
          status: 'pending',
          updated_at: now,
        });
      return true;
    } catch (err) {
      if (attempt === HOLD_RECORD_ATTEMPTS) {
        logger.error(`[first-touch-resume] hold record failed for call ${callLogId} after ${HOLD_RECORD_ATTEMPTS} attempts: ${err.message}`);
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
  return null;
}

module.exports = {
  resumeHeldFirstTouch,
  resumeHeldNewsletterPostCommit,
  recordFirstTouchHold,
  EMAIL_REVIEW_REASON_CODES,
};
