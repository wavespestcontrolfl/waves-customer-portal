// The flea and bed bug cards changed on 2026-11-25 (owner picks D1 and D2 on the protocols page; server/config/protocols.json):
// a flea job is Antapex with Tekko Pro in one tank, a bed bug treatment is Crossfire on the bed with Antapex off it. The service
// library still names the older products, so the estimate inventory check, the project materials, the cost mapping and the product
// list on a flea estimate would keep planning products the card no longer uses. This migration moves that data with the cards.
// Protocols audit 2026-11-26, items 11 and 12.
//
// Three steps, all inside the migration's transaction. Each row is locked (FOR UPDATE), then written only while it still holds
// exactly the value read from production on 2026-11-26: the checked values are in the UPDATE's own WHERE. So an admin edit made
// first wins, and a second run changes nothing. Every changed or added row gets one audit_log event with its before and after.
//   1. services.default_products of bed_bug_treatment: ["Temprid FX","CrossFire","Gentrol Complete EC3"] ->
//      ["MGK Crossfire Bed Bug Concentrate","Atticus Antapex WSG"] (the treatment 1 card's own list; "CrossFire" was not a
//      catalog name). Of flea_tick: no list (NULL) -> ["Atticus Antapex WSG","Tekko Pro IGR"] (the treatment 1 card's list).
//   2. service_product_usage (the cost mapping) "Flea Treatment": its one row, Demand CS (2 oz, 0.5 per 1,000 sq ft,
//      "Interior + exterior broadcast"), points at Antapex at the card's 10 g per gallon at 1 gallon per 1,000 sq ft.
//   3. The same mapping gains the card's growth regulator: Tekko Pro at 0.66 fl oz per 1,000 sq ft, when the type has no Tekko
//      Pro row and step 2's row is the Antapex row this migration wrote.
// Both flea products go down at treatment 1 only (treatment 2 is a check, with a spot treatment where live fleas are found), so
// both rows carry [usage:once_per_package]: the estimate audit costs them once for the two-visit package.
// Not touched: catalog rows, past visit lines, stock, vendor pricing, and any bed bug cost row (none exists).
// CimeXa dust is on the bed bug card as text only: it has no catalog row yet, so no list names it.
//
// down() is a documented no-op. These rows are admin-editable (Service Library, inventory cost mapping): after this runs, a value
// equal to what up() wrote may be an admin's own choice, and a rollback must not replace it. To undo by hand, read the audit_log
// events with action "migration:20261127120000_bed_bug_flea_service_products:*": each holds the row id and its before value.

const ANTAPEX = 'Atticus Antapex WSG';
const ANTAPEX_EPA = '91234-401';
const TEKKO = 'Tekko Pro IGR';
const TEKKO_EPA = '53883-335';
const CROSSFIRE = 'MGK Crossfire Bed Bug Concentrate';
const CROSSFIRE_EPA = '1021-2776';
const DEMAND = 'Demand CS';

// Each service key, the list read from production on 2026-11-26 (null: no list) and the card's list.
const SERVICE_LISTS = [
  { key: 'bed_bug_treatment', before: ['Temprid FX', 'CrossFire', 'Gentrol Complete EC3'], after: [CROSSFIRE, ANTAPEX] },
  { key: 'flea_tick', before: null, after: [ANTAPEX, TEKKO] },
];

const USAGE_TYPE = 'Flea Treatment';
const USAGE_BEFORE = Object.freeze({ usage_amount: 2, usage_unit: 'oz', usage_per_1000sf: 0.5, notes: 'Interior + exterior broadcast' });
// 10 g per gallon at 1 gallon per 1,000 sq ft is 10 g per 1,000 sq ft; 10 g when the area is unknown. g is the unit the cockroach
// cost rows keep Antapex in.
const ANTAPEX_USAGE = Object.freeze({ usage_amount: 10, usage_unit: 'g', usage_per_1000sf: 10, notes: '[usage:once_per_package] Interior spray: 10 g per gallon at 1 gallon per 1,000 sq ft (10 g per 1,000 sq ft), at treatment 1' });
// 0.66 fl oz per gallon in the same tank: 0.66 fl oz per 1,000 sq ft, just under the label's 1 fl oz per 1,500 sq ft (EPA 53883-335).
const TEKKO_USAGE = Object.freeze({ usage_amount: 0.66, usage_unit: 'fl_oz', usage_per_1000sf: 0.66, notes: '[usage:once_per_package] Growth regulator in the Antapex tank: 0.66 fl oz per gallon at 1 gallon per 1,000 sq ft, at treatment 1' });

const MIGRATION = '20261127120000_bed_bug_flea_service_products';
const LOG = '[20261127120000]';

const sameList = (a, b) => (a == null || b == null ? a == null && b == null : Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => item === b[i]));

// The one audit_log writer: critical, so a lost event fails the migration (and rolls its transaction back) instead of leaving an
// unrecorded change to admin-editable rows.
async function writeAudit(knex, step, resourceType, resourceId, metadata) {
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system', action: `migration:${MIGRATION}:${step}`,
    resource_type: resourceType, resource_id: String(resourceId),
    metadata: { migration: MIGRATION, ...metadata },
    critical: true, trx: knex,
  });
}

async function hasTables(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

// The one active catalog row of a product (by name, and by registration number where given), or null.
async function activeRow(knex, name, epa = null) {
  const rows = await knex('products_catalog').where({ name, active: true, ...(epa ? { epa_reg_number: epa } : {}) }).select('id');
  return rows.length === 1 ? rows[0] : null;
}

// Neither step writes a name or an id the catalog cannot resolve to one active row.
async function products(knex) {
  const found = {
    antapex: await activeRow(knex, ANTAPEX, ANTAPEX_EPA),
    tekko: await activeRow(knex, TEKKO, TEKKO_EPA),
    crossfire: await activeRow(knex, CROSSFIRE, CROSSFIRE_EPA),
    demand: await activeRow(knex, DEMAND),
  };
  const missing = Object.entries(found).filter(([, row]) => !row).map(([key]) => key);
  if (missing.length) {
    console.log(`${LOG} no single active catalog row for: ${missing.join(', ')}: nothing changed`);
    return null;
  }
  return found;
}

async function moveServiceLists(knex) {
  let changed = 0;
  for (const { key, before, after } of SERVICE_LISTS) {
    const rows = await knex('services').where({ service_key: key }).select('id', 'default_products').forUpdate();
    for (const row of rows) {
      // pg returns a jsonb array as a JS array and SQL NULL as null. A jsonb string holding an encoded list, or a jsonb null,
      // would not meet the UPDATE's WHERE: it is kept and logged here, never left to a silent no-op.
      if (!sameList(row.default_products, before)) {
        console.log(`${LOG} service "${key}" default_products is not the value read on 2026-11-26: kept`);
        continue;
      }
      // The checked value is in the WHERE (jsonb equality, or IS NULL: knex's object form of null), so the write and the check
      // are one statement.
      const wrote = await knex('services').where({ id: row.id, default_products: before ? JSON.stringify(before) : null })
        .update({ default_products: JSON.stringify(after), updated_at: knex.fn.now() });
      if (wrote) await writeAudit(knex, 'service_list', 'services', row.id, { service_key: key, before, after });
      changed += wrote;
    }
  }
  return changed;
}

async function moveFleaUsage(knex, found) {
  // Blocks other writers of the cost mapping (the admin inventory screen) until this migration commits, so a row cannot be added
  // between a check below and the write it decides. Reads go on.
  if (typeof knex.raw === 'function') await knex.raw('LOCK TABLE service_product_usage IN SHARE ROW EXCLUSIVE MODE');
  const all = await knex('service_product_usage').where({ service_type: USAGE_TYPE })
    .select('id', 'product_id', 'usage_amount', 'usage_unit', 'usage_per_1000sf', 'notes', 'is_primary');
  const [row] = all;
  // The type held exactly one row on 2026-11-26. Any other shape (an admin added, changed or removed a row) is kept whole.
  const asRead = all.length === 1 && String(row.product_id) === String(found.demand.id)
    && Number(row.usage_amount) === USAGE_BEFORE.usage_amount && row.usage_unit === USAGE_BEFORE.usage_unit
    && Number(row.usage_per_1000sf) === USAGE_BEFORE.usage_per_1000sf && row.notes === USAGE_BEFORE.notes;
  if (!asRead) {
    console.log(`${LOG} cost mapping of "${USAGE_TYPE}" is not the row read on 2026-11-26: kept`);
    return 0;
  }
  const wrote = await knex('service_product_usage')
    .where({ id: row.id, product_id: found.demand.id, ...USAGE_BEFORE })
    .update({ product_id: found.antapex.id, ...ANTAPEX_USAGE, updated_at: knex.fn.now() });
  if (!wrote) return 0;
  await writeAudit(knex, 'cost_row', 'service_product_usage', row.id, {
    service_type: USAGE_TYPE,
    before: { product_id: String(found.demand.id), ...USAGE_BEFORE },
    after: { product_id: String(found.antapex.id), ...ANTAPEX_USAGE },
  });
  // The growth regulator's row: the type had no Tekko Pro row (checked above: one row, and it was Demand CS).
  const [added] = await knex('service_product_usage')
    .insert({ service_type: USAGE_TYPE, product_id: found.tekko.id, ...TEKKO_USAGE, is_primary: false })
    .returning('id');
  const addedId = added?.id ?? added;
  await writeAudit(knex, 'cost_row_added', 'service_product_usage', addedId, {
    service_type: USAGE_TYPE, before: null, after: { product_id: String(found.tekko.id), ...TEKKO_USAGE, is_primary: false },
  });
  return 2;
}

exports.up = async function up(knex) {
  if (!(await hasTables(knex, ['products_catalog', 'services', 'service_product_usage', 'audit_log']))) return;
  const found = await products(knex);
  if (!found) return;
  const lists = await moveServiceLists(knex);
  const usage = await moveFleaUsage(knex, found);
  console.log(`${LOG} bed bug and flea service products: ${lists} service lists, ${usage} cost rows`);
};

exports.down = async function down() {
  // No-op, on purpose: see the header.
};

exports.SERVICE_LISTS = SERVICE_LISTS;
exports.USAGE_TYPE = USAGE_TYPE;
exports.USAGE_BEFORE = USAGE_BEFORE;
exports.ANTAPEX_USAGE = ANTAPEX_USAGE;
exports.TEKKO_USAGE = TEKKO_USAGE;
exports.MIGRATION = MIGRATION;
