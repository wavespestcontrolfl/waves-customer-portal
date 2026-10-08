/**
 * Lawn protocol v13, SW Florida matrix adds (owner 2026-10-06 "I approve all changes" and
 * 2026-10-07 "do whatever you recommend is 100% best for Waves"). One migration. It gives the
 * staged v13 protocol rows the same lines the recipe file (lawn-protocol-v13.json) now carries.
 *
 * What the recipe gained, and what this writes for each staged v13 protocol (all four tracks):
 *   1. Mole crickets: Talak 7.9 F, 1.0 fl oz per 1,000 sq ft by backpack on nymph areas, in the
 *      July line (the existing Talak row; only its trigger text changes) and a new August row.
 *   2. Take-all: the second application of each Artavia pair is Headway. The April Artavia row
 *      becomes the Headway row (name, product id). October keeps its Artavia row for large patch
 *      (trigger text only) and gains a Headway row for the second fall take-all pass.
 *   3. Spot disease rows from products already in the kit: Velista (fairy ring, dollar spot, rust,
 *      leaf spot), Gravex (dollar spot, rust), Artavia in July (Pythium root rot). A month that
 *      already has the product keeps its row; the recipe line only gained a clause.
 *   4. Arena S.E. 50 WDG Insecticide 2.5 lb. (Florida Only) is the Arena row. The manufacturer's
 *      specimen label for Arena S.E. reads EPA Reg. No. 59639-152, the same number as Arena 50 WDG,
 *      with the same chinch rate and the same 0.4 lb clothianidin per acre per year cap. The
 *      catalog row (same id, so limits, history and links stay) is renamed and the old name and the
 *      SiteOne title are kept as aliases. Staged rows follow by product id.
 *   6. July potash on the 12x plan (the 9x plan has no July visit): LESCO Elite 0-0-50 SOP at 1.0 lb per
 *      1,000 sq ft (0.5 lb K2O, no N or P, legal in the summer blackout) is the July spreader
 *      tool. The July window becomes a spreader window (visit type, production mode, goal,
 *      required tasks); its window key never changes.
 *   7. Advion Fire Ant Bait as an optional add-on (not in the plan by default) in April and
 *      October (both spreader visits). The office prices it. No customer price changes here.
 *
 * Catalog rows are inserted only when no row has the exact name and no alias spells it. A row that
 * prod already has (Headway Fungicide is there) is never touched. Price fields stay with the
 * vendor-pricing workflow (needs_pricing). An EPA number that no label in hand shows stays NULL
 * (Advion Fire Ant Bait). A product that cannot be resolved after the insert is skipped and logged.
 *
 * Insert-only except these guarded updates, each recorded before and after in the audit row and
 * written only while the field still holds the value this was written against: the April Artavia
 * row, the October Artavia trigger, the July Talak trigger, the July window, the Arena row name and
 * the staged Arena row names.
 *
 * Idempotent: a second run changes nothing. One 'v13_matrix_adds' audit row per protocol and one
 * 'v13_matrix_adds_catalog' row record what was written.
 *
 * down(), exact-equality guarded: a protocol that a scheduled visit or a completion references is
 * left as it is (and so are the catalog rows); otherwise inserted rows are deleted only while they
 * are still what was inserted and no completion actual references them, updates go back only
 * where the field still holds the written value, and the catalog rows this inserted are removed
 * only while nothing references them.
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const staged = require('./20261005120000_lawn_protocol_v13_staged');

const V13_VERSION = staged.V13_VERSION;
const ACTION = 'v13_matrix_adds';
const CATALOG_ACTION = 'v13_matrix_adds_catalog';
const ACTOR = 'migration 20261007180000';
const MIGRATION = '20261007180000_lawn_v13_matrix_adds';

const N = staged.NAMES;
const HEAD = 'Headway Fungicide';
const SOP = 'LESCO Elite 0-0-50 AM 18% S SOP Turfgrass Granular Fertilizer';
const ADVION = 'Advion Fire Ant Bait';
const ARENA_OLD = N.ARE;
const ARENA_NEW = 'Arena S.E. 50 WDG Insecticide 2.5 lb. (Florida Only)';
const ARENA_EPA = '59639-152';
const ARENA_SITEONE_TITLE = 'Arena S.E. 50 WDG Insecticide 2.5 lb. (40 oz.) Jug (Florida Only)';

const W = {
  MAR: 'mar_v13_pre_m_hose', APR: 'apr_v13_spreader_feeding', MAY: 'may_v13_tetrino_hose', JUN: 'jun_v13_hose_blackout',
  JUL: 'jul_v13_inspect_spot', AUG: 'aug_v13_hose_blackout', SEP: 'sep_v13_hose_blackout', OCT: 'oct_v13_spreader_fall', NOV: 'nov_v13_spreader_feeding',
};
const SPREADER = 'spreader_plus_spot_backpack';
const SCOUT = 'scout_or_premium_route';

// Row gate: Talak on mole cricket nymphs is watered in right after (label: up to 0.5 inch) instead of the
// product's 24-hour hold. The completion freeze (report-data.js withApplicationWaterIn) reads it with the
// use's recorded targets; the catalog rule for Talak's other uses is not touched.
const MOLE_CRICKET_WATER_IN = 0.5;

const VERIFIED_AT = '2026-10-07T00:00:00.000Z';
const VERIFIED_BY = 'label-check-2026-10-07';
const watering = (fields) => ({ ...fields, verified_at: VERIFIED_AT, verified_by: VERIFIED_BY });

// Watering rules. The Headway label has no turf watering instruction (only the 12-hour re-entry): the owner rule
// Artavia and Gravex already carry. A fertilizer label gives no amount (as for the 24-0-11): 0.25 inch within 24 hours.
const HEAD_RULE = watering({ mode: 'hold', hold_until: 'dry', source: 'owner', label_note: 'Label: no watering instruction for turf. Owner: hold until the spray has dried.' });
const SOP_RULE = watering({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'owner', label_note: 'Fertilizer: no watering-in instruction. Owner (same as the other v13 granular fertilizer): 0.25 inch within 24 hours.' });
// Written to a row that already exists (prod has Headway) only where its rule is empty.
const WATERING = [{ name: HEAD, rule: HEAD_RULE }, { name: SOP, rule: SOP_RULE }];
// No Advion Fire Ant Bait label was read: the row has no rule, so a visit that logs it gets no watering claim.
const FAIL_CLOSED = [{ name: ADVION, reason: 'No label read; optional add-on the office prices.' }];

// Catalog rows, inserted only when missing. Rates are the label's (Headway liquid label, EPA 100-1216:
// take-all 3 fl oz per 1,000 sq ft, 28 days, max 23.75 fl oz per 1,000 sq ft a year) or the program's.
const CATALOG = [
  {
    name: HEAD,
    category: 'fungicide', active_ingredient: 'Azoxystrobin + Propiconazole', formulation: 'liquid', container_size: '1 gal', unit_size_oz: 128,
    epa_reg_number: '100-1216', frac_group: '3 + 11', siteone_sku: '26328',
    default_rate_per_1000: 3, min_label_rate_per_1000: 1.5, max_label_rate_per_1000: 3, max_annual_per_1000: 23.75, rate_unit: 'fl oz',
    label_source_note: 'Headway liquid label (EPA 100-1216, 2016 copy): take-all patch 3 fl oz per 1,000 sq ft, 28 days, two in spring and two in fall; no more than 3 fl oz per 1,000 sq ft every 30 days on bermudagrass. SiteOne 26328, $563.00 per gal (2026-10-07 member price).',
    aliases: ['Syngenta Headway Broad Spectrum Liquid Fungicide 1 gal. Jug (Agency)'],
    post_application_watering: HEAD_RULE,
  },
  {
    name: SOP,
    category: 'fertilizer', active_ingredient: null, formulation: 'granular', container_size: '50 lb', unit_size_oz: 800,
    epa_reg_number: 'N/A', siteone_sku: '009842', analysis_n: 0, analysis_p: 0, analysis_k: 50,
    default_rate_per_1000: 1, rate_unit: 'lb',
    label_source_note: 'LESCO Elite 0-0-50 sulfate of potash, 18% S. SiteOne 009842, $41.09 per 50 lb bag (2026-10-07 member price). 1 lb per 1,000 sq ft = 0.5 lb K2O, no N or P.',
    aliases: ['LESCO Elite 0-0-50 AM 18% S SOP Turfgrass Elite Granular Fertilizer 50 lb. Bag'],
    post_application_watering: SOP_RULE,
  },
  {
    // No EPA number is written: no Advion Fire Ant Bait label was read. No watering rule either (no claim).
    name: ADVION,
    category: 'insecticide', active_ingredient: 'Indoxacarb', formulation: 'granular', container_size: '25 lb', unit_size_oz: 400,
    epa_reg_number: null, irac_group: '22A', siteone_sku: '53209',
    default_rate_per_1000: 0.034, rate_unit: 'lb',
    label_source_note: 'Optional add-on, office prices it. Broadcast 1.5 lb per acre = 0.034 lb per 1,000 sq ft (matrix, not read from the label). SiteOne 53209 $451.07 per 25 lb, 53212 $58.88 per 2 lb (2026-10-07 member prices).',
    aliases: ['Advion Fire Ant Insecticide Bait 25 lb.', 'Syngenta Advion Fire Ant Insecticide Bait 2 lb.'],
  },
];

// Spot rows share one shape; whole-lawn and optional rows pass their own.
const spot = (windowKey, name, trigger, role = 'fungicide_spot', carrier = 2) => ({ windowKey, name, role, mode: 'spot', rate: null, unit: 'label_rate', carrier, defaultInPlan: false, gates: { trigger } });

// Velista and Gravex uses per month, the same words the recipe lines carry.
const VELISTA_TRIGGERS = {
  [W.MAR]: 'rust_zoysia_leaf_spot_bermuda',
  [W.APR]: 'fairy_ring_dollar_spot_rust_leaf_spot',
  [W.MAY]: 'fairy_ring_dollar_spot_rust_leaf_spot',
  [W.JUN]: 'fairy_ring_dollar_spot',
  [W.JUL]: 'fairy_ring',
  [W.AUG]: 'fairy_ring',
  [W.SEP]: 'fairy_ring_leaf_spot_bermuda',
  // October and November already have a Velista row (large patch): the recipe line gained clauses.
};
const GRAVEX_TRIGGERS = {
  [W.MAR]: 'rust_zoysia',
  [W.APR]: 'dollar_spot_rust',
  [W.MAY]: 'dollar_spot_rust',
  [W.JUN]: 'dollar_spot',
  [W.OCT]: 'dollar_spot_rust',
  [W.NOV]: 'dollar_spot_rust',
};

const INSERTS = [
  ...Object.entries(VELISTA_TRIGGERS).map(([windowKey, trigger]) => spot(windowKey, N.VEL, trigger)),
  ...Object.entries(GRAVEX_TRIGGERS).map(([windowKey, trigger]) => spot(windowKey, N.GRA, trigger)),
  spot(W.JUL, N.ART, 'pythium_root_rot'),
  { ...spot(W.AUG, N.TAL, 'mole_cricket_nymphs', 'insecticide_spot', 4), gates: { trigger: 'mole_cricket_nymphs', moleCricketWaterInInches: MOLE_CRICKET_WATER_IN } },
  spot(W.OCT, HEAD, 'mapped_take_all_fall_2'),
  {
    windowKey: W.JUL, name: SOP, role: 'potassium_nutrition', mode: 'broadcast', rate: 1, unit: 'lb', carrier: null, defaultInPlan: true,
    gates: { targetK2O: '0.5 lb K2O/1000', requiresZeroNP: true },
  },
  // Optional add-on: never default_in_plan; the office prices it.
  ...[W.APR, W.OCT].map((windowKey) => ({
    windowKey, name: ADVION, role: 'insecticide_optional_addon', mode: 'broadcast', rate: 0.034, unit: 'lb', carrier: null, defaultInPlan: false,
    gates: { trigger: 'fire_ants_optional_add_on', optionalAddOn: true, officePrices: true },
  })),
];

// Guarded updates of existing staged rows: a column and/or gate-key set, written only while the row is
// still what `guard` says.
const UPDATES = [
  {
    // The April Artavia row (take-all spring 2) is the Headway row now.
    windowKey: W.APR, guard: { product_name: N.ART, trigger: 'mapped_take_all_spring_2' },
    columns: { product_name: HEAD }, productName: HEAD, gates: {},
  },
  {
    // October keeps Artavia for large patch only; its take-all pass moved to the new Headway row.
    windowKey: W.OCT, guard: { product_name: N.ART, trigger: 'mapped_large_patch_with_velista_and_take_all_fall_2' },
    columns: {}, gates: { trigger: 'mapped_large_patch_with_velista' },
  },
  {
    windowKey: W.JUL, guard: { product_name: N.TAL, trigger: 'chinch_second_product_or_caterpillars' },
    columns: {}, gates: { trigger: 'chinch_second_product_caterpillars_or_mole_cricket_nymphs', moleCricketWaterInInches: MOLE_CRICKET_WATER_IN },
  },
];

const JULY_OLD = {
  visit_type: 'scout_first', production_mode: SCOUT,
  goal: 'No whole-lawn tool: inspect the lawn and treat spots only.',
  required_tasks: ['required_10_minute_inspection', 'photos_for_problem_areas'],
};
const JULY_NEW = {
  visit_type: 'granular_production_plus_spots', production_mode: SPREADER,
  goal: 'Potassium feeding (0-0-50, no N or P) on the spreader; inspect the whole lawn and treat spots only.',
  required_tasks: ['required_10_minute_inspection', 'photos_for_problem_areas', 'blackout_zero_np'],
};

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

function asArray(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || []; } catch { return []; }
  }
  return Array.isArray(value) ? value : [];
}

// Exact catalog name (active rows first), else an exact alias; null when neither exists.
async function resolveProductId(knex, name) {
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const hit = [...catalog].sort((a, b) => Number(b.active !== false) - Number(a.active !== false))
    .find((row) => normalize(row.name) === normalize(name));
  if (hit) return hit.id;
  if (!(await knex.schema.hasTable('product_aliases'))) return null;
  const alias = (await knex('product_aliases').select('product_id', 'alias_name')).find((row) => normalize(row.alias_name) === normalize(name));
  return alias ? alias.product_id : null;
}

async function insertAliasIfMissing(knex, productId, aliasName) {
  if (!(await knex.schema.hasTable('product_aliases'))) return null;
  const all = await knex('product_aliases').select('id', 'alias_name');
  if (all.some((row) => normalize(row.alias_name) === normalize(aliasName))) return null;
  const [made] = await knex('product_aliases').insert({ product_id: productId, alias_name: aliasName }).returning('id');
  return { id: made && typeof made === 'object' ? made.id : made, product_id: productId, alias_name: aliasName };
}

// ── Catalog ──────────────────────────────────────────────────────────────────

async function writeCatalog(knex) {
  const written = { products: [], aliases: [], arena: null };
  const columns = await knex('products_catalog').columnInfo();
  const keepKnown = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => key in columns));

  for (const spec of CATALOG) {
    if (await resolveProductId(knex, spec.name)) continue;
    const { aliases, ...fields } = spec;
    const [made] = await knex('products_catalog').insert(keepKnown({
      ...fields,
      active: true,
      needs_pricing: true,
      content_status: 'draft',
      customer_visibility: 'internal_only',
      ...(fields.post_application_watering ? { post_application_watering: JSON.stringify(fields.post_application_watering) } : {}),
      created_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    })).returning('id');
    const id = made && typeof made === 'object' ? made.id : made;
    written.products.push({ id, name: spec.name });
    for (const aliasName of aliases) {
      const alias = await insertAliasIfMissing(knex, id, aliasName);
      if (alias) written.aliases.push(alias);
    }
  }

  // Arena: the row prod has, renamed in place. Only the row whose EPA number is the S.E. label's.
  const arena = await knex('products_catalog').where({ name: ARENA_OLD }).first('id', 'name', 'epa_reg_number');
  const taken = await resolveProductId(knex, ARENA_NEW);
  if (arena && !taken && String(arena.epa_reg_number || '').trim() === ARENA_EPA) {
    await knex('products_catalog').where({ id: arena.id, name: ARENA_OLD }).update({ name: ARENA_NEW, updated_at: knex.fn.now() });
    written.arena = { id: arena.id, before: ARENA_OLD, after: ARENA_NEW };
    for (const aliasName of [ARENA_OLD, ARENA_SITEONE_TITLE]) {
      const alias = await insertAliasIfMissing(knex, arena.id, aliasName);
      if (alias) written.aliases.push(alias);
    }
  } else if (arena || !taken) {
    console.log(`[lawn-v13-matrix-adds] Arena rename skipped: ${arena ? (taken ? 'the new name already exists' : `EPA number is ${arena.epa_reg_number || 'empty'}, not ${ARENA_EPA}`) : 'no Arena row'}`);
  }
  return written;
}

// ── Staged rows ──────────────────────────────────────────────────────────────

const windowRows = (knex, windowId) => knex('lawn_protocol_products').where({ lawn_protocol_window_id: windowId })
  .select('id', 'product_id', 'product_name', 'gates', 'sort_order');

async function writeProtocol(knex, protocol, ids) {
  const windows = await knex('lawn_protocol_windows').where({ lawn_protocol_id: protocol.id })
    .select('id', 'window_key', 'visit_type', 'production_mode', 'goal', 'required_tasks');
  const byKey = new Map(windows.map((window) => [window.window_key, window]));
  const record = { inserted: [], updates: [], windows: [], renamed: [] };

  for (const spec of INSERTS) {
    const window = byKey.get(spec.windowKey);
    if (!window) continue;
    const productId = ids.get(spec.name);
    if (!productId) { console.log(`[lawn-v13-matrix-adds] skipped ${spec.name} in ${spec.windowKey}: no catalog row or alias`); continue; }
    const rows = await windowRows(knex, window.id);
    if (rows.some((row) => row.product_name === spec.name || String(row.product_id) === String(productId))) continue;
    const [made] = await knex('lawn_protocol_products').insert({
      lawn_protocol_window_id: window.id,
      product_id: productId,
      product_name: spec.name,
      role: spec.role,
      application_mode: spec.mode,
      rate_per_1000: spec.rate,
      rate_unit: spec.unit,
      carrier_gal_per_1000: spec.carrier,
      default_in_plan: spec.defaultInPlan,
      gates: JSON.stringify(spec.gates),
      annual_counter: JSON.stringify({}),
      mixing: JSON.stringify({}),
      report_copy: JSON.stringify({ role: spec.role }),
      sort_order: Math.max(0, ...rows.map((row) => Number(row.sort_order) || 0)) + 1,
    }).returning('id');
    record.inserted.push({ id: made && typeof made === 'object' ? made.id : made, windowKey: spec.windowKey, product_name: spec.name, product_id: productId });
  }

  for (const spec of UPDATES) {
    const window = byKey.get(spec.windowKey);
    if (!window) continue;
    const rows = await windowRows(knex, window.id);
    const row = rows.find((candidate) => candidate.product_name === spec.guard.product_name && asObject(candidate.gates).trigger === spec.guard.trigger);
    if (!row) continue;
    const gates = asObject(row.gates);
    const update = { updated_at: knex.fn.now() };
    const entry = { rowId: row.id, windowKey: spec.windowKey, columns: {}, gates: {} };
    for (const [column, after] of Object.entries(spec.columns)) { entry.columns[column] = { before: row[column], after }; update[column] = after; }
    if (spec.productName) {
      const id = ids.get(spec.productName);
      if (!id) { console.log(`[lawn-v13-matrix-adds] ${spec.productName} not resolved: ${spec.windowKey} row left as it is`); continue; }
      entry.columns.product_id = { before: row.product_id, after: id };
      update.product_id = id;
    }
    const next = { ...gates };
    for (const [key, after] of Object.entries(spec.gates)) { entry.gates[key] = { before: gates[key] ?? null, after }; next[key] = after; }
    update.gates = JSON.stringify(next);
    await knex('lawn_protocol_products').where({ id: row.id }).update(update);
    record.updates.push(entry);
  }

  const july = byKey.get(W.JUL);
  if (july) {
    const tasks = asArray(july.required_tasks);
    if (july.visit_type === JULY_OLD.visit_type && july.production_mode === JULY_OLD.production_mode && july.goal === JULY_OLD.goal
      && isDeepStrictEqual(tasks, JULY_OLD.required_tasks)) {
      await knex('lawn_protocol_windows').where({ id: july.id }).update({
        visit_type: JULY_NEW.visit_type, production_mode: JULY_NEW.production_mode, goal: JULY_NEW.goal,
        required_tasks: JSON.stringify(JULY_NEW.required_tasks), updated_at: knex.fn.now(),
      });
      record.windows.push({ windowId: july.id, before: JULY_OLD, after: JULY_NEW });
    }
  }

  if (ids.arena) {
    for (const window of windows) {
      for (const row of await windowRows(knex, window.id)) {
        if (row.product_name !== ARENA_OLD || String(row.product_id) !== String(ids.arena)) continue;
        await knex('lawn_protocol_products').where({ id: row.id }).update({ product_name: ARENA_NEW, updated_at: knex.fn.now() });
        record.renamed.push({ rowId: row.id, before: ARENA_OLD, after: ARENA_NEW, product_id: row.product_id });
      }
    }
  }
  return record;
}

// Fill-only-empty: a rule already stored, whoever wrote it, is never replaced. The audit row keeps the write.
async function fillWatering(knex) {
  if (!(await knex.schema.hasColumn('products_catalog', 'post_application_watering'))) return [];
  const filled = [];
  for (const item of WATERING) {
    const rows = await knex('products_catalog').where({ name: item.name }).whereNull('post_application_watering').select('id', 'name');
    for (const row of rows) {
      const updated = await knex('products_catalog').where({ id: row.id }).whereNull('post_application_watering')
        .update({ post_application_watering: JSON.stringify(item.rule), updated_at: knex.fn.now() });
      if (updated) filled.push({ id: row.id, name: row.name });
    }
  }
  return filled;
}

const REQUIRED_TABLES = ['products_catalog', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log'];

async function hasAll(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex, REQUIRED_TABLES))) return;
  const protocols = await knex('lawn_protocols').where({ version: V13_VERSION }).select('id', 'protocol_key');
  if (!protocols.length) return;

  const written = await writeCatalog(knex);
  written.watering = await fillWatering(knex);
  const ids = new Map();
  for (const name of [HEAD, SOP, ADVION, N.VEL, N.GRA, N.ART, N.TAL]) {
    const id = await resolveProductId(knex, name);
    if (id) ids.set(name, id);
  }
  ids.arena = written.arena ? written.arena.id : (await resolveProductId(knex, ARENA_NEW)) || null;

  for (const protocol of protocols) {
    const record = await writeProtocol(knex, protocol, ids);
    if (!record.inserted.length && !record.updates.length && !record.windows.length && !record.renamed.length) continue;
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocol.id,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: protocol.id,
      action: ACTION,
      changed_fields: JSON.stringify(['products', 'window']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify(record),
      metadata: JSON.stringify({ migration: MIGRATION, gate: 'GATE_LAWN_V13' }),
    });
  }

  if (written.products.length || written.aliases.length || written.arena || written.watering.length) {
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: null,
      actor_name: ACTOR,
      entity_type: 'catalog',
      entity_id: crypto.randomUUID(),
      action: CATALOG_ACTION,
      changed_fields: JSON.stringify(['catalog']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify(written),
      metadata: JSON.stringify({ migration: MIGRATION }),
    });
  }
};

// ── Down ─────────────────────────────────────────────────────────────────────

async function protocolReferenced(knex, protocol) {
  if (await knex.schema.hasTable('scheduled_services')) {
    const visit = await knex('scheduled_services').where({ lawn_protocol_key: protocol.protocol_key, lawn_protocol_version: V13_VERSION }).first('id');
    if (visit) return true;
  }
  if (!(await knex.schema.hasTable('lawn_protocol_service_completions'))) return false;
  const completion = await knex('lawn_protocol_service_completions')
    .where({ lawn_protocol_id: protocol.id })
    .orWhere({ protocol_key: protocol.protocol_key, protocol_version: V13_VERSION })
    .first('id');
  return Boolean(completion);
}

async function revertProtocol(knex, log) {
  const record = asObject(log.after_snapshot);
  const protocol = log.lawn_protocol_id ? await knex('lawn_protocols').where({ id: log.lawn_protocol_id }).first('id', 'protocol_key') : null;
  if (protocol && await protocolReferenced(knex, protocol)) {
    console.log(`[lawn-v13-matrix-adds] rollback skipped for protocol ${protocol.protocol_key}: a visit or completion references ${V13_VERSION}`);
    return true;
  }
  const hasActuals = await knex.schema.hasTable('lawn_protocol_product_actuals');

  for (const renamed of record.renamed || []) {
    await knex('lawn_protocol_products').where({ id: renamed.rowId, product_name: renamed.after }).update({ product_name: renamed.before, updated_at: knex.fn.now() });
  }
  if (record.windows?.length) {
    const [change] = record.windows;
    const window = await knex('lawn_protocol_windows').where({ id: change.windowId }).first('id', 'visit_type', 'production_mode', 'goal', 'required_tasks');
    if (window && window.visit_type === change.after.visit_type && window.production_mode === change.after.production_mode
      && window.goal === change.after.goal && isDeepStrictEqual(asArray(window.required_tasks), change.after.required_tasks)) {
      await knex('lawn_protocol_windows').where({ id: window.id }).update({
        visit_type: change.before.visit_type, production_mode: change.before.production_mode, goal: change.before.goal,
        required_tasks: JSON.stringify(change.before.required_tasks), updated_at: knex.fn.now(),
      });
    }
  }
  for (const entry of record.updates || []) {
    const row = await knex('lawn_protocol_products').where({ id: entry.rowId }).first('id', 'product_name', 'product_id', 'gates');
    if (!row) continue;
    const gates = asObject(row.gates);
    const update = { updated_at: knex.fn.now() };
    for (const [column, change] of Object.entries(entry.columns || {})) {
      if (String(row[column] ?? '') === String(change.after ?? '')) update[column] = change.before;
    }
    for (const [key, change] of Object.entries(entry.gates || {})) {
      if (gates[key] === change.after) { if (change.before == null) delete gates[key]; else gates[key] = change.before; }
    }
    update.gates = JSON.stringify(gates);
    await knex('lawn_protocol_products').where({ id: row.id }).update(update);
  }
  for (const made of record.inserted || []) {
    if (hasActuals && await knex('lawn_protocol_product_actuals').where({ protocol_product_id: made.id }).first('id')) continue;
    await knex('lawn_protocol_products').where({ id: made.id, product_name: made.product_name }).del();
  }
  await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  return false;
}

async function productReferenced(knex, productId) {
  for (const [table, column] of [['lawn_protocol_products', 'product_id'], ['product_limits', 'product_id'], ['property_application_history', 'product_id'], ['service_products', 'product_id']]) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (await knex(table).where({ [column]: productId }).first('id')) return true;
  }
  return false;
}

async function revertCatalog(knex) {
  const logs = await knex('lawn_protocol_audit_log').where({ action: CATALOG_ACTION }).select('id', 'after_snapshot');
  for (const log of logs) {
    const { products = [], aliases = [], arena = null, watering: filled = [] } = asObject(log.after_snapshot);
    if (arena) {
      const row = await knex('products_catalog').where({ id: arena.id }).first('id', 'name');
      const staged = await knex('lawn_protocol_products').where({ product_id: arena.id, product_name: arena.after }).first('id');
      if (row && row.name === arena.after && !staged) await knex('products_catalog').where({ id: arena.id, name: arena.after }).update({ name: arena.before, updated_at: knex.fn.now() });
    }
    // A rule this filled on an existing row goes back to empty only while it is still the rule written.
    for (const row of filled) {
      const rule = (WATERING.find((item) => item.name === row.name) || {}).rule;
      const current = await knex('products_catalog').where({ id: row.id }).first('post_application_watering');
      if (rule && current && isDeepStrictEqual(asObject(current.post_application_watering), rule)) {
        await knex('products_catalog').where({ id: row.id }).update({ post_application_watering: null, updated_at: knex.fn.now() });
      }
    }
    for (const alias of aliases) await knex('product_aliases').where({ id: alias.id, alias_name: alias.alias_name }).del();
    for (const product of products) {
      if (await productReferenced(knex, product.id)) continue;
      await knex('product_aliases').where({ product_id: product.id }).del();
      await knex('products_catalog').where({ id: product.id, name: product.name }).del();
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
}

exports.down = async function down(knex) {
  if (!(await hasAll(knex, REQUIRED_TABLES))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'lawn_protocol_id', 'after_snapshot');
  let kept = 0;
  for (const log of logs) if (await revertProtocol(knex, log)) kept += 1;
  if (kept) {
    console.log('[lawn-v13-matrix-adds] catalog rows kept: a protocol still uses them');
    return;
  }
  await revertCatalog(knex);
};

exports.ACTION = ACTION;
exports.CATALOG_ACTION = CATALOG_ACTION;
exports.HEAD = HEAD;
exports.SOP = SOP;
exports.ADVION = ADVION;
exports.ARENA_OLD = ARENA_OLD;
exports.ARENA_NEW = ARENA_NEW;
exports.ARENA_EPA = ARENA_EPA;
exports.CATALOG = CATALOG;
exports.WATERING = WATERING;
exports.FAIL_CLOSED = FAIL_CLOSED;
exports.INSERTS = INSERTS;
exports.UPDATES = UPDATES;
exports.JULY_OLD = JULY_OLD;
exports.JULY_NEW = JULY_NEW;
exports.WINDOWS = W;
exports.MOLE_CRICKET_WATER_IN = MOLE_CRICKET_WATER_IN;
