'use strict';

/**
 * Seeds the single rate_review_config row (id = 1) with the plan's defaults
 * (~/.claude/plans/annual-rate-review-2026-09-30.md §3 + the 09-30
 * conversation-time correction):
 *
 *   pass_through_pct 3.5      band B: year pass-through on at-list accounts
 *   band_b_tolerance_pct 5    at list = within ±5% of today's list
 *   band_c_max_pct 10         under list by ≤10% → to list; beyond → band D
 *   cap_pct 12 / cap_cents 1500  cap = the SMALLER of 12% and $15 per application
 *   min_delta_cents 300       a change under $3 is not sent (no_change)
 *   min_usable_visits 3       revenue/hour needs ≥3 usable visits
 *   lock_months 12            first 12 months are locked
 *   exception_callback_days 60
 *   exception_manual_edit_months 6
 *
 * Insert-if-absent only: an existing row (admin-edited through the later
 * Pricing hub → Rate review screen) is never overwritten. down() is a
 * documented NO-OP — the row is admin-editable state, and a blanket revert
 * would erase edits made after this seed (seed-migration rule, 2026-08-09).
 */
const CONFIG = 'rate_review_config';

const DEFAULTS = {
  id: 1,
  pass_through_pct: 3.5,
  band_b_tolerance_pct: 5,
  band_c_max_pct: 10,
  cap_pct: 12,
  cap_cents: 1500,
  min_delta_cents: 300,
  min_usable_visits: 3,
  lock_months: 12,
  exception_callback_days: 60,
  exception_manual_edit_months: 6,
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(CONFIG))) return;
  const existing = await knex(CONFIG).where({ id: 1 }).first('id');
  if (existing) return;
  await knex(CONFIG).insert({ ...DEFAULTS, updated_at: knex.fn.now() });
};

exports.down = async function down() {
  // Documented no-op: rate_review_config row 1 is admin-editable state.
  // Dropping it here would erase edits made after the seed; the table
  // itself is removed by 20260930210000's down().
};

exports._private = { DEFAULTS };
