/**
 * Referral invite email (referral.invite template) — owner trigger call
 * 2026-07-06: fires on a POSITIVE review submission (the existing
 * promoter definition in review-request.js, rating >= 7). The warmest
 * moment we have with a customer is right after they told us we did a
 * good job — that's when the ask lands as a favor, not a pitch.
 *
 * Once per customer EVER (idempotency key is customer-scoped): a repeat
 * promoter rating us 9/10 quarterly should not be re-invited each time.
 *
 * The reward line is composed from LIVE referral_program_settings so
 * amounts are never baked into copy; the referee clause drops cleanly
 * when no referee discount is configured.
 *
 * Best-effort by contract — callers fire-and-forget; a failure must
 * never affect the review submission response.
 */

const db = require('../models/db');
const logger = require('./logger');

const FALLBACK_PORTAL_HOME_URL = 'https://portal.wavespestcontrol.com';

function dollars(cents) {
  const n = Number(cents || 0) / 100;
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

async function sendReferralInviteEmail({ customerId, trigger = 'positive_review' } = {}) {
  try {
    if (!customerId) return null;

    // One referral email per customer (owner rule 2026-07-11): with the gate
    // on, the Automations-tab referral_nudge sequence (editable in the tab)
    // IS the invite — it replaces the transactional referral.invite template.
    // Once-ever dedupe mirrors this function's own customer-scoped
    // idempotency; both call sites (review-gate + review-request promoter
    // hooks) flow through here unchanged. The referral SMS nudge is a
    // separate channel and is unaffected. Known one-time overlap: a customer
    // already invited via referral.invite pre-flip who submits another
    // promoter rating post-flip has no enrollment row yet and gets the
    // sequence once — accepted, noted on the PR.
    //
    // OPERATIONAL COUPLING (accepted trade of tab-editable copy): the
    // sequence's reward line is static copy, unlike the transactional
    // invite's live referral_program_settings lookup. Changing the referral
    // reward in admin REQUIRES editing the referral_nudge step copy to
    // match — same as any other fact baked into an editable automation.
    // Copy verified in sync at wiring time ($25, #2621).
    const { isEnabled } = require('../config/feature-gates');
    if (isEnabled('referralNudgeEnroll')) {
      const { enrollSequenceFromEvent } = require('./automation-enroll');
      return enrollSequenceFromEvent({
        templateKey: 'referral_nudge',
        customerId,
        dedupe: 'ever',
        source: `referral_${trigger}`,
      });
    }

    const customer = await db('customers')
      .where({ id: customerId })
      .first('id', 'first_name', 'email');
    const email = String(customer?.email || '').trim();
    if (!email || !email.includes('@')) {
      logger.info(`[referral-invite-email] no usable email for customer ${customerId}; skipping invite`);
      return null;
    }

    const { getSettings } = require('./referral-engine');
    const settings = await getSettings();
    const referrer = dollars(settings.referrer_reward_cents);
    const refereeCents = Number(settings.referee_discount_cents || 0);
    const rewardLine = refereeCents > 0
      ? `you get a ${referrer} referral reward and they get ${dollars(refereeCents)} off their first service.`
      : `you get a ${referrer} referral reward.`;

    const EmailTemplateLibrary = require('./email-template-library');
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey: 'referral.invite',
      to: email,
      payload: {
        first_name: String(customer.first_name || '').trim() || 'there',
        referral_url: `${FALLBACK_PORTAL_HOME_URL}/?tab=refer`,
        referral_reward_line: rewardLine,
      },
      recipientType: 'customer',
      recipientId: customerId,
      // Customer-scoped on purpose: one invite per customer, ever.
      idempotencyKey: `referral.invite:customer:${customerId}`,
      triggerEventId: `referral.invite:${trigger}:${customerId}`,
      categories: ['referral_invite'],
      // SendGrid 4xx bodies can echo the recipient address — keep provider
      // errors out of the logs and log a redacted reason below.
      suppressProviderErrorLog: true,
    });
    logger.info(`[referral-invite-email] invite sent to customer ${customerId} (trigger=${trigger})`);
    return result;
  } catch (err) {
    const reason = err.status
      ? `SendGrid ${err.status}`
      : require('./email-template-library').redactEmailAddresses(err.message);
    logger.warn(`[referral-invite-email] failed for customer ${customerId}: ${reason}`);
    return null;
  }
}

module.exports = { sendReferralInviteEmail };
