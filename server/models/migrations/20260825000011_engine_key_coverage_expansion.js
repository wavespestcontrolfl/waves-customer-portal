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
  // closed — the id makes them unambiguous). `one_time_lawn` is DELIBERATELY
  // absent: the engine reuses that raw key for the distinct "Lawn Pest
  // Knockdown" identity (estimate-engine wraps priceOneTimeLawn), so the key
  // cannot name one catalog row (codex #3485 r1 P1).
  // `one_time_pest` is seeded CONDITIONALLY below: prod carries the
  // admin-created one_time_pest_control row, while migration-built
  // databases carry its documented twin pest_initial_cleanout
  // (20260401000105:151) — creating a parallel row would put two
  // conflicting one-time pest identities in the same catalog (codex
  // #3485 r3 P1), so the key lands on whichever row the environment has.
  { service_key: 'mosquito_one_time', engine_keys: ['one_time_mosquito'] },
  // Standalone recurring termite bait — 1:1 with the termite_bait row; the
  // reserved-path label is an admin-editable name, so the link is the only
  // durable identity (codex #3485 r1 P1).
  { service_key: 'termite_bait', engine_keys: ['termite_bait'] },
  // Foam pair — the one-time line previously mis-resolved to the BAIT row
  // via short-name fallback (grade-D in the 2026-08-25 audit).
  { service_key: 'foam_drill', engine_keys: ['foam_drill'] },
  { service_key: 'foam_recurring', engine_keys: ['foam_recurring'] },
  // Termite one-times.
  { service_key: 'bora_care', engine_keys: ['bora_care'] },
  { service_key: 'termite_trenching', engine_keys: ['trenching'] },
  { service_key: 'termite_spot_treatment', engine_keys: ['termite_foam'] },
  // pre_slab_termidor is NOT seeded here — it is the legacy alias of the
  // pre-slab line (a wrapper around pricePreSlabTermiticide) and belongs on
  // termite_slab_pretreat's certificate lane, appended below (codex #3485
  // r1 P1 — stamping termite_pretreatment would bypass the FDACS/FBC
  // certificate workflow for identical pre-slab work).
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
  // NOT rodent_guarantee_combo: the combo line is exclusion + bait stations
  // + guarantee and needs a field visit, while this row is a duration-zero
  // internal-only billing construct — stamping it would hide the sold work
  // from the tech completion flow (codex #3485 r1 P1).
  { service_key: 'rodent_guarantee', engine_keys: ['rodent_guarantee'] },
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

// Seeds whose target row differs per environment: candidates in preference
// order, first existing + unstamped row wins. Never creates rows.
const CONDITIONAL_SEEDS = [
  {
    engine_keys: ['one_time_pest'],
    service_key_candidates: ['one_time_pest_control', 'pest_initial_cleanout'],
  },
];

// Additive alias appends onto rows the PARENT migration already stamped —
// guarded on the exact shipped array (compare-and-set in the UPDATE
// predicate) so an admin-customized value is never rewritten.
//   - `wasp`: the legacy v1 third alias of the stinging-insect line
//     (service-pricing.js:7842), missed by the 20260810000002 seed.
//   - `pre_slab_termidor`: the legacy wrapper key around
//     pricePreSlabTermiticide — same certificate-lane service.
const ALIAS_APPENDS = [
  {
    service_key: 'bee_wasp_removal',
    shipped: ['stinging_insect', 'stinging_insect_v2'],
    append: 'wasp',
  },
  {
    service_key: 'termite_slab_pretreat',
    shipped: ['pre_slab_termiticide'],
    append: 'pre_slab_termidor',
  },
];

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
  // migration documents). Rows are recorded by {service_key, id} so a
  // delete-and-recreate of the same key can never read as ownership
  // (codex #3485 r1 P2).
  const state = { stamped: [], appended: [] };

  for (const seed of ENGINE_KEY_SEEDS) {
    // Read-modify-write: only stamp rows that exist and are still unstamped,
    // so an admin edit (or a re-run) is never clobbered. whereNull rides on
    // the id-scoped UPDATE too, so a concurrent admin stamp between read and
    // write hits zero rows and is never claimed.
    const row = await knex('services')
      .where({ service_key: seed.service_key })
      .whereNull('engine_keys')
      .first('id');
    if (!row) continue;
    const count = await knex('services')
      .where({ id: row.id })
      .whereNull('engine_keys')
      .update({ engine_keys: JSON.stringify(seed.engine_keys), updated_at: knex.fn.now() });
    if (count) state.stamped.push({ service_key: seed.service_key, id: row.id });
  }

  for (const seed of CONDITIONAL_SEEDS) {
    for (const candidateKey of seed.service_key_candidates) {
      const row = await knex('services')
        .where({ service_key: candidateKey })
        .whereNull('engine_keys')
        .first('id');
      if (!row) continue;
      const count = await knex('services')
        .where({ id: row.id })
        .whereNull('engine_keys')
        .update({ engine_keys: JSON.stringify(seed.engine_keys), updated_at: knex.fn.now() });
      if (count) state.stamped.push({ service_key: candidateKey, id: row.id, engine_keys: seed.engine_keys });
      break;
    }
  }

  for (const target of ALIAS_APPENDS) {
    const row = await knex('services')
      .where({ service_key: target.service_key })
      .first('id', 'engine_keys');
    if (!row) continue;
    const current = Array.isArray(row.engine_keys)
      ? row.engine_keys
      : (() => { try { return JSON.parse(row.engine_keys); } catch { return null; } })();
    const isShipped = Array.isArray(current)
      && current.length === target.shipped.length
      && target.shipped.every((k, i) => current[i] === k);
    if (!isShipped) continue;
    // Compare-and-set: the expected current value rides in the UPDATE
    // predicate, so an admin edit landing between the SELECT and this
    // UPDATE hits zero rows instead of being overwritten (codex #3485 r1
    // P2).
    const count = await knex('services')
      .where({ id: row.id })
      .whereRaw('engine_keys = ?::jsonb', [JSON.stringify(target.shipped)])
      .update({
        engine_keys: JSON.stringify([...target.shipped, target.append]),
        updated_at: knex.fn.now(),
      });
    if (count) state.appended.push({ service_key: target.service_key, id: row.id });
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

  const seedsByKey = new Map(ENGINE_KEY_SEEDS.map((s) => [s.service_key, s]));
  for (const rec of (Array.isArray(state.stamped) ? state.stamped : [])) {
    // Conditional seeds record their engine_keys inline (their target key
    // varies per environment); fixed seeds resolve through the seed table.
    const seed = rec && (Array.isArray(rec.engine_keys)
      ? { engine_keys: rec.engine_keys }
      : seedsByKey.get(rec.service_key));
    if (!seed || !rec.id) continue;
    // Ownership binds to the recorded ROW id — a same-key row recreated by
    // an admin after a delete is a different row and is never touched.
    await knex('services')
      .where({ id: rec.id, service_key: rec.service_key })
      .whereRaw('engine_keys = ?::jsonb', [JSON.stringify(seed.engine_keys)])
      .update({ engine_keys: null, updated_at: knex.fn.now() });
  }

  const appendsByKey = new Map(ALIAS_APPENDS.map((t) => [t.service_key, t]));
  for (const rec of (Array.isArray(state.appended) ? state.appended : [])) {
    const target = rec && appendsByKey.get(rec.service_key);
    if (!target || !rec.id) continue;
    await knex('services')
      .where({ id: rec.id, service_key: rec.service_key })
      .whereRaw('engine_keys = ?::jsonb', [JSON.stringify([...target.shipped, target.append])])
      .update({ engine_keys: JSON.stringify(target.shipped), updated_at: knex.fn.now() });
  }

  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};

// Consumed by accept-path-service-identity.test.js (same contract as the
// parent migration's export).
exports.ENGINE_KEY_SEEDS = ENGINE_KEY_SEEDS;
exports.ALIAS_APPENDS = ALIAS_APPENDS;
exports.CONDITIONAL_SEEDS = CONDITIONAL_SEEDS;
