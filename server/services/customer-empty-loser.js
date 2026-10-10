/**
 * The "this record is only an unknown-contact stub" scan for
 * delete_duplicate_customer.
 * server/services/customer-empty-loser.js
 *
 * Owner ruling 2026-10-07 (Q3): empty stubs only; a record with any history
 * goes through merge_customers. "Empty" is FAIL-CLOSED and bounded, in three
 * parts, and every part refuses when it cannot read what it needs.
 *
 *  A. Fields. The record must look like what the unknown-caller creator makes
 *     (call-recording-processor.js, the customers insert for a new inbound
 *     call). Every customer column outside STUB_CREATOR_COLUMNS must be NULL or
 *     the column's schema default, read from information_schema and compared at
 *     runtime, so a column added later refuses by default. The refusal names the
 *     column, never the value.
 *  B. Linked rows. The merge engine's own readers: loserAutoBlockers (the
 *     auto-merge "not a shell" list), previewMergeEffects (every table that
 *     points at the customer: declared FKs, every *customer_id column, the
 *     polymorphic pointers), nonFkMergeRewrites (history no customer_id column
 *     names), every merge-excluded table, and the customers table's own
 *     pointer columns (referred_by_customer_id and any other customers column
 *     that references a customer). A count that cannot be read refuses.
 *     Allowed: ONE untouched automatic primary saved property and the derived
 *     health score.
 *  C. Account ownership. A primary profile with other live members in its
 *     account refuses.
 *
 * readEmptiness runs unlocked for the preview card and again on the archive
 * transaction after the row lock and the pair lock (duplicate-customer-delete).
 */

const db = require('../models/db');
const logger = require('./logger');

// Tables a pointer may sit in without making the record "not empty".
// customer_properties is allowed only as ONE primary row (checked below).
const DERIVED_TABLES = new Set(['customer_health_scores']);

// The card's check list, in order. Each names what it covers; a table the
// sweep finds that no category names lands in `other`.
const CHECKS = [
  { key: 'visits', label: 'Visits', tables: ['scheduled_services'] },
  { key: 'service_records', label: 'Service records', tables: ['service_records'] },
  { key: 'invoices', label: 'Invoices', tables: ['invoices'] },
  {
    key: 'payments',
    label: 'Payments, saved cards, Stripe profile',
    tables: ['payments', 'payment_methods', 'estimate_deposits', 'estimate_card_holds'],
    blockers: ['stripe_customer_id'],
  },
  { key: 'estimates', label: 'Estimates', tables: ['estimates'] },
  { key: 'leads', label: 'Leads', tables: ['leads'] },
  {
    key: 'messages',
    label: 'Calls, texts, emails',
    match: (table) => /(call|sms|email|message|conversation|notification|voicemail|outbox)/.test(table),
  },
  { key: 'properties', label: 'Saved properties (one untouched auto-created primary allowed)', tables: ['customer_properties'] },
  { key: 'fields', label: 'Record fields (only what the unknown-caller stub creator writes may be set)' },
  { key: 'plan_rates', label: 'Plan-rate ledger', tables: ['customer_plan_rates'] },
  {
    key: 'billing',
    label: 'Monthly rate, plan, billing',
    tables: ['customer_contracts', 'annual_prepay_terms', 'termite_bonds', 'customer_discounts'],
    blockers: ['monthly_rate', 'billing_mode', 'third_party_payer', 'live_stage'],
  },
  { key: 'portal_login', label: 'Portal login', tables: ['customer_refresh_tokens'], blockers: ['portal_login'] },
  {
    key: 'referral_credit',
    label: 'Referral or credit balance',
    tables: ['referral_promoters', 'customer_credit_ledger', 'field_credit_allocations'],
  },
  { key: 'account', label: 'Other live members of its account' },
  { key: 'customer_links', label: 'Other customer records pointing at it (referrals)' },
  { key: 'other', label: 'Other linked records' },
];

// Key columns of the merge-excluded tables that are not keyed on
// customer_id (a merge or a "not duplicates" decision involving the record).
const EXCLUDED_TABLE_KEYS = {
  customer_merge_journal: ['winner_customer_id', 'loser_customer_id'],
  customer_duplicate_dismissals: ['customer_id_a', 'customer_id_b'],
};

const BLOCKER_LABELS = {
  stripe_customer_id: 'a Stripe customer profile',
  portal_login: 'a portal login',
  third_party_payer: 'a third-party payer',
  billing_mode: 'a billing mode',
  monthly_rate: 'a monthly rate',
  live_stage: 'a live customer stage',
};

function categoryFor(table) {
  const base = String(table).split('.')[0];
  for (const check of CHECKS) {
    if (check.tables?.includes(base)) return check.key;
    if (check.match?.(base)) return check.key;
  }
  return 'other';
}

// The columns the automatic primary-property backfill writes
// (customer-properties.js ensurePrimaryCore) plus row bookkeeping. Any other
// column holding a value is operator data, and makes the property history.
const AUTO_PRIMARY_COLUMNS = new Set([
  'id', 'customer_id', 'label', 'occupancy_type', 'relationship', 'is_primary',
  'address_line1', 'address_line2', 'city', 'state', 'zip', 'latitude', 'longitude',
  'property_type', 'lawn_type', 'property_sqft', 'lot_sqft', 'bed_sqft', 'linear_ft_perimeter',
  'palm_count', 'canopy_type', 'address_key', 'source', 'active', 'created_at', 'updated_at',
]);
// The automatic neighborhood lookup (neighborhood-access.js) stamps these
// with source 'county'; any other source is an office entry.
const AUTO_NEIGHBORHOOD_COLUMNS = ['neighborhood_id', 'neighborhood_source', 'county_subdivision', 'neighborhood_checked_at'];

const isBlank = (v) => v === null || v === undefined || v === false || String(v).trim() === ''
  || (typeof v === 'object' && !(v instanceof Date) && Object.keys(v).length === 0);

// The exact row ensurePrimaryCore (customer-properties.js) writes from this
// customer when it backfills the primary: same defaults, same copies.
function backfilledPrimaryValues(customer) {
  const props = require('./customer-properties');
  const mirror = ['address_line1', 'city', 'zip', 'latitude', 'longitude', 'property_type', 'lawn_type',
    'property_sqft', 'lot_sqft', 'bed_sqft', 'linear_ft_perimeter', 'palm_count', 'canopy_type'];
  return {
    ...Object.fromEntries(mirror.map((column) => [column, customer[column] ?? null])),
    label: customer.profile_label || 'Primary',
    occupancy_type: props.defaultOccupancyForContactRole(customer.contact_role),
    relationship: props.defaultRelationshipForContactRole(customer.contact_role),
    address_line2: customer.address_line2 || null,
    state: customer.state || 'FL',
    address_key: props.addressKey({ address_line1: customer.address_line1, address_line2: customer.address_line2, city: customer.city, zip: customer.zip }),
  };
}

const sameValue = (a, b) => {
  if (isBlank(a) && isBlank(b)) return true;
  if (isBlank(a) || isBlank(b)) return false;
  const na = Number(a);
  const nb = Number(b);
  return (Number.isFinite(na) && Number.isFinite(nb)) ? na === nb : String(a).trim() === String(b).trim();
};

// What makes a saved property more than the untouched automatic primary:
// another source (manual, call_pipeline, self_book), not primary, inactive,
// any backfilled column whose value differs from what the backfill writes
// from this customer (an edited occupancy, relationship, label, address or
// measurement — editManualProperty keeps source 'backfill'), an office
// neighborhood entry, or any other column with a value.
function primaryPropertyEdits(property, customer) {
  const edits = [];
  if (property.source !== 'backfill') edits.push(`source ${property.source || 'unknown'}`);
  if (property.is_primary !== true) edits.push('not the primary');
  if (property.active === false) edits.push('inactive');
  for (const [column, value] of Object.entries(backfilledPrimaryValues(customer))) {
    if (!sameValue(property[column], value)) edits.push(`edited ${column}`);
  }
  if (property.neighborhood_source && property.neighborhood_source !== 'county') edits.push('an office neighborhood entry');
  for (const [column, value] of Object.entries(property)) {
    if (AUTO_PRIMARY_COLUMNS.has(column) || AUTO_NEIGHBORHOOD_COLUMNS.includes(column)) continue;
    if (!isBlank(value)) edits.push(column);
  }
  return edits;
}

// The customers columns the unknown-caller creator writes - exactly the keys of
// the insert in call-recording-processor.js (the new-customer-from-a-call
// path), plus row bookkeeping. Nothing else may hold a value.
const STUB_CREATOR_COLUMNS = new Set([
  'id', 'account_id', 'is_primary_profile', 'profile_label',
  'first_name', 'last_name', 'phone', 'email',
  'address_line1', 'address_line2', 'city', 'state', 'zip',
  'referral_code', 'lead_source', 'lead_source_detail',
  'pipeline_stage', 'pipeline_stage_changed_at', 'nearest_location_id',
  'active', 'created_at', 'updated_at', 'deleted_at',
]);
// Keys the callers add to the row they pass in (not columns).
const ROW_ALIASES = new Set(['version', 'created_on']);

// A default the database fills in by itself on every new row (a timestamp,
// a generated id or token). Not operator data, so any value passes.
const GENERATED_DEFAULT = /(now\(\)|current_timestamp|clock_timestamp\(|gen_random_uuid\(|uuid_generate_v|gen_random_bytes\(|nextval\()/i;

function stripCasts(expr) {
  let out = String(expr).trim();
  for (;;) {
    const next = out.replace(/::[a-zA-Z_][\w\s]*(\[\])?$/, '').trim();
    if (next === out) return out;
    out = next;
  }
}

// -> { kind: 'none' | 'generated' | 'literal' | 'unknown', value? }
function parseColumnDefault(expr) {
  if (expr === null || expr === undefined) return { kind: 'none' };
  const raw = String(expr);
  if (GENERATED_DEFAULT.test(raw)) return { kind: 'generated' };
  const body = stripCasts(raw);
  if (/^null$/i.test(body)) return { kind: 'none' };
  if (/^(true|false)$/i.test(body)) return { kind: 'literal', value: body.toLowerCase() === 'true' };
  if (/^-?\d+(\.\d+)?$/.test(body)) return { kind: 'literal', value: Number(body) };
  const quoted = body.match(/^'((?:[^']|'')*)'$/);
  if (quoted) return { kind: 'literal', value: quoted[1].replace(/''/g, "'") };
  return { kind: 'unknown' };
}

function valueMatchesDefault(value, def) {
  if (def.kind === 'generated') return true;
  if (def.kind !== 'literal') return false; // no default, or one that cannot be read: any value is data
  const d = def.value;
  if (typeof value === 'boolean') return typeof d === 'boolean' && value === d;
  if (typeof value === 'number' || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) && typeof d === 'number')) {
    return typeof d === 'number' && Number(value) === d;
  }
  if (Array.isArray(value)) return typeof d === 'string' && d.trim() === '{}' && value.length === 0;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if (typeof d !== 'string') return false;
    try { return JSON.stringify(JSON.parse(d)) === JSON.stringify(value); } catch { return false; }
  }
  if (typeof value === 'string') return typeof d === 'string' && value === d;
  return false;
}

let columnMetaCache = null;
async function customerColumnMeta(conn) {
  if (columnMetaCache) return columnMetaCache;
  const result = await conn.raw(`
    SELECT column_name, column_default, is_generated
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'customers'`);
  const meta = new Map((result.rows || []).map((r) => [r.column_name, { def: parseColumnDefault(r.column_default), generated: r.is_generated === 'ALWAYS' }]));
  if (!meta.size) throw new Error('customers columns unreadable');
  columnMetaCache = meta;
  return meta;
}

// Customer columns holding a value the stub creator would not have written.
async function readFieldFindings(row, conn) {
  const meta = await customerColumnMeta(conn);
  const findings = [];
  for (const [column, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;
    if (STUB_CREATOR_COLUMNS.has(column)) continue;
    const info = meta.get(column);
    if (!info) {
      if (!ROW_ALIASES.has(column)) findings.push(column);
      continue;
    }
    if (info.generated || valueMatchesDefault(value, info.def)) continue;
    findings.push(column);
  }
  return findings;
}

const holdsText = (column) => `holds ${column.replace(/_/g, ' ')} (${column})`;

// The customers table's own pointer columns: declared FKs to customers(id)
// and every *customer_id column (customers.referred_by_customer_id). The
// generic FK scan skips the customers table itself.
let selfRefCache = null;
async function customerSelfReferenceColumns(conn) {
  if (selfRefCache) return selfRefCache;
  const result = await conn.raw(`
    SELECT DISTINCT column_name FROM (
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
        AND tc.table_name = 'customers' AND ccu.table_name = 'customers' AND ccu.column_name = 'id'
      UNION
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'customers' AND column_name ~ '(^|_)customer_id$'
    ) refs ORDER BY column_name`);
  selfRefCache = (result.rows || []).map((r) => r.column_name);
  return selfRefCache;
}

// nonFkMergeRewrites keys that are a premise about the two ADDRESSES, not a
// row the loser holds (the sprinkler "home changed" stamp lands on the
// winner). Everything else it names is history.
const NON_HISTORY_REWRITE_KEYS = new Set(['property_preferences.irrigation_home_changed_at']);

async function readAccountMembers(loser, conn) {
  if (!loser.account_id || loser.is_primary_profile !== true) return [];
  const sibling = await conn('customers')
    .where({ account_id: loser.account_id })
    .whereNull('deleted_at')
    .whereNot('id', loser.id)
    .first('id');
  return sibling ? ['other live members in its account'] : [];
}
async function countTable(table, customerId, conn = db, columns = ['customer_id']) {
  try {
    const row = await conn(table).where((q) => { for (const column of columns) q.orWhere(column, customerId); }).count({ n: '*' }).first();
    return Number(row?.n || 0);
  } catch (err) {
    logger.warn(`[intelligence-bar] delete_duplicate_customer: count failed for ${table}: ${err.message}`);
    return 'unknown';
  }
}

// Every check's result for one customer. `found` maps a check key to the
// list of things found ("2 scheduled_services", "a portal login"); an empty
// list is a clean check. A count that could not be read is "could not be
// checked" — it blocks, like a found row (fail closed). `conn` is the
// archive transaction on the commit's locked re-check.
async function readEmptiness(stub, conn = db, winner = null) {
  const { loserAutoBlockers, previewMergeEffects, nonFkMergeRewrites, REPOINT_EXCLUDED_TABLES } = require('./customer-dedupe');
  const found = Object.fromEntries(CHECKS.map((c) => [c.key, []]));
  const add = (key, text) => { if (!found[key].includes(text)) found[key].push(text); };
  const countText = (table, n) => (n === 'unknown' ? `${table} (could not be checked)` : `${n} ${table}`);

  const blockers = await loserAutoBlockers(conn, stub);
  for (const blocker of blockers) {
    const label = BLOCKER_LABELS[blocker];
    if (label) {
      const check = CHECKS.find((c) => c.blockers?.includes(blocker));
      add(check ? check.key : 'other', label);
    } else {
      // A blocker table ("invoices", or "invoices (check failed)").
      const table = String(blocker).replace(/ \(check failed\)$/, '');
      add(categoryFor(table), blocker.endsWith('(check failed)') ? `${table} (could not be checked)` : `${table} rows`);
    }
  }

  const winnerId = winner ? winner.id : stub.id;
  const { moving } = await previewMergeEffects(conn, winnerId, stub.id);
  for (const [key, n] of Object.entries(moving || {})) {
    // fk_sweep: 'unknown' (the table list itself failed) lands in `other`
    // as "could not be checked", like any unreadable count.
    if (key === 'total_rows' || key === 'non_fk_rewrites') continue;
    if (DERIVED_TABLES.has(key)) continue;
    if (key === 'customer_properties' && n === 1) {
      const [property] = await conn('customer_properties').where({ customer_id: stub.id }).select('*');
      const edits = property ? primaryPropertyEdits(property, stub) : ['could not be read'];
      if (!edits.length) continue;
      add('properties', `1 customer_properties (${edits.join(', ')})`);
      continue;
    }
    // A table the blocker list already named reads once, with its count.
    const category = categoryFor(key);
    found[category] = found[category].filter((t) => t !== `${key} rows`);
    add(category, countText(key, n));
  }

  // Every table the merge sweep skips on purpose (REPOINT_EXCLUDED_TABLES:
  // plan rates, credit allocations, location reviews, merge journal and
  // dismissals), read from the engine's own list so a new exclusion is
  // counted too. An unknown key column reads "could not be checked".
  for (const table of REPOINT_EXCLUDED_TABLES) {
    const n = await countTable(table, stub.id, conn, EXCLUDED_TABLE_KEYS[table]);
    if (n !== 0) add(categoryFor(table), countText(table, n));
  }

  // History a merge rewrites that no customer_id column names. 'unknown'
  // (a count that failed) blocks like a found row.
  const nonFk = await nonFkMergeRewrites(conn, winner || stub, stub);
  for (const [key, n] of Object.entries(nonFk || {})) {
    if (NON_HISTORY_REWRITE_KEYS.has(key)) continue;
    add(categoryFor(key), n === 'unknown' ? `${key} (could not be checked)` : `${n} ${key}`);
  }
  for (const text of await readAccountMembers(stub, conn)) add('account', text);

  // A. Fields: every column outside the stub creator's list is NULL or its
  // schema default. Unreadable schema refuses.
  try {
    for (const column of await readFieldFindings(stub, conn)) add('fields', holdsText(column));
  } catch (err) {
    logger.warn(`[intelligence-bar] delete_duplicate_customer: field check failed: ${err.message}`);
    add('fields', 'the record fields could not be checked');
  }

  // B (self references). Other customer rows pointing at this one.
  try {
    for (const column of await customerSelfReferenceColumns(conn)) {
      const n = await countTable('customers', stub.id, conn, [column]);
      if (n !== 0) add('customer_links', n === 'unknown' ? `customers.${column} (could not be checked)` : `${n} customers.${column}`);
    }
  } catch (err) {
    logger.warn(`[intelligence-bar] delete_duplicate_customer: customer self-reference check failed: ${err.message}`);
    add('customer_links', 'the customer pointer columns could not be checked');
  }

  return found;
}

function notEmptyRefusal(found) {
  const blocking = CHECKS.filter((c) => found[c.key].length);
  if (!blocking.length) return null;
  const named = blocking.map((c) => `${c.label}: ${found[c.key].join(', ')}`).join('; ');
  return {
    error: `This record is not empty, so the bar will not delete it. Found — ${named}. Use merge_customers to fold it into the real customer (that moves its history), or delete it from the customer page after review.`,
    code: 'not_empty',
    found: Object.fromEntries(blocking.map((c) => [c.key, found[c.key]])),
  };
}


module.exports = {
  CHECKS,
  categoryFor,
  readEmptiness,
  notEmptyRefusal,
  STUB_CREATOR_COLUMNS,
  parseColumnDefault,
  valueMatchesDefault,
  readFieldFindings,
  _resetCaches: () => { columnMetaCache = null; selfRefCache = null; },
  primaryPropertyEdits,
};
