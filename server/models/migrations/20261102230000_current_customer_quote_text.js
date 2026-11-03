/**
 * Current Customer Quote Text (GATE_CURRENT_CUSTOMER_QUOTE_TEXT, owner
 * 2026-11-02 "text and bell"): a current or past customer who sends the
 * website quote form gets the lead text's CALL or TEXT offer.
 *
 * 1. current_customer_quote_texts: one claim row per send attempt.
 *    services/lead-auto-reply.js sendCurrentCustomerQuoteText inserts one
 *    under a per-phone advisory lock only when no row for the phone is under
 *    a day old, before the Twilio call; it stamps the real SID on success and
 *    deletes that row on a provable no-delivery. A stamped row is the witness
 *    the CALL ring and the call/text follow-ups read
 *    (lead-call-reply-ring.js customerBlocker): a current customer's CALL or
 *    TEXT reply counts as a lead's for 7 days, whatever a later attempt does.
 * 2. sms_templates current_customer_quote_text: the text, editable in
 *    Communications → Templates. The lead text's words (owner 2026-10-14)
 *    without "Reply STOP to opt out.": the recipient is a customer, not a
 *    cold first touch (docs/sms-stop-line-policy.md, test 2).
 *
 * Idempotent both ways. The seed writes its sms_template.seeded audit event
 * only when this run inserted the row. down() drops the table; the template
 * seed stays, a documented no-op (waves-db skill §4: a seed rollback never
 * deletes an admin-editable row once it may have been hand-edited).
 */
const MIGRATION = '20261102230000_current_customer_quote_text';

const TABLE = 'current_customer_quote_texts';

const TEMPLATE = {
  template_key: 'current_customer_quote_text',
  name: 'Quote Form Reply (Current Customer)',
  category: 'leads',
  body: "Hello {first_name}, Waves here. We got your quote request. Reply CALL and we'll call you shortly, or TEXT to handle it right here.",
  variables: ['first_name'],
  sort_order: 22,
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.schema.createTable(TABLE, (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('phone_digits', 10).notNullable();
      t.uuid('customer_id');
      t.string('twilio_sid', 64);
      t.timestamp('claimed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index(['phone_digits', 'claimed_at']);
    });
  }

  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const inserted = await knex('sms_templates').insert({
    template_key: TEMPLATE.template_key,
    name: TEMPLATE.name,
    category: TEMPLATE.category,
    body: TEMPLATE.body,
    variables: JSON.stringify(TEMPLATE.variables),
    sort_order: TEMPLATE.sort_order,
    is_active: true,
  }).onConflict('template_key').ignore().returning('id');
  if (inserted.length && await knex.schema.hasTable('audit_log')) {
    await require('../../services/audit-log').recordAuditEvent({
      actor_type: 'system', action: 'sms_template.seeded', resource_type: 'sms_template',
      resource_id: inserted[0].id,
      metadata: { templateKey: TEMPLATE.template_key, migration: MIGRATION },
      trx: knex, critical: true,
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(TABLE);
};

