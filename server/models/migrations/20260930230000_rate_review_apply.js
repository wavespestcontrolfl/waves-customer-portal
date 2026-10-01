'use strict';

/**
 * Annual rate review — APPLY lane (plan
 * ~/.claude/plans/annual-rate-review-2026-09-30.md, build step 3; stacked
 * on the ranking tables of 20260930210000).
 *
 * price_change_notices grows the per-customer, per-plan-line columns the
 * rate review needs. The existing monthly-lane notice workflow
 * (services/price-change-notices.js) never sets or reads them — every new
 * column is nullable (or defaulted), so its inserts, the public
 * /price-change/:token page and the activity timeline are byte-identical.
 *
 *   rate_review_row_id     the rate_review_snapshots row this notice carries
 *                          (NULL on a legacy monthly-batch notice)
 *   billing_lane           per_application | monthly_membership | annual_prepay
 *   family_key             the plan line (pest_control, lawn_care, …)
 *   noticed_current_cents  the EXACT numbers shown to the customer — the
 *   noticed_new_cents      apply job charges these and nothing else
 *   applies_from_visit_id  per_application: the first visit billed at the
 *                          new rate (set on apply)
 *   applied_at             when the rate was written (NULL = not yet)
 *   apply_hold_reason      why the nightly apply refused (retried nightly)
 *   apply_attempts         nightly attempts so far
 *
 * rate_review_snapshots.notice_id links the ranking row to its notice (the
 * row stays `approved` until the comms PR sends; `applied` once the rate
 * is written).
 *
 * annual_prepay_terms.next_term_prepay_amount: the renewal amount the
 * customer was noticed for the SUCCESSOR term, written by the apply job on
 * the live term before the renewal reminders go out ("notified amount is
 * the charged amount" — the same invariant the termite renewal_noticed_fee
 * freeze enforces). The live term's own prepay_amount is never touched.
 *
 * Every column is additive and nullable; down() removes exactly what up()
 * added. Dark: GATE_RATE_REVIEW — nothing writes these columns without it.
 */
const NOTICES = 'price_change_notices';
const SNAPSHOTS = 'rate_review_snapshots';
const TERMS = 'annual_prepay_terms';
const LANE_CHECK = 'price_change_notices_billing_lane_check';
const DUE_IDX = 'price_change_notices_rate_review_due_idx';
const ROW_IDX = 'price_change_notices_rate_review_row_idx';

const BILLING_LANES = ['per_application', 'monthly_membership', 'annual_prepay'];

exports.up = async function up(knex) {
  if (await knex.schema.hasTable(NOTICES)) {
    const snapshotsExist = await knex.schema.hasTable(SNAPSHOTS);
    const visitsExist = await knex.schema.hasTable('scheduled_services');
    // The CHECK rides with the column: added only on the run that adds
    // billing_lane, so a re-run never duplicates it.
    const addLaneCheck = !(await knex.schema.hasColumn(NOTICES, 'billing_lane'));
    const cols = {
      rate_review_row_id: (t) => {
        const col = t.uuid('rate_review_row_id');
        if (snapshotsExist) col.references('id').inTable(SNAPSHOTS).onDelete('SET NULL');
      },
      billing_lane: (t) => t.string('billing_lane', 24),
      family_key: (t) => t.string('family_key', 64),
      noticed_current_cents: (t) => t.integer('noticed_current_cents'),
      noticed_new_cents: (t) => t.integer('noticed_new_cents'),
      applies_from_visit_id: (t) => {
        const col = t.uuid('applies_from_visit_id');
        if (visitsExist) col.references('id').inTable('scheduled_services').onDelete('SET NULL');
      },
      applied_at: (t) => t.timestamp('applied_at', { useTz: true }),
      apply_hold_reason: (t) => t.text('apply_hold_reason'),
      apply_attempts: (t) => t.integer('apply_attempts').notNullable().defaultTo(0),
    };
    for (const [name, define] of Object.entries(cols)) {
      if (!(await knex.schema.hasColumn(NOTICES, name))) {
        await knex.schema.alterTable(NOTICES, (t) => define(t));
      }
    }
    if (addLaneCheck) {
      await knex.raw(`ALTER TABLE ${NOTICES} ADD CONSTRAINT ${LANE_CHECK} CHECK (billing_lane IS NULL OR billing_lane IN (${BILLING_LANES.map((l) => `'${l}'`).join(', ')}))`);
    }
    await knex.raw(`CREATE INDEX IF NOT EXISTS ${ROW_IDX} ON ${NOTICES} (rate_review_row_id) WHERE rate_review_row_id IS NOT NULL`);
    // The nightly due scan: rate-review notices not yet applied, by effective date.
    await knex.raw(`CREATE INDEX IF NOT EXISTS ${DUE_IDX} ON ${NOTICES} (effective_date) WHERE rate_review_row_id IS NOT NULL AND applied_at IS NULL`);
  }

  if (await knex.schema.hasTable(SNAPSHOTS) && !(await knex.schema.hasColumn(SNAPSHOTS, 'notice_id'))) {
    const noticesExist = await knex.schema.hasTable(NOTICES);
    await knex.schema.alterTable(SNAPSHOTS, (t) => {
      const col = t.uuid('notice_id');
      if (noticesExist) col.references('id').inTable(NOTICES).onDelete('SET NULL');
    });
  }

  if (await knex.schema.hasTable(TERMS) && !(await knex.schema.hasColumn(TERMS, 'next_term_prepay_amount'))) {
    await knex.schema.alterTable(TERMS, (t) => t.decimal('next_term_prepay_amount', 10, 2));
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable(TERMS) && (await knex.schema.hasColumn(TERMS, 'next_term_prepay_amount'))) {
    await knex.schema.alterTable(TERMS, (t) => t.dropColumn('next_term_prepay_amount'));
  }
  if (await knex.schema.hasTable(SNAPSHOTS) && (await knex.schema.hasColumn(SNAPSHOTS, 'notice_id'))) {
    await knex.schema.alterTable(SNAPSHOTS, (t) => t.dropColumn('notice_id'));
  }
  if (await knex.schema.hasTable(NOTICES)) {
    await knex.raw(`DROP INDEX IF EXISTS ${DUE_IDX}`);
    await knex.raw(`DROP INDEX IF EXISTS ${ROW_IDX}`);
    await knex.raw(`ALTER TABLE ${NOTICES} DROP CONSTRAINT IF EXISTS ${LANE_CHECK}`);
    for (const name of ['apply_attempts', 'apply_hold_reason', 'applied_at', 'applies_from_visit_id', 'noticed_new_cents', 'noticed_current_cents', 'family_key', 'billing_lane', 'rate_review_row_id']) {
      if (await knex.schema.hasColumn(NOTICES, name)) {
        await knex.schema.alterTable(NOTICES, (t) => t.dropColumn(name));
      }
    }
  }
};

exports._private = { BILLING_LANES };
