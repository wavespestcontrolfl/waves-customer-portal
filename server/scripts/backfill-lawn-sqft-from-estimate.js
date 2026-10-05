#!/usr/bin/env node
//
// Backfill: make the ACCEPTED ESTIMATE the source of each current lawn
// customer's treatable lawn size (owner ruling 2026-10-04).
//
// Usage (from the repo root):
//   DATABASE_URL=... node server/scripts/backfill-lawn-sqft-from-estimate.js --out /path/dry-run.csv
//   DATABASE_URL=... node server/scripts/backfill-lawn-sqft-from-estimate.js --apply \
//       --i-am-sure-this-is-the-intended-database --out /path/applied.csv
//
// DRY RUN IS THE DEFAULT. It reads, classifies and writes a CSV (customer ids
// only: no names, phones or addresses) plus a per-class summary
// (<out>.summary.txt and stdout). It writes nothing to the database.
//   --dry-run                          explicit default
//   --apply                            write, one customer per transaction
//   --i-am-sure-this-is-the-intended-database
//                                      required with --apply; the script also
//                                      prints the (masked) database host first
//   --out <file>                       CSV path (required)
//   --only <customerId>                one customer
//   --use-unconfirmed-when-empty       opt-in (dry run and --apply): see below
//   --limit N                          first N customers (stable order)
//
// How a customer is linked to an estimate:
//   1. LINKED: the customer's live recurring lawn visits (the same
//      purchased-plan row predicate the rate review uses) carry
//      scheduled_services.source_estimate_id (or their series parent's). Those
//      estimates, when accepted and carrying a recurring lawn service, are the
//      candidates. More than one candidate that disagrees on the confirmed
//      size or the property = ambiguous (never written).
//   2. LATEST ACCEPTED: no live lawn visit links an estimate, so the most
//      recent accepted estimate (estimates.customer_id, status accepted, with
//      a recurring lawn service) for the customer's PRIMARY property wins.
//      Two with the same accepted_at = ambiguous.
//
// Classes (the first that applies wins):
//   no_accepted_lawn_estimate | ambiguous | estimate_for_another_property |
//   estimate_has_no_confirmed_size | turf_profile_empty | differs |
//   mirrors_differ | same   (+ turf_profile_empty_unconfirmed with the opt-in flag)
// mirrors_differ = the turf profile already holds the estimate's size but the
// primary property's property_sqft or customers.property_sqft (where those
// mirrors apply) does not. `same` means all applicable places agree.
// --apply writes ONLY turf_profile_empty, differs and mirrors_differ, through the SAME
// function estimate acceptance uses (lawn-size-sync.applyEstimateLawnSqft:
// customer fence, three places in sync, audit row), and never reprices anyone.
// Inside that fence --apply re-selects and re-classifies the customer with
// fresh reads and writes only if the class, the chosen estimate and its size
// are unchanged since the dry-run read; otherwise it records
// skipped_changed_since_read (a concurrent acceptance wins).
//
// --use-unconfirmed-when-empty (owner ruling 2026-10-04, "use the guess"): for a
// customer with NO lawn size anywhere (turf profile empty or 0, and neither the
// primary property's nor customers.property_sqft holds a positive size) whose
// matched estimate has no confirmed size, copy the AI / satellite / lot figure
// the estimate was PRICED on, as class turf_profile_empty_unconfirmed. Never
// overwrites an existing size. A guess under 500 sq ft (below any real treatable
// yard it is almost always a failed imagery read) or over 20,000 (the estimate
// tool's own custom-quote review line) is not written and is flagged in
// guess_flag for a person. Without the flag those rows stay
// estimate_has_no_confirmed_size exactly as before, with the guess and its basis
// still shown in guess_sqft / guess_basis, and has_any_size says whether the
// customer has any size on file. The audit row records the basis and trigger
// backfill_unconfirmed. ESTIMATE ACCEPTANCE IS NOT CHANGED BY THIS: acceptance
// still writes confirmed sizes only.
//
// This script has no hard-coded connection: it reads DATABASE_URL only.
const fs = require('fs');
const { addressKey } = require('../services/customer-property-address-keys');

const APPLY_CLASSES = new Set(['turf_profile_empty', 'differs', 'mirrors_differ']);
// Written by --apply only when --use-unconfirmed-when-empty is given.
const UNCONFIRMED_CLASS = 'turf_profile_empty_unconfirmed';
const CLASSES = [
  'same', 'differs', 'mirrors_differ', 'turf_profile_empty', UNCONFIRMED_CLASS, 'no_accepted_lawn_estimate',
  'estimate_has_no_confirmed_size', 'estimate_for_another_property', 'ambiguous',
];
const CSV_COLUMNS = [
  'customer_id', 'class', 'reason', 'via', 'candidate_count', 'estimate_id', 'estimate_property_id',
  'estimate_accepted_at', 'confirmed_sqft', 'confirmed_field', 'confirmed_basis',
  'turf_lawn_sqft', 'primary_property_sqft', 'customer_property_sqft', 'pct_diff', 'over_20000',
  'guess_sqft', 'guess_basis', 'guess_flag', 'has_any_size',
];
// The estimate tool marks a confirmed size above this for custom-quote review;
// the CSV flags it so the office can look before --apply.
const REVIEW_ABOVE_SQFT = 20000;

function parseArgs(argv = []) {
  const out = {};
  const valued = new Set(['out', 'only', 'limit']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) { out[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
    const key = arg.slice(2);
    if (valued.has(key) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) { out[key] = argv[i + 1]; i += 1; } else out[key] = true;
  }
  return out;
}

function maskPart(value) {
  const s = String(value || '');
  if (s.length <= 4) return '***';
  return `${s.slice(0, 2)}***${s.slice(-3)}`;
}

/** host / port / database of a connection string, masked; never user or password. */
function describeDatabase(url) {
  try {
    const u = new URL(url);
    return `host=${maskPart(u.hostname)} port=${u.port || '5432'} database=${maskPart(decodeURIComponent(u.pathname.replace(/^\//, '')))}`;
  } catch {
    return 'host=(unparseable DATABASE_URL)';
  }
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const iso = (v) => (v instanceof Date ? v.toISOString() : (v ? String(v) : ''));

function pctDiff(estimateSqft, turfSqft) {
  if (!(turfSqft > 0)) return null;
  return Math.round(((estimateSqft - turfSqft) / turfSqft) * 1000) / 10;
}

/**
 * Pure classifier. Input is already-loaded rows:
 *   customer, primary (customer_properties primary row or null), turf (profile row or null),
 *   linked   - estimate rows referenced by the live recurring lawn visits (any status)
 *   accepted - the customer's accepted estimates (any property)
 * Returns the CSV row object plus `estimate` (the chosen estimate row, if any).
 */
function classifyCustomer({ customer, primary, turf, linked = [], accepted = [] }, deps = {}) {
  const sync = deps.lawnSize || require('../services/lawn-size-sync');
  const includesLawn = deps.estimateIncludesRecurringLawn || (() => {
    const converter = require('../services/estimate-converter');
    return (data) => converter.recurringServicesFromEstimateData(data).some((svc) => converter.recurringServiceKey(svc) === 'lawn_care');
  })();
  const evaluate = (estimate) => {
    const data = sync.parseEstimateData ? sync.parseEstimateData(estimate.estimate_data) : estimate.estimate_data;
    return {
      estimate,
      lawn: estimate.status === 'accepted' && includesLawn(data),
      confirmed: sync.confirmedLawnSqftFromEstimate(data),
      target: sync.estimateTargetsPrimary(estimate, customer, primary),
    };
  };
  const base = {
    customer_id: customer.id, class: '', reason: '', via: '', candidate_count: 0,
    estimate_id: '', estimate_property_id: '', estimate_accepted_at: '',
    confirmed_sqft: '', confirmed_field: '', confirmed_basis: '',
    turf_lawn_sqft: num(turf?.lawn_sqft) ?? '', primary_property_sqft: num(primary?.property_sqft) ?? '',
    customer_property_sqft: num(customer.property_sqft) ?? '', pct_diff: '', over_20000: '',
    guess_sqft: '', guess_basis: '', guess_flag: '',
    has_any_size: [turf?.lawn_sqft, primary?.property_sqft, customer.property_sqft].some((v) => Number(v) > 0) ? 'yes' : 'no',
  };
  // What the locked re-read must still see for --apply to write (see changedSinceRead).
  const snapshot = {
    turf: num(turf?.lawn_sqft), primarySqft: num(primary?.property_sqft), customerSqft: num(customer.property_sqft),
    primaryId: primary?.id ?? null, primaryKey: primary ? addressKey(primary) : null, customerKey: addressKey(customer),
  };
  const done = (patch, estimate = null) => ({ ...base, ...patch, estimate, snapshot });

  const linkedPool = linked.map(evaluate).filter((c) => c.lawn);
  let pool = linkedPool;
  let via = 'linked';
  if (!pool.length) {
    via = 'latest_accepted';
    pool = accepted.map(evaluate).filter((c) => c.lawn)
      .sort((a, b) => new Date(b.estimate.accepted_at || 0) - new Date(a.estimate.accepted_at || 0));
  }
  if (!pool.length) return done({ class: 'no_accepted_lawn_estimate', reason: linked.length ? 'linked_estimate_not_an_accepted_lawn_estimate' : 'none_found' });

  let chosen;
  if (via === 'linked') {
    const sig = (c) => `${c.target.match ? 'primary' : c.target.reason}|${c.confirmed.sqft ?? c.confirmed.reason}`;
    if (pool.length > 1 && new Set(pool.map(sig)).size > 1) {
      return done({ class: 'ambiguous', reason: 'linked_estimates_disagree', via, candidate_count: pool.length });
    }
    chosen = pool.slice().sort((a, b) => new Date(b.estimate.accepted_at || 0) - new Date(a.estimate.accepted_at || 0))[0];
  } else {
    chosen = pool.find((c) => c.target.match) || pool[0];
    const sameTime = pool.filter((c) => c.target.match === chosen.target.match
      && iso(c.estimate.accepted_at) === iso(chosen.estimate.accepted_at));
    if (sameTime.length > 1) return done({ class: 'ambiguous', reason: 'tied_accepted_at', via, candidate_count: pool.length });
  }

  const e = chosen.estimate;
  const fill = {
    via, candidate_count: pool.length, estimate_id: e.id, estimate_property_id: e.property_id || '',
    estimate_accepted_at: iso(e.accepted_at),
    confirmed_sqft: chosen.confirmed.sqft ?? '', confirmed_field: chosen.confirmed.field || '', confirmed_basis: chosen.confirmed.basis || '',
  };
  if (!chosen.target.match) return done({ ...fill, class: 'estimate_for_another_property', reason: chosen.target.reason }, e);
  if (chosen.confirmed.sqft === null) {
    const patch = { ...fill, class: 'estimate_has_no_confirmed_size', reason: chosen.confirmed.reason };
    if (chosen.confirmed.reason === 'unconfirmed_estimate') {
      const guess = sync.unconfirmedLawnGuessFromEstimate(e.estimate_data);
      if (guess.sqft !== null) {
        Object.assign(patch, { guess_sqft: guess.sqft, guess_basis: guess.basis, guess_flag: guess.flag || '' });
        if (deps.useUnconfirmedWhenEmpty && !guess.flag && base.has_any_size === 'no') patch.class = UNCONFIRMED_CLASS;
      }
    }
    return done(patch, e);
  }
  const sqft = chosen.confirmed.sqft;
  const over = sqft > REVIEW_ABOVE_SQFT ? 'yes' : '';
  const turfSqft = num(turf?.lawn_sqft);
  if (turfSqft === null) return done({ ...fill, class: 'turf_profile_empty', over_20000: over }, e);
  if (turfSqft === sqft) {
    // Same mirror rule as lawn-size-sync.writeLawnSqft: the primary property
    // carries the mirrors only at the customer's own address; with no primary
    // row the customer row is the only mirror; a mismatched primary has none.
    const mirrors = [];
    if (primary && addressKey(customer) === addressKey(primary)) mirrors.push(num(primary.property_sqft), num(customer.property_sqft));
    else if (!primary) mirrors.push(num(customer.property_sqft));
    return done({ ...fill, class: mirrors.some((m) => m !== sqft) ? 'mirrors_differ' : 'same', over_20000: over }, e);
  }
  return done({ ...fill, class: 'differs', pct_diff: pctDiff(sqft, turfSqft) ?? '', over_20000: over }, e);
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows) => [CSV_COLUMNS.join(','), ...rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';

function summarize(rows) {
  const counts = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  for (const r of rows) counts[r.class] = (counts[r.class] || 0) + 1;
  return counts;
}
const summaryText = (counts, total, mode, rows = null) => {
  const lines = [
    `lawn size backfill (${mode}): ${total} customers`,
    ...CLASSES.map((c) => `  ${c}: ${counts[c] || 0}${APPLY_CLASSES.has(c) ? '  (written by --apply)' : ''}${c === UNCONFIRMED_CLASS ? '  (written by --apply only with --use-unconfirmed-when-empty)' : ''}`),
  ];
  const noSize = (rows || []).filter((r) => r.has_any_size === 'no');
  if (rows) {
    lines.push(`customers with no lawn size on file (${noSize.length}), as read (ids only):`);
    for (const r of noSize) {
      lines.push(`  ${r.customer_id}  ${r.class}${r.guess_sqft ? `  guess ${r.guess_sqft} (${r.guess_basis})${r.guess_flag ? ` FLAG ${r.guess_flag}` : ''}` : ''}`);
    }
  }
  return lines.join('\n');
};

/** Customers with a live recurring lawn visit, and the estimates those visits carry. */
async function loadLawnCustomers(knex, { today, only = null, limit = null }) {
  const { PLAN_ROW_SQL, LIVE_STATUS_SQL } = require('../services/rate-review')._private;
  const { rows } = await knex.raw(`
    SELECT s.customer_id,
      array_remove(array_agg(DISTINCT COALESCE(s.source_estimate_id, p.source_estimate_id)), NULL) AS estimate_ids
    FROM scheduled_services s
    LEFT JOIN services sv ON sv.id = s.service_id
    LEFT JOIN scheduled_services p ON p.id = s.recurring_parent_id
    JOIN customers c ON c.id = s.customer_id
    WHERE s.scheduled_date >= ?
      AND ${LIVE_STATUS_SQL}
      AND ${PLAN_ROW_SQL}
      AND COALESCE(s.service_category_snapshot, sv.category,
            CASE WHEN s.service_type ILIKE '%lawn%' THEN 'lawn_care' END) = 'lawn_care'
      AND c.deleted_at IS NULL AND c.active = true
      AND c.pipeline_stage IN ('active_customer', 'won', 'at_risk')
      ${only ? 'AND s.customer_id = ?' : ''}
    GROUP BY s.customer_id
    ORDER BY s.customer_id
    ${limit ? 'LIMIT ?' : ''}
  `, [today, ...(only ? [only] : []), ...(limit ? [limit] : [])]);
  return rows;
}

async function loadRows(knex, entries) {
  const ids = entries.map((r) => r.customer_id);
  if (!ids.length) return { customers: new Map(), primaries: new Map(), turfs: new Map(), estimates: new Map(), acceptedBy: new Map() };
  const customers = new Map((await knex('customers').whereIn('id', ids)
    .select('id', 'address_line1', 'address_line2', 'city', 'zip', 'property_sqft')).map((r) => [r.id, r]));
  const primaries = new Map((await knex('customer_properties').whereIn('customer_id', ids).where({ is_primary: true, active: true })
    .select('id', 'customer_id', 'address_line1', 'address_line2', 'city', 'zip', 'property_sqft')).map((r) => [r.customer_id, r]));
  const turfs = new Map((await knex('customer_turf_profiles').whereIn('customer_id', ids)
    .select('customer_id', 'lawn_sqft')).map((r) => [r.customer_id, r]));
  const acceptedRows = await knex('estimates').whereIn('customer_id', ids).where({ status: 'accepted' })
    .select('id', 'customer_id', 'property_id', 'address', 'status', 'accepted_at', 'estimate_data');
  const estimates = new Map(acceptedRows.map((r) => [r.id, r]));
  const acceptedBy = new Map();
  for (const r of acceptedRows) acceptedBy.set(r.customer_id, [...(acceptedBy.get(r.customer_id) || []), r]);
  // Linked estimates that are not accepted still count as a link (they classify
  // as "linked estimate is not an accepted lawn estimate" rather than vanishing).
  const linkedIds = [...new Set(entries.flatMap((r) => r.estimate_ids || []))].filter((id) => !estimates.has(id));
  if (linkedIds.length) {
    for (const r of await knex('estimates').whereIn('id', linkedIds)
      .select('id', 'customer_id', 'property_id', 'address', 'status', 'accepted_at', 'estimate_data')) estimates.set(r.id, r);
  }
  return { customers, primaries, turfs, estimates, acceptedBy };
}

function classifyLoaded(customer, entry, loaded, deps) {
  const linked = (entry.estimate_ids || []).map((id) => loaded.estimates.get(id)).filter((e) => e && String(e.customer_id) === String(customer.id));
  return classifyCustomer({
    customer, primary: loaded.primaries.get(customer.id) || null, turf: loaded.turfs.get(customer.id) || null,
    linked, accepted: loaded.acceptedBy.get(customer.id) || [],
  }, deps);
}

/**
 * Re-select and re-classify one customer with FRESH reads on `handle` (the
 * locked transaction) and compare with the decision the dry-run read made.
 * Returns null when nothing changed, else a short reason. Reads made before
 * the customer fence can be stale: a newer lawn estimate accepted in between
 * would otherwise be overwritten with the older estimate's size.
 */
async function changedSinceRead(handle, { customerId, decided, snapshot, today }, deps) {
  const [entry] = await (deps.loadLawnCustomers || loadLawnCustomers)(handle, { today, only: customerId });
  if (!entry) return 'no longer a live recurring lawn customer';
  const loaded = await (deps.loadRows || loadRows)(handle, [entry]);
  const customer = loaded.customers.get(customerId);
  if (!customer) return 'customer row missing';
  const { snapshot: freshSnap, ...fresh } = classifyLoaded(customer, entry, loaded, deps);
  if (String(fresh.estimate_id) !== String(decided.estimate_id)) return `estimate ${decided.estimate_id} -> ${fresh.estimate_id}`;
  if (fresh.class !== decided.class) return `class ${decided.class} -> ${fresh.class}`;
  if (String(fresh.confirmed_sqft) !== String(decided.confirmed_sqft)) return `size ${decided.confirmed_sqft} -> ${fresh.confirmed_sqft}`;
  if (String(fresh.guess_sqft) !== String(decided.guess_sqft)) return `guess ${decided.guess_sqft} -> ${fresh.guess_sqft}`;
  // Anything an office edit could have changed since the first read: the sizes
  // this write would replace, and which property the mirrors belong to.
  for (const key of ['turf', 'primarySqft', 'customerSqft', 'primaryId', 'primaryKey', 'customerKey']) {
    if (freshSnap[key] !== snapshot[key]) return `${key} ${snapshot[key] ?? 'none'} -> ${freshSnap[key] ?? 'none'}`;
  }
  return null;
}

/**
 * Plan (and with apply:true, execute) the backfill. `deps.applyEstimateLawnSqft`
 * is injectable for tests; the default is the shared acceptance writer.
 */
async function runBackfill({ knex, today, apply = false, only = null, limit = null, log = () => {}, chunk = 50, useUnconfirmedWhenEmpty = false }, baseDeps = {}) {
  const deps = { ...baseDeps, useUnconfirmedWhenEmpty };
  const writeClasses = new Set([...APPLY_CLASSES, ...(useUnconfirmedWhenEmpty ? [UNCONFIRMED_CLASS] : [])]);
  const applyFn = deps.applyEstimateLawnSqft || require('../services/lawn-size-sync').applyEstimateLawnSqft;
  const entries = await (deps.loadLawnCustomers || loadLawnCustomers)(knex, { today, only, limit });
  const rows = [];
  const applied = [];
  for (let i = 0; i < entries.length; i += chunk) {
    const slice = entries.slice(i, i + chunk);
    const loaded = await (deps.loadRows || loadRows)(knex, slice);
    for (const entry of slice) {
      const customer = loaded.customers.get(entry.customer_id);
      if (!customer) continue;
      const result = classifyLoaded(customer, entry, loaded, deps);
      const { estimate, snapshot, ...row } = result;
      rows.push(row);
      if (!apply || !writeClasses.has(row.class)) continue;
      try {
        const outcome = await applyFn(knex, {
          customerId: customer.id, estimate, estimateData: estimate.estimate_data,
          trigger: row.class === UNCONFIRMED_CLASS ? 'backfill_unconfirmed' : 'backfill',
          allowUnconfirmedWhenEmpty: row.class === UNCONFIRMED_CLASS,
          revalidate: (trx) => changedSinceRead(trx, { customerId: customer.id, decided: row, snapshot, today }, deps),
        });
        const changed = outcome.reason === 'changed_since_read';
        applied.push({ customer_id: customer.id, class: row.class, estimate_id: estimate.id,
          status: changed ? 'skipped_changed_since_read' : outcome.status, reason: changed ? outcome.detail : (outcome.reason || ''),
          sqft: outcome.sqft ?? '', before_turf: outcome.before?.turf_lawn_sqft ?? '', after_turf: outcome.after?.turf_lawn_sqft ?? '',
          before_property: outcome.before?.primary_property_sqft ?? '', after_property: outcome.after?.primary_property_sqft ?? '',
          before_customer: outcome.before?.customer_property_sqft ?? '', after_customer: outcome.after?.customer_property_sqft ?? '' });
        log(`applied customer=${customer.id} ${row.class} ${changed ? `skipped_changed_since_read (${outcome.detail})` : outcome.status}${outcome.status === 'written' ? ` turf ${outcome.before.turf_lawn_sqft ?? 'none'} -> ${outcome.after.turf_lawn_sqft}` : ''}`);
      } catch (err) {
        applied.push({ customer_id: customer.id, class: row.class, estimate_id: estimate.id, status: 'error', reason: err.message });
        log(`ERROR customer=${customer.id}: ${err.message}`);
      }
    }
  }
  return { rows, applied, counts: summarize(rows) };
}

// A dry run opens every session read-only, so even a bug cannot write.
// --apply opens normal sessions.
function buildKnex(url, { readOnly = false } = {}, knexFactory = require('knex')) {
  const local = /localhost|127\.0\.0\.1/.test(url);
  return knexFactory({
    client: 'pg',
    connection: { connectionString: url, ssl: local ? false : { rejectUnauthorized: false } },
    pool: {
      min: 0,
      max: 2,
      ...(readOnly ? { afterCreate: (conn, done) => conn.query('SET default_transaction_read_only = on', (err) => done(err, conn)) } : {}),
    },
  });
}

async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const args = parseArgs(argv);
  const apply = args.apply === true;
  if (apply && args['dry-run']) throw new Error('Choose --dry-run or --apply, not both.');
  const url = env.DATABASE_URL;
  if (!url || url === 'undefined' || url === 'null') throw new Error('DATABASE_URL is not set.');
  if (typeof args.out !== 'string' || !args.out) throw new Error('--out <csv path> is required.');
  const limit = args.limit ? Math.max(1, Number.parseInt(args.limit, 10) || 0) : null;
  if (args.limit && !limit) throw new Error('--limit needs a positive number.');
  console.log(`[lawn-size-backfill] ${apply ? 'APPLY' : 'DRY RUN'} against ${describeDatabase(url)}`);
  if (apply && args['i-am-sure-this-is-the-intended-database'] !== true) {
    throw new Error('Refusing --apply without --i-am-sure-this-is-the-intended-database (check the host printed above first).');
  }
  const knex = buildKnex(url, { readOnly: !apply }, deps.knexFactory);
  try {
    const { etDateString } = require('../utils/datetime-et');
    const result = await (deps.runBackfill || runBackfill)({
      knex, today: etDateString(), apply, useUnconfirmedWhenEmpty: args['use-unconfirmed-when-empty'] === true, only: typeof args.only === 'string' ? args.only : null, limit,
      log: (m) => console.log(`[lawn-size-backfill] ${m}`),
    });
    fs.writeFileSync(args.out, toCsv(result.rows));
    const text = summaryText(result.counts, result.rows.length, apply ? 'apply' : 'dry run', result.rows);
    fs.writeFileSync(`${args.out}.summary.txt`, `${text}\n`);
    console.log(text);
    if (apply) {
      const cols = ['customer_id', 'class', 'estimate_id', 'status', 'reason', 'sqft', 'before_turf', 'after_turf', 'before_property', 'after_property', 'before_customer', 'after_customer'];
      fs.writeFileSync(`${args.out}.applied.csv`, [cols.join(','), ...result.applied.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n');
      const by = result.applied.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
      console.log(`[lawn-size-backfill] applied outcomes: ${JSON.stringify(by)} (details: ${args.out}.applied.csv)`);
    }
    console.log(`[lawn-size-backfill] CSV: ${args.out}`);
  } finally {
    await knex.destroy();
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error(`[lawn-size-backfill] ${err.message}`); process.exit(1); });
}

module.exports = { parseArgs, describeDatabase, classifyCustomer, runBackfill, toCsv, summarize, summaryText, loadLawnCustomers, loadRowsForTest: loadRows, changedSinceRead, buildKnex, UNCONFIRMED_CLASS, CLASSES, APPLY_CLASSES, CSV_COLUMNS, main };
