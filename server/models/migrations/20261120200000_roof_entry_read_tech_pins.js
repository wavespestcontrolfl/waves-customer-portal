'use strict';

/**
 * roof_entry_reads: the points the technician confirmed on the roof photo (owner ruling 2026-11-20, choice 4A: the
 * customer estimate shows only tech-confirmed points, never the AI read).
 *   tech_pins         [{ x, y, type, note }] on the read's crop, x/y as 0-1 image fractions (same frame as ai_flags pins),
 *                     type = an entry type or 'other', note = optional short plain text ("front left"). Null until saved;
 *                     [] = the technician confirmed none.
 *   hide_on_estimate  staff hid the points from this estimate's customer page. Default false.
 *   crop_lat/crop_lng the crop centre (rounded to 5 decimals, the same value the lookup_key hashes), written when the
 *                     pins are saved after the server checked it against lookup_key, so the customer page can rebuild
 *                     the exact county crop the pins sit on. No address is stored.
 * Additive and idempotent (hasColumn guards both ways).
 */
const COLUMNS = ['tech_pins', 'hide_on_estimate', 'crop_lat', 'crop_lng'];

exports.up = async function up(knex) {
  const missing = [];
  for (const c of COLUMNS) if (!(await knex.schema.hasColumn('roof_entry_reads', c))) missing.push(c);
  if (!missing.length) return;
  await knex.schema.alterTable('roof_entry_reads', (t) => {
    if (missing.includes('tech_pins')) t.jsonb('tech_pins').nullable();
    if (missing.includes('hide_on_estimate')) t.boolean('hide_on_estimate').notNullable().defaultTo(false);
    if (missing.includes('crop_lat')) t.decimal('crop_lat', 8, 5).nullable();
    if (missing.includes('crop_lng')) t.decimal('crop_lng', 8, 5).nullable();
  });
};

exports.down = async function down(knex) {
  const present = [];
  for (const c of COLUMNS) if (await knex.schema.hasColumn('roof_entry_reads', c)) present.push(c);
  if (!present.length) return;
  await knex.schema.alterTable('roof_entry_reads', (t) => {
    for (const c of present) t.dropColumn(c);
  });
};
