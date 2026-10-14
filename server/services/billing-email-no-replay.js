// Billing emails that are never re-sent from their stored copy (owner ruling
// 2026-09-27: "never replay; next stage covers"). The amount, due date and
// dunning or verification state each one froze can all change before a
// provider retry or a bounce resend, and each fact would have to be
// re-proven at the provider boundary. A blocked or bounced one settles as
// not sent; the sender renders fresh from live data at its next stage:
// late payment 7→14→30→60→90 days, follow-ups 3→7→14→30(→60→90) and the
// micro-deposit email on the next dunning touch. The legacy pre-visit
// balance email has no next stage: that visit's reminder is not re-sent by
// email (accepted cost; its text leg is separate).
const SENDER_RENDERED_TEMPLATES = new Set([
  'billing_late_payment_7_day', 'billing_late_payment_14_day', 'billing_late_payment_30_day',
  'billing_late_payment_60_day', 'billing_late_payment_90_day',
  'invoice.followup_3_day', 'invoice.followup_7_day', 'invoice.followup_14_day', 'invoice.followup_30_day',
  // The Day 90 ladder's steps (GATE_DUNNING_LADDER_90).
  'invoice.followup_60_day', 'invoice.followup_90_day',
  // The combined-message steps (the customer-level dunning schedule,
  // GATE_DUNNING_CUSTOMER_SCHEDULE) — same doctrine: the amount, invoice count and
  // included invoices can all change before a retry, so the sender
  // re-renders fresh from live data at the next stage rather than
  // replaying a stored copy.
  'invoice.followup_combined_3_day', 'invoice.followup_combined_10_day', 'invoice.followup_combined_17_day',
  'invoice.followup_combined_30_day', 'invoice.followup_combined_60_day', 'invoice.followup_combined_90_day',
  // The dunning diversion's email arm (microdeposit-verification-email.js).
  'payment.microdeposit_verification',
  // The legacy pre-visit balance email (no billing channel choice). The
  // explicit-choice pre-visit email is a billing.notice row that re-quotes
  // the balance on retry (billing-email-provider-replay.js).
  'billing.previsit_balance',
  // The annual rate review letter (rate-review-comms.js) is single-shot:
  // its 30-day clock, eligibility and the GATE_RATE_REVIEW kill switch are
  // judged at the send, and delivery is stamped on its notice by the
  // sender — a provider retry or bounce resend of the stored copy would
  // bypass all three. A blocked or bounced letter is returned to the Rate
  // review batch for a re-send (its reconciliation alert says so).
  'billing.rate_review_notice',
]);

function isSenderRenderedEmail(message) {
  return SENDER_RENDERED_TEMPLATES.has(String(message?.template_key || '').trim());
}

// A skipped email with no later stage: nothing else re-sends it, so staff
// must follow up by hand. The Day 30 follow-up is final unless the Day 90
// ladder (GATE_DUNNING_LADDER_90, read now) carries the invoice on.
// The micro-deposit email names its dunning touch at the end of its
// trigger_event_id (microdeposit_verification_email:<invoice>:<touch>):
// the late-payment tier ('90d') or the follow-up step id.
function isFinalSenderRenderedEmail(message) {
  const ladderLive = process.env.GATE_DUNNING_LADDER_90 === 'true';
  const key = String(message?.template_key || '').trim();
  // Combined-message terminal steps (the customer-level dunning schedule) carry
  // the same final-notice doctrine as their single-invoice counterparts:
  // Day 30 is final only while the Day 90 ladder is off, Day 90 is always
  // final.
  if (key === 'invoice.followup_30_day' || key === 'invoice.followup_combined_30_day') return !ladderLive;
  if (key === 'payment.microdeposit_verification') {
    const touch = String(message?.trigger_event_id || '').split(':').pop();
    return touch === '90d' || touch === 'd90_final_notice' || (touch === 'd30_final' && !ladderLive);
  }
  return [
    'billing_late_payment_90_day', 'invoice.followup_90_day', 'invoice.followup_combined_90_day',
    'billing.previsit_balance',
    // NOT the rate review letter: it is sender-rendered (never replayed), but a
    // bounced or blocked one is returned to the batch for re-send by its own
    // reconciliation alert (rate-review-comms.js), so no "will not be re-sent" alert.
  ].includes(key);
}

const FINAL_NOTICE_CAUSES = {
  blocked: 'SendGrid blocked it',
  bounced: 'it hard-bounced',
};

// A final notice that will never be re-sent gets its own staff alert, once
// per email, whatever else is said about the address: fixing the address
// does not deliver it, so someone has to contact the customer.
async function alertFinalNoticeMissed(message, cause) {
  if (!isFinalSenderRenderedEmail(message) || !message?.id) return;
  if (String(message.recipient_type || '').toLowerCase() === 'test') return;
  const logger = require('./logger');
  const dedupeKey = `billing-final-notice-missed:${message.id}`;
  try {
    const customerId = String(message.recipient_type || '').toLowerCase() === 'customer' ? message.recipient_id || null : null;
    await require('./notification-service').notifyAdmin(
      'alert',
      'Final billing notice not delivered',
      `A final ${message.template_key} email was not delivered (${FINAL_NOTICE_CAUSES[cause] || cause}) and will not be re-sent; no later reminder follows. Contact the customer directly.`,
      {
        link: customerId ? `/admin/customers?customerId=${customerId}` : '/admin/communications',
        // notifyAdmin's own dedupe (advisory lock + metadata key): once per email.
        dedupeKey,
        metadata: { customer_id: customerId, original_message_id: message.id, template_key: message.template_key, cause },
      },
    );
  } catch (err) {
    logger.warn(`[billing-email-no-replay] final-notice alert failed for ${message.id}: ${err.message}`);
  }
}

module.exports = {
  SENDER_RENDERED_TEMPLATES, isSenderRenderedEmail, isFinalSenderRenderedEmail, alertFinalNoticeMissed,
};
