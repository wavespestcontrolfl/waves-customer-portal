/**
 * Report text to on-location contacts (GATE_CONTACT_REPORT_TEXT, owner
 * 2026-10-03). When the account holder's visit-complete text goes out, each
 * confirmed on-location contact gets one plain text with the report link: no
 * pay link, no review ask.
 *
 * contact_report_texts is the one-text-per-contact-per-report ledger:
 * UNIQUE (source_key, phone_key) is the claim. source_key is
 * `record:<service_records.id>` for a single visit and
 * `visit:<service_visits.id>` for a combined stop.
 *
 * contact_report_ready is the owner-approved wording. The row is active: the
 * gate is the switch. Deactivating the row also stops the text.
 */

const TEMPLATE = {
  template_key: 'contact_report_ready',
  name: 'Service Report Ready (On-location Contact)',
  category: 'service-reports',
  // GSM-7 only; "Waves Pest Control" named; no STOP line on a transactional
  // text (docs/sms-stop-line-policy.md).
  body: 'Waves Pest Control: The service report for {street_address} is ready: {report_url}',
  description: 'Sent to each confirmed on-location contact when the account holder\'s visit-complete text goes out (GATE_CONTACT_REPORT_TEXT). Report link only: no pay link, no review ask.',
  variables: ['street_address', 'report_url'],
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('contact_report_texts'))) {
    await knex.schema.createTable('contact_report_texts', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.string('source_key', 80).notNullable();
      t.uuid('scheduled_service_id').nullable();
      t.string('phone_key', 10).notNullable();
      t.string('phone_e164', 20).notNullable();
      t.text('report_url').notNullable();
      t.string('status', 24).notNullable().defaultTo('pending');
      t.string('status_reason', 80).nullable();
      t.integer('attempts').notNullable().defaultTo(0);
      t.timestamp('not_before', { useTz: true }).nullable();
      t.timestamp('claimed_at', { useTz: true }).nullable();
      // Set just before the sender call: a claim that died after it is never retried.
      t.timestamp('send_started_at', { useTz: true }).nullable();
      t.timestamp('sent_at', { useTz: true }).nullable();
      t.timestamps(true, true);
      t.unique(['source_key', 'phone_key']);
      t.index(['status', 'created_at']);
    });
    await knex.raw(`
      ALTER TABLE contact_report_texts
        ADD CONSTRAINT contact_report_texts_status_chk
        CHECK (status IN ('pending', 'sent', 'suppressed', 'failed', 'unknown_delivery'))
    `);
  }
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const existing = await knex('sms_templates').where({ template_key: TEMPLATE.template_key }).first('id');
  if (existing) return;
  await knex('sms_templates').insert({
    template_key: TEMPLATE.template_key,
    name: TEMPLATE.name,
    category: TEMPLATE.category,
    body: TEMPLATE.body,
    description: TEMPLATE.description,
    variables: JSON.stringify(TEMPLATE.variables),
    sort_order: 9,
    is_active: true,
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('contact_report_texts');
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates').where({ template_key: TEMPLATE.template_key }).del();
};

exports.TEMPLATE = TEMPLATE;
