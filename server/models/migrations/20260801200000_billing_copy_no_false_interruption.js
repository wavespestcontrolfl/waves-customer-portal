/**
 * Remove the service-interruption threat from billing copy (owner finding
 * 2026-08-01).
 *
 * Five active templates told customers that paying protects their service.
 * Two said it outright; three said the same thing in positive framing, which
 * is the same claim and just as untrue:
 *
 *   balance_reminder_gentle     "keeps your service uninterrupted"
 *   payment_method_expiry       "so your service isn't interrupted"
 *   balance_reminder_firm       "so we can keep you on schedule"
 *   balance_reminder_urgent     "Pay here to keep your appointment"
 *   autopay_retry_final_failed  "Update your card to keep service active"
 *
 * The last one is the sharpest: it goes out at the exact moment the 3-retry
 * ladder exhausts and service_paused_at is set — the one moment a customer
 * might believe it — and the pause it announces stops only their dues, never
 * their visits.
 *
 * Neither is true. Nothing in the platform withholds service for a balance:
 * the visit is scheduled, dispatched and performed regardless, and a new
 * invoice stacks on the old one. The only thing an exhausted autopay ladder
 * does is set customers.service_paused_at, which stops the DUES CRON and
 * renders a dispatcher note — it does not block the appointment (grep:
 * service_paused_at has no scheduling consumer, only billing-cron's skip,
 * MRR at-risk reporting, and the admin-schedule payload).
 *
 * A threat we never carry out is both untrue and a poor collections lever —
 * customers who test it learn the reminder is noise. The replacements keep
 * the ask and the link, and drop the consequence claim. The real consequence
 * of an expired card (the next charge fails) IS true, so that one stays.
 *
 * Deliberately NOT touched here — real consequences, or Adam's call:
 *   late_payment_60d  "to avoid further action"      (vague; owner decision)
 *   late_payment_90d  "may be sent to collections"   (hedged; owner decision)
 *   notification-triggers credential renewal notice  (an expired applicator
 *     license genuinely does stop service — that claim is true, and it goes
 *     to staff, not customers)
 *
 * ADMIN-EDIT SAFETY: sms_templates rows are editable in /admin, so each
 * rewrite carries the exact body this migration audited and the guard lives
 * in the UPDATE predicate. A row edited by hand since matches nothing and is
 * skipped rather than clobbered — same contract as the house-voice sweep.
 */

// [template_key, expected current body, new body]
const REWRITES = [
  ['balance_reminder_gentle',
    "Hello {first_name}! We're scheduled to see you on {service_date}, and your account has an outstanding balance.\n\nTaking care of it before the visit keeps your service uninterrupted: {pay_url}",
    "Hello {first_name}! We're scheduled to see you on {service_date}, and your account has an outstanding balance.\n\nYou can take care of it before the visit here: {pay_url}"],
  ['payment_method_expiry',
    "Hello {first_name}! Your {card_brand} card ending in {last_four} expires {exp_date}. Update it here so your service isn't interrupted: portal.wavespestcontrol.com",
    "Hello {first_name}! Your {card_brand} card ending in {last_four} expires {exp_date}. Update it here so your next payment goes through: portal.wavespestcontrol.com"],
  ['balance_reminder_firm',
    "Hello {first_name}! Your {service_type} is {service_timing} and your account has an outstanding balance.\n\nPlease take care of it so we can keep you on schedule: {pay_url}",
    "Hello {first_name}! Your {service_type} is {service_timing} and your account has an outstanding balance.\n\nYou can take care of it here: {pay_url}"],
  ['balance_reminder_urgent',
    "Hello {first_name}! Your service is {service_timing} and your account has an outstanding balance.\n\nPay here to keep your appointment: {pay_url}\n\nAlready paid? Reply and we'll check.",
    "Hello {first_name}! Your service is {service_timing} and your account has an outstanding balance.\n\nPay here: {pay_url}\n\nAlready paid? Reply and we'll check."],
  ['autopay_retry_final_failed',
    "Hello {first_name}! After several tries your payment of ${amount} still has not gone through. Update your card to keep service active: {update_card_url}",
    // NOT "pay here": {update_card_url} is the generic billing tab, and an
    // exhausted monthly autopay leaves a failed `payments` row, not an open
    // invoice — so the portal may show no Pay now button at all. Promising a
    // payment path that isn't there just swaps one false claim for another.
    "Hello {first_name}! After several tries your payment of ${amount} still has not gone through. You can update your card here: {update_card_url}"],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const cols = await knex('sms_templates').columnInfo();
  if (!cols.body) return;

  let updated = 0;
  const skipped = [];
  for (const [templateKey, expected, next] of REWRITES) {
    const patch = { body: next };
    if (cols.updated_at) patch.updated_at = new Date();
    const matched = await knex('sms_templates')
      .where({ template_key: templateKey, body: expected })
      .update(patch);
    if (matched) updated += 1;
    else skipped.push(templateKey);
  }

  // Rewriting the base row alone is not enough: getTemplate resolves
  // `SmsTemplateVariants.selectVariant(templateKey)` and sends
  // `variant?.body || t.body` (admin-sms-templates.js:412), so a live A/B
  // variant outranks everything above and would keep sending the claim.
  // Prod carries zero variants today, so this is forward cover for one
  // created in /admin against the pre-fix copy — same predicate guard, so a
  // variant whose body was written independently is left alone.
  const variantsUpdated = await rewriteVariants(knex);

  console.log(`[billing-copy] rewrote ${updated} template(s) + ${variantsUpdated} variant(s); skipped ${skipped.length}${skipped.length ? ` (edited since audit or missing): ${skipped.join(', ')}` : ''}`);
};

// Guarded body swap over sms_template_variants, in whichever direction the
// caller needs. Returns the row count changed.
async function rewriteVariants(knex, reverse = false) {
  if (!(await knex.schema.hasTable('sms_template_variants'))) return 0;
  const cols = await knex('sms_template_variants').columnInfo();
  if (!cols.body) return 0;

  let changed = 0;
  for (const [templateKey, expected, next] of REWRITES) {
    const from = reverse ? next : expected;
    const to = reverse ? expected : next;
    const patch = { body: to };
    if (cols.updated_at) patch.updated_at = new Date();
    changed += await knex('sms_template_variants')
      .where({ template_key: templateKey, body: from })
      .update(patch);
  }
  return changed;
}

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const cols = await knex('sms_templates').columnInfo();
  if (!cols.body) return;

  for (const [templateKey, expected, next] of REWRITES) {
    const patch = { body: expected };
    if (cols.updated_at) patch.updated_at = new Date();
    // Same predicate guard as up(): only revert rows still carrying exactly
    // what this migration wrote, so a later hand edit survives a rollback.
    await knex('sms_templates')
      .where({ template_key: templateKey, body: next })
      .update(patch);
  }

  await rewriteVariants(knex, true);
};

module.exports.REWRITES = REWRITES;
