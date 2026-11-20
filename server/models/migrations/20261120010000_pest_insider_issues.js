/**
 * pest_insider_issues: one row per Pest Insider issue (services/pest-insider/schedule.js).
 *
 * Issues go out on the 1st and 3rd Thursday of each month. The day before, the shadow planner
 * (Wednesday 7:00 AM ET) plans and builds the issue and records the result here. Nothing is
 * emailed from this table in this step: status 'shadow' means "built, not sent" and 'skipped'
 * means "the builder refused, see reason". The other statuses (drafted, scheduled, sent, held,
 * failed) are for the send path in the next PR; they are listed now because a pushed migration
 * is frozen.
 *
 * issue_date is the send date. A CHECK keeps it to a real issue Thursday (ISODOW 4, day of
 * month 1-7 or 15-21), and UNIQUE makes the planner idempotent: a catch-up tick cannot write
 * a second row for the same issue. diagnostics holds the planner's problem list and ids only,
 * never the email bodies. send_id will point at the newsletter_sends row once there is one.
 *
 * Additive; down drops the table.
 */
const STATUSES = ['shadow', 'skipped', 'drafted', 'scheduled', 'sent', 'held', 'failed'];

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('pest_insider_issues')) return;
  await knex.schema.createTable('pest_insider_issues', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.date('issue_date').notNullable().unique();
    t.string('status', 16).notNullable();
    t.uuid('send_id').nullable().references('id').inTable('newsletter_sends').onDelete('SET NULL');
    t.text('fact_id');
    t.text('species_slug');
    t.text('tool_id');
    t.text('subject');
    t.text('preview');
    t.text('reason');
    t.jsonb('diagnostics').notNullable().defaultTo('{}');
    t.timestamp('built_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`ALTER TABLE pest_insider_issues
    ADD CONSTRAINT pest_insider_issues_issue_date_check
    CHECK (EXTRACT(ISODOW FROM issue_date) = 4
      AND (EXTRACT(DAY FROM issue_date) BETWEEN 1 AND 7 OR EXTRACT(DAY FROM issue_date) BETWEEN 15 AND 21))`);
  await knex.raw(`ALTER TABLE pest_insider_issues
    ADD CONSTRAINT pest_insider_issues_status_check
    CHECK (status IN (${STATUSES.map((s) => `'${s}'`).join(', ')}))`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('pest_insider_issues');
};

exports._STATUSES = STATUSES;
