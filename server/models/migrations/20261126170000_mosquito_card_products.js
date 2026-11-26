// The mosquito card's products (owner 2026-11-25, protocols page pick D7: "dump and drain, larvicide, then a PolyZone + Tekko Pro
// barrier with a mist blower ... Take In2Care, Scion and Tekko Trio off the mosquito defaults"; server/config/protocols.json, mosquito).
//
// The service library names the products a mosquito visit plans and pre-fills (the estimate inventory check, the project materials,
// the close-out). Read from production on 2026-11-26, it still names the old mix: CrossCheck Plus, Scion and In2Care stations on the
// monthly plan, CrossCheck Plus and Onslaught FastCap on the one-time visit, and nothing on the seasonal plan. This migration moves
// those lists to the card:
//   mosquito_monthly, mosquito_seasonal and mosquito_event (inactive): Suspend PolyZone, Tekko Pro IGR, Summit Mosquito Dunk Tablets
//   mosquito_one_time (the event card, no larvicide by default): Suspend PolyZone, Tekko Pro IGR
// In2Care stations stay a separate add-on the customer buys; they are only off the default list.
//
// Each row is locked (FOR UPDATE), then written only while it still holds exactly the value read on 2026-11-26: the checked value
// is in the UPDATE's own WHERE. So an admin edit made first wins, and a second run changes nothing. Every changed row gets one
// audit_log event with its before and after values.
// Not touched: the catalog rows, the cost mapping (service_product_usage: the estimate audit still costs the CrossCheck Plus barrier;
// product cost rows are their own step of the protocols build), the misting services, past visit lines, stock and vendor pricing.
//
// down() is a documented no-op. These rows are admin-editable (Service Library): after this runs, a value equal to what up() wrote may
// be an admin's own choice, and a rollback must not replace it. To undo by hand, read the audit_log events with action
// "migration:20261126170000_mosquito_card_products:service_list": each holds the row id and its before value.

const POLYZONE = 'Suspend Polyzone';
const TEKKO = 'Tekko Pro IGR';
const TEKKO_EPA = '53883-335';
const DUNK = 'Summit Mosquito Dunk Tablets';

const RECURRING_AFTER = [POLYZONE, TEKKO, DUNK];
const EVENT_AFTER = [POLYZONE, TEKKO];
// Each service key and the list read from production on 2026-11-26 (null = no list).
const SERVICE_LISTS = [
  {
    key: 'mosquito_monthly',
    before: ['LESCO Crosscheck Plus', TEKKO, 'Scion Insecticide', 'In2Care Mosquito Station', DUNK],
    after: RECURRING_AFTER,
  },
  { key: 'mosquito_seasonal', before: null, after: RECURRING_AFTER },
  { key: 'mosquito_event', before: ['LESCO Crosscheck Plus', TEKKO, DUNK], after: RECURRING_AFTER },
  { key: 'mosquito_one_time', before: ['LESCO Crosscheck Plus', 'Onslaught FastCap'], after: EVENT_AFTER },
];

const MIGRATION = '20261126170000_mosquito_card_products';
const LOG = '[20261126170000]';

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => item === b[i]);
// The value read on 2026-11-26: a list, or no list at all (SQL NULL; pg returns null).
const isAsRead = (value, before) => (before === null ? value === null : sameList(value, before));

// The one audit_log writer: critical, so a lost event fails the migration (and rolls its transaction back) instead of leaving an
// unrecorded change to admin-editable rows.
async function writeAudit(knex, resourceId, metadata) {
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system', action: `migration:${MIGRATION}:service_list`,
    resource_type: 'services', resource_id: String(resourceId),
    metadata: { migration: MIGRATION, ...metadata },
    critical: true, trx: knex,
  });
}

async function hasTables(knex, tables) {
  for (const table of tables) if (!(await knex.schema.hasTable(table))) return false;
  return true;
}

// Each named product resolves to exactly one active catalog row, or nothing changes (logged): the lists store names, and the
// close-out resolver refuses a name two active rows share. Tekko Pro's one active row must also hold EPA 53883-335: an inactive row
// with the same name holds another registration (Tekko Trio data).
async function productsResolve(knex) {
  const found = await Promise.all([POLYZONE, TEKKO, DUNK].map((name) => knex('products_catalog').where({ name, active: true }).select('id', 'epa_reg_number')));
  const tekko = found[1];
  if (found.every((rows) => rows.length === 1) && tekko[0].epa_reg_number === TEKKO_EPA) return true;
  console.log(`${LOG} active catalog rows: ${found.map((rows) => rows.length).join(', ')} for "${POLYZONE}", "${TEKKO}" (need EPA ${TEKKO_EPA}), "${DUNK}"; need one each: nothing changed`);
  return false;
}

exports.up = async function up(knex) {
  if (!(await hasTables(knex, ['products_catalog', 'services', 'audit_log']))) return;
  if (!(await productsResolve(knex))) return;
  let changed = 0;
  for (const { key, before, after } of SERVICE_LISTS) {
    const rows = await knex('services').where({ service_key: key }).select('id', 'default_products').forUpdate();
    for (const row of rows) {
      // pg returns a jsonb array as a JS array. A jsonb string holding an encoded list (live: none on 2026-11-26) would never equal
      // the jsonb array the UPDATE's WHERE binds, so it is kept and logged here, never left to a silent no-op.
      if (!isAsRead(row.default_products, before)) {
        console.log(`${LOG} service "${key}" default_products is not the list read on 2026-11-26: kept`);
        continue;
      }
      // The checked value is in the WHERE (jsonb equality, or IS NULL), so the write and the check are one statement.
      const wrote = await knex('services').where({ id: row.id, default_products: before === null ? null : JSON.stringify(before) })
        .update({ default_products: JSON.stringify(after), updated_at: knex.fn.now() });
      if (wrote) await writeAudit(knex, row.id, { service_key: key, before, after });
      changed += wrote;
    }
  }
  console.log(`${LOG} mosquito card products: ${changed} service lists`);
};

// A documented no-op: see the header.
exports.down = async function down() {};

exports.MIGRATION = MIGRATION;
exports.SERVICE_LISTS = SERVICE_LISTS;
exports.RECURRING_AFTER = RECURRING_AFTER;
exports.EVENT_AFTER = EVENT_AFTER;
