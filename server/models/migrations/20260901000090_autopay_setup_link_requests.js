// Standalone "set up Auto Pay" link (owner ruling 2026-09-01) — a
// customer-scoped MODE of appointment_card_requests, not a new table:
//
// 1. scheduled_service_id becomes NULLABLE. Its UNIQUE constraint stays —
//    Postgres uniqueness ignores NULLs, so the visit lane's one-row-per-visit
//    contract (and its onConflict inserts) is untouched while standalone rows
//    carry no visit.
// 2. kind ('visit' | 'customer', default 'visit') tells the page/router/
//    webhook which mode a row is; expires_at is the standalone row's
//    liveness (the visit lane derives "closed" from the visit instead).
// 3. Partial unique on (customer_id) WHERE kind='customer' AND status IN
//    ('pending','completing') — one live standalone link per customer; the
//    request service retires an expired pending row before minting a fresh
//    one and reuses a live (pending or mid-completion) row's token.
// 4. autopay_setup_link SMS template — seeded INACTIVE (same dark lever as
//    secure_appointment_card): the operator "Text link" action refuses to
//    send until the owner reviews the copy in /admin templates AND
//    GATE_AUTOPAY_SETUP_LINK is on.
//
// Body is GSM-7-safe (no em-dash/curly quotes) and carries the unshortened
// /secure/<token> bearer URL.
const TEMPLATE = {
  template_key: 'autopay_setup_link',
  name: 'Auto Pay setup link (standalone)',
  category: 'billing',
  body: 'Hi {first_name}! Set up Auto Pay for your Waves service here: {secure_link}\nSave a card or bank account and each visit is paid automatically after it is completed. Nothing is charged today. We never take card numbers by phone. Reply STOP to opt out.',
  variables: JSON.stringify(['first_name', 'secure_link']),
  is_active: false,
  sort_order: 33,
  updated_at: new Date(),
};

const PARTIAL_UNIQUE = 'uq_appt_card_requests_customer_pending_standalone';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('appointment_card_requests'))) return;

  await knex.raw('ALTER TABLE appointment_card_requests ALTER COLUMN scheduled_service_id DROP NOT NULL');

  if (!(await knex.schema.hasColumn('appointment_card_requests', 'kind'))) {
    await knex.schema.alterTable('appointment_card_requests', (t) => {
      t.string('kind', 16).notNullable().defaultTo('visit');
    });
  }
  if (!(await knex.schema.hasColumn('appointment_card_requests', 'expires_at'))) {
    await knex.schema.alterTable('appointment_card_requests', (t) => {
      t.timestamp('expires_at', { useTz: true });
    });
  }
  // 'completing' is still a LIVE link (the completion claim, which can
  // revert to pending) — one live standalone link per customer means both
  // statuses are covered (pre-push Codex P1).
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${PARTIAL_UNIQUE}
    ON appointment_card_requests (customer_id)
    WHERE kind = 'customer' AND status IN ('pending', 'completing')`);

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
  if (!(await knex.schema.hasTable('appointment_card_requests'))) return;
  await knex.raw(`DROP INDEX IF EXISTS ${PARTIAL_UNIQUE}`);
  // Standalone rows cannot satisfy NOT NULL — remove them before restoring
  // the visit lane's original constraint (they are inert without the code
  // that reads `kind`).
  if (await knex.schema.hasColumn('appointment_card_requests', 'kind')) {
    await knex('appointment_card_requests').where({ kind: 'customer' }).del();
    await knex.schema.alterTable('appointment_card_requests', (t) => {
      t.dropColumn('kind');
    });
  }
  if (await knex.schema.hasColumn('appointment_card_requests', 'expires_at')) {
    await knex.schema.alterTable('appointment_card_requests', (t) => {
      t.dropColumn('expires_at');
    });
  }
  await knex.raw('ALTER TABLE appointment_card_requests ALTER COLUMN scheduled_service_id SET NOT NULL');
};
