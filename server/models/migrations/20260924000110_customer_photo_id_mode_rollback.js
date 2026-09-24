/**
 * Rollback-safety companion to 20260924000100_customer_photo_id_columns.js.
 *
 * WHY THIS FILE EXISTS INSTEAD OF EDITING 20260924000100 DIRECTLY:
 * 20260924000100 was already pushed to origin as part of PR #4752, so per
 * this repo's migration-guard (and .claude/skills/waves-db §4: "a pushed
 * migration is frozen — fix mistakes with a new migration, never edit"),
 * that file's up()/down() cannot be touched again. This migration supersedes
 * the unsafe part of its down() instead.
 *
 * WHY 20260924000100's down() WOULD FAIL:
 * That migration's down() restores the narrower, original 2-value CHECK —
 * `mode IN ('internal','prospect')` — on both `pest_identifications` and
 * `lawn_diagnostics`. Postgres validates an ADD CONSTRAINT against every
 * EXISTING row at the moment it's added. Once even one real customer photo-
 * id submission exists (mode='customer', written by server/routes/photo-id.js
 * once GATE_CUSTOMER_PHOTO_ID is on), that ADD CONSTRAINT throws and aborts
 * the whole rollback — not just for this migration, but for every migration
 * batched with it, since knex runs a batch's down() calls in one transaction.
 *
 * `tree_shrub_assessments` never got a CHECK constraint on its `mode` column
 * (20260924000100 added the column as a plain string) — 20260924000100's
 * down() drops the column outright regardless of value there, which is safe
 * with no CHECK to violate, so no remap is needed for that table.
 *
 * THE FIX — remap before the CHECK narrows:
 * Because knex runs a batch's migrations in REVERSE order on rollback, this
 * migration's down() (stamp 000110, newer) runs BEFORE 20260924000100's
 * down() (stamp 000100, older) in the same rollback. So this down() gets one
 * chance to make the older migration's down() safe: flip every
 * mode='customer' row to mode='internal' BEFORE the narrower CHECK is ever
 * re-added. `source='portal'` already distinguishes these rows from real
 * tech-captured 'internal' rows (see 20260924000100's up()), so the remap
 * loses no information and is fully reversible — a customer photo-id
 * submission is IDENTIFIABLE FOREVER by `source='portal'`, with or without
 * the 'customer' mode value existing as a CHECK option.
 *
 * up() is a documented no-op: there is no forward schema change here, only a
 * data-safety net for the OTHER migration's down(). Seed/data-correction
 * migrations whose down() must be careful keep an idempotent, side-effect-
 * free up() by convention (waves-db skill §4).
 */

exports.up = async function up() {
  // No-op by design — see header. Nothing forward to change; this migration
  // exists solely to make 20260924000100's down() safe to run.
};

exports.down = async function down(knex) {
  // Runs BEFORE 20260924000100's down() in the same rollback batch (newer
  // stamp rolls back first) — this is what makes that migration's CHECK
  // narrowing safe instead of throwing.
  if (await knex.schema.hasTable('pest_identifications')) {
    await knex('pest_identifications').where({ mode: 'customer' }).update({ mode: 'internal' });
  }
  if (await knex.schema.hasTable('lawn_diagnostics')) {
    await knex('lawn_diagnostics').where({ mode: 'customer' }).update({ mode: 'internal' });
  }
  // tree_shrub_assessments: no CHECK constraint exists on its mode column,
  // so 20260924000100's down() (a plain dropColumn) never throws there —
  // nothing to remap.
};
