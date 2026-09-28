/**
 * Codex round-0 P1 fix for 20260928080000_seed_email_division_templates.js.
 *
 * That migration is already on this branch's remote ref (Railway runs
 * preview migrations on every push), so per waves-db §4 it is never edited
 * in place — this supersedes it with a targeted correction instead:
 *
 *  1. lc.first_visit_pest's "full" fixture stated a fixed re-entry time
 *     ("30 minutes"/"2 hours") for pets and kids. AGENTS.md bans a fixed
 *     re-entry/drying minute figure outright ("safe once dry" + technician
 *     confirms timing) — corrected to name no number.
 *  2. lc.rain_and_treatment's preview text still said "the one-hour rule",
 *     left over from the pre-revision copy the 2026-09-28 draft update
 *     removed (the drying-time claim it named is gone from the body).
 *     Corrected to match the current "dry first / no rain in the forecast"
 *     content.
 *
 * Read-modify-write, guarded on the exact known-stale value (waves-db §4:
 * preserve any admin edit made between the two migrations rather than
 * overwriting wholesale — these are still draft/unpublished rows, but the
 * guard costs nothing and is the house style).
 */

const STALE_PET_ADVISORY = 'Keep pets and kids off the treated foundation line for 30 minutes and off the interior baseboards for 2 hours.';
const FIXED_PET_ADVISORY = "Keep pets and kids off the treated foundation line and interior baseboards until they're dry — the technician confirmed the exact timing on your visit report.";

const STALE_RAIN_PREVIEW = 'The one-hour rule, the 24-hour rule, and why the ants show up right after a storm.';
const FIXED_RAIN_PREVIEW = 'Dry first, no rain in the forecast, and why the ants show up right after a storm.';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('email_template_fixtures') && await knex.schema.hasTable('email_templates')) {
    const template = await knex('email_templates').where({ template_key: 'lc.first_visit_pest' }).first();
    if (template) {
      const fixture = await knex('email_template_fixtures').where({ template_id: template.id, name: 'full' }).first();
      if (fixture) {
        const payload = typeof fixture.payload === 'string' ? JSON.parse(fixture.payload) : (fixture.payload || {});
        if (payload.pet_advisory_sentence === STALE_PET_ADVISORY) {
          payload.pet_advisory_sentence = FIXED_PET_ADVISORY;
          await knex('email_template_fixtures').where({ id: fixture.id }).update({
            payload: JSON.stringify(payload), updated_at: new Date(),
          });
        }
      }
    }
  }

  if (await knex.schema.hasTable('email_template_versions') && await knex.schema.hasTable('email_templates')) {
    const template = await knex('email_templates').where({ template_key: 'lc.rain_and_treatment' }).first();
    if (template) {
      const version = await knex('email_template_versions')
        .where({ template_id: template.id })
        .orderBy('version_number', 'desc')
        .first();
      if (version && version.preview_text === STALE_RAIN_PREVIEW) {
        await knex('email_template_versions').where({ id: version.id }).update({
          preview_text: FIXED_RAIN_PREVIEW, updated_at: new Date(),
        });
      }
    }
  }
};

// Documented no-op (waves-db §4): reverting would restore a compliance
// violation (a fixed re-entry/drying minute figure) and a stale claim.
// Seed/correction rollbacks are never destructive.
exports.down = async function down() {};

exports.__private = { STALE_PET_ADVISORY, FIXED_PET_ADVISORY, STALE_RAIN_PREVIEW, FIXED_RAIN_PREVIEW };
