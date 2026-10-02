// MUTATES (dry-run default; pass --execute to write)
//
// One-time fill of the neighborhood access directory (gate-code directory
// PR 1, migration 20261001190000_neighborhood_access).
//
// 1. Link: for every active property of a live customer (active, customer
//    stage — customer-stages.js whereLiveCustomer) OR of a customer with a gate
//    code on file, look the parcel up in the county roll
//    (lookupCountyParcelByPoint) and link the property to its neighborhood,
//    named from the recorded subdivision collapsed to the community's base
//    name. Sarasota's layer returns a numeric code and some parcels sit in no
//    subdivision; those stay unlinked for the office to pick (owner D3).
//    A property the office already linked is never touched.
// 2. File: every non-empty property_preferences.neighborhood_gate_code is
//    filed under that customer's neighborhood (owner 10-01: neighborhood
//    codes are shared by every stop there). Skipped when the customer has
//    more than one active property — the profile-level code cannot say which
//    one it belongs to. A code tagged "is unconfirmed" by the 10-01 message
//    harvest files as needs_confirm; two different live codes in one
//    neighborhood both go needs_confirm for the office. Property gate,
//    lockbox and garage codes are never filed (owner D5).
//
// All county lookups run first, outside any transaction. The dry run then
// runs the SAME database path as --execute inside one transaction that is
// rolled back at the end (seconds of row locks, not the lookups' minutes), so it reports exactly what execute would
// do — duplicates, conflicts and needs_confirm flags included. It prints
// property / neighborhood ids and neighborhood names only. A keypad code prints masked to its last two digits; a free-text
// value prints as [instructions] only — it can hold names or addresses.
//
// A property links only when the parcel under its pin carries its own house
// number and ZIP (a ZIP-centroid or wrong-city pin would otherwise link it to
// someone else's subdivision).
//
// Reversible: every committed write is journaled with its prior value
// (updated_at included) as it happens, and the rollback (newest write first) prints at the end of the
// run — on failure too, covering exactly what committed before the error.
//
// Usage (repo root):
//   railway run --service Postgres -- node ops/agents/neighborhood-access-backfill.js            # dry run
//   railway run --service Postgres -- node ops/agents/neighborhood-access-backfill.js --execute
//   ... --limit 20                                                                                # cap the lookups

const path = require('path');

const usableUrl = (v) => { const u = String(v || '').trim(); return !!u && u !== 'undefined' && u !== 'null'; };
if (!usableUrl(process.env.DATABASE_PUBLIC_URL) && !usableUrl(process.env.DATABASE_URL)) {
  console.error('[neighborhood-access-backfill] DATABASE_PUBLIC_URL (or DATABASE_URL) not set — aborting. Run via: railway run --service Postgres -- node ops/agents/neighborhood-access-backfill.js');
  process.exit(1);
}
if (!usableUrl(process.env.DATABASE_PUBLIC_URL)) delete process.env.DATABASE_PUBLIC_URL;
if (process.env.DATABASE_PUBLIC_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
  if (!/sslmode=/.test(process.env.DATABASE_URL) && !process.env.PGSSLMODE) process.env.PGSSLMODE = 'no-verify';
}
const db = require(path.join(__dirname, '..', '..', 'server', 'models', 'db'));
const { lookupCountyParcelByPoint } = require(path.join(__dirname, '..', '..', 'server', 'services', 'property-lookup', 'county-parcel-gis'));
const { SERVICE_AREA_COUNTY_ZIPS } = require(path.join(__dirname, '..', '..', 'server', 'config', 'county-zips'));
// whereLiveCustomer's own stage list; its bare column names are ambiguous in
// this join (customer_properties also has `active`), so the predicate is
// spelled out on c.* below.
const { CUSTOMER_STAGES } = require(path.join(__dirname, '..', '..', 'server', 'services', 'customer-stages'));
const {
  isKeypadCode,
  resolvePropertyNeighborhood,
  fileNeighborhoodCode,
} = require(path.join(__dirname, '..', '..', 'server', 'services', 'neighborhood-access'));

const TAG = '[neighborhood-access-backfill]';
const UNCONFIRMED_MARK = 'is unconfirmed: confirm on site';

const execute = process.argv.includes('--execute');
const limitIdx = process.argv.indexOf('--limit');
let limit = 0;
if (limitIdx > -1) {
  const raw = process.argv[limitIdx + 1];
  if (!/^[1-9]\d*$/.test(String(raw || ''))) {
    console.error(`${TAG} --limit needs a positive integer, got ${JSON.stringify(raw ?? null)} — aborting`);
    process.exit(1);
  }
  limit = parseInt(raw, 10);
}

const shown = (value) => (isKeypadCode(value)
  ? String(value).trim().replace(/\d(?=\d{2})/g, '•')
  : '[instructions]');

// Rollback statements, one per committed write, in write order.
const journal = [];
const q1 = (v) => `'${String(v).replace(/'/g, "''")}'`;
// Prior timestamps arrive as Postgres text (microseconds intact) — restored verbatim.
const ts = (d) => (d ? `${q1(d)}::timestamptz` : 'NULL');

// ---- 1. link properties ----------------------------------------------------
// The county lookups are network-bound, so they all run first, outside any
// transaction; the database phase that follows holds row locks for seconds,
// not for the length of the lookups (the dry run's outer transaction too).
async function candidateProperties() {
  const hasGateCode = db('property_preferences as pp')
    .select(1)
    .whereRaw('pp.customer_id = c.id')
    .whereRaw("btrim(coalesce(pp.neighborhood_gate_code, '')) <> ''");
  let q = db('customer_properties as p')
    .join('customers as c', 'c.id', 'p.customer_id')
    .where('p.active', true)
    .whereNull('c.deleted_at')
    .whereNull('p.neighborhood_id')
    .whereNull('p.neighborhood_checked_at')
    .where((w) => w.whereNull('p.neighborhood_source').orWhereNot('p.neighborhood_source', 'office'))
    .whereNotNull('p.latitude')
    .whereNotNull('p.longitude')
    // A live customer (active, customer stage) — or any customer whose gate
    // code is on file, which the filing step needs linked.
    .where((w) => w.where((live) => live.where('c.active', true).whereIn('c.pipeline_stage', CUSTOMER_STAGES))
      .orWhereExists(hasGateCode))
    .orderBy('p.id')
    .select('p.id', 'p.customer_id', 'p.address_line1', 'p.city', 'p.zip', 'p.latitude', 'p.longitude', 'p.neighborhood_source');
  if (limit) q = q.limit(limit);
  return q;
}

// The one county whose service-area ZIP set holds this ZIP, else none (a ZIP
// that straddles a county line keeps the Manatee → Sarasota → Charlotte
// fallback). A hint keeps an earlier county's slow layer from spending the
// shared deadline before the right one is asked.
function countyHint(zip) {
  const z = String(zip || '').slice(0, 5);
  const hits = Object.entries(SERVICE_AREA_COUNTY_ZIPS).filter(([, zips]) => zips.includes(z)).map(([county]) => county);
  return hits.length === 1 ? hits[0] : undefined;
}

async function lookUpParcels(props) {
  console.log(`${TAG} ${execute ? 'EXECUTE' : 'DRY RUN'} — ${props.length} propert(ies) to look up`);
  const parcels = new Map();
  for (const p of props) {
    parcels.set(p.id, await lookupCountyParcelByPoint(Number(p.latitude), Number(p.longitude), { county: countyHint(p.zip) }));
  }
  return parcels;
}

async function linkProperties(conn, props, parcels) {
  const tally = {};
  for (const p of props) {
    const { status, name } = await linkOne(conn, p, parcels.get(p.id));
    tally[status] = (tally[status] || 0) + 1;
    console.log(`  property ${p.id}  ${status}${name ? ` → ${name}` : ''}`);
  }
  console.log(`${TAG} link results`, tally);
}

// The neighborhood upsert and the property update commit together, and are
// journaled only after commit.
async function linkOne(conn, p, parcel) {
  const r = await conn.transaction(async (trx) => {
    // Customer before property, as every other writer (and the filing step)
    // locks them; the dry run keeps both phases' locks until its rollback.
    const customer = await trx('customers').where({ id: p.customer_id }).forUpdate()
      .first('deleted_at', 'active', 'pipeline_stage');
    // The lookups ran minutes ago: re-check, under locks (customer →
    // property → preferences, the filing step's order), that this is still in
    // scope — an active property of a live customer, or of one whose gate
    // code is on file — before anything is written.
    const property = customer && !customer.deleted_at
      && await trx('customer_properties').where({ id: p.id, active: true }).forUpdate().first('id');
    const prefs = property && await trx('property_preferences').where({ customer_id: p.customer_id })
      .forUpdate().first('neighborhood_gate_code');
    const inScope = property && ((customer.active && CUSTOMER_STAGES.includes(customer.pipeline_stage))
      || String(prefs?.neighborhood_gate_code || '').trim() !== '');
    if (!inScope) return { status: 'out_of_scope', wrote: false };
    return resolvePropertyNeighborhood(p, { conn: trx, lookup: async () => parcel, onlyUnchecked: true });
  });
  // Every undo is guarded by the state this run left (its updated_at /
  // checked_at stamp), so it is a no-op on a row someone changed since.
  const n = r.neighborhood;
  if (n && n.inserted) {
    journal.push(`DELETE FROM neighborhoods n WHERE n.id = ${q1(n.id)} AND n.source = 'county' AND n.updated_at = ${ts(n.written_at)} AND NOT EXISTS (SELECT 1 FROM customer_properties p WHERE p.neighborhood_id = n.id) AND NOT EXISTS (SELECT 1 FROM neighborhood_access a WHERE a.neighborhood_id = n.id);`);
  } else if (n && n.prior) {
    // Remove only the alias this run appended (if any); later appends survive.
    const names = n.addedAlias ? `subdivision_names - ${q1(n.addedAlias)}` : 'subdivision_names';
    journal.push(`UPDATE neighborhoods SET subdivision_names = ${names}, updated_at = ${ts(n.prior.updated_at)} WHERE id = ${q1(n.id)} AND updated_at = ${ts(n.written_at)};`);
  }
  // The candidate query only takes rows with every neighborhood column NULL.
  if (r.wrote) {
    journal.push(`UPDATE customer_properties SET neighborhood_id = NULL, neighborhood_source = NULL, county_subdivision = NULL, neighborhood_checked_at = NULL WHERE id = ${q1(p.id)} AND neighborhood_checked_at = ${ts(r.checkedAt)};`);
  }
  return { status: r.status, name: n ? n.name : null };
}

// ---- 2. file neighborhood gate codes ----------------------------------------
// Re-read, under locks, everything the filing decision rests on — the
// customer (still live), its active properties (exactly one, linked) and its
// current code — so an address move, a new property or an edited code since
// the candidate list was built is honored. Lock order follows the existing
// writers: customers → customer_properties → property_preferences (then the
// neighborhood row, inside fileNeighborhoodCode).
async function fileOne(trx, customerId) {
  const customer = await trx('customers').where({ id: customerId }).whereNull('deleted_at').forUpdate().first('id');
  if (!customer) return { outcome: 'skip_customer_gone' };
  const active = await trx('customer_properties')
    .where({ customer_id: customerId, active: true })
    .forUpdate()
    .select('id', 'neighborhood_id');
  const prefs = await trx('property_preferences').where({ customer_id: customerId }).forUpdate()
    .first('neighborhood_gate_code', 'access_notes');
  const value = String(prefs?.neighborhood_gate_code || '').trim();
  const unconfirmed = String(prefs?.access_notes || '').includes(UNCONFIRMED_MARK);
  const base = { value, unconfirmed };
  if (!value) return { ...base, outcome: 'skip_no_code' };
  if (active.length !== 1) return { ...base, outcome: active.length ? 'skip_multi_property' : 'skip_no_property' };
  if (!active[0].neighborhood_id) return { ...base, outcome: 'skip_no_neighborhood' };
  const r = await fileNeighborhoodCode(trx, {
    neighborhoodId: active[0].neighborhood_id,
    value,
    source: 'backfill',
    sourceCustomerId: customerId,
    unconfirmed,
  });
  return { ...base, outcome: r.status, result: r };
}

async function fileCodes(conn) {
  const customerIds = await conn('property_preferences as pp')
    .join('customers as c', 'c.id', 'pp.customer_id')
    .whereNull('c.deleted_at')
    .whereRaw("btrim(coalesce(pp.neighborhood_gate_code, '')) <> ''")
    .orderBy('pp.customer_id')
    .pluck('pp.customer_id');

  const tally = {};
  for (const customerId of customerIds) {
    const { outcome, value, unconfirmed, result: r } = await conn.transaction((trx) => fileOne(trx, customerId));
    if (r && r.id && r.status !== 'duplicate') {
      journal.push(`DELETE FROM neighborhood_access WHERE id = ${q1(r.id)} AND source = 'backfill' AND updated_at = ${ts(r.written_at)};`);
    }
    for (const f of (r ? r.flagged : [])) {
      journal.push(`UPDATE neighborhood_access SET status = 'active', updated_at = ${ts(f.updated_at)} WHERE id = ${q1(f.id)} AND status = 'needs_confirm' AND updated_at = ${ts(f.written_at)};`);
    }
    tally[outcome] = (tally[outcome] || 0) + 1;
    console.log(`  customer ${customerId}  ${outcome}${value ? `  ${shown(value)}` : ''}${unconfirmed ? ' (needs_confirm)' : ''}`);
  }
  console.log(`${TAG} file results`, tally);
}

function printRollback() {
  if (!journal.length) {
    console.log(`${TAG} nothing written — no rollback needed`);
    return;
  }
  console.log(`\n${TAG} ROLLBACK — ${journal.length} statement(s), newest write first; run inside one transaction.`);
  console.log(`${TAG} Each statement applies only while its row is still as this run left it; a row changed since is left alone (0 rows).`);
  for (const line of [...journal].reverse()) console.log(`  ${line}`);
}

async function run(conn, props, parcels) {
  await linkProperties(conn, props, parcels);
  await fileCodes(conn);
}

(async () => {
  const props = await candidateProperties();
  const parcels = await lookUpParcels(props);
  if (execute) {
    await run(db, props, parcels);
    return;
  }
  // Dry run: the execute path, inside a transaction that never commits.
  const trx = await db.transaction();
  try {
    await run(trx, props, parcels);
  } finally {
    await trx.rollback();
  }
  console.log(`${TAG} dry run — rolled back; pass --execute to write`);
})()
  .catch((err) => {
    // Never the message or stack: knex errors carry the SQL with its bindings,
    // which can include a free-text access value.
    console.error(`${TAG} failed: ${(err && (err.code || err.name)) || 'error'} — rerun the dry run to see where it stopped`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (execute) printRollback();
    await db.destroy();
  });
