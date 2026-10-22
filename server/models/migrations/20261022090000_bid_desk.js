/**
 * Bid Desk, PR 1 (GATE_BID_DESK, dark). Bid invites that reach contact@ (BuildingConnected, Procore, a city RFQ, an HOA
 * RFP) used to be filed as ordinary leads and die. These two tables hold one row per bid opportunity and the emails
 * attached to it. Nothing here sends anything to a buyer or a contractor.
 *
 * bid_opportunities
 *   source                   how the bid was found: a BuildingConnected or Procore template, a government/portal
 *                            sender, a subject match, or an operator marking an email by hand
 *   buyer_*, gc_or_agency,
 *   project_title,
 *   package_name             the bid package / bid form ("Termite Treatment", "General Requirements")
 *   solicitation_number,
 *   location                 read ONLY from the fixed provider templates; NULL for any other email
 *   due_at                   the due date as read from the email, or typed by the operator; NULL = not read
 *   due_source_line          the exact line of the email the date was read from (what the operator checks)
 *   due_confirmed            true only after the operator confirms or types the date. Reminders need it.
 *   needs_date_confirmation  an addendum or a different date arrived after the first email; never changes due_at
 *   status                   new -> bid | no_bid -> submitted -> won | lost (the operator moves it)
 *   historical               created by the 180-day backfill: listed, never notified, never reminded
 *   group_key                normalised sender org + project title, for grouping a bid across threads
 *   notified_at              when the "new bid" notification was posted (NULL = none, e.g. historical)
 *   reminder_7d_sent_at,
 *   reminder_2d_sent_at      each reminder fires once; cleared when the operator changes the due date
 *
 * bid_opportunity_emails: one row per email (email_id is unique, so the job is idempotent) with its kind.
 *
 * The closed value lists are checked by the database. down() drops both tables; they hold only what the job wrote.
 */
const BIDS = 'bid_opportunities';
const LINKS = 'bid_opportunity_emails';
const SOURCES = ['buildingconnected', 'procore', 'gov_email', 'email_subject', 'manual'];
const STATUSES = ['new', 'bid', 'no_bid', 'submitted', 'won', 'lost'];
const KINDS = ['invite', 'addendum', 'reminder', 'message'];

const list = (values) => values.map((value) => `'${value}'`).join(', ');

exports.SOURCES = SOURCES;
exports.STATUSES = STATUSES;
exports.KINDS = KINDS;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(BIDS))) {
    await knex.schema.createTable(BIDS, (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('source', 24).notNullable();
      t.text('buyer_name');
      t.text('buyer_email');
      t.text('gc_or_agency');
      t.text('project_title');
      t.text('package_name');
      t.text('solicitation_number');
      t.text('location');
      t.timestamp('due_at', { useTz: true }).nullable();
      t.text('due_source_line');
      t.boolean('due_confirmed').notNullable().defaultTo(false);
      t.timestamp('job_walk_at', { useTz: true }).nullable();
      t.timestamp('questions_due_at', { useTz: true }).nullable();
      t.string('status', 12).notNullable().defaultTo('new');
      t.text('decision_note');
      t.boolean('historical').notNullable().defaultTo(false);
      t.boolean('needs_date_confirmation').notNullable().defaultTo(false);
      t.uuid('first_email_id').nullable().references('id').inTable('emails').onDelete('SET NULL');
      t.text('gmail_thread_id');
      t.text('group_key');
      t.timestamp('notified_at', { useTz: true }).nullable();
      t.timestamp('reminder_7d_sent_at', { useTz: true }).nullable();
      t.timestamp('reminder_2d_sent_at', { useTz: true }).nullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
    await knex.raw(`ALTER TABLE ${BIDS} ADD CONSTRAINT bid_opportunities_source_check CHECK (source IN (${list(SOURCES)}))`);
    await knex.raw(`ALTER TABLE ${BIDS} ADD CONSTRAINT bid_opportunities_status_check CHECK (status IN (${list(STATUSES)}))`);
    await knex.raw(`CREATE INDEX bid_opportunities_thread ON ${BIDS} (gmail_thread_id)`);
    await knex.raw(`CREATE INDEX bid_opportunities_group_key ON ${BIDS} (group_key)`);
    await knex.raw(`CREATE INDEX bid_opportunities_due ON ${BIDS} (due_at) WHERE status IN ('new', 'bid')`);
  }
  if (!(await knex.schema.hasTable(LINKS))) {
    await knex.schema.createTable(LINKS, (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('bid_id').notNullable().references('id').inTable(BIDS).onDelete('CASCADE');
      t.uuid('email_id').notNullable().unique().references('id').inTable('emails').onDelete('CASCADE');
      t.string('kind', 12).notNullable();
      t.timestamp('received_at', { useTz: true }).notNullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index('bid_id');
    });
    await knex.raw(`ALTER TABLE ${LINKS} ADD CONSTRAINT bid_opportunity_emails_kind_check CHECK (kind IN (${list(KINDS)}))`);
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(LINKS);
  await knex.schema.dropTableIfExists(BIDS);
};
