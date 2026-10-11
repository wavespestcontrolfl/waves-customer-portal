/**
 * The table snapshot behind a manual accept's effect list.
 *
 * The accept's effect list must show every row the accept changes, so the
 * list cannot be built from a hand-picked set of fields (a table the
 * converter writes that nobody listed would be missed silently). This module
 * is TABLE-DRIVEN: SNAPSHOT_TABLES lists every table the accept path writes
 * inside its transaction, with a selector by customer or estimate. The accept
 * reads the whole set before it claims the estimate and again after its last
 * write, and diffTables() turns any difference into `table_changes` effects.
 *
 * The contract test (estimate-accept-snapshot-contract.test.js) scans the
 * converter, the accept steps and the helpers they call for write targets and
 * fails when a written table is in neither SNAPSHOT_TABLES nor
 * NOT_SNAPSHOTTED (which says why). A future writer cannot be missed.
 *
 * Effects carry no clocks and no generated ids: a timestamp-valued column
 * reads as "<time>", rows the accept INSERTS are listed without their key,
 * and the estimate's JSON document is compared by the names of the top-level
 * keys that changed.
 */
const crypto = require('crypto');
const { TERMINAL_STATUSES } = require('./waveguard-existing-services');

const VOLATILE_COLUMNS = new Set(['updated_at', 'created_at']);

// Every table the accept path writes inside its transaction. `scope` picks the
// selector ('estimate' = the estimate id, 'customer' = the customer id);
// `key` names a row across the two reads; `generatedKey` rows are listed
// without it when they are new. `optional` tables are read through a savepoint
// (the table may not exist on every database).
const SNAPSHOT_TABLES = [
  {
    table: 'estimates', scope: 'estimate', key: ['id'], jsonKeysOnly: ['estimate_data'],
    select: (q, { estimateId }) => q.where({ id: estimateId }),
  },
  {
    table: 'customers', scope: 'customer', key: ['id'],
    select: (q, { customerId }) => q.where({ id: customerId }),
  },
  {
    table: 'customer_plan_rates', scope: 'customer', key: ['family_key'], optional: true,
    select: (q, { customerId }) => q.where({ customer_id: customerId }),
  },
  {
    table: 'customer_turf_profiles', scope: 'customer', key: ['customer_id'],
    select: (q, { customerId }) => q.where({ customer_id: customerId }),
  },
  {
    table: 'customer_properties', scope: 'customer', key: ['id'],
    select: (q, { customerId }) => q.where({ customer_id: customerId }),
  },
  {
    // The accept closes an open consultation as won (consultation-outcomes
    // markWonForCustomer): the outcome row, matched by its own customer or,
    // with none, through the customer's leads.
    table: 'consultation_outcomes', scope: 'customer', key: ['id'], optional: true,
    select: (q, { customerId }) => q.where(function matchCustomerOrItsLeads() {
      this.where('customer_id', customerId).orWhere(function viaLeads() {
        this.whereNull('customer_id').whereIn('lead_id', function leadsOfCustomer() {
          this.select('id').from('leads').where({ customer_id: customerId });
        });
      });
    }),
  },
  {
    table: 'customer_credit_ledger', scope: 'customer', key: ['id'], generatedKey: true,
    select: (q, { customerId }) => q.where({ customer_id: customerId }),
  },
  {
    // The frozen existing-service extension reprices live visits.
    table: 'scheduled_services', scope: 'customer', key: ['id'], generatedKey: true,
    select: (q, { customerId }) => q.where({ customer_id: customerId }).whereNotIn('status', TERMINAL_STATUSES),
  },
  {
    table: 'activity_log', scope: 'customer', key: ['id'], generatedKey: true, columns: ['id', 'action'],
    select: (q, { customerId }) => q.where({ customer_id: customerId }),
  },
];

// Tables the accept path code writes that are NOT read in the transaction,
// and why. The contract test requires every written table to be here or in
// SNAPSHOT_TABLES.
const NOT_SNAPSHOTTED = {
  appointment_reminders: 'written only when visits are booked; a carded accept refuses that path before it writes (carded_path_schedules_visits)',
  invoices: 'written only by the invoice and credit paths; a carded accept refuses them before it writes (carded_path_creates_invoice)',
  leads: 'written after the commit by the lead_won step of the post-commit plan, which the effect list shows',
  lead_activities: 'written after the commit by the lead_won step of the post-commit plan, which the effect list shows',
  ad_service_attribution: 'written after the commit by the lead_won step of the post-commit plan, which the effect list shows',
};

// Source files on the accept path whose write targets the contract test scans.
const WRITER_FILES = [
  'estimate-converter.js',
  'estimate-manual-acceptance.js',
  'consultation-outcomes.js',
  'lawn-size-sync.js',
  'plan-rate-ledger.js',
  'customer-credit.js',
  'estimate-property-linkage.js',
  'lead-estimate-link.js',
];

// ── Reading ──

const TIME_STRING = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

// A deterministic, clock-free copy of a value.
function normalize(value) {
  if (value instanceof Date) return '<time>';
  if (typeof value === 'string' && TIME_STRING.test(value)) return '<time>';
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) if (value[key] !== undefined) out[key] = normalize(value[key]);
    return out;
  }
  return value === undefined ? null : value;
}

function parseJson(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

const hashOf = (value) => crypto.createHash('sha1').update(JSON.stringify(normalize(value))).digest('hex').slice(0, 12);

// One row as it is compared: volatile columns dropped, timestamps masked, the
// estimate document reduced to a hash per top-level key.
function shapeRow(spec, row) {
  const out = {};
  for (const column of Object.keys(row).sort()) {
    if (VOLATILE_COLUMNS.has(column)) continue;
    const value = row[column];
    if ((spec.jsonKeysOnly || []).includes(column)) {
      const doc = parseJson(value);
      const keys = {};
      if (doc && typeof doc === 'object') for (const key of Object.keys(doc).sort()) keys[key] = hashOf(doc[key]);
      out[column] = { __keys: keys };
    } else {
      out[column] = normalize(value);
    }
  }
  return out;
}

async function readTable(trx, spec, ids) {
  const run = (conn) => {
    let q = spec.select(conn(spec.table), ids);
    if (spec.columns) q = q.select(...spec.columns);
    return q;
  };
  let rows;
  if (spec.optional) {
    try { rows = await trx.transaction((sp) => run(sp)); } catch (err) {
      if (err && (err.code === '42P01' || /does not exist/i.test(String(err.message)))) return [];
      throw err;
    }
  } else {
    rows = await run(trx);
  }
  return (rows || []).map((row) => shapeRow(spec, row));
}

// The whole set, read through the accept's transaction. `ids.customerId` may be
// null (an estimate with no customer yet): the customer-scoped tables read as
// empty.
async function snapshotTables(trx, ids) {
  const out = {};
  for (const spec of SNAPSHOT_TABLES) {
    out[spec.table] = spec.scope === 'customer' && !ids.customerId ? [] : await readTable(trx, spec, ids);
  }
  return out;
}

// ── Diffing ──

const keyOf = (spec, row) => spec.key.map((k) => String(row[k])).join('|');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function keysChanged(before, after) {
  const names = new Set([...Object.keys(before.__keys), ...Object.keys(after.__keys)]);
  return [...names].sort().filter((name) => before.__keys[name] !== after.__keys[name]);
}

function changedColumns(spec, before, after) {
  const columns = {};
  for (const column of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if ((spec.jsonKeysOnly || []).includes(column)) {
      const names = keysChanged(before[column] || { __keys: {} }, after[column] || { __keys: {} });
      if (names.length) columns[column] = { changed_keys: names };
    } else if (!same(before[column], after[column])) {
      columns[column] = { before: before[column] ?? null, after: after[column] ?? null };
    }
  }
  return columns;
}

function listedRow(spec, row) {
  const out = { ...row };
  if (spec.generatedKey) for (const k of spec.key) delete out[k];
  return out;
}

const sortedByJson = (rows) => rows.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));

function diffTable(spec, beforeRows, afterRows) {
  const before = new Map(beforeRows.map((r) => [keyOf(spec, r), r]));
  const after = new Map(afterRows.map((r) => [keyOf(spec, r), r]));
  const changed = [];
  const added = [];
  const removed = [];
  for (const [key, row] of after) {
    if (!before.has(key)) { added.push(listedRow(spec, row)); continue; }
    const columns = changedColumns(spec, before.get(key), row);
    if (Object.keys(columns).length) changed.push({ key, columns });
  }
  for (const [key, row] of before) if (!after.has(key)) removed.push(listedRow(spec, row));
  if (!changed.length && !added.length && !removed.length) return null;
  changed.sort((a, b) => (a.key < b.key ? -1 : 1));
  return { kind: 'table_changes', table: spec.table, changed, added: sortedByJson(added), removed: sortedByJson(removed) };
}

// Every table whose rows differ, as effects (in SNAPSHOT_TABLES order).
function diffTables(before, after) {
  const effects = [];
  for (const spec of SNAPSHOT_TABLES) {
    const effect = diffTable(spec, before?.[spec.table] || [], after?.[spec.table] || []);
    if (effect) effects.push(effect);
  }
  return effects;
}

module.exports = {
  SNAPSHOT_TABLES,
  NOT_SNAPSHOTTED,
  WRITER_FILES,
  snapshotTables,
  diffTables,
  diffTable,
  normalize,
};
