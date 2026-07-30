/**
 * Resume the HELD first-touch email sends for a call-created lead once the
 * office settles the email read-back question (2026-07-30 lane).
 *
 * The call pipeline holds BOTH first-touch emails while an
 * email_unverified / email_invalid review card is live:
 *   - the new_lead automation drip (Step 6 enroll), and
 *   - the newsletter double-opt-in subscribe.
 * This module is the single release point, invoked from every way the
 * question can settle:
 *   - the operator corrects the email on the record (customer-email-fanout),
 *   - the operator resolves the card as-is in the Triage Inbox
 *     (admin-triage single resolve AND the call-level accept verdict).
 *
 * Consent is RE-CHECKED here (Codex #3084): the original enrollment veto ran
 * inside call processing, and a resume that skipped the recheck could start
 * a marketing sequence for a caller whose extraction said do-not-contact.
 * An active email suppression also blocks the resume — enrolling a
 * suppressed address would just bounce-cancel again.
 *
 * Best-effort by contract: failures log and return { resumed: false } —
 * never break the caller's transition/fanout. enrollCustomer carries its own
 * dedupe, so calling this for a normally-enrolled customer is a no-op.
 */

const db = require('../models/db');
const logger = require('./logger');

const EMAIL_REVIEW_REASON_CODES = ['email_unverified', 'email_invalid'];
// Same permissive-but-real syntax class the fanout uses — the resume is also
// reached when an email_invalid card is resolved as-is, and enrollCustomer
// performs no syntax validation of its own (Codex #3084 r4).
const RESUME_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function customerCallDoNotContact(customerId, dbh) {
  const row = await dbh('call_log')
    .where({ customer_id: customerId })
    .whereRaw("ai_extraction_enriched->'consent'->>'do_not_contact_request' = 'true'")
    .first('id');
  return !!row;
}

// Canonical suppression semantics (Codex #3084 r3): only a suppression that
// the automation lane itself would honor blocks the resume — a group-scoped
// suppression for an unrelated stream (e.g. service_operational) must not
// bury a marketing-drip release. Mirrors automation-runner's own gate.
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

// The newsletter DOI resumes ONLY when this call actually held one — the
// processor stamps held_newsletter on the review card at hold time. An
// existing customer whose card resolution never held a subscribe must not
// receive a DOI email (Codex #3084 r3); the marker also guarantees no
// newsletter_subscribers row exists yet, so the global-connection subscribe
// cannot collide with an uncommitted row move inside a caller's transaction.
async function heldNewsletterCards(customerId, dbh) {
  return dbh('triage_items')
    .whereIn('reason_code', EMAIL_REVIEW_REASON_CODES)
    .whereRaw("payload->>'held_newsletter' = 'true'")
    .whereIn('call_log_id', dbh('call_log').select('id').where({ customer_id: customerId }))
    .select('id', 'payload');
}

// The marker is CONSUMED on successful resume (Codex #3084 r4) — a later
// call's card resolution must not re-trigger a DOI from a stale historical
// marker.
async function consumeHeldNewsletterMarkers(cards, dbh) {
  for (const card of cards) {
    let payload = {};
    try { payload = typeof card.payload === 'string' ? JSON.parse(card.payload || '{}') : (card.payload || {}); } catch { payload = {}; }
    await dbh('triage_items')
      .where({ id: card.id })
      .update({ payload: JSON.stringify({ ...payload, held_newsletter: false, held_newsletter_resumed_at: new Date().toISOString() }), updated_at: new Date() });
  }
}

async function resumeHeldFirstTouch({ customerId, email = null, dbh = db, source = 'email_review_resolved', deferNewsletter = false }) {
  const result = { resumed: false, enrolled: false, newsletter: null, newsletterResume: null, skipped: null };
  try {
    if (!customerId) return { ...result, skipped: 'no_customer' };
    const customer = await dbh('customers')
      .where({ id: customerId })
      .first('id', 'first_name', 'last_name', 'email');
    if (!customer) return { ...result, skipped: 'customer_not_found' };
    const resumeEmail = String(email || customer.email || '').trim().toLowerCase();
    if (!resumeEmail) return { ...result, skipped: 'no_email' };
    if (!RESUME_EMAIL_RE.test(resumeEmail)) return { ...result, skipped: 'invalid_email' };

    if (await customerCallDoNotContact(customerId, dbh)) {
      logger.info(`[first-touch-resume] customer ${customerId}: do-not-contact veto — not resuming (${source})`);
      return { ...result, skipped: 'do_not_contact' };
    }
    if (await emailSuppressedForNewLead(resumeEmail, dbh)) {
      logger.info(`[first-touch-resume] customer ${customerId}: address suppressed — not resuming (${source})`);
      return { ...result, skipped: 'email_suppressed' };
    }

    const AutomationRunner = require('./automation-runner');
    const enroll = await AutomationRunner.enrollCustomer({
      templateKey: 'new_lead',
      customer: {
        email: resumeEmail,
        first_name: customer.first_name || null,
        last_name: customer.last_name || null,
        id: customerId,
      },
      dbh,
    });
    result.enrolled = !!enroll?.enrolled;

    // Newsletter DOI resume — only when the pipeline actually held one for
    // this customer's call (held_newsletter marker). A TRANSACTIONAL caller
    // (the email-correction fanout) must not fire the DOI mid-transaction
    // (Codex #3084 r4): with deferNewsletter the payload is RETURNED for the
    // caller to execute post-commit via resumeHeldNewsletterPostCommit —
    // the same contract as the fanout's pendingConfirmation.
    try {
      const heldCards = await heldNewsletterCards(customerId, dbh);
      if (heldCards.length) {
        const newsletterPayload = {
          customerId,
          email: resumeEmail,
          firstName: customer.first_name || null,
          lastName: customer.last_name || null,
          cardIds: heldCards.map((c) => c.id),
        };
        if (deferNewsletter) {
          result.newsletterResume = newsletterPayload;
        } else {
          const CRP = require('./call-recording-processor');
          if (typeof CRP.resumeNewsletterForCallCustomer === 'function') {
            result.newsletter = await CRP.resumeNewsletterForCallCustomer(newsletterPayload);
            if (result.newsletter && !result.newsletter.skipped) {
              await consumeHeldNewsletterMarkers(heldCards, dbh);
            }
          }
        }
      }
    } catch (newsletterErr) {
      logger.warn(`[first-touch-resume] newsletter resume failed for customer ${customerId}: ${newsletterErr.message}`);
    }

    result.resumed = result.enrolled || !!(result.newsletter && !result.newsletter.skipped);
    if (result.resumed) {
      logger.info(`[first-touch-resume] customer ${customerId}: first-touch resumed (${source}; enrolled=${result.enrolled})`);
    }
    return result;
  } catch (err) {
    logger.warn(`[first-touch-resume] failed for customer ${customerId}: ${err.message}`);
    return { ...result, skipped: 'error' };
  }
}

// Post-commit companion for transactional callers (same contract as the
// fanout's resendPendingConfirmation): execute the deferred newsletter DOI
// after the edit commits, then consume the markers. Never throws.
async function resumeHeldNewsletterPostCommit(payload, dbh = db) {
  if (!payload) return null;
  try {
    const CRP = require('./call-recording-processor');
    if (typeof CRP.resumeNewsletterForCallCustomer !== 'function') return null;
    const outcome = await CRP.resumeNewsletterForCallCustomer(payload);
    if (outcome && !outcome.skipped && Array.isArray(payload.cardIds)) {
      const cards = await dbh('triage_items').whereIn('id', payload.cardIds).select('id', 'payload');
      await consumeHeldNewsletterMarkers(cards, dbh);
    }
    return outcome;
  } catch (err) {
    logger.warn(`[first-touch-resume] post-commit newsletter resume failed for customer ${payload.customerId}: ${err.message}`);
    return null;
  }
}

module.exports = { resumeHeldFirstTouch, resumeHeldNewsletterPostCommit, EMAIL_REVIEW_REASON_CODES };
