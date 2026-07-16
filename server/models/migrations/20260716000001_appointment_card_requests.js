// Single idempotent "request card for appointment" funnel (card-on-file spec
// §3 Phase 5.1) — schema + dark SMS template.
//
// 1. scheduled_services.card_link_sent_at — the one-text-ever claim stamp.
//    The request service's atomic claim (UPDATE ... WHERE card_link_sent_at
//    IS NULL) collapses N concurrent triggers to one send; the stamp never
//    resets except when the claimed send itself fails before the text left.
// 2. appointment_card_requests — one row per visit (unique
//    scheduled_service_id), the capture lifecycle the "secure your
//    appointment" page keys on. Status: pending (link minted) →
//    completed (card captured) | satisfied (auto-secured from an existing
//    consented saved method — no text, no token). stripe_setup_intent_id
//    uniqueness gives the T5b capture page the same webhook/verify
//    idempotency discipline as estimate_card_holds.
// 3. secure_appointment_card SMS template — seeded INACTIVE (same dark lever
//    as service_complete_paid_receipt): the request service refuses to send
//    while the row is missing or inactive, so nothing texts until the owner
//    reviews the copy in /admin templates AND APPOINTMENT_CARD_REQUEST is on.

// Body is GSM-7-safe (no em-dash/curly quotes — UCS-2 would cut the
// per-segment budget to 67 chars) and deliberately tight: {secure_link} is
// the UNSHORTENED /secure/<64-hex> bearer URL (~100 chars — the generic
// 5-char shortener is too weak a credential for a card-capture page), so
// the rendered send runs ~3 GSM segments (card_request maxSegments: 3).
const TEMPLATE = {
  template_key: 'secure_appointment_card',
  name: 'Secure Appointment (card on file link)',
  category: 'billing',
  body: 'Hi {first_name}! To finish booking your {service_type} visit{date_line}, add a card on file. Nothing is charged today - your card is only charged after service is completed: {secure_link}\nWe never take card numbers by phone. Reply STOP to opt out.',
  variables: JSON.stringify(['first_name', 'service_type', 'date_line', 'secure_link']),
  is_active: false,
  sort_order: 32,
  updated_at: new Date(),
};

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('scheduled_services')) {
    if (!(await knex.schema.hasColumn('scheduled_services', 'card_link_sent_at'))) {
      await knex.schema.alterTable('scheduled_services', (t) => {
        t.timestamp('card_link_sent_at', { useTz: true });
      });
    }
  }

  if (!(await knex.schema.hasTable('appointment_card_requests'))) {
    await knex.schema.createTable('appointment_card_requests', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      // Unique per appointment — the table itself enforces "one capture
      // request per visit, ever", whatever path triggered it.
      t.uuid('scheduled_service_id').notNullable().unique()
        .references('id').inTable('scheduled_services').onDelete('CASCADE');
      t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
      // 64-hex page credential (same trust contract as reschedule/estimate
      // tokens). NULL on satisfied rows — no page was ever needed.
      t.string('token', 64).unique();
      t.string('status', 24).notNullable().defaultTo('pending');
      // Which funnel asked: estimate_flow / book_flow / ai_call_pipeline /
      // admin / decline_recovery — observability only, never behavior.
      t.string('trigger', 40);
      t.string('stripe_setup_intent_id', 100).unique();
      t.string('stripe_payment_method_id', 100);
      // Set on satisfied rows: the existing consented saved method that
      // auto-secured the visit.
      t.uuid('payment_method_id').references('id').inTable('payment_methods').onDelete('SET NULL');
      t.timestamp('sent_at', { useTz: true });
      t.timestamp('completed_at', { useTz: true });
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.index(['customer_id'], 'idx_appt_card_requests_customer');
      t.index(['status'], 'idx_appt_card_requests_status');
    });
  }

  if (await knex.schema.hasTable('sms_templates')) {
    await knex('sms_templates')
      .insert({ ...TEMPLATE, created_at: new Date() })
      .onConflict('template_key')
      .merge(TEMPLATE);
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('sms_templates')) {
    await knex('sms_templates').where({ template_key: TEMPLATE.template_key }).del();
  }
  if (await knex.schema.hasTable('appointment_card_requests')) {
    await knex.schema.dropTable('appointment_card_requests');
  }
  if (await knex.schema.hasTable('scheduled_services')) {
    if (await knex.schema.hasColumn('scheduled_services', 'card_link_sent_at')) {
      await knex.schema.alterTable('scheduled_services', (t) => {
        t.dropColumn('card_link_sent_at');
      });
    }
  }
};
