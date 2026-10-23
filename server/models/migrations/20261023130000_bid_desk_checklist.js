/**
 * Bid Desk, PR B (GATE_BID_CHECKLIST, dark): what the operator records on a bid beyond its dates. Nothing here sends
 * anything to a buyer, a general contractor or an agency; the only output is the admin bell.
 *
 * bid_opportunities gains
 *   solicitation_type         'quote' | 'itb' | 'rfq' | 'rfp' | 'itn' | 'federal' | 'gc_subcontract' | 'other'; NULL = not set
 *   scored                    true = scored proposal, false = pass/fail; NULL = not set
 *   job_walk_mandatory        the job walk is required to bid (default false); the job-walk reminder says so
 *   estimate_id               the estimate (and its proposal) prepared for this bid; ON DELETE SET NULL
 *   submitted_at              when the bid was handed in (what the operator typed)
 *   submission_confirmation   the confirmation number or the words of the receipt
 *   reminder_14d_sent_at      the 14-day reminder before a confirmed due date; each fires once and is cleared when
 *   questions_reminder_sent_at   the date it was computed for changes (due_at, questions_due_at, job_walk_at)
 *   job_walk_reminder_sent_at
 *
 * bid_checklist_items: one row per checklist line of one bid. section groups the lines ("base", "itb", ...);
 * template_key names the template line a row came from (NULL = typed by the operator), so "add missing" never
 * duplicates a line; source_text is the quote or page cite from the solicitation; archived_at hides a line without
 * losing it. The index serves the ordered list of live lines.
 *
 * down() drops the new table and the new columns. They hold only what the operator typed on the Bid Desk (types,
 * walk flags, estimate links, submission records, checklist lines) and the reminder stamps; nothing else reads them.
 */
const BIDS = 'bid_opportunities';
const ITEMS = 'bid_checklist_items';
const TYPES = ['quote', 'itb', 'rfq', 'rfp', 'itn', 'federal', 'gc_subcontract', 'other'];
const list = (values) => values.map((value) => `'${value}'`).join(', ');

exports.TYPES = TYPES;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(BIDS))) return;
  const missing = async (column) => !(await knex.schema.hasColumn(BIDS, column));
  const add = {
    solicitation_type: await missing('solicitation_type'),
    scored: await missing('scored'),
    job_walk_mandatory: await missing('job_walk_mandatory'),
    estimate_id: await missing('estimate_id'),
    submitted_at: await missing('submitted_at'),
    submission_confirmation: await missing('submission_confirmation'),
    reminder_14d_sent_at: await missing('reminder_14d_sent_at'),
    questions_reminder_sent_at: await missing('questions_reminder_sent_at'),
    job_walk_reminder_sent_at: await missing('job_walk_reminder_sent_at'),
  };
  if (Object.values(add).some(Boolean)) {
    await knex.schema.alterTable(BIDS, (t) => {
      if (add.solicitation_type) t.string('solicitation_type', 16).nullable();
      if (add.scored) t.boolean('scored').nullable();
      if (add.job_walk_mandatory) t.boolean('job_walk_mandatory').notNullable().defaultTo(false);
      if (add.estimate_id) t.uuid('estimate_id').nullable().references('id').inTable('estimates').onDelete('SET NULL');
      if (add.submitted_at) t.timestamp('submitted_at', { useTz: true }).nullable();
      if (add.submission_confirmation) t.text('submission_confirmation').nullable();
      if (add.reminder_14d_sent_at) t.timestamp('reminder_14d_sent_at', { useTz: true }).nullable();
      if (add.questions_reminder_sent_at) t.timestamp('questions_reminder_sent_at', { useTz: true }).nullable();
      if (add.job_walk_reminder_sent_at) t.timestamp('job_walk_reminder_sent_at', { useTz: true }).nullable();
    });
  }
  await knex.raw(`ALTER TABLE ${BIDS} DROP CONSTRAINT IF EXISTS bid_opportunities_solicitation_type_check`);
  await knex.raw(`ALTER TABLE ${BIDS} ADD CONSTRAINT bid_opportunities_solicitation_type_check CHECK (solicitation_type IS NULL OR solicitation_type IN (${list(TYPES)}))`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS bid_opportunities_estimate ON ${BIDS} (estimate_id) WHERE estimate_id IS NOT NULL`);

  if (!(await knex.schema.hasTable(ITEMS))) {
    await knex.schema.createTable(ITEMS, (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('bid_id').notNullable().references('id').inTable(BIDS).onDelete('CASCADE');
      t.integer('position').notNullable();
      t.string('section', 24).notNullable();
      t.text('label').notNullable();
      t.text('source_text').nullable();
      t.boolean('required').notNullable().defaultTo(true);
      t.string('template_key', 48).nullable();
      t.timestamp('checked_at', { useTz: true }).nullable();
      t.uuid('checked_by').nullable();
      t.text('notes').nullable();
      t.timestamp('archived_at', { useTz: true }).nullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS bid_checklist_items_bid_position ON ${ITEMS} (bid_id, position) WHERE archived_at IS NULL`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(ITEMS);
  if (!(await knex.schema.hasTable(BIDS))) return;
  await knex.raw('DROP INDEX IF EXISTS bid_opportunities_estimate');
  await knex.raw(`ALTER TABLE ${BIDS} DROP CONSTRAINT IF EXISTS bid_opportunities_solicitation_type_check`);
  const columns = ['solicitation_type', 'scored', 'job_walk_mandatory', 'estimate_id', 'submitted_at', 'submission_confirmation',
    'reminder_14d_sent_at', 'questions_reminder_sent_at', 'job_walk_reminder_sent_at'];
  const present = [];
  for (const column of columns) if (await knex.schema.hasColumn(BIDS, column)) present.push(column);
  if (present.length) {
    await knex.schema.alterTable(BIDS, (t) => { for (const column of present) t.dropColumn(column); });
  }
};
