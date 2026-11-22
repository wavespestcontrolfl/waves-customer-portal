/**
 * Lawn protocol v13: the October spreader product becomes LESCO Stonewall 0.37% 18-0-10
 * (owner 2026-11-21, "stonewall"). The same swap shape as 20261007120500, which moved October
 * from Stonewall 15-0-15 to the Dimension granular.
 *
 * What changes. Each v13 protocol's October step (window oct_v13_spreader_fall, all grass
 * tracks) goes from LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus
 * Fertilizer (dithiopyr, EPA 10404-87) to LESCO Stonewall 0.37% 18-0-10 (prodiamine, EPA
 * 10404-114), at the SAME rate: 4.04 lb of product per 1,000 sq ft, spreader. Same analysis, so
 * the same 0.73 lb N and 0.4 lb K2O per 1,000 sq ft. Prodiamine: 4.04 x 43.56 x 0.0037 =
 * 0.65 lb ai per acre.
 *
 * Out of scope, left exactly as it is: the 9x April step and the North Port March swap (both
 * stay on the Dimension granular), January Stonewall 4FL, March and June Dimension 2EW, every
 * price field, every catalog row's label, watering and report fields, and every product_limits
 * row that already exists. A 9-visit lawn already gets January Stonewall 4FL (0.68 lb prodiamine
 * per acre) and October (0.65); a third prodiamine application (April, 0.45) would pass the
 * label's yearly maximum, so April stays dithiopyr.
 *
 * The label (EPA accepted label 10404-114, May 1 2020):
 *   - at most 405 lb of product per acre = 9.3 lb per 1,000 sq ft = 1.5 lb ai per acre in a
 *     calendar year on bermudagrass, bahiagrass, centipedegrass, seashore paspalum,
 *     St. Augustinegrass, tall fescue and zoysia ("Do not apply more than 1.5 lb a.i. per
 *     calendar year per acre");
 *   - listed rates: 135 lb/A = 3.1 lb per 1,000 = 0.50 lb ai/A; 176 = 4.0 = 0.65; 203 = 4.7 = 0.75;
 *     270 = 6.2 = 1.0; 405 = 9.3 = 1.5. Single or sequential applications are allowed inside
 *     the yearly maximum; the label states no other per-application maximum, no maximum number
 *     of applications and no minimum interval;
 *   - activation: at least 0.5 inch of rainfall or irrigation within 14 days after application.
 *     Not for new or overseeded turf within 60 days of seeding or before the second mowing.
 *     It does not control established weeds.
 * Year total, both plans: January Stonewall 4FL 0.5 fl oz per 1,000 sq ft (0.68 lb ai per acre)
 * plus this step (0.65) = 1.33 lb prodiamine per acre, under 1.5. October no longer carries
 * dithiopyr.
 *
 * ONE GATE, BEFORE ANY WRITE (readState). The migration acts only on a database it knows in full.
 * Five dry runs of the pre-push audit each named another state of existing data (an edited row, a
 * second cap row, an alias on another product, a blank ingredient), so the states are not handled
 * one by one: every fact the swap relies on is checked in one place, and anything else THROWS
 * and names what to correct. Nothing is written then. Known states:
 *   - The October window of each v13 protocol is TO SWAP (its one bag row is EXACTLY the row the
 *     migrations up to 20261007120500 leave: the Dimension granular by name and product id, and
 *     the WHOLE row beside that: role, broadcast, 4.04 lb, no carrier, in the plan by default,
 *     its five gate keys, its dithiopyr counter and nothing else in it, mixing, report copy; no
 *     Stonewall row beside it) or SWAPPED (the same whole row with the Stonewall name, product
 *     id and prodiamine counter; no Dimension bag row beside it). The row is compared column for
 *     column and key for key (ROW_SHAPE, ROW_JSON, ROW_GATES), so a row edited in ANY way
 *     (renamed, re-rated, another unit or mode, another product id or counter, turned off, a key
 *     added), both bags in one window, or no bag row: throws. The recipe in
 *     lawn-protocol-v13.json says Stonewall for every track, so a track this could not swap
 *     would leave the recipe and the staged protocol apart (AGENTS.md, lawn protocol data
 *     fan-out); an office edit is never overwritten either. The Dimension product id is the one
 *     catalog row with that exact name, else the one product an alias spells that way (the
 *     upgrade path 20261007120500 supports); it is only compared, never written.
 *   - The Stonewall catalog row is the production row (exactly ONE row with this exact name, no
 *     alias that spells the name on another product, active, an active ingredient that BEGINS
 *     with prodiamine as the yearly cap check reads it (ILIKE 'prodiamine%', so a leading space
 *     fails here too), EPA 10404-114, rates in pounds), or the database has NO row and no alias for the name (CI, a dev copy) and the
 *     row is inserted. Two rows, a row known only through an alias, another ingredient,
 *     registration or unit: throws.
 *   - The bag has NO yearly prodiamine cap row, or exactly ONE that is a hard block in lb per
 *     1,000 sq ft per year. Two rows (the check would count one application twice), another
 *     unit or a warning-only row (it cannot be compared with the label): throws.
 * Production, read 2026-11-22: four tracks TO SWAP (each whole row equal to a migrations-built
 * one), one catalog row with the production facts, no alias, one hard-block cap row. A database with no v13 October window gets no check and no write.
 * The window, its rows, the catalog row and the cap row are read FOR UPDATE, and each write repeats
 * the values it checked in its WHERE: an edit made while the migration runs waits, or stops the
 * migration; it is never overwritten from an older read.
 *
 * What this writes:
 *   1. The row: product name, product id, the N and K2O gate text (values unchanged), the
 *      annual counter (prodiamine_lb_per_1000, the granular's own unit; the staged Stonewall
 *      4FL rows count prodiamine_oz_per_1000). report_copy holds only the row's role, never a
 *      product name, so it is not touched.
 *   2. The window goal text, only while it still reads the 10-07 text.
 *   3. The Stonewall product id is the one catalog row with the exact name. The row exists in
 *      production but not in a database built from migrations alone (CI, a dev copy): there the
 *      catalog row is INSERTED with the production label values (the insert style of
 *      20261005130000), so every database ends on the same October product. Customer-copy and
 *      approval columns keep their defaults (the owner approves them).
 * Items 4 to 7 are the bag's catalog facts. They are checked on every database where a track
 * uses the bag, swapped by this run or before it; a database with no v13 October window gets no
 * lookup and no write.
 *   4. Fertilizer analysis. The production row holds no analysis_n/p/k. The new-sod sheet
 *      (lawn-sod-sheet) and two completion checks read analysis_n from the row, so a bag
 *      without it is not treated as a fertilizer there. The bag's guaranteed analysis
 *      (18-0-10, in its name) is filled column by column, each only where it is NULL (a row
 *      that holds P but no N is still no fertilizer to those readers); a value an administrator
 *      wrote is never overwritten.
 *   5. The standard rate. AGENTS.md, lawn protocol data fan-out: the catalog's
 *      default_rate_per_1000 matches the program rate. The yearly cap check counts an
 *      application whose ledger row holds no rate and no quantity at this figure. The production
 *      row holds 3.1 lb (the label's lowest listed rate), which would count the 4.04 lb October
 *      pass 0.94 lb short. The standard rate becomes 4.04 lb, whatever it held (the before
 *      value is in the audit row). The inserted row starts at 4.04.
 *   6. The yearly prodiamine cap row (annual_max_rate, active_ingredient prodiamine). The label's
 *      yearly maximum is 405 lb of product per acre, printed as 9.3 lb per 1,000 sq ft. The figure
 *      20261006140000 derived from the 1.5 lb ai line (9.3068) sits a little above it, so the
 *      cap is the label's own 9.3 (the rule of 20261006170000: the lower of the derived figure
 *      and the label's annual maximum). The planner divides by this row, so it may never be
 *      above the label:
 *        - no cap row: 9.3 is inserted;
 *        - the one cap row is ABOVE 9.3 (production's 9.3068, or any higher figure): lowered to 9.3;
 *        - the one cap row is at or under 9.3, a stricter limit someone set: it stays.
 *      405 / 43.56 = 9.2975 is not used: it would refuse the 9.3 lb rate the label itself lists.
 *      The 4FL cap and every other limit row are never changed.
 *
 *   7. The label water-in rule (0.5 inch within 14 days), only where post_application_watering
 *      is NULL (20261022120000 stores it on the row with this exact name; a row created after
 *      that migration ran has none).
 *
 * Chemical group: no write. The production Stonewall row holds its group in the older free-text
 * column (moa_group 'Group 3', hrac_group NULL), as the liquid pre-emergents do. The rotation
 * check's pre_emergent_group_3 exemption (waveguard-approval-engine) reads the group from either
 * column, so the October bag after a Group 3 pre-emergent raises no approval block.
 *
 * Idempotent: a second run finds the Stonewall rows and writes nothing. One
 * 'v13_october_stonewall' audit row per protocol records each value before and after; one
 * 'v13_october_stonewall_catalog' row records the inserted catalog row, the filled analysis, the
 * standard rate, the filled watering rule and the inserted or lowered cap row.
 *
 * down():
 *   - a staged row goes back only while it is still EXACTLY the row this wrote, the whole row
 *     as in the gate. Identity, dose and counter are one decision: a row edited since in any way
 *     (re-rated for Stonewall, a key added to its counter or gates) stays whole, with its goal
 *     and its audit row, so an edited Stonewall dose never ends on the Dimension row and nothing
 *     written since is erased. The window goal goes back only while it reads the new text;
 *   - a protocol that a scheduled visit or a completion references is NOT touched (the staging
 *     migration's guard): the rollback logs and leaves it and its audit row;
 *   - the catalog row, its analysis, standard rate and watering rule, and the cap row are NEVER rolled back, on purpose. They are
 *     label facts that an administrator can edit after up() ran (a price, inventory, an
 *     approval), an application made with the bag still counts against the cap, and equality
 *     of a value cannot prove who wrote it. Their audit row stays as the record. A second up()
 *     finds them and writes nothing.
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const staged = require('./20261005120000_lawn_protocol_v13_staged');
const octoberDimension = require('./20261007120500_lawn_v13_october_dimension');

const V13_VERSION = staged.V13_VERSION;
const ACTION = 'v13_october_stonewall';
const CATALOG_ACTION = 'v13_october_stonewall_catalog';
const OCTOBER_WINDOW = 'oct_v13_spreader_fall';
const OLD_NAME = octoberDimension.NEW_NAME;
const NEW_NAME = 'LESCO Stonewall 0.37% 18-0-10';

const OCT_RATE = octoberDimension.OCT_RATE; // 4.04 lb per 1,000 sq ft, unchanged
const OLD_GOAL = octoberDimension.NEW_GOAL;
const NEW_GOAL = 'Stonewall 18-0-10 fall feeding with pre-emergent; mapped large patch, take-all, grub and weed spots.';
const OLD_COUNTER_KEY = octoberDimension.NEW_GATES.annualCounter; // 'dithiopyr_lb_per_1000'
const NEW_COUNTER_KEY = 'prodiamine_lb_per_1000';
// The N and K2O text is the same bag analysis at the same rate (4.04 lb x 18% = 0.73 lb N; x 10% = 0.40 lb K2O).
const OLD_GATES = octoberDimension.NEW_GATES; // what 20261007120500 wrote: the same N and K2O targets, the dithiopyr counter
const NEW_GATES = { targetN: OLD_GATES.targetN, targetK2O: OLD_GATES.targetK2O, annualCounter: NEW_COUNTER_KEY };
const JSON_COLUMNS = new Set(['annual_counter']);

// Label: at most 405 lb of product per acre in a calendar year, printed as 9.3 lb per 1,000 sq ft (1.4989 lb ai per acre).
// The 1.5 lb ai line gives 1.5 / 43.56 / 0.37% = 9.3068, a little ABOVE that, so the cap is the label's own 9.3.
const STRENGTH = 0.0037;
const DERIVED_CAP = Math.round((1.5 / 43.56 / STRENGTH) * 10000) / 10000; // 9.3068: what 20261006140000 wrote where the product existed
const CAP_VALUE = 9.3;
// The label's lowest listed rate: the standard rate the production catalog row holds.
const LABEL_LOW_RATE = 3.1;
const CAP_SPEC = {
  match_type: 'active_ingredient',
  match_value: 'prodiamine',
  limit_type: 'annual_max_rate',
  limit_value: CAP_VALUE,
  limit_unit: 'lb/1000sf/year',
  severity: 'hard_block',
  description: `Prodiamine yearly cap, all products: the label's yearly maximum (EPA 10404-114: 405 lb of product per acre = 9.3 lb per 1,000 sq ft, under 1.5 lb ai/acre/year), written as ${CAP_VALUE} lb of ${NEW_NAME} per 1,000 sq ft. Every prodiamine product shares this one cap.`,
};

// The production row, read 2026-11-21, with the program rate as its standard rate (AGENTS.md, lawn protocol data
// fan-out). Inserted only where no row has this exact name and no alias spells it.
// Customer-copy and approval columns (content_status, customer_visibility, approved_for_service_report, ...)
// keep their column defaults: production has them already and the approval is the owner's.
// The label water-in rule is the one 20261022120000 stores for this name. analysis_n/p/k is the bag's guaranteed
// analysis (18-0-10, in its name): the production row does not hold it (nor does production's Dimension granular row),
// but the Dimension row of a migration-built database does (20261005130000), so the two bags read alike there.
const CATALOG_ROW = {
  name: NEW_NAME,
  category: 'herbicide',
  subcategory: 'Pre-emergent + fertilizer combo',
  active_ingredient: 'Prodiamine 0.37% + 18-0-10',
  moa_group: 'Group 3',
  formulation: 'granular',
  container_size: '50 lb',
  unit_size_oz: 800,
  epa_reg_number: '10404-114',
  default_rate_per_1000: OCT_RATE,
  min_label_rate_per_1000: LABEL_LOW_RATE,
  max_label_rate_per_1000: 9.3,
  rate_unit: 'lb',
  analysis_n: 18,
  analysis_p: 0,
  analysis_k: 10,
  service_lines: JSON.stringify(['lawn']),
  post_application_watering: JSON.stringify({
    mode: 'water_in',
    source: 'label',
    label_note: 'Label: "activated by at least 0.5 inch of rainfall or irrigation prior to weed seed germination and within 14 days following application."',
    verified_at: '2026-10-22T00:00:00.000Z',
    verified_by: 'label-check-2026-10-22',
    water_in_inches: 0.5,
    water_in_by_hours: 336,
  }),
  active: true,
};

const ANALYSIS_COLUMNS = ['analysis_n', 'analysis_p', 'analysis_k'];
const ANALYSIS = Object.fromEntries(ANALYSIS_COLUMNS.map((column) => [column, CATALOG_ROW[column]])); // 18-0-10

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const isLb = (value) => String(value || '').trim().toLowerCase() === 'lb';

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

// Two column values are the same: numbers by value (pg decimals arrive as strings), JSON deeply.
function same(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'object' || typeof b === 'object') return isDeepStrictEqual(asObject(a), asObject(b));
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na === nb;
  return a === b;
}

// The catalog rows whose name is exactly `name`, and the product ids an alias spells that way.
async function catalogMatches(knex, name) {
  const rows = (await knex('products_catalog').select('id', 'name')).filter((row) => normalize(row.name) === normalize(name));
  const aliases = (await knex.schema.hasTable('product_aliases')) ? await knex('product_aliases').select('product_id', 'alias_name') : [];
  const aliasIds = [...new Set(aliases.filter((row) => normalize(row.alias_name) === normalize(name)).map((row) => String(row.product_id)))];
  return { rows, aliasIds };
}

// What the production Stonewall row must state for the swap to be safe: [is it so, what is wrong].
const BAG_CHECKS = [
  [(bag) => bag.active !== false, () => 'is not active'],
  // application-limits.js finds a prodiamine application by `active_ingredient ILIKE 'prodiamine%'`: the same test, no trim.
  [(bag) => /^prodiamine/i.test(String(bag.active_ingredient ?? '')),
    (bag) => `does not state prodiamine first as its active ingredient (${JSON.stringify(bag.active_ingredient)}); the yearly cap check finds an application by that word`],
  [(bag) => String(bag.epa_reg_number || '').trim() === CATALOG_ROW.epa_reg_number,
    (bag) => `holds EPA registration ${JSON.stringify(bag.epa_reg_number)}, not ${CATALOG_ROW.epa_reg_number}`],
  [(bag) => isLb(bag.rate_unit),
    (bag) => `states its rates in ${JSON.stringify(bag.rate_unit)}, not lb, so its standard rate cannot be set to the program rate of ${OCT_RATE} lb per 1,000 sq ft`],
];

const stop = (what) => { throw new Error(`lawn v13 October Stonewall: ${what}. Nothing was written. Correct it, then run the migration again.`); };

// The Stonewall catalog row (read FOR UPDATE), or null when the database has no row and no alias for the name (it is
// inserted then). Any state between the two stops the migration: see the header.
async function readBag(knex) {
  const { rows, aliasIds } = await catalogMatches(knex, NEW_NAME);
  if (!rows.length && !aliasIds.length) return null;
  if (rows.length !== 1) stop(`${rows.length} catalog rows are named ${NEW_NAME}${aliasIds.length ? ', and an alias spells that name' : ''}; the migration needs exactly one row with the name`);
  if (aliasIds.some((id) => id !== String(rows[0].id))) stop(`an alias spells ${NEW_NAME} on another product than the catalog row with that name`);
  const bag = await knex('products_catalog').where({ id: rows[0].id }).forUpdate()
    .first('id', 'active', 'active_ingredient', 'epa_reg_number', 'default_rate_per_1000', 'rate_unit');
  const wrong = BAG_CHECKS.filter(([holds]) => !holds(bag)).map(([, why]) => why(bag));
  if (wrong.length) stop(`the catalog row of ${NEW_NAME} ${wrong.join('; ')}`);
  return bag;
}

// ── Staged rows ──────────────────────────────────────────────────────────────

// Writes `columns` and `gateKeys` onto a staged row and returns what it recorded:
// every value before and after, read BEFORE the write.
async function patchRow(knex, row, columns, gateKeys) {
  const gates = asObject(row.gates);
  const record = { rowId: row.id, guard: { product_name: columns.product_name, product_id: columns.product_id }, columns: {}, gates: {} };
  const update = { updated_at: knex.fn.now() };
  for (const [column, after] of Object.entries(columns)) {
    const current = JSON_COLUMNS.has(column) ? asObject(row[column]) : (row[column] ?? null);
    record.columns[column] = { before: current, after };
    update[column] = JSON_COLUMNS.has(column) ? JSON.stringify(after) : after;
  }
  const next = { ...gates };
  for (const [key, after] of Object.entries(gateKeys)) {
    record.gates[key] = { had: key in gates, before: gates[key] ?? null, after };
    next[key] = after;
  }
  update.gates = JSON.stringify(next);
  // The row was read FOR UPDATE; the WHERE repeats what was checked, so a write from an older read can never land.
  const changed = await knex('lawn_protocol_products')
    .where({ id: row.id, product_name: row.product_name, product_id: row.product_id, rate_per_1000: row.rate_per_1000, rate_unit: row.rate_unit })
    .update(update);
  if (changed !== 1) throw new Error(`lawn v13 October Stonewall: staged row ${row.id} changed while the migration ran. Run the migration again.`);
  return record;
}

// Puts a staged row back to the values the record holds, only while the row is still EXACTLY the row up() wrote (the
// whole row: nothing written since can be erased). Returns false, and writes nothing, when it is not.
async function revertRow(knex, record) {
  // FOR UPDATE, and the write repeats the guard: an edit made while the rollback runs waits; it is never overwritten from an older read.
  const row = await knex('lawn_protocol_products').where({ id: record.rowId }).forUpdate().first();
  const { product_name: name, product_id: productId } = record.guard;
  if (!row || !isOctoberBagRow(row, name, productId, NEW_COUNTER_KEY)) return false;
  const update = { updated_at: knex.fn.now() };
  for (const [column, change] of Object.entries(record.columns || {})) {
    update[column] = JSON_COLUMNS.has(column) ? JSON.stringify(change.before) : change.before;
  }
  const gates = asObject(row.gates);
  for (const [key, change] of Object.entries(record.gates || {})) {
    if (change.had) gates[key] = change.before; else delete gates[key];
  }
  update.gates = JSON.stringify(gates);
  const changed = await knex('lawn_protocol_products')
    .where({ id: row.id, product_name: name, product_id: productId, rate_per_1000: row.rate_per_1000, rate_unit: row.rate_unit }).update(update);
  return changed === 1;
}

// The whole staged October bag row, as the migrations leave it: the same on all four tracks, and in production on
// 2026-11-22. The swap and the rollback act only on a row that is EXACTLY this, column for column and key for key.
const ROW_COLUMNS = ['id', 'product_id', 'product_name', 'role', 'application_mode', 'rate_per_1000', 'rate_unit', 'carrier_gal_per_1000', 'default_in_plan', 'gates', 'annual_counter', 'mixing', 'report_copy'];
const ROW_SHAPE = Object.freeze({ role: 'fall_pre_emergent_nutrition', application_mode: 'broadcast', rate_unit: 'lb', carrier_gal_per_1000: null, default_in_plan: true });
const ROW_JSON = Object.freeze({ mixing: {}, report_copy: { role: 'fall_pre_emergent_nutrition' } });
const ROW_GATES = Object.freeze({ targetN: OLD_GATES.targetN, targetK2O: OLD_GATES.targetK2O, fertilizerSafety: true, blackoutSensitive: true });

// Is this staged row exactly the October bag row for `name`? Name and product id, 4.04, every ROW_SHAPE column, the
// two JSON columns, and gates and annual counter that hold the counter key and NOTHING else beside the fixed keys.
function isOctoberBagRow(row, name, productId, counterKey) {
  if (row.product_name !== name || !productId || String(row.product_id) !== String(productId)) return false;
  if (!same(row.rate_per_1000, OCT_RATE)) return false;
  if (!Object.entries(ROW_SHAPE).every(([column, value]) => (row[column] ?? null) === value)) return false;
  if (!Object.entries(ROW_JSON).every(([column, value]) => isDeepStrictEqual(asObject(row[column]), value))) return false;
  return isDeepStrictEqual(asObject(row.gates), { ...ROW_GATES, annualCounter: counterKey })
    && isDeepStrictEqual(asObject(row.annual_counter), { counter: counterKey });
}

// The October windows of the v13 protocols, read FOR UPDATE, each with its protocol key.
async function octoberWindows(knex) {
  const protocols = await knex('lawn_protocols').where({ version: V13_VERSION }).select('id', 'protocol_key');
  const known = new Map(protocols.map((protocol) => [String(protocol.id), protocol.protocol_key]));
  const windows = await knex('lawn_protocol_windows').where({ window_key: OCTOBER_WINDOW }).select('id', 'lawn_protocol_id', 'goal').forUpdate();
  return windows.filter((window) => known.has(String(window.lawn_protocol_id))).map((window) => ({ ...window, protocolKey: known.get(String(window.lawn_protocol_id)) }));
}

// The rows to swap ({ protocolId, window, row }) and the protocol keys whose window is neither TO SWAP nor SWAPPED.
async function readOctober(knex, windows, dimensionId, stonewallId) {
  const swaps = [];
  const unresolved = [];
  for (const window of windows) {
    const rows = await knex('lawn_protocol_products').where({ lawn_protocol_window_id: window.id }).select(ROW_COLUMNS).forUpdate();
    const oldRows = rows.filter((row) => row.product_name === OLD_NAME);
    const newRows = rows.filter((row) => row.product_name === NEW_NAME);
    const toSwap = oldRows.length === 1 && !newRows.length && isOctoberBagRow(oldRows[0], OLD_NAME, dimensionId, OLD_COUNTER_KEY);
    const swapped = !oldRows.length && newRows.length === 1 && isOctoberBagRow(newRows[0], NEW_NAME, stonewallId, NEW_COUNTER_KEY);
    if (toSwap) swaps.push({ protocolId: window.lawn_protocol_id, window, row: oldRows[0] });
    else if (!swapped) unresolved.push(window.protocolKey);
  }
  return { swaps, unresolved };
}

// The bag's yearly prodiamine cap rows, read FOR UPDATE before any write.
function readCaps(knex, productId) {
  return knex('product_limits')
    .where({ product_id: productId, match_type: CAP_SPEC.match_type, match_value: CAP_SPEC.match_value, limit_type: CAP_SPEC.limit_type })
    .select('id', 'limit_value', 'limit_unit', 'severity').forUpdate();
}

// Can this cap row be compared with the label maximum? A hard block, in lb per 1,000 sq ft per year, above zero.
const capComparable = (cap) => cap.limit_unit === CAP_SPEC.limit_unit && cap.severity === CAP_SPEC.severity && Number(cap.limit_value) > 0;

// No cap row: the label's 9.3 is inserted. The one cap row above 9.3 is lowered to it; at or under 9.3 it stays (a
// stricter limit someone set). `caps` is what the gate accepted: none, or one comparable row. Returns what it
// inserted and lowered.
async function applyCap(knex, productId, caps) {
  if (!caps.length) {
    const row = { product_id: productId, ...CAP_SPEC };
    const [made] = await knex('product_limits').insert(row).returning('id');
    return { inserted: [{ id: made && typeof made === 'object' ? made.id : made, ...row }], lowered: [] };
  }
  const lowered = [];
  for (const cap of caps) {
    if (!(Number(cap.limit_value) > CAP_VALUE)) continue;
    const changed = await knex('product_limits').where({ id: cap.id, limit_value: cap.limit_value, limit_unit: cap.limit_unit })
      .update({ limit_value: CAP_VALUE, updated_at: knex.fn.now() });
    if (changed === 1) lowered.push({ id: cap.id, before: Number(cap.limit_value), after: CAP_VALUE });
  }
  return { inserted: [], lowered };
}

// Inserts the catalog row (production values) and returns its id.
async function insertCatalogRow(knex) {
  const columns = await knex('products_catalog').columnInfo();
  const row = Object.fromEntries(Object.entries(CATALOG_ROW).filter(([column]) => column in columns));
  const [made] = await knex('products_catalog').insert({ ...row, created_at: knex.fn.now(), updated_at: knex.fn.now() }).returning('id');
  return made && typeof made === 'object' ? made.id : made;
}

// The bag's guaranteed analysis, column by column, each only where the row holds none. Returns the columns it
// filled ({ analysis_n: 18, ... }), or null when it wrote nothing.
async function fillAnalysis(knex, productId) {
  const columns = await knex('products_catalog').columnInfo();
  const filled = {};
  for (const column of ANALYSIS_COLUMNS) {
    if (!(column in columns)) continue;
    const changed = await knex('products_catalog').where({ id: productId }).whereNull(column).update({ [column]: ANALYSIS[column], updated_at: knex.fn.now() });
    if (changed === 1) filled[column] = ANALYSIS[column];
  }
  return Object.keys(filled).length ? filled : null;
}

// The standard rate of an existing row in pounds (`bag`, read FOR UPDATE): the program rate. Returns { before, after }
// when it wrote, else null.
async function alignDefaultRate(knex, bag) {
  const before = bag.default_rate_per_1000 == null ? null : Number(bag.default_rate_per_1000);
  if (before === OCT_RATE) return null;
  const changed = await knex('products_catalog').where({ id: bag.id, rate_unit: bag.rate_unit }).update({ default_rate_per_1000: OCT_RATE, updated_at: knex.fn.now() });
  return changed === 1 ? { before, after: OCT_RATE } : null;
}

// The label water-in rule, only where the row holds none. Returns true when it wrote.
async function fillWatering(knex, productId) {
  const columns = await knex('products_catalog').columnInfo();
  if (!('post_application_watering' in columns)) return false;
  const changed = await knex('products_catalog').where({ id: productId }).whereNull('post_application_watering')
    .update({ post_application_watering: CATALOG_ROW.post_application_watering, updated_at: knex.fn.now() });
  return changed === 1;
}

const REQUIRED_TABLES = [
  'products_catalog', 'product_limits', 'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log',
];

async function hasAll(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

// THE GATE: everything the swap relies on, read and checked BEFORE any write (see the header). Returns what up() writes
// from, or null when no v13 October window exists (nothing names the bag here: no check, no write).
async function readState(knex) {
  const windows = await octoberWindows(knex);
  if (!windows.length) return null;
  const bag = await readBag(knex);
  const dimension = await catalogMatches(knex, OLD_NAME);
  // Only compared with the staged row's product id, never written: one row with the name, else the one product an alias spells so.
  const dimensionIds = dimension.rows.length ? dimension.rows.map((row) => row.id) : dimension.aliasIds;
  const dimensionId = dimensionIds.length === 1 ? dimensionIds[0] : null;
  const { swaps, unresolved } = await readOctober(knex, windows, dimensionId, bag ? bag.id : null);
  // A track that cannot be swapped would leave the recipe (Stonewall on every track) and its staged row apart.
  if (unresolved.length) {
    stop(`the October step of ${unresolved.join(', ')} is not the row 20261007120500 wrote `
      + `(${OLD_NAME} at ${OCT_RATE} lb, in the plan, with its N, K2O and dithiopyr values), and is not that row already swapped to ${NEW_NAME}`);
  }
  // The cap row is the planner's divisor: more than one counts an application twice; one that cannot be compared could sit above the label.
  const caps = bag ? await readCaps(knex, bag.id) : [];
  if (caps.length > 1 || caps.some((cap) => !capComparable(cap))) {
    stop(`${NEW_NAME} has ${caps.length} yearly prodiamine cap row(s) (${caps.map((cap) => `${cap.limit_value} ${cap.limit_unit}, ${cap.severity}`).join('; ')}); `
      + `the migration needs none, or one ${CAP_SPEC.severity} row in ${CAP_SPEC.limit_unit}, or the cap cannot be checked against the label maximum of ${CAP_VALUE} lb per 1,000 sq ft`);
  }
  return { swaps, bag, caps };
}

// One track: the row, its window goal (only while it still reads the 10-07 text) and the protocol's audit row.
async function swapTrack(knex, { protocolId, window, row }, stonewallId) {
  const counter = { ...asObject(row.annual_counter), counter: NEW_COUNTER_KEY };
  const record = await patchRow(knex, row, { product_name: NEW_NAME, product_id: stonewallId, annual_counter: counter }, NEW_GATES);
  let goalWindowId = null;
  if (window.goal === OLD_GOAL) {
    const moved = await knex('lawn_protocol_windows').where({ id: window.id, goal: OLD_GOAL }).update({ goal: NEW_GOAL, updated_at: knex.fn.now() });
    if (moved === 1) goalWindowId = window.id;
  }
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: protocolId,
    actor_name: 'migration 20261122120000',
    entity_type: 'protocol',
    entity_id: protocolId,
    action: ACTION,
    changed_fields: JSON.stringify(['products', 'goal']),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify({ rows: [record], goalWindowId, oldGoal: OLD_GOAL, newGoal: NEW_GOAL }),
    metadata: JSON.stringify({ migration: '20261122120000_lawn_v13_october_stonewall', gate: 'GATE_LAWN_V13' }),
  });
}

// The bag's catalog facts (header items 4 to 7), wherever a track uses it: swapped by this run or before it.
// A row this run inserted holds them already (`bag` is null then); one audit row records whatever was written.
async function writeCatalogFacts(knex, { stonewallId, insertedProductId, caps, bag }) {
  const cap = await applyCap(knex, stonewallId, caps);
  const analysisFilled = bag ? await fillAnalysis(knex, stonewallId) : null;
  const defaultRate = bag ? await alignDefaultRate(knex, bag) : null;
  const wateringFilled = bag ? await fillWatering(knex, stonewallId) : false;
  if (!(cap.inserted.length || cap.lowered.length || insertedProductId || analysisFilled || defaultRate || wateringFilled)) return;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: 'migration 20261122120000',
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: CATALOG_ACTION,
    changed_fields: JSON.stringify(['catalog', 'limits']),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify({
      productId: stonewallId, insertedProductId, analysisFilled, defaultRate, wateringFilled, caps: cap.inserted, capsLowered: cap.lowered,
    }),
    metadata: JSON.stringify({ migration: '20261122120000_lawn_v13_october_stonewall' }),
  });
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex, REQUIRED_TABLES))) return;
  const state = await readState(knex);
  if (!state) return;
  // The row lives in production; a database built from migrations alone has none: insert it.
  const insertedProductId = state.bag ? null : await insertCatalogRow(knex);
  const stonewallId = state.bag ? state.bag.id : insertedProductId;
  for (const swap of state.swaps) await swapTrack(knex, swap, stonewallId);
  await writeCatalogFacts(knex, { stonewallId, insertedProductId, caps: state.caps, bag: state.bag });
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

// Reverts one protocol's audit record; a protocol that is referenced is logged and left.
async function revertProtocol(knex, log) {
  const after = asObject(log.after_snapshot);
  const protocol = log.lawn_protocol_id ? await knex('lawn_protocols').where({ id: log.lawn_protocol_id }).first('id', 'protocol_key') : null;
  if (protocol && await protocolReferenced(knex, protocol)) {
    console.log(`[lawn-v13-october-stonewall] rollback skipped for protocol ${protocol.protocol_key}: a visit or completion references ${V13_VERSION}`);
    return;
  }
  for (const record of after.rows || []) {
    if (await revertRow(knex, record)) continue;
    // Edited since (a rate, a target, the counter, turned off, renamed): the whole row, the goal and this audit row stay.
    console.log(`[lawn-v13-october-stonewall] rollback skipped for protocol ${protocol ? protocol.protocol_key : log.lawn_protocol_id}: its October row is no longer the row this migration wrote`);
    return;
  }
  if (after.goalWindowId) {
    // One conditional UPDATE: the goal goes back only while it still reads the text this wrote.
    await knex('lawn_protocol_windows').where({ id: after.goalWindowId, goal: after.newGoal }).update({ goal: after.oldGoal, updated_at: knex.fn.now() });
  }
  await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
}

exports.down = async function down(knex) {
  if (!(await hasAll(knex, REQUIRED_TABLES))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: ACTION }).select('id', 'lawn_protocol_id', 'after_snapshot');
  for (const log of logs) await revertProtocol(knex, log);
  // The catalog row, its analysis, its standard rate and the cap row stay, with their audit row: see the header.
};

exports.ACTION = ACTION;
exports.CATALOG_ACTION = CATALOG_ACTION;
exports.OLD_NAME = OLD_NAME;
exports.NEW_NAME = NEW_NAME;
exports.OCT_RATE = OCT_RATE;
exports.OLD_GOAL = OLD_GOAL;
exports.NEW_GOAL = NEW_GOAL;
exports.OLD_COUNTER_KEY = OLD_COUNTER_KEY;
exports.NEW_COUNTER_KEY = NEW_COUNTER_KEY;
exports.NEW_GATES = NEW_GATES;
exports.CAP_SPEC = CAP_SPEC;
exports.CATALOG_ROW = CATALOG_ROW;
exports.CAP_VALUE = CAP_VALUE;
exports.DERIVED_CAP = DERIVED_CAP;
exports.LABEL_LOW_RATE = LABEL_LOW_RATE;
exports.ANALYSIS = ANALYSIS;
exports.OLD_GATES = OLD_GATES;
