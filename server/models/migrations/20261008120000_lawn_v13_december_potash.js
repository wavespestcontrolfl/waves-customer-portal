/**
 * Lawn protocol v13, December whole-lawn step becomes LESCO 10-0-22 (owner 2026-10-08, "swap
 * december", "december only, no july potash"). One migration; it does not touch July. Two weed-season rules of the
 * same day ride in it (see "Weed season" below).
 *
 * Why. The December feeding changes from LESCO 24-0-11 with PolyPlus OPTI (2.1 lb per 1,000 sq ft,
 * 0.5 lb N) to a lighter nitrogen feeding with potassium for cold and dry weather: LESCO 10-0-22 50%
 * PolyPlus OPTI45 50% YaraRega 2% Fe 2% Mg KMAG MOP SOP Turfgrass Granular Fertilizer (SiteOne 511289,
 * 50 lb bag), 4.5 lb per 1,000 sq ft = 0.45 lb N and 0.99 lb K2O. Same on every plan and every grass.
 *
 * The label (LESCO 10-0-22, Rev. 7/23/24, read 2026-10-08): 10% N = 5.00% polymer-coated urea (slow
 * release) + 2.39% ammoniacal + 2.61% nitrate, so the slow-release share is exactly 50%; 22% K2O; 2% Mg;
 * 6.81% S; 2% Fe; 9.68% Cl; rotary spreader only; "watered into the turf soon after application"; sweep
 * product off walks and painted surfaces. No phosphorus. The label sets no per-application maximum.
 *
 * What this writes. Every other value stays exactly as main has it.
 *   1. Catalog. The product id is resolved by exact name, else an exact alias. No row: one is inserted
 *      (draft, internal only, needs_pricing: no price field is written, the price is set in Inventory),
 *      with the 0.25 inch within 24 hours watering rule the 24-0-11 carries, and approved for the
 *      service report with a plain customer summary, as 20261007184000 did for the other row a
 *      migration inserted. A row that already exists is never replaced: only its EMPTY analysis,
 *      slow-release and watering fields are filled (the derived rate and the report read them), and its
 *      approval and copy are left as they are.
 *   2. The staged December row of every v13 protocol (all four grass tracks): the row named for the
 *      24-0-11 becomes the 10-0-22 (name, product id) with gates.targetN 0.45 lb N/1000 and
 *      gates.targetK2O 0.99 lb K2O/1000. The row stays a lb_n row: the plan derives the rate from the
 *      visit's N target and the product's analysis, 0.45 / 0.10 = 4.5 lb, as it does for every nutrition
 *      row. Its other gates (blackoutSensitive, fertilizerSafety) and the window are not touched.
 *      A protocol whose December window has no 24-0-11 row, or already has the 10-0-22, is skipped.
 *
 * Weed season (owner 2026-10-08, after an advisor review; the recipe file carries the same lines):
 *   A. February weed spots are Celsius only. The February window's Certainty, LESCO 90/10 surfactant and
 *      Blindside rows are retired. Reason: the Certainty label says it "may delay green-up", and the program's
 *      own February note says light weed spots only during green-up.
 *   B. Blindside is a November-through-March product. Its May and October rows are retired; January, March and
 *      December keep theirs (November has no weed spots). April through October: no weed spray once the Celsius
 *      cap is reached. Reason: Blindside is restricted until its full label is read (heat injury on St. Augustine).
 *   A retired row is the Dismiss mechanism of 20261007158000: the row keeps its place, its id and the link of every
 *   completion actual, and gains gates.retired = true; every planning reader leaves it out (activeProtocolProducts).
 *   One 'v13_weed_season' audit row per protocol lists the retired row ids. A row already retired, or not in the
 *   protocol, is skipped.
 *
 * Arena at the Florida half rate (owner 2026-10-08):
 *   D. Every staged Arena row (April, May, June; all four grass tracks) states its rate: rate_per_1000 0.147,
 *      rate_unit 'oz' (6.4 oz per acre) and gates.minIntervalDays 56. The Arena S.E. 50 WDG label (EPA 59639-152)
 *      allows turf at 6.4 to 12.8 oz per acre ("multiple applications can be made but do not exceed the maximum
 *      amount per year (12.8 oz per acre)"; "do not apply more than 0.4 lb active ingredient clothianidin per acre
 *      per year"), so 0.147 oz is the low end of its range and two applications reach the yearly limit. The 56 days
 *      between applications is the company's own rule, not a label interval (it follows the manufacturer's former
 *      Florida recommendation). Only a row still at the staged state (no rate, unit 'label_rate') is written; its
 *      trigger key, carrier (4 gal), cap gates and every other gate stay. The yearly count of 2 and the 56-day
 *      minimum are enforced in code behind GATE_LAWN_V13 (config/lawn-v13-count-caps.js), by product id, so no
 *      product_limits row is written; the catalog default rate (0.29 oz, the label's chinch rate) is untouched.
 *      One 'v13_arena_half_rate' audit row per protocol.
 *
 * No product limit is written: the label states none (the ordinance N caps and the program's 0.45 lb N
 * are read from the visit, not from the catalog).
 *
 * Idempotent: a second run changes nothing. One 'v13_december_potash' audit row per protocol records
 * each staged value before and after; one 'v13_december_potash_catalog' row records the catalog change.
 * The recipe wording of the chinch bug trigger (found at the edge of a damaged patch, no count) is text only;
 * the staged rows' gates.trigger key keeps its name.
 *
 * down(), exact-equality guarded:
 *   - a staged row goes back only while it is still the 10-0-22 row this wrote (name and product id), and
 *     each gate key only while it holds the written value;
 *   - a protocol that a scheduled visit or a completion references is NOT touched (the staging
 *     migration's guard): the rollback logs and leaves it, its audit rows and the catalog row;
 *   - a retired weed row is un-retired only while its gates.retired still reads true, and an Arena row goes back to
 *     its staged state (no rate, unit label_rate) only while it still reads the written rate, unit and interval;
 *   - the catalog goes back only when no protocol was left: a filled field only while it still holds
 *     the written value, an inserted row only while every written field is unchanged, no price field
 *     has a value and nothing references it (any foreign key, any table).
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const staged = require('./20261005120000_lawn_protocol_v13_staged');

const V13_VERSION = staged.V13_VERSION;
const ACTION = 'v13_december_potash';
const WEED_ACTION = 'v13_weed_season';
const ARENA_ACTION = 'v13_arena_half_rate';
const CATALOG_ACTION = 'v13_december_potash_catalog';
const ACTOR = 'migration 20261008120000';
const MIGRATION = '20261008120000_lawn_v13_december_potash';
const DECEMBER_WINDOW = 'dec_v13_spreader_feeding';
const OLD_NAME = staged.NAMES.F24;
const N = staged.NAMES;
const BLINDSIDE = 'Blindside Herbicide';
const NEW_NAME = 'LESCO 10-0-22 50% PolyPlus OPTI45 50% YaraRega 2% Fe 2% Mg KMAG MOP SOP Turfgrass Granular Fertilizer';

// 4.5 lb x 10% = 0.45 lb N; 4.5 lb x 22% = 0.99 lb K2O.
const DEC_RATE = 4.5;
const OLD_TARGET_N = '0.5 lb N/1000';
const NEW_GATES = { targetN: '0.45 lb N/1000', targetK2O: '0.99 lb K2O/1000' };

const VERIFIED_AT = '2026-10-08T00:00:00.000Z';
const VERIFIED_BY = 'label-check-2026-10-08';
// A fertilizer label gives no amount (as for the 24-0-11): 0.25 inch within 24 hours.
const WATERING_RULE = {
  mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'owner',
  label_note: 'Label: "watered into the turf soon after application" (no amount). Owner: 0.25 inch within 24 hours.',
  verified_at: VERIFIED_AT, verified_by: VERIFIED_BY,
};

const SUMMARY = 'A slow-release fertilizer with extra potassium. It feeds the lawn lightly and helps it handle cool, dry weather.';
const PRECAUTION = 'Granules on sidewalks or driveways are swept back into the turf. Watering-in follows the visit notes. No re-entry wait once watered in and dry.';

// The inserted row. Price fields are never written (vendor-pricing workflow): needs_pricing stays true.
const CATALOG = {
  name: NEW_NAME,
  display_name: 'LESCO 10-0-22 Turf Fertilizer',
  category: 'fertilizer',
  product_type: 'fertilizer',
  manufacturer: 'LESCO / SiteOne',
  active_ingredient: 'Nitrogen and potash fertilizer',
  formulation: 'granular',
  container_size: '50 lb',
  unit_size_oz: 800,
  siteone_sku: '511289',
  epa_reg_number: 'N/A',
  analysis_n: 10,
  analysis_p: 0,
  analysis_k: 22,
  slow_release_n_pct: 50,
  default_rate_per_1000: DEC_RATE,
  rate_unit: 'lb',
  label_version: 'LESCO 10-0-22 label, Rev. 7/23/24',
  label_verified_at: VERIFIED_AT,
  label_verified_by: VERIFIED_BY,
  label_source_note: 'LESCO 10-0-22 label (Rev. 7/23/24, read 2026-10-08), SiteOne 511289, 50 lb bag. 10% N: 5.00% polymer-coated urea (slow release), 2.39% ammoniacal, 2.61% nitrate. 22% K2O, 2% Mg, 6.81% S, 2% Fe, 9.68% Cl. Rotary spreader only; watered in soon after application; sweep walks. December: 4.5 lb per 1,000 sq ft = 0.45 lb N, 0.99 lb K2O. No price written: set it in Inventory (SiteOne, owner price $31.81 per 50 lb).',
  public_summary: SUMMARY,
  service_report_summary: SUMMARY,
  customer_precaution_summary: PRECAUTION,
  approved_for_service_report: true,
  post_application_watering: WATERING_RULE,
};
const JSON_COLUMNS = new Set(['post_application_watering']);
// Never written here; a value in any of them means someone priced the row after this inserted it.
const PRICE_FIELDS = ['best_price', 'best_vendor', 'cost_per_unit', 'cost_unit', 'best_vendor_pricing_id', 'best_price_amount_cached'];

// What an existing row gets where the field is empty: the derived rate and the report read these.
const FILL = {
  analysis_n: CATALOG.analysis_n,
  analysis_p: CATALOG.analysis_p,
  analysis_k: CATALOG.analysis_k,
  slow_release_n_pct: CATALOG.slow_release_n_pct,
  post_application_watering: WATERING_RULE,
};

// Arena (chinch bugs): 6.4 oz per acre = 0.147 oz per 1,000 sq ft, at least 8 weeks (56 days) between applications.
const ARENA_NAMES = [N.ARE, 'Arena S.E. 50 WDG Insecticide 2.5 lb. (Florida Only)'];
const ARENA_RATE = 0.147;
const ARENA_UNIT = 'oz';
const ARENA_INTERVAL_DAYS = 56;
const ARENA_STAGED_UNIT = 'label_rate';

// Weed-season rows to retire: [window key, product names].
const RETIRE = [
  ['feb_v13_spreader_green_up', [N.CER, N.NIS, BLINDSIDE]],
  ['may_v13_tetrino_hose', [BLINDSIDE]],
  ['oct_v13_spreader_fall', [BLINDSIDE]],
];

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

// Two column values are the same: numbers by value (pg decimals arrive as strings), dates by time, JSON deeply.
function same(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() === new Date(b).getTime();
  if (typeof a === 'object' || typeof b === 'object') return isDeepStrictEqual(asObject(a), asObject(b));
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na === nb;
  return a === b;
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

// ── Catalog ──────────────────────────────────────────────────────────────────

// Inserts the row when no name or alias spells it; else fills its empty fields. Returns what it wrote.
async function writeCatalog(knex) {
  const columns = await knex('products_catalog').columnInfo();
  const known = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => key in columns));
  const existingId = await resolveProductId(knex, NEW_NAME);

  if (!existingId) {
    const fields = known(CATALOG);
    const insert = { ...fields, active: true, needs_pricing: true, content_status: 'draft', customer_visibility: 'internal_only', created_at: knex.fn.now(), updated_at: knex.fn.now() };
    for (const column of JSON_COLUMNS) if (column in insert) insert[column] = JSON.stringify(insert[column]);
    const [made] = await knex('products_catalog').insert(insert).returning('id');
    return { productId: made && typeof made === 'object' ? made.id : made, inserted: fields, filled: [] };
  }

  const row = await knex('products_catalog').where({ id: existingId }).first();
  const filled = [];
  for (const [column, after] of Object.entries(known(FILL))) {
    if (row[column] != null) continue;
    const written = JSON_COLUMNS.has(column) ? JSON.stringify(after) : after;
    const updated = await knex('products_catalog').where({ id: existingId }).whereNull(column).update({ [column]: written, updated_at: knex.fn.now() });
    if (updated) filled.push({ column, after });
  }
  return { productId: existingId, inserted: null, filled };
}

// ── Staged rows ──────────────────────────────────────────────────────────────

// Writes the new name, product id and gate keys onto a staged row; returns what it recorded, read BEFORE the write.
async function patchRow(knex, row, productId) {
  const gates = asObject(row.gates);
  const record = {
    rowId: row.id,
    guard: { product_name: NEW_NAME, product_id: productId },
    columns: { product_name: { before: row.product_name, after: NEW_NAME }, product_id: { before: row.product_id ?? null, after: productId } },
    gates: {},
  };
  const next = { ...gates };
  for (const [key, after] of Object.entries(NEW_GATES)) {
    record.gates[key] = { had: key in gates, before: gates[key] ?? null, after };
    next[key] = after;
  }
  await knex('lawn_protocol_products').where({ id: row.id }).update({
    product_name: NEW_NAME, product_id: productId, gates: JSON.stringify(next), updated_at: knex.fn.now(),
  });
  return record;
}

// Puts back each column and gate key of a record that still holds the written value, and only on a
// row that is still the 10-0-22 row this wrote.
async function revertRow(knex, record) {
  const row = await knex('lawn_protocol_products').where({ id: record.rowId }).first();
  const { product_name: name, product_id: productId } = record.guard;
  if (!row || row.product_name !== name || String(row.product_id) !== String(productId)) return;
  const update = { updated_at: knex.fn.now() };
  for (const [column, change] of Object.entries(record.columns || {})) {
    if (same(row[column], change.after)) update[column] = change.before;
  }
  const gates = asObject(row.gates);
  for (const [key, change] of Object.entries(record.gates || {})) {
    if (!isDeepStrictEqual(gates[key], change.after)) continue;
    if (change.had) gates[key] = change.before; else delete gates[key];
  }
  update.gates = JSON.stringify(gates);
  await knex('lawn_protocol_products').where({ id: row.id }).update(update);
}

async function swapStagedRows(knex, productId) {
  const protocols = await knex('lawn_protocols').where({ version: V13_VERSION }).select('id');
  const known = new Set(protocols.map((protocol) => String(protocol.id)));
  const windows = (await knex('lawn_protocol_windows').where({ window_key: DECEMBER_WINDOW }).select('id', 'lawn_protocol_id'))
    .filter((window) => known.has(String(window.lawn_protocol_id)));
  for (const window of windows) {
    const rows = await knex('lawn_protocol_products').where({ lawn_protocol_window_id: window.id })
      .select('id', 'product_id', 'product_name', 'gates');
    const old = rows.find((row) => row.product_name === OLD_NAME);
    if (!old || rows.some((row) => row.product_name === NEW_NAME)) continue;
    const record = await patchRow(knex, old, productId);
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: window.lawn_protocol_id,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: window.lawn_protocol_id,
      action: ACTION,
      changed_fields: JSON.stringify(['products']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ rows: [record], oldTargetN: OLD_TARGET_N }),
      metadata: JSON.stringify({ migration: MIGRATION, gate: 'GATE_LAWN_V13' }),
    });
  }
}

// Retires the weed-season rows of one protocol; returns [{ rowId, window, product_name }].
async function retireWeedRows(knex, protocolId) {
  const retired = [];
  for (const [windowKey, names] of RETIRE) {
    const window = await knex('lawn_protocol_windows').where({ lawn_protocol_id: protocolId, window_key: windowKey }).first('id');
    if (!window) continue;
    const rows = await knex('lawn_protocol_products').where({ lawn_protocol_window_id: window.id }).whereIn('product_name', names).select('id', 'product_name', 'gates');
    for (const row of rows) {
      const gates = asObject(row.gates);
      if (gates.retired === true) continue;
      await knex('lawn_protocol_products').where({ id: row.id }).update({ gates: JSON.stringify({ ...gates, retired: true }), updated_at: knex.fn.now() });
      retired.push({ rowId: row.id, window: windowKey, product_name: row.product_name });
    }
  }
  return retired;
}

async function retireWeedSeason(knex) {
  for (const protocol of await knex('lawn_protocols').where({ version: V13_VERSION }).select('id')) {
    const retired = await retireWeedRows(knex, protocol.id);
    if (!retired.length) continue;
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocol.id,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: protocol.id,
      action: WEED_ACTION,
      changed_fields: JSON.stringify(['gates']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ retired }),
      metadata: JSON.stringify({ migration: MIGRATION, gate: 'GATE_LAWN_V13' }),
    });
  }
}

// Writes the half rate onto each staged Arena row still at the staged state; returns what it recorded.
async function setArenaRates(knex, protocolId) {
  const written = [];
  const rows = await knex('lawn_protocol_products as p').join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .where({ 'w.lawn_protocol_id': protocolId }).whereIn('p.product_name', ARENA_NAMES)
    .select('p.id', 'p.product_name', 'p.rate_per_1000', 'p.rate_unit', 'p.gates');
  for (const row of rows) {
    if (row.rate_per_1000 != null || row.rate_unit !== ARENA_STAGED_UNIT) continue;
    const gates = asObject(row.gates);
    await knex('lawn_protocol_products').where({ id: row.id }).update({
      rate_per_1000: ARENA_RATE, rate_unit: ARENA_UNIT, gates: JSON.stringify({ ...gates, minIntervalDays: ARENA_INTERVAL_DAYS }), updated_at: knex.fn.now(),
    });
    written.push({ rowId: row.id, product_name: row.product_name, hadInterval: 'minIntervalDays' in gates, beforeInterval: gates.minIntervalDays ?? null });
  }
  return written;
}

async function setArenaHalfRate(knex) {
  for (const protocol of await knex('lawn_protocols').where({ version: V13_VERSION }).select('id')) {
    const rows = await setArenaRates(knex, protocol.id);
    if (!rows.length) continue;
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocol.id,
      actor_name: ACTOR,
      entity_type: 'protocol',
      entity_id: protocol.id,
      action: ARENA_ACTION,
      changed_fields: JSON.stringify(['rate_per_1000', 'rate_unit', 'gates']),
      before_snapshot: JSON.stringify({}),
      after_snapshot: JSON.stringify({ rows, rate: ARENA_RATE, unit: ARENA_UNIT, beforeUnit: ARENA_STAGED_UNIT, interval: ARENA_INTERVAL_DAYS }),
      metadata: JSON.stringify({ migration: MIGRATION, gate: 'GATE_LAWN_V13' }),
    });
  }
}

const REQUIRED_TABLES = ['products_catalog', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log'];

async function hasAll(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex, REQUIRED_TABLES))) return;
  if (!(await knex('lawn_protocols').where({ version: V13_VERSION }).first('id'))) return;

  await retireWeedSeason(knex);
  await setArenaHalfRate(knex);
  const written = await writeCatalog(knex);
  await swapStagedRows(knex, written.productId);
  if (!written.inserted && !written.filled.length) return;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: ACTOR,
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: CATALOG_ACTION,
    changed_fields: JSON.stringify(['catalog']),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify({ productId: written.productId, inserted: written.inserted, filled: written.filled }),
    metadata: JSON.stringify({ migration: MIGRATION }),
  });
};

// ── Down ─────────────────────────────────────────────────────────────────────

// A protocol a scheduled visit or a completion points at: the staging migration's own guard.
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

// Reverts one protocol's audit record; returns true when the protocol was left because it is referenced.
async function revertProtocol(knex, log) {
  const after = asObject(log.after_snapshot);
  const protocol = log.lawn_protocol_id ? await knex('lawn_protocols').where({ id: log.lawn_protocol_id }).first('id', 'protocol_key') : null;
  if (protocol && await protocolReferenced(knex, protocol)) {
    console.log(`[lawn-v13-december-potash] rollback skipped for protocol ${protocol.protocol_key}: a visit or completion references ${V13_VERSION}`);
    return true;
  }
  for (const record of after.rows || []) await revertRow(knex, record);
  await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  return false;
}

// Any table that holds a foreign key to the product: a row there means the product is in use.
async function productReferenced(knex, productId) {
  const { rows } = await knex.raw(`
    SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.confrelid = 'products_catalog'::regclass
  `);
  for (const { tbl, col } of rows) {
    if (await knex(tbl).where({ [col]: productId }).first(col)) return true;
  }
  return false;
}

async function revertCatalog(knex) {
  const logs = await knex('lawn_protocol_audit_log').where({ action: CATALOG_ACTION }).select('id', 'after_snapshot');
  for (const log of logs) {
    const { productId, inserted, filled = [] } = asObject(log.after_snapshot);
    // A field this filled goes back to empty only while it still holds the written value.
    for (const change of filled) {
      const row = await knex('products_catalog').where({ id: productId }).first('id', change.column);
      if (row && same(row[change.column], change.after)) {
        await knex('products_catalog').where({ id: productId }).update({ [change.column]: null, updated_at: knex.fn.now() });
      }
    }
    if (inserted) {
      const row = await knex('products_catalog').where({ id: productId }).first();
      // Unchanged: every written field as written, and no price set on the row since.
      const unchanged = row && Object.entries(inserted).every(([column, value]) => same(row[column], value))
        && PRICE_FIELDS.every((column) => row[column] == null);
      if (unchanged && !(await productReferenced(knex, productId))) await knex('products_catalog').where({ id: productId }).del();
    }
    await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  }
}

// Un-retires the rows a weed-season audit row lists, each only while it still reads retired; returns true when the protocol was left.
async function revertWeedSeason(knex, log) {
  const protocol = log.lawn_protocol_id ? await knex('lawn_protocols').where({ id: log.lawn_protocol_id }).first('id', 'protocol_key') : null;
  if (protocol && await protocolReferenced(knex, protocol)) {
    console.log(`[lawn-v13-december-potash] weed-season rollback skipped for protocol ${protocol.protocol_key}: a visit or completion references ${V13_VERSION}`);
    return true;
  }
  for (const { rowId, product_name: name } of asObject(log.after_snapshot).retired || []) {
    const row = await knex('lawn_protocol_products').where({ id: rowId }).first('id', 'product_name', 'gates');
    const gates = row ? asObject(row.gates) : null;
    if (!gates || row.product_name !== name || gates.retired !== true) continue;
    delete gates.retired;
    await knex('lawn_protocol_products').where({ id: rowId }).update({ gates: JSON.stringify(gates), updated_at: knex.fn.now() });
  }
  await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  return false;
}

// Puts the staged Arena state back, a row only while it still reads the written rate, unit and interval.
async function revertArena(knex, log) {
  const protocol = log.lawn_protocol_id ? await knex('lawn_protocols').where({ id: log.lawn_protocol_id }).first('id', 'protocol_key') : null;
  if (protocol && await protocolReferenced(knex, protocol)) {
    console.log(`[lawn-v13-december-potash] arena rollback skipped for protocol ${protocol.protocol_key}: a visit or completion references ${V13_VERSION}`);
    return true;
  }
  const after = asObject(log.after_snapshot);
  for (const entry of after.rows || []) {
    const row = await knex('lawn_protocol_products').where({ id: entry.rowId }).first('id', 'product_name', 'rate_per_1000', 'rate_unit', 'gates');
    if (!row || row.product_name !== entry.product_name || !same(row.rate_per_1000, after.rate) || row.rate_unit !== after.unit) continue;
    const gates = asObject(row.gates);
    if (gates.minIntervalDays !== after.interval) continue;
    if (entry.hadInterval) gates.minIntervalDays = entry.beforeInterval; else delete gates.minIntervalDays;
    await knex('lawn_protocol_products').where({ id: row.id }).update({ rate_per_1000: null, rate_unit: after.beforeUnit, gates: JSON.stringify(gates), updated_at: knex.fn.now() });
  }
  await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
  return false;
}

exports.down = async function down(knex) {
  if (!(await hasAll(knex, REQUIRED_TABLES))) return;
  for (const log of await knex('lawn_protocol_audit_log').where({ action: ARENA_ACTION }).select('id', 'lawn_protocol_id', 'after_snapshot')) await revertArena(knex, log);
  for (const log of await knex('lawn_protocol_audit_log').where({ action: WEED_ACTION }).select('id', 'lawn_protocol_id', 'after_snapshot')) await revertWeedSeason(knex, log);
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'lawn_protocol_id', 'after_snapshot');
  let kept = 0;
  for (const log of logs) if (await revertProtocol(knex, log)) kept += 1;
  if (kept) {
    console.log('[lawn-v13-december-potash] catalog row kept: a protocol still uses the 10-0-22 row');
    return;
  }
  await revertCatalog(knex);
};

exports.ACTION = ACTION;
exports.CATALOG_ACTION = CATALOG_ACTION;
exports.DECEMBER_WINDOW = DECEMBER_WINDOW;
exports.WEED_ACTION = WEED_ACTION;
exports.ARENA_ACTION = ARENA_ACTION;
exports.ARENA_RATE = ARENA_RATE;
exports.ARENA_UNIT = ARENA_UNIT;
exports.ARENA_INTERVAL_DAYS = ARENA_INTERVAL_DAYS;
exports.RETIRE = RETIRE;
exports.OLD_NAME = OLD_NAME;
exports.NEW_NAME = NEW_NAME;
exports.DEC_RATE = DEC_RATE;
exports.OLD_TARGET_N = OLD_TARGET_N;
exports.NEW_GATES = NEW_GATES;
exports.CATALOG = CATALOG;
exports.WATERING_RULE = WATERING_RULE;
exports.WATERING = [{ name: NEW_NAME, rule: WATERING_RULE }];
exports.SUMMARY = SUMMARY;
exports.PRECAUTION = PRECAUTION;
