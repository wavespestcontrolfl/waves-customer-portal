'use strict';

/**
 * rate_review_snapshots.review_date — the anniversary's occurrence inside
 * the batch window (the date the line is reviewed AT; tenure for the
 * 12-month lock is measured at it) or, for a row carried forward from an
 * earlier batch (flag carried_forward), that earlier row's review date.
 * Stored at the source by services/rate-review.js so the admin screen reads
 * it instead of re-deriving it from anniversary_date (the line's START
 * date, which can be years earlier).
 *
 * Additive, nullable; down() drops it. Stacked lane stamps: 20260930210000 /
 * 210100 (ranking), 220000 (UI child), 230000 (apply child) — this one sits
 * between the ranking pair and the children. Dark behind GATE_RATE_REVIEW.
 */
const SNAPSHOTS = 'rate_review_snapshots';
const COLUMN = 'review_date';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(SNAPSHOTS))) return;
  if (await knex.schema.hasColumn(SNAPSHOTS, COLUMN)) return;
  await knex.schema.alterTable(SNAPSHOTS, (t) => t.date(COLUMN));
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(SNAPSHOTS))) return;
  if (!(await knex.schema.hasColumn(SNAPSHOTS, COLUMN))) return;
  await knex.schema.alterTable(SNAPSHOTS, (t) => t.dropColumn(COLUMN));
};
