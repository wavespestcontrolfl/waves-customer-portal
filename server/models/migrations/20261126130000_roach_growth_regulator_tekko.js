// The cockroach card's growth regulator changes from Gentrol Complete EC3 to Tekko Pro IGR (owner 2026-11-25, protocols page
// pick D11: "EC3 stops on cockroach jobs"; server/config/protocols.json, cockroach visit 1). Gentrol Complete EC3 carries a pyrethroid (lambda-cyhalothrin) that
// repels roaches from the gel bait placed at the same visit; Tekko Pro is a growth regulator only (pyriproxyfen + novaluron).
//
// The service library still names Gentrol for the four active cockroach services, so the estimate inventory check, the project
// materials and the cost mapping would keep planning the replaced product. This migration moves that data with the card.
//
// Label read 2026-11-26: EPA 53883-335, "CONTROL OF COCKROACHES AND CRICKETS": 2 oz per gallon of water, 1 gallon per 1,000 sq ft,
// repeat every 6 months as necessary. Its use sites include transportation equipment (automobiles, buses, boats, trucks), so the
// vehicle roach services move too.
//
// Two steps, both run inside the migration's transaction. Each row is locked (FOR UPDATE), then written only while it still holds
// exactly the value read from production on 2026-11-26: the checked values are in the UPDATE's own WHERE. So an admin edit made first
// wins, and a second run changes nothing. Every changed row gets one audit_log event with its before and after values.
//   1. services.default_products of cockroach_control, german_roach and vehicle_german_roach:
//      ["Atticus Antapex WSG","Advion Evolution Cockroach Gel Bait","Gentrol Complete EC3"] -> the same list with "Tekko Pro IGR";
//      of vehicle_roach_addon: ["Advion Evolution Cockroach Gel Bait","Gentrol Complete EC3"] -> the same with "Tekko Pro IGR".
//   2. service_product_usage (the cost mapping) of "Cockroach Treatment" and "German Roach Cleanout": the Gentrol row
//      (1 oz, "Tank-mixed at 1 oz/gal with the Antapex gallon") points at Tekko Pro at 2 fl oz per 1,000 sq ft (2 fl oz with no area).
// Not touched: the Tekko Pro catalog row (its per-gallon rate stays 1, the label's rate for fleas and flying insects; the cockroach
// card line carries the cockroach rate itself), the inactive german_roach_initial, the Gentrol catalog row, past visit lines, stock and
// vendor pricing. No cost row exists for a vehicle service type.
//
// down() is a documented no-op. These rows are admin-editable (Service Library, inventory cost mapping): after this runs, a value
// equal to what up() wrote may be an admin's own choice, and a rollback must not replace it. To undo by hand, read the audit_log
// events with action "migration:20261126130000_roach_growth_regulator_tekko:*": each holds the row id and its before value.

const TEKKO = 'Tekko Pro IGR';
const TEKKO_EPA = '53883-335';
const GENTROL = 'Gentrol Complete EC3';

const LIST_BEFORE = ['Atticus Antapex WSG', 'Advion Evolution Cockroach Gel Bait', GENTROL];
const LIST_AFTER = ['Atticus Antapex WSG', 'Advion Evolution Cockroach Gel Bait', TEKKO];
const ADDON_LIST_BEFORE = ['Advion Evolution Cockroach Gel Bait', GENTROL];
const ADDON_LIST_AFTER = ['Advion Evolution Cockroach Gel Bait', TEKKO];
// Each service key and the list read from production on 2026-11-26.
const SERVICE_LISTS = [
  { key: 'cockroach_control', before: LIST_BEFORE, after: LIST_AFTER },
  { key: 'german_roach', before: LIST_BEFORE, after: LIST_AFTER },
  { key: 'vehicle_german_roach', before: LIST_BEFORE, after: LIST_AFTER },
  { key: 'vehicle_roach_addon', before: ADDON_LIST_BEFORE, after: ADDON_LIST_AFTER },
];

const USAGE_TYPES = ['Cockroach Treatment', 'German Roach Cleanout'];
// usage_per_1000sf is empty on both rows read on 2026-11-26. A per-area amount outranks usage_amount in costing (product-costing.js),
// so a row an admin gave one keeps Gentrol: the switch never carries an edited Gentrol rate over to Tekko Pro.
const USAGE_BEFORE = Object.freeze({ usage_amount: 1, usage_unit: 'oz', usage_per_1000sf: null, notes: 'Tank-mixed at 1 oz/gal with the Antapex gallon' });
// The label's 2 fl oz per gallon at 1 gallon per 1,000 sq ft is 2 fl oz per 1,000 sq ft: the estimate audit costs it by the home's area,
// and 2 fl oz when the area is unknown. fl_oz is the catalog row's cost unit. The [usage:once_per_package] tag (product-costing.js
// usageOncePerPackage) has the audit cost it once for a multi-visit package: one treatment lasts 6 months.
const USAGE_AFTER = Object.freeze({ usage_amount: 2, usage_unit: 'fl_oz', usage_per_1000sf: 2, notes: '[usage:once_per_package] Growth regulator: 2 fl oz per gallon at 1 gallon per 1,000 sq ft (2 fl oz per 1,000 sq ft), once per job (lasts 6 months)' });

const MIGRATION = '20261126130000_roach_growth_regulator_tekko';
const LOG = '[20261126130000]';

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => item === b[i]);

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

// The one active catalog row of each product, or null (logged): neither step writes a name or an id the catalog cannot resolve.
async function products(knex) {
  const tekko = await knex('products_catalog').where({ name: TEKKO, epa_reg_number: TEKKO_EPA, active: true }).select('id');
  const gentrol = await knex('products_catalog').where({ name: GENTROL, active: true }).select('id');
  if (tekko.length !== 1 || gentrol.length !== 1) {
    console.log(`${LOG} active catalog rows: ${tekko.length} "${TEKKO}" (EPA ${TEKKO_EPA}), ${gentrol.length} "${GENTROL}"; need one each: nothing changed`);
    return null;
  }
  return { tekko: tekko[0], gentrol: gentrol[0] };
}

async function moveServiceLists(knex) {
  let changed = 0;
  for (const { key, before, after } of SERVICE_LISTS) {
    const rows = await knex('services').where({ service_key: key }).select('id', 'default_products').forUpdate();
    for (const row of rows) {
      // pg returns a jsonb array as a JS array. A jsonb string holding an encoded list (live: none on 2026-11-26) would never
      // equal the jsonb array the UPDATE's WHERE binds, so it is kept and logged here, never left to a silent no-op.
      if (!sameList(row.default_products, before)) {
        console.log(`${LOG} service "${key}" default_products is not the list read on 2026-11-26: kept`);
        continue;
      }
      // The checked list is in the WHERE (jsonb equality), so the write and the check are one statement.
      const wrote = await knex('services').where({ id: row.id, default_products: JSON.stringify(before) })
        .update({ default_products: JSON.stringify(after), updated_at: knex.fn.now() });
      if (wrote) await writeAudit(knex, 'service_list', 'services', row.id, { service_key: key, before, after });
      changed += wrote;
    }
  }
  return changed;
}

async function moveUsage(knex, found) {
  // Blocks other writers of the cost mapping (the admin inventory screen) until this migration commits, so a Tekko Pro row cannot be
  // added between the check below and the write it decides. Reads go on.
  if (typeof knex.raw === 'function') await knex.raw('LOCK TABLE service_product_usage IN SHARE ROW EXCLUSIVE MODE');
  let changed = 0;
  for (const serviceType of USAGE_TYPES) {
    const source = await knex('service_product_usage').where({ service_type: serviceType, product_id: found.gentrol.id })
      .select('id', 'usage_amount', 'usage_unit', 'usage_per_1000sf', 'notes');
    const target = await knex('service_product_usage').where({ service_type: serviceType, product_id: found.tekko.id }).select('id');
    const row = source[0];
    const asRead = source.length === 1 && Number(row.usage_amount) === USAGE_BEFORE.usage_amount
      && row.usage_unit === USAGE_BEFORE.usage_unit && row.usage_per_1000sf == null && row.notes === USAGE_BEFORE.notes;
    // One product is one row per service type: a type that already has a Tekko Pro row keeps both rows as they are.
    if (!asRead || target.length) {
      console.log(`${LOG} cost mapping of "${serviceType}" is not the row read on 2026-11-26: kept`);
      continue;
    }
    const wrote = await knex('service_product_usage')
      // usage_per_1000sf: null is "IS NULL" in knex's object form.
      .where({ id: row.id, product_id: found.gentrol.id, ...USAGE_BEFORE })
      .update({ product_id: found.tekko.id, ...USAGE_AFTER, updated_at: knex.fn.now() });
    if (wrote) {
      await writeAudit(knex, 'cost_row', 'service_product_usage', row.id, {
        service_type: serviceType,
        before: { product_id: String(found.gentrol.id), ...USAGE_BEFORE },
        after: { product_id: String(found.tekko.id), ...USAGE_AFTER },
      });
    }
    changed += wrote;
  }
  return changed;
}

exports.up = async function up(knex) {
  if (!(await hasTables(knex, ['products_catalog', 'services', 'service_product_usage', 'audit_log']))) return;
  const found = await products(knex);
  if (!found) return;
  const lists = await moveServiceLists(knex);
  const usage = await moveUsage(knex, found);
  console.log(`${LOG} cockroach growth regulator -> ${TEKKO}: ${lists} service lists, ${usage} cost rows`);
};

// A documented no-op: see the header.
exports.down = async function down() {};

exports.MIGRATION = MIGRATION;
exports.LIST_BEFORE = LIST_BEFORE;
exports.LIST_AFTER = LIST_AFTER;
exports.ADDON_LIST_BEFORE = ADDON_LIST_BEFORE;
exports.ADDON_LIST_AFTER = ADDON_LIST_AFTER;
exports.USAGE_BEFORE = USAGE_BEFORE;
exports.USAGE_AFTER = USAGE_AFTER;
