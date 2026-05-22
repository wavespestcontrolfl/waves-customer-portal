/**
 * Fix the 3-day invoice follow-up SMS template body.
 *
 * The prior seed used "Your {invoice_title} invoice still has an open balance..."
 * paired with a fallback of "your service" when `invoices.title` is empty,
 * which rendered as "Your your service invoice...". Rephrase to "Your invoice
 * for {invoice_title}..." so the fallback reads naturally, matching the
 * 7-day / 14-day / 30-day follow-up wording.
 *
 * Idempotent: only rewrites the row if its body still matches the broken seed.
 */

const BROKEN_BODY =
  "Hello {first_name}! Your {invoice_title} invoice still has an open balance of ${amount}. " +
  "Pay securely here: {pay_url}\n\nIf something looks off, reply and we'll sort it.";

const FIXED_BODY =
  "Hello {first_name}! Your invoice for {invoice_title} still has an open balance of ${amount}. " +
  "Pay securely here: {pay_url}\n\nIf something looks off, reply and we'll sort it.";

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const row = await knex('sms_templates')
    .where({ template_key: 'invoice_followup_3day' })
    .first();

  if (!row) return;
  if (row.body !== BROKEN_BODY) return; // admin edited copy — leave it alone

  await knex('sms_templates')
    .where({ template_key: 'invoice_followup_3day' })
    .update({ body: FIXED_BODY, updated_at: new Date() });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const row = await knex('sms_templates')
    .where({ template_key: 'invoice_followup_3day' })
    .first();

  if (!row || row.body !== FIXED_BODY) return;

  await knex('sms_templates')
    .where({ template_key: 'invoice_followup_3day' })
    .update({ body: BROKEN_BODY, updated_at: new Date() });
};
