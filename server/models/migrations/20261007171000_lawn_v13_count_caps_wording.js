/**
 * Lawn protocol v13 count caps: property-wide wording (Codex round 1 on #6104).
 *
 * 20261007170000 (frozen) wrote descriptions that say "per spot" for Celsius and Certainty.
 * The app counts applications per lawn (the treated property) per year, so the descriptions
 * now say that. Arena keeps its label rule as a tech rule: the app enforces 2 applications per
 * lawn per year, and "never treat the same area twice" (label 0.4 lb clothianidin per acre per
 * year) is the tech's job.
 *
 * What this writes: ONLY the description column of the rows 170000 wrote. A row is rewritten
 * only while every field still equals what 170000 wrote (the product-level annual_max_apps row,
 * value, unit, severity and the exact 170000 description). Anything an admin edited is left
 * alone. No value, severity, unit or product id changes. Idempotent.
 *
 * down() puts the 170000 description back, under the same exact-equality guard on the new one.
 */

const base = require('./20261007170000_lawn_v13_count_caps');

const LABEL = 'owner 2026-10-06';

// old description (170000) -> new description, keyed by the row's value/unit/severity.
const REWORDS = [
  {
    from: base.CAPS.find((cap) => cap.name === 'Arena 50 WDG').description,
    to: `Arena 50 WDG: max 2 applications per lawn per year (${LABEL}; label 0.4 lb clothianidin per acre per year). Never treat the same area twice (tech rule, not enforced by the app).`,
  },
  {
    from: base.CAPS.find((cap) => cap.name === 'Celsius WG').description,
    to: `Celsius WG: max 2 applications per lawn per year (${LABEL}).`,
  },
  {
    from: base.CELSIUS_LOWERED.description,
    to: `Celsius WG: max 2 applications per lawn per year (${LABEL}; lowered from 3).`,
  },
  {
    from: base.CAPS.find((cap) => cap.name === 'Certainty Turf Herbicide').description,
    to: `Certainty Turf Herbicide: max 2 applications per lawn per year (${LABEL}).`,
  },
  {
    from: base.CAPS.find((cap) => cap.name === 'Blindside Herbicide').description,
    to: `Blindside Herbicide: max 2 applications per lawn per year (${LABEL}).`,
  },
];

const ROW = { match_type: 'product', limit_type: 'annual_max_apps', limit_value: 2, limit_unit: 'applications', severity: 'hard_block' };

async function rewrite(knex, fromKey, toKey) {
  if (!(await knex.schema.hasTable('product_limits'))) return;
  for (const reword of REWORDS) {
    await knex('product_limits')
      .whereNotNull('product_id')
      .where({ ...ROW, description: reword[fromKey] })
      .update({ description: reword[toKey], updated_at: knex.fn.now() });
  }
}

exports.up = (knex) => rewrite(knex, 'from', 'to');
exports.down = (knex) => rewrite(knex, 'to', 'from');
exports.REWORDS = REWORDS;
