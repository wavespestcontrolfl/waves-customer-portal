/**
 * Phone-linkage snapshot for persisted bridge-ambiguity records (pre-push
 * audit P1 on ambiguity-record r2).
 *
 * The organic sweep's sid and metadata-stamp exclusion arms are durable
 * call↔lead links, so the persisted ambiguity records ride them safely for
 * however long a hold lives. The PHONE arm is not: findReusableCallLead
 * links a phone-bearing call to an existing lead without touching the
 * lead's sid or writing a stamp, and a bare last-10 match kept indefinitely
 * would permanently suppress every LATER, DISTINCT lead reusing the same
 * household number (the r25 bug class). r2 therefore restricted the phone
 * arm to the day's fresh candidates — which reopened the original hole one
 * mode narrower: a phone-linked lead lost its hold the day its ambiguous
 * call aged past the scan window.
 *
 * This table closes it exactly: when an ambiguity is recorded, snapshot the
 * leads whose phone matches the call's CALLER leg at that moment. Those
 * exact associations — not the open-ended number match — carry the
 * indefinite hold. A lead minted on the same number after the ambiguity
 * ages out is a genuinely different prospect and is never suppressed.
 *
 * Insert-only from the app's perspective (ON CONFLICT DO NOTHING); rows are
 * inert while their parent record is resolved and re-arm automatically on a
 * reopen. ON DELETE CASCADE both ways: a purged call or lead leaves nothing
 * to hold.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('bridge_ambiguous_call_leads')) return;
  await knex.schema.createTable('bridge_ambiguous_call_leads', (t) => {
    t.uuid('call_log_id').notNullable()
      .references('call_log_id').inTable('bridge_ambiguous_calls').onDelete('CASCADE');
    t.uuid('lead_id').notNullable()
      .references('id').inTable('leads').onDelete('CASCADE');
    t.timestamp('first_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['call_log_id', 'lead_id']);
  });
  // The daily read joins open parent records to their held leads.
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS bridge_ambiguous_call_leads_lead_index ON bridge_ambiguous_call_leads (lead_id)',
  );
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('bridge_ambiguous_call_leads'))) return;
  await knex.raw('DROP INDEX IF EXISTS bridge_ambiguous_call_leads_lead_index');
  await knex.schema.dropTable('bridge_ambiguous_call_leads');
};
