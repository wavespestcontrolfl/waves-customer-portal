/**
 * Two area add-on catalog notes state limits the enforced rules do not have (Codex round 9 on #6135).
 *
 * 20261008200000 wrote the staff-facing `internal_notes` of two rows before the limit rulings settled:
 *   area_addon_bed_pre_emergent       "(two applications a year)"  -> the enforced rule is 4 in 12 months, at least 60 days apart
 *   area_addon_lawn_insect_preventive "once a year (April)"        -> the enforced rule is once in 12 months, any month
 *
 * Rewrites a note only while it still equals the text 20261008200000 wrote (an edited note is never touched). up() records
 * the service keys it changed in a system_settings state row; down() restores the old text only for those, and only while the
 * note still holds the corrected text.
 */
const STATE_KEY = 'migration.20261010130000.state';

const NOTES = [
  {
    serviceKey: 'area_addon_bed_pre_emergent',
    before: 'Snapshot 2.5TG, label 600 lb/acre per 12 months (two applications a year). Version 1 sells one application per estimate; a second is a new estimate.',
    after: 'Snapshot 2.5TG, label 600 lb/acre per 12 months: 4 applications of 3.45 lb/1,000 sq ft, at least 60 days apart (lawn and Tree & Shrub applications count). Version 1 sells one application per estimate; a second is a new estimate.',
  },
  {
    serviceKey: 'area_addon_lawn_insect_preventive',
    before: 'Acelepryn at 0.184 fl oz/1,000 sq ft, once a year (April).',
    after: 'Acelepryn at 0.184 fl oz/1,000 sq ft, once in 12 months, any month (April is the best time, not a limit).',
  },
];

exports.NOTES = NOTES;
exports.STATE_KEY = STATE_KEY;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const changed = [];
  for (const note of NOTES) {
    const row = await knex('services').where({ service_key: note.serviceKey }).first('id', 'internal_notes');
    if (!row || row.internal_notes !== note.before) continue;
    await knex('services').where({ id: row.id }).update({ internal_notes: note.after });
    changed.push(note.serviceKey);
  }
  if (!changed.length || !(await knex.schema.hasTable('system_settings'))) return;
  const existing = await knex('system_settings').where({ key: STATE_KEY }).first();
  let prior = [];
  try { prior = existing ? JSON.parse(existing.value).services || [] : []; } catch { /* keep empty */ }
  const value = JSON.stringify({ services: [...new Set([...prior, ...changed])] });
  if (existing) await knex('system_settings').where({ key: STATE_KEY }).update({ value });
  else await knex('system_settings').insert({ key: STATE_KEY, value });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const existing = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!existing) return;
  let keys = [];
  try { keys = JSON.parse(existing.value).services || []; } catch { /* nothing recorded */ }
  for (const note of NOTES.filter((n) => keys.includes(n.serviceKey))) {
    await knex('services').where({ service_key: note.serviceKey, internal_notes: note.after }).update({ internal_notes: note.before });
  }
  await knex('system_settings').where({ key: STATE_KEY }).del();
};
