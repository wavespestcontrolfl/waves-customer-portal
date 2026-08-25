/**
 * Engine-key coverage expansion (owner directive 2026-08-25: "make sure
 * everything we can give an estimate for includes the right service").
 *
 * 20260810000002 introduced `services.engine_keys` with deliberately partial
 * coverage — 4 rows / 5 keys, "mapping them is a business decision per
 * service." The 2026-08-25 estimate-coverage audit graded every offering the
 * engine can put on an acceptable estimate: 29 declared-unmapped keys plus 5
 * undeclared ones booked with NO catalog identity (no service_id, labels that
 * match no catalog name), which kills typed one-time billing and compliance
 * projects exactly like the pre-slab case that motivated the column.
 *
 * This migration seeds every engine key with an unambiguous 1:1 catalog row.
 * Deliberately still NOT seeded (fail-open, listed in
 * accept-path-service-identity.test.js):
 *   - `rodent_sanitation` — ONE key, four tier rows (light/standard/heavy +
 *     legacy medium); no tier discriminator exists in the line.
 *   - `termite_bond` — three term rows; the converter's term-keyed
 *     `catalogServiceKey` rewrite owns bond identity (same PR).
 *   - `trap_only_retainer*` — retainers are billing plans with no
 *     schedulable rows by design (estimate-converter.js:2648-2655).
 *   - cadence-family keys (`pest_control`, `lawn_care`, `mosquito`,
 *     `tree_shrub`) — one key spans multiple cadence rows; the
 *     canonicalServiceTypeForProfile cadence labels + converter cadence
 *     routes own those.
 *
 * Same contract as the parent migration: rows that already carry engine_keys
 * are never overwritten (admin edits win) — except the one additive alias
 * append below, which only fires while the row still carries the exact
 * shipped array.
 */

const ENGINE_KEY_SEEDS = [
  // One-time family rows (labels were ambiguous abbreviations that failed
  // closed — the id makes them unambiguous).
  { service_key: 'one_time_pest_control', engine_keys: ['one_time_pest'] },
  { service_key: 'lawn_care_one_time', engine_keys: ['one_time_lawn'] },
  { service_key: 'mosquito_one_time', engine_keys: ['one_time_mosquito'] },
  // Foam pair — the one-time line previously mis-resolved to the BAIT row
  // via short-name fallback (grade-D in the 2026-08-25 audit).
  { service_key: 'foam_drill', engine_keys: ['foam_drill'] },
  { service_key: 'foam_recurring', engine_keys: ['foam_recurring'] },
  // Termite one-times.
  { service_key: 'bora_care', engine_keys: ['bora_care'] },
  { service_key: 'termite_trenching', engine_keys: ['trenching'] },
  { service_key: 'termite_spot_treatment', engine_keys: ['termite_foam'] },
  { service_key: 'termite_pretreatment', engine_keys: ['pre_slab_termidor'] },
  // Inspections.
  { service_key: 'wdo_inspection', engine_keys: ['wdo_inspection'] },
  { service_key: 'rodent_inspection', engine_keys: ['rodent_inspection'] },
  // Rodent one-times — none of these were in the canonical-label whitelist,
  // so every one fell through to raw lead text.
  { service_key: 'rodent_trapping', engine_keys: ['rodent_trapping'] },
  { service_key: 'rodent_trapping_followup', engine_keys: ['rodent_trapping_followup'] },
  { service_key: 'rodent_exclusion_only', engine_keys: ['rodent_exclusion', 'exclusion', 'exclusion_v2'] },
  { service_key: 'rodent_wire_mesh', engine_keys: ['rodent_wire_mesh'] },
  { service_key: 'rodent_bird_box', engine_keys: ['rodent_bird_box'] },
  { service_key: 'rodent_guarantee', engine_keys: ['rodent_guarantee', 'rodent_guarantee_combo'] },
  { service_key: 'rodent_bait_setup', engine_keys: ['rodent_bait_setup'] },
  // Lawn one-time projects.
  { service_key: 'dethatching', engine_keys: ['dethatching'] },
  { service_key: 'plugging', engine_keys: ['plugging'] },
  { service_key: 'top_dressing', engine_keys: ['top_dressing'] },
  // Specialty.
  { service_key: 'flea_tick', engine_keys: ['flea_knockdown_single', 'flea_package'] },
  { service_key: 'cockroach_control', engine_keys: ['pest_initial_roach'] },
  { service_key: 'bed_bug_treatment', engine_keys: ['bed_bug', 'bed_bug_chemical', 'bed_bug_heat'] },
  { service_key: 'palm_injection', engine_keys: ['palm_injection'] },
];

// The legacy v1 `wasp` key is the third alias of the stinging-insect line
// (service-pricing.js:7842) — same real service as stinging_insect /
// stinging_insect_v2, missed by the 20260810000002 seed.
const WASP_ALIAS_TARGET = {
  service_key: 'bee_wasp_removal',
  shipped: ['stinging_insect', 'stinging_insect_v2'],
  append: 'wasp',
};

const STATE_KEY = 'migration.20260825000011.state';

async function saveState(knex, state) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  await knex('system_settings').where({ key: STATE_KEY }).del();
  await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify(state) });
}

async function loadState(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return null;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  if (!(await knex.schema.hasColumn('services', 'engine_keys'))) return;

  // Ownership is RECORDED, not inferred: value equality cannot prove up()
  // wrote a mapping (an admin who pre-stamped the identical array would be
  // clobbered by a value-guarded rollback — the exact trap the parent
  // migration documents). down() reverses only the rows recorded here.
  const state = { stampedKeys: [], waspAppended: false };

  for (const seed of ENGINE_KEY_SEEDS) {
    // Read-modify-write: only stamp rows that exist and are still unstamped,
    // so an admin edit (or a re-run) is never clobbered.
    const count = await knex('services')
      .where({ service_key: seed.service_key })
      .whereNull('engine_keys')
      .update({ engine_keys: JSON.stringify(seed.engine_keys), updated_at: knex.fn.now() });
    if (count) state.stampedKeys.push(seed.service_key);
  }

  // Additive alias append, guarded on the exact shipped array so an
  // admin-customized value is never rewritten.
  const row = await knex('services')
    .where({ service_key: WASP_ALIAS_TARGET.service_key })
    .first('id', 'engine_keys');
  if (row) {
    const current = Array.isArray(row.engine_keys)
      ? row.engine_keys
      : (() => { try { return JSON.parse(row.engine_keys); } catch { return null; } })();
    const isShipped = Array.isArray(current)
      && current.length === WASP_ALIAS_TARGET.shipped.length
      && WASP_ALIAS_TARGET.shipped.every((k, i) => current[i] === k);
    if (isShipped) {
      const count = await knex('services')
        .where({ id: row.id })
        .update({
          engine_keys: JSON.stringify([...current, WASP_ALIAS_TARGET.append]),
          updated_at: knex.fn.now(),
        });
      state.waspAppended = count > 0;
    }
  }

  await saveState(knex, state);
};

// Down reverses only what the RECORDED ownership state proves up() wrote —
// no state row means up() never completed (or has nothing to answer for):
// restore nothing rather than guess. Each reversal is additionally
// value-guarded so a post-up() admin edit survives the rollback.
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  if (!(await knex.schema.hasColumn('services', 'engine_keys'))) return;
  const state = await loadState(knex);
  if (!state) return;

  const stamped = new Set(Array.isArray(state.stampedKeys) ? state.stampedKeys : []);
  for (const seed of ENGINE_KEY_SEEDS) {
    if (!stamped.has(seed.service_key)) continue;
    const row = await knex('services').where({ service_key: seed.service_key }).first('id', 'engine_keys');
    if (!row) continue;
    const current = Array.isArray(row.engine_keys)
      ? row.engine_keys
      : (() => { try { return JSON.parse(row.engine_keys); } catch { return null; } })();
    const isSeeded = Array.isArray(current)
      && current.length === seed.engine_keys.length
      && seed.engine_keys.every((k, i) => current[i] === k);
    if (isSeeded) {
      await knex('services').where({ id: row.id })
        .update({ engine_keys: null, updated_at: knex.fn.now() });
    }
  }

  const row = state.waspAppended
    ? await knex('services')
      .where({ service_key: WASP_ALIAS_TARGET.service_key })
      .first('id', 'engine_keys')
    : null;
  if (row) {
    const current = Array.isArray(row.engine_keys)
      ? row.engine_keys
      : (() => { try { return JSON.parse(row.engine_keys); } catch { return null; } })();
    const appended = [...WASP_ALIAS_TARGET.shipped, WASP_ALIAS_TARGET.append];
    const isAppended = Array.isArray(current)
      && current.length === appended.length
      && appended.every((k, i) => current[i] === k);
    if (isAppended) {
      await knex('services').where({ id: row.id })
        .update({ engine_keys: JSON.stringify(WASP_ALIAS_TARGET.shipped), updated_at: knex.fn.now() });
    }
  }

  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};

// Consumed by accept-path-service-identity.test.js (same contract as the
// parent migration's export).
exports.ENGINE_KEY_SEEDS = ENGINE_KEY_SEEDS;
exports.WASP_ALIAS_TARGET = WASP_ALIAS_TARGET;
