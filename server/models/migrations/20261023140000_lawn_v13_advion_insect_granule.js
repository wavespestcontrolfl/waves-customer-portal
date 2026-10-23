/**
 * Lawn protocol v13, mole cricket nymph bait: the catalog row for Advion Insect Granule (owner 2026-10-23, "do whatever is
 * going to make the grass look its best, based on the research we did"). One migration, deliberately small: it only INSERTS one
 * catalog row, and it rolls back all or nothing.
 *
 * Why. UF/IFAS and Clemson say to treat small mole cricket nymphs from mid-June through July. Lawn Care Nut reports an indoxacarb
 * bait worked where Arena did not. The v13 recipe (server/config/lawn-protocol-v13.json) now sends the June hose visit and the
 * July scout visit to Advion Insect Granule (indoxacarb 0.22%, IRAC Group 22A; SiteOne 53202, 25 lb) on the tunnel areas, 3 lb per
 * 1,000 sq ft by hand shaker, and drops Talak as the nymph product. The recipe names the product; this gives it a catalog row.
 *
 * The label (EPA PPLS, accepted 2019-12-19, "Advion Insect Granule", EPA Reg. No. 100-1483; split labels "Advion Mole Cricket Bait"
 * and "Advion Insect Granular Bait") says: mole crickets 1.15 to 4.6 lb per 1,000 sq ft (the Insect Granular Bait split label
 * allows 0.38 to 4.6); turf around residential dwellings is a labeled site; apply late in the day, to dry grass; if the soil is
 * not moist, irrigate before applying; "Rainfall or irrigation within 2 to 3 days after application may reduce the effectiveness
 * ... which may require retreatment"; never through an irrigation system; at most 4.6 lb per 1,000 sq ft per year; repeat after 7
 * days if necessary. Note: the owner brief said EPA 100-1484; that number is the Advion cockroach gel in this catalog. The label
 * reads 100-1483, which is what the row carries.
 *
 * up(), all in the migration's one transaction:
 *   1. If ANY catalog row matches the product by exact name or exact alias (normalized: case, spacing and punctuation ignored), in
 *      any state (active or not, correct or not), up() THROWS and writes nothing: "a row named X already exists; this migration
 *      only inserts". It never reads, fills, links or changes an existing row. Staff remove or rename that row, then run it
 *      again. The one exception is the row this migration inserted itself (its catalog audit row names the id): a re-run after a
 *      rollback that was a no-op (see down()) finds its own row and carries on without inserting a second.
 *      The catalog already holds "Advion WDG Granular" (the same indoxacarb granule, used by pest control, EPA 100-1483, with no
 *      watering rule). It is a different name, so it does not block this insert, and it is NOT touched.
 *   2. Otherwise it INSERTS the full row: indoxacarb 0.22%, IRAC 22A, EPA 100-1483, 25 lb bag (400 oz), SiteOne 53202, default
 *      rate 3 lb per 1,000 sq ft (label range 1.15 to 4.6, yearly maximum 4.6), the 72-hour no-irrigation watering rule
 *      (a hold: label advice for 2 to 3 days, owner rule 3 days), approved for the service report with a plain customer summary,
 *      draft, internal only, needs_pricing. No mow hold.
 *   NO PRICE IS WRITTEN. The SiteOne price ($166.01 for the 25 lb bag) goes in through the bundled pricing import row
 *   (server/data/pricing.csv) or Inventory's pricing entry, the paths that run recalcBestPrice. Writing vendor_pricing here would
 *   need the SiteOne vendor id (a production id) and the route's own recalculation; neither belongs in a migration. An unpriced
 *   product plans, mixes and reports normally; its material cost reads null and the cost summary counts it as unpriced.
 *
 * Protocol rows are not touched: the staged v13 windows (lawn_protocol_products) keep their rows. The recipe file is the card.
 * Adding the Advion and June Acelepryn rows to the staged windows, and retiring the August Talak row, is a separate migration.
 *
 * down() is all or nothing:
 *   - if ANY scheduled visit or completion references ANY v13 protocol, it does nothing and logs why;
 *   - if the inserted row is no longer exactly as inserted (any written field, the four workflow values too), is priced, or is
 *     referenced by anything (any foreign key, any table), it does nothing and logs which;
 *   - otherwise it deletes the row and its audit row. It never touches a row it did not insert.
 */

const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const { anyV13ProtocolReferenced } = require('../../services/lawn-v13-rollback-guard');

const CATALOG_ACTION = 'v13_advion_insect_granule_catalog';
const ACTOR = 'migration 20261023140000';
const MIGRATION = '20261023140000_lawn_v13_advion_insect_granule';
const NAME = 'Advion Insect Granule';

const DEFAULT_RATE = 3;
const VERIFIED_AT = '2026-10-23T00:00:00.000Z';
const VERIFIED_BY = 'owner-rule-2026-10-23';
// Hold: no irrigation or rain-dependent watering for 3 days. The label gives efficacy advice ("rainfall or irrigation within 2 to 3
// days may reduce the effectiveness"), so the owner rule is 3 days. The customer text reads "Skip your turf watering until <time>".
const WATERING_RULE = {
  mode: 'hold', hold_hours: 72, source: 'owner',
  label_note: 'Label (EPA 100-1483): rainfall or irrigation within 2 to 3 days after application may reduce effectiveness and may require retreatment. Owner: no irrigation for 3 days (72 hours), the opposite of Acelepryn. If the soil is dry the tech waters the spot lightly BEFORE applying.',
  verified_at: VERIFIED_AT, verified_by: VERIFIED_BY,
};

const SUMMARY = 'A small bait placed on the spots where mole crickets are tunneling. The crickets eat it and it controls them.';
const PRECAUTION = 'Keep pets and children from picking at the bait granules. Granules on sidewalks or driveways are swept back into the turf. Skip your turf watering for the time shown on this report.';

// The inserted row. Price fields are never written: needs_pricing stays true until a price is set.
const CATALOG = {
  name: NAME,
  display_name: NAME,
  category: 'insecticide',
  product_type: 'pesticide',
  manufacturer: 'Syngenta',
  active_ingredient: 'Indoxacarb 0.22%',
  moa_group: 'Group 22A',
  irac_group: '22A',
  formulation: 'granular bait',
  container_size: '25 lb',
  unit_size_oz: 400,
  siteone_sku: '53202',
  epa_reg_number: '100-1483',
  default_rate_per_1000: DEFAULT_RATE,
  min_label_rate_per_1000: 1.15,
  max_label_rate_per_1000: 4.6,
  max_annual_per_1000: 4.6,
  rate_unit: 'lb',
  label_url: 'https://assets.syngentapmp.com/pdf/labels/SCP1483AL1E1219.pdf',
  label_source_url: 'https://www3.epa.gov/pesticides/chem_search/ppls/000100-01483-20191219.pdf',
  label_source_note: 'Advion Insect Granule, EPA Reg. No. 100-1483 (EPA-accepted label 2019-12-19; split labels Advion Mole Cricket Bait and Advion Insect Granular Bait), SiteOne 53202, 25 lb bag. Mole crickets (adults and nymphs): 1.15 to 4.6 lb per 1,000 sq ft; yearly maximum 4.6 lb per 1,000 sq ft; repeat after 7 days if necessary; turf around residential dwellings is a labeled site. Apply late in the day to dry grass; if the soil is not moist, irrigate before applying; rainfall or irrigation within 2 to 3 days may reduce effectiveness; never through an irrigation system. Lawn v13 use (owner 2026-10-23): 3 lb per 1,000 sq ft of treated area on mole cricket tunnel areas by hand shaker, June and the July scout visit. No price written: SiteOne $166.01 for 25 lb goes in through the pricing import or Inventory.',
  public_summary: SUMMARY,
  service_report_summary: SUMMARY,
  customer_precaution_summary: PRECAUTION,
  approved_for_service_report: true,
  post_application_watering: WATERING_RULE,
};
// What the insert also sets, beside the CATALOG fields; part of the "unchanged" test in down().
const INSERT_DEFAULTS = Object.freeze({ active: true, needs_pricing: true, content_status: 'draft', customer_visibility: 'internal_only' });
const JSON_COLUMNS = new Set(['post_application_watering']);
// Never written here; a value in any of them means someone priced the row after this inserted it.
const PRICE_FIELDS = ['best_price', 'best_vendor', 'cost_per_unit', 'cost_unit', 'best_vendor_pricing_id', 'best_price_amount_cached'];

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

// ── up ───────────────────────────────────────────────────────────────────────

// Ids of every catalog row that spells the name exactly (normalized) or has an exact alias for it, in any state.
async function matchingIds(knex, name) {
  const wanted = normalize(name);
  const ids = new Set((await knex('products_catalog').select('id', 'name')).filter((row) => normalize(row.name) === wanted).map((row) => String(row.id)));
  if (await knex.schema.hasTable('product_aliases')) {
    for (const row of await knex('product_aliases').select('product_id', 'alias_name')) if (normalize(row.alias_name) === wanted) ids.add(String(row.product_id));
  }
  return [...ids];
}

// The id of the catalog row an earlier run of THIS migration inserted, else null.
async function ownInsertedId(knex) {
  const logs = await knex('lawn_protocol_audit_log').where({ action: CATALOG_ACTION }).select('after_snapshot');
  for (const log of logs) {
    const { productId, inserted } = asObject(log.after_snapshot);
    if (inserted && productId) return String(productId);
  }
  return null;
}

async function insertCatalog(knex) {
  const columns = await knex('products_catalog').columnInfo();
  const known = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => key in columns));
  const fields = known(CATALOG);
  const workflow = known(INSERT_DEFAULTS);
  const insert = { ...fields, ...workflow, created_at: knex.fn.now(), updated_at: knex.fn.now() };
  for (const column of JSON_COLUMNS) if (column in insert) insert[column] = JSON.stringify(insert[column]);
  const [made] = await knex('products_catalog').insert(insert).returning('id');
  const productId = made && typeof made === 'object' ? made.id : made;
  await knex('lawn_protocol_audit_log').insert({
    lawn_protocol_id: null,
    actor_name: ACTOR,
    entity_type: 'catalog',
    entity_id: crypto.randomUUID(),
    action: CATALOG_ACTION,
    changed_fields: JSON.stringify(['catalog']),
    before_snapshot: JSON.stringify({}),
    after_snapshot: JSON.stringify({ productId, inserted: { ...fields, ...workflow } }),
    metadata: JSON.stringify({ migration: MIGRATION }),
  });
  return productId;
}

const REQUIRED_TABLES = ['products_catalog', 'lawn_protocol_audit_log'];

async function hasAll(knex) {
  for (const table of REQUIRED_TABLES) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

exports.up = async function up(knex) {
  if (!(await hasAll(knex))) return;

  const matches = await matchingIds(knex, NAME);
  if (matches.length === 1 && matches[0] === await ownInsertedId(knex)) return; // our own row from an earlier run: insert nothing
  if (matches.length) {
    throw new Error(`lawn v13 Advion Insect Granule: a catalog row named "${NAME}" already exists; this migration only inserts. Remove or rename it (catalog id ${matches.join(', ')}) and run this migration again. Nothing was written.`);
  }
  await insertCatalog(knex);
};

// ── down ─────────────────────────────────────────────────────────────────────

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

exports.down = async function down(knex) {
  if (!(await hasAll(knex))) return;
  const logs = await knex('lawn_protocol_audit_log').where({ action: CATALOG_ACTION }).select('id', 'after_snapshot');
  if (!logs.length) return;

  if (await anyV13ProtocolReferenced(knex)) {
    console.log('[lawn-v13-advion-insect-granule] rollback did nothing: a scheduled visit or completion references a v13 protocol');
    return;
  }
  // Check every recorded row before deleting any: one that is changed, priced or in use makes the whole rollback a no-op.
  const rows = [];
  for (const log of logs) {
    const { productId, inserted } = asObject(log.after_snapshot);
    if (!inserted || !productId) continue;
    const row = await knex('products_catalog').where({ id: productId }).first();
    if (!row) continue; // already gone: only its audit row is left to remove
    const unchanged = Object.entries(inserted).every(([column, value]) => same(row[column], value))
      && PRICE_FIELDS.every((column) => row[column] == null);
    if (!unchanged || await productReferenced(knex, productId)) {
      console.log('[lawn-v13-advion-insect-granule] rollback did nothing: the catalog row was changed, priced or is in use');
      return;
    }
    rows.push(productId);
  }
  for (const productId of rows) await knex('products_catalog').where({ id: productId }).del();
  for (const log of logs) await knex('lawn_protocol_audit_log').where({ id: log.id }).del();
};

exports.CATALOG_ACTION = CATALOG_ACTION;
exports.NAME = NAME;
exports.DEFAULT_RATE = DEFAULT_RATE;
exports.CATALOG = CATALOG;
exports.INSERT_DEFAULTS = INSERT_DEFAULTS;
exports.WATERING_RULE = WATERING_RULE;
exports.WATERING = [{ name: NAME, rule: WATERING_RULE }];
exports.SUMMARY = SUMMARY;
exports.PRECAUTION = PRECAUTION;
exports.PRICE_FIELDS = PRICE_FIELDS;
