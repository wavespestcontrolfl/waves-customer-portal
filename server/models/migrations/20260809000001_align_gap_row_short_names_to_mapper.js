/**
 * Align two estimate-gap rows' short_names to the v1 mapper vocabulary.
 *
 * The estimate path persists line labels from the v1 legacy mapper's
 * SERVICE_LABEL map (pricing-engine/v1-legacy-mapper.js), which is a
 * DIFFERENT vocabulary from the pricer's own line names. 20260808080000
 * named its rows after the pricer/public-ranges labels; most still
 * resolve because the completion resolver also matches short_name
 * case-insensitively (bora_care 'Bora-Care', plugging 'Plugging',
 * rodent_wire_mesh + rodent_bird_box + rodent_guarantee match on name).
 *
 * Two do not:
 *   dethatching   mapper 'Dethatching'  vs short_name 'Dethatch'
 *   top_dressing  mapper 'Top Dressing' vs short_name 'Top Dress'
 *
 * A visit persisted under those mapper labels resolves NO catalog row and
 * completes on the generic fallback. 20260808080000 is already applied,
 * so this ships as a new migration rather than an edit (knex tracks by
 * filename — an edit is a silent no-op wherever it already ran).
 *
 * Self-healing: each row is updated only if it still holds the exact
 * short_name 20260808080000 wrote (an admin edit since then owns the
 * field). down() restores that prior value under the same rule.
 */

const TARGETS = [
  { service_key: 'dethatching', from: 'Dethatch', to: 'Dethatching' },
  { service_key: 'top_dressing', from: 'Top Dress', to: 'Top Dressing' },
];

const STATE_KEY = 'migration.20260809000001.state';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) {
    console.warn('[short-name-align] services table absent — skipping');
    return;
  }
  const changed = [];
  for (const target of TARGETS) {
    const row = await knex('services').where({ service_key: target.service_key }).first();
    if (!row) {
      console.warn(`[short-name-align] ${target.service_key}: row absent — skipping`);
      continue;
    }
    if (row.short_name !== target.from) {
      console.warn(`[short-name-align] ${target.service_key}: short_name is ${JSON.stringify(row.short_name)}, not the expected ${JSON.stringify(target.from)} — admin-owned, leaving untouched`);
      continue;
    }
    await knex('services').where({ id: row.id }).update({ short_name: target.to });
    changed.push({ id: row.id, key: target.service_key, from: target.from, to: target.to });
    console.log(`[short-name-align] ${target.service_key}: short_name ${target.from} → ${target.to}`);
  }
  if (changed.length > 0 && (await knex.schema.hasTable('system_settings'))) {
    const existing = await knex('system_settings').where({ key: STATE_KEY }).first();
    const value = JSON.stringify({ changed });
    if (existing) await knex('system_settings').where({ key: STATE_KEY }).update({ value });
    else await knex('system_settings').insert({ key: STATE_KEY, value });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('system_settings')) || !(await knex.schema.hasTable('services'))) return;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row) return;
  let changed = [];
  try { ({ changed = [] } = JSON.parse(row.value)); } catch { changed = []; }
  for (const entry of changed) {
    const current = await knex('services').where({ id: entry.id }).first();
    // Only revert if the row still holds exactly what up() wrote.
    if (!current || current.short_name !== entry.to) {
      console.warn(`[short-name-align] down: ${entry.key} short_name changed since deploy — leaving admin value`);
      continue;
    }
    // An in-flight name-only visit persisted under the MAPPER label
    // resolves this row only through the new short_name — reverting it
    // would strand that visit on the generic completion flow, so the
    // alias is kept (the reservation path leaves these rows without
    // service_id; documented boundary). Rollback still un-does the
    // change everywhere it is safe to.
    let inFlight = 0;
    if (await knex.schema.hasTable('scheduled_services')) {
      inFlight += (await knex('scheduled_services').whereRaw('lower(service_type) = lower(?)', [entry.to]).pluck('id')).length;
    }
    if (await knex.schema.hasTable('scheduled_service_addons')) {
      inFlight += (await knex('scheduled_service_addons').whereRaw('lower(service_name) = lower(?)', [entry.to]).pluck('id')).length;
    }
    if (inFlight > 0) {
      console.warn(`[short-name-align] down: ${entry.key} keeps short_name ${JSON.stringify(entry.to)} — ${inFlight} visit(s)/add-on(s) resolve through it`);
      continue;
    }
    await knex('services').where({ id: entry.id }).update({ short_name: entry.from });
  }
  await knex('system_settings').where({ key: STATE_KEY }).del();
};
