'use strict';

/**
 * Annual rate review — ranking backend tables (plan
 * ~/.claude/plans/annual-rate-review-2026-09-30.md, build step 2).
 *
 * rate_review_snapshots: one row per (batch, customer, plan line) written by
 * services/rate-review.js#buildBatch — the deterministic ranking of every
 * active recurring plan line whose anniversary falls in the batch window:
 * current rate per billing lane, today's list rate (engine replay or the
 * line+cadence mode), treatment-minute median and revenue per hour, band
 * A/B/C/D, the proposed whole-dollar rate and the exception flags that hold
 * a row out. Nothing in this table is read by billing, completion, or any
 * customer surface; the apply and comms lanes (later PRs) consume it.
 *
 * status lifecycle (CHECK below): this PR writes green | no_change |
 * exception | skipped only. approved | sent | applied are reserved for the
 * reply-APPROVE / notice / apply PRs so the CHECK does not need a widening
 * migration later (knex CHECK constraints are not editable in place). A
 * batch with any `sent` row refuses a rebuild (route + service).
 *
 * rate_review_batches: one row per batch_key — the window it covers and the
 * batch-time references every row was computed against (the per-line
 * conversation allowances, the config in force, the per-line revenue/hour
 * quartiles), so a row is reproducible; also the one-email-per-batch
 * marker (email_sent_at).
 *
 * rate_review_config: single-row (id = 1) knob table, admin-editable later
 * from the Pricing hub → Rate review area. Created here; the defaults are
 * SEEDED by the companion migration (20260930210100), whose down() is a
 * documented no-op so a rollback never erases admin edits.
 *
 * Dark: GATE_RATE_REVIEW (services/config/feature-gates.js). The tables are
 * inert until the gate is on — no reader or writer runs without it.
 */
const SNAPSHOTS = 'rate_review_snapshots';
const BATCHES = 'rate_review_batches';
const CONFIG = 'rate_review_config';
const SNAPSHOT_UNIQUE = 'rate_review_snapshots_batch_customer_family_uniq';
const SNAPSHOT_BATCH_STATUS_IDX = 'rate_review_snapshots_batch_status_idx';
const SNAPSHOT_CUSTOMER_IDX = 'rate_review_snapshots_customer_family_idx';

const SNAPSHOT_STATUSES = ['green', 'exception', 'skipped', 'no_change', 'approved', 'sent', 'applied'];
const LIST_RATE_SOURCES = ['engine', 'cadence_mode', 'none'];

const quoted = (values) => values.map((v) => `'${v}'`).join(', ');

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(SNAPSHOTS))) {
    await knex.schema.createTable(SNAPSHOTS, (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('batch_key', 7).notNullable(); // 'YYYY-MM' — the anniversary month the batch covers
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.string('family_key', 64).notNullable(); // pest_control | lawn_care | tree_shrub | mosquito | termite | rodent | other
      t.string('cadence', 24).notNullable(); // quarterly | bimonthly | monthly | every_6_weeks | semiannual | other
      t.integer('visits_per_year');
      t.string('billing_lane', 24); // customers.billing_mode at compute time (NULL = legacy inference)
      t.date('anniversary_date');
      t.string('anniversary_source', 24); // first_visit | estimate_accept | member_since
      t.integer('tenure_months'); // at the REVIEW date = the anniversary's occurrence inside the batch window
      t.integer('current_rate_cents').notNullable().defaultTo(0);
      t.string('current_rate_source', 32); // visit_median | per_application_fee | ledger_slice | monthly_rate | prepay_term | none
      t.string('rate_unit', 16).notNullable().defaultTo('application'); // application | month
      t.integer('list_rate_cents');
      t.string('list_rate_source', 16).notNullable().defaultTo('none');
      t.decimal('gap_pct', 8, 3); // (list - current) / list * 100; positive = below list
      t.integer('usable_visits').notNullable().defaultTo(0);
      // customer_interaction split of the usable visits: home = the tech
      // spoke with the customer (conversation allowance applied), not_home
      // = full access, nobody home (pure treatment time); the remainder had
      // no interaction value (lower confidence, flag interaction_unknown).
      t.integer('home_visits').notNullable().defaultTo(0);
      t.integer('not_home_visits').notNullable().defaultTo(0);
      t.decimal('allowance_minutes_applied', 6, 2); // the line's allowance in force for this row (null = none applied)
      t.boolean('rph_from_not_home').notNullable().defaultTo(false); // revenue/hour from the account's own not-home visits only
      t.decimal('treatment_minutes_median', 8, 2);
      t.integer('revenue_per_hour_cents');
      t.specificType('band', 'char(1)'); // A | B | C | D
      t.integer('proposed_rate_cents').notNullable().defaultTo(0);
      t.integer('delta_cents').notNullable().defaultTo(0);
      t.integer('annual_delta_cents').notNullable().defaultTo(0);
      t.jsonb('flags').notNullable().defaultTo('[]');
      t.string('status', 16).notNullable();
      t.timestamp('computed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamps(true, true);

      // One row per customer × family per batch: the builder consolidates a
      // family with open visits at two cadences onto the dominant cadence and
      // flags it cadence_conflict (rate-review.js consolidatePlanLines).
      t.unique(['batch_key', 'customer_id', 'family_key'], SNAPSHOT_UNIQUE);
      t.index(['batch_key', 'status'], SNAPSHOT_BATCH_STATUS_IDX);
      t.index(['customer_id', 'family_key'], SNAPSHOT_CUSTOMER_IDX);
    });
    await knex.raw(`ALTER TABLE ${SNAPSHOTS} ADD CONSTRAINT rate_review_snapshots_status_check CHECK (status IN (${quoted(SNAPSHOT_STATUSES)}))`);
    await knex.raw(`ALTER TABLE ${SNAPSHOTS} ADD CONSTRAINT rate_review_snapshots_band_check CHECK (band IS NULL OR band IN ('A', 'B', 'C', 'D'))`);
    await knex.raw(`ALTER TABLE ${SNAPSHOTS} ADD CONSTRAINT rate_review_snapshots_list_source_check CHECK (list_rate_source IN (${quoted(LIST_RATE_SOURCES)}))`);
    await knex.raw(`ALTER TABLE ${SNAPSHOTS} ADD CONSTRAINT rate_review_snapshots_batch_key_check CHECK (batch_key ~ '^[0-9]{4}-[0-9]{2}$')`);
  }

  if (!(await knex.schema.hasTable(BATCHES))) {
    await knex.schema.createTable(BATCHES, (t) => {
      t.string('batch_key', 7).primary();
      t.date('window_from').notNullable();
      t.date('window_to').notNullable();
      // { pest_control: { allowance_minutes, home_median, not_home_median, home_n, not_home_n, source }, ... }
      t.jsonb('allowances').notNullable().defaultTo('{}');
      // rate_review_config values in force when the batch was computed
      t.jsonb('config').notNullable().defaultTo('{}');
      // { pest_control: { q1, median, q3, n }, ... } revenue/hour cents across the book
      t.jsonb('line_rph').notNullable().defaultTo('{}');
      t.integer('book_lines').notNullable().defaultTo(0); // active plan lines in the whole book at build time
      t.timestamp('computed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('email_sent_at', { useTz: true });
      t.text('email_subject');
      t.timestamps(true, true);
    });
    await knex.raw(`ALTER TABLE ${BATCHES} ADD CONSTRAINT rate_review_batches_key_check CHECK (batch_key ~ '^[0-9]{4}-[0-9]{2}$')`);
  }

  if (!(await knex.schema.hasTable(CONFIG))) {
    await knex.schema.createTable(CONFIG, (t) => {
      t.integer('id').primary(); // always 1 (CHECK below) — one row of knobs
      t.decimal('pass_through_pct', 6, 3).notNullable(); // band B: current × (1 + pct/100)
      t.decimal('band_b_tolerance_pct', 6, 3).notNullable(); // |gap| ≤ this → band B
      t.decimal('band_c_max_pct', 6, 3).notNullable(); // gap ≤ this → band C (to list); beyond → D
      t.decimal('cap_pct', 6, 3).notNullable(); // every band: delta ≤ min(cap_pct × current, cap_cents)
      t.integer('cap_cents').notNullable();
      t.integer('min_delta_cents').notNullable(); // smaller proposed delta → no_change
      t.integer('min_usable_visits').notNullable(); // revenue/hour needs this many usable visits
      t.integer('lock_months').notNullable(); // first-year price lock (exception tenure_under_lock)
      t.integer('exception_callback_days').notNullable(); // callback / cancellation-case lookback
      t.integer('exception_manual_edit_months').notNullable(); // manual rate edit lookback
      t.uuid('updated_by'); // technicians.id of the admin who last edited (later UI PR)
      t.timestamps(true, true);
    });
    await knex.raw(`ALTER TABLE ${CONFIG} ADD CONSTRAINT rate_review_config_single_row CHECK (id = 1)`);
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(SNAPSHOTS);
  await knex.schema.dropTableIfExists(BATCHES);
  await knex.schema.dropTableIfExists(CONFIG);
};

exports._private = { SNAPSHOT_STATUSES, LIST_RATE_SOURCES };
