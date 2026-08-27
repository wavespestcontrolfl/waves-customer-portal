/**
 * services.rodent_trapping_followup: an INCLUDED callback, never a $95
 * separately billable visit (owner directive 2026-08-26 — Standard-only
 * trapping with unlimited callbacks; re-services/callbacks are never
 * priced, ruling 2026-08-27; companion to 20260826000001).
 *
 * 20260428000006 seeded this row at $95 with "additional follow-up …
 * beyond the 1 included" copy, and the scheduling picker copies the
 * catalog base_price onto a staff-booked trap check — so a callback could
 * still be invoiced (codex #3521 r7 P1). Value-guarded read-modify-write:
 * an admin-edited row is left alone, and down() restores only what up()
 * recorded changing.
 */
const MIGRATION_TAG = 'migration:20260826000006';
const STATE_KEY = 'migration.20260826000006.state';
const LEGACY_PRICE = 95;
const NEW_PRICE = 0;
const LEGACY_DESCRIPTION = 'Additional follow-up trap check beyond the 1 included in base trapping service. Use for active infestations requiring extended monitoring.';
const NEW_DESCRIPTION = 'Included callback/check for the same active trapping job — no charge. The Standard trapping plan includes unlimited callbacks; this row exists so the visit can be scheduled and reported, never billed.';
// Seeded by 20260428000006 — per-visit billing guidance that no longer applies.
const LEGACY_INTERNAL_NOTES = 'Per-visit rate. 3-pack available at $245 (saves $40).';
const NEW_INTERNAL_NOTES = 'Included callback under the Standard trapping plan (unlimited callbacks for the active job). Never billed; no packs.';

async function loadState(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return null;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

async function saveState(knex, state) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const value = JSON.stringify(state);
  const updated = await knex('system_settings').where({ key: STATE_KEY }).update({ value });
  if (!updated) await knex('system_settings').insert({ key: STATE_KEY, value });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const row = await knex('services').where({ service_key: 'rodent_trapping_followup' }).first();
  if (!row) return;
  const patch = {};
  const state = { priceChanged: false, descriptionChanged: false, priorPrice: null };
  // ANY nonzero price goes to $0 — an admin-edited $60 is just as billable
  // as the seeded $95, and an included callback is never billable (uncapped
  // audit P0 on #3521). The prior value rides the state for rollback.
  const currentPrice = Number(row.base_price);
  if (Number.isFinite(currentPrice) && currentPrice > 0) {
    patch.base_price = NEW_PRICE;
    state.priceChanged = true;
    state.priorPrice = currentPrice;
  }
  if (String(row.description || '') === LEGACY_DESCRIPTION) {
    patch.description = NEW_DESCRIPTION;
    state.descriptionChanged = true;
  }
  // The seeded internal note still told the office this bills per visit
  // (and sold a 3-pack) — contradictory guidance in the Service Library
  // once callbacks are always included (uncapped audit P1 on #3521).
  if (String(row.internal_notes || '') === LEGACY_INTERNAL_NOTES) {
    patch.internal_notes = NEW_INTERNAL_NOTES;
    state.notesChanged = true;
  }
  if (!Object.keys(patch).length) return;
  await knex('services').where({ id: row.id }).update({ ...patch, updated_at: knex.fn.now() });
  await saveState(knex, { ...state, id: row.id, tag: MIGRATION_TAG });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const state = await loadState(knex);
  if (!state || !state.id) return;
  const row = await knex('services').where({ id: state.id, service_key: 'rodent_trapping_followup' }).first();
  if (row) {
    const patch = {};
    if (state.priceChanged && Number(row.base_price) === NEW_PRICE) {
      patch.base_price = Number.isFinite(Number(state.priorPrice)) && Number(state.priorPrice) > 0
        ? Number(state.priorPrice)
        : LEGACY_PRICE;
    }
    if (state.descriptionChanged && String(row.description || '') === NEW_DESCRIPTION) patch.description = LEGACY_DESCRIPTION;
    if (state.notesChanged && String(row.internal_notes || '') === NEW_INTERNAL_NOTES) patch.internal_notes = LEGACY_INTERNAL_NOTES;
    if (Object.keys(patch).length) {
      await knex('services').where({ id: row.id }).update({ ...patch, updated_at: knex.fn.now() });
    }
  }
  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};

exports.LEGACY_PRICE = LEGACY_PRICE;
exports.NEW_PRICE = NEW_PRICE;
exports.LEGACY_DESCRIPTION = LEGACY_DESCRIPTION;
exports.NEW_DESCRIPTION = NEW_DESCRIPTION;
exports.LEGACY_INTERNAL_NOTES = LEGACY_INTERNAL_NOTES;
exports.NEW_INTERNAL_NOTES = NEW_INTERNAL_NOTES;
