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
  // The dunning diversion's email arm (microdeposit-verification-email.js).
  'payment.microdeposit_verification',
  // The legacy pre-visit balance email (no billing channel choice). The
  // explicit-choice pre-visit email is a billing.notice row that re-quotes
  // the balance on retry (billing-email-provider-replay.js).
  'billing.previsit_balance',
]);

function isSenderRenderedEmail(message) {
  return SENDER_RENDERED_TEMPLATES.has(String(message?.template_key || '').trim());
}

// A skipped email with no later stage: nothing else re-sends it, so staff
// must follow up by hand. The Day 30 follow-up is final unless the Day 90
// ladder (GATE_DUNNING_LADDER_90, read now) carries the invoice on.
function isFinalSenderRenderedEmail(message) {
  const key = String(message?.template_key || '').trim();
  if (key === 'invoice.followup_30_day') return process.env.GATE_DUNNING_LADDER_90 !== 'true';
  return ['billing_late_payment_90_day', 'invoice.followup_90_day', 'billing.previsit_balance'].includes(key);
}

module.exports = { SENDER_RENDERED_TEMPLATES, isSenderRenderedEmail, isFinalSenderRenderedEmail };
