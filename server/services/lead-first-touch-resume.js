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

async function customerCallDoNotContact(customerId, dbh) {
  const row = await dbh('call_log')
    .where({ customer_id: customerId })
    .whereRaw("ai_extraction_enriched->'consent'->>'do_not_contact_request' = 'true'")
    .first('id');
  return !!row;
}

async function emailSuppressed(email, dbh) {
  if (!(await dbh.schema.hasTable('email_suppressions'))) return false;
  const row = await dbh('email_suppressions')
    .where({ email: String(email).trim().toLowerCase(), status: 'active' })
    .first('id');
  return !!row;
}

async function resumeHeldFirstTouch({ customerId, email = null, dbh = db, source = 'email_review_resolved' }) {
  const result = { resumed: false, enrolled: false, newsletter: null, skipped: null };
  try {
    if (!customerId) return { ...result, skipped: 'no_customer' };
    const customer = await dbh('customers')
      .where({ id: customerId })
      .first('id', 'first_name', 'last_name', 'email');
    if (!customer) return { ...result, skipped: 'customer_not_found' };
    const resumeEmail = String(email || customer.email || '').trim().toLowerCase();
    if (!resumeEmail) return { ...result, skipped: 'no_email' };

    if (await customerCallDoNotContact(customerId, dbh)) {
      logger.info(`[first-touch-resume] customer ${customerId}: do-not-contact veto — not resuming (${source})`);
      return { ...result, skipped: 'do_not_contact' };
    }
    if (await emailSuppressed(resumeEmail, dbh)) {
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

    // Newsletter DOI resume — the held candidate was in-memory only, so it is
    // re-derived here. Runs on the GLOBAL connection deliberately: the DOI
    // email is a side effect that cannot be rolled back anyway, and the
    // subscribe helper carries its own invalid/unsubscribed/strict guards.
    try {
      const CRP = require('./call-recording-processor');
      if (typeof CRP.resumeNewsletterForCallCustomer === 'function') {
        result.newsletter = await CRP.resumeNewsletterForCallCustomer({
          customerId,
          email: resumeEmail,
          firstName: customer.first_name || null,
          lastName: customer.last_name || null,
        });
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

const EMAIL_REVIEW_REASON_CODES = ['email_unverified', 'email_invalid'];

module.exports = { resumeHeldFirstTouch, EMAIL_REVIEW_REASON_CODES };
