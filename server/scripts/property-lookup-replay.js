#!/usr/bin/env node
// READ-ONLY — no writes, no paid APIs, no customer contact.
//
// Property-lookup replay harness (address-match scope PR 1, no behavior
// change). For each past lookup it reports WHERE the county match stops, so a
// later PR (road aliases, parent-parcel match, suite path, ...) can be
// measured before/after by running this same script from that PR's worktree:
// it imports the lookup modules RELATIVELY, so it exercises whatever code the
// checkout has, and the parcel guards are the live lookup's own function
// (ai-property-lookup _private.applyGisParcelGuards), not a copy.
//
// Replays ONLY free, deterministic steps — county GIS is public:
//   1. normalizeCountyStreetLine + auditAddressHouseNumber on the stored
//      normalized address -> street exists / exact number / nearest numbers.
//   2. county point-in-parcel at the stored lat/lng, then the live guards
//      (mobile-home park, aggregate situs verdict, situs house-number
//      mismatch, interpolated rule) -> kept / dropped(reason) / none.
//   3. From the stored snapshot: isCommercial + its source, subtype,
//      unitScopedLookup.
// No Google geocode/Address Validation, no Anthropic/OpenAI/Gemini, no PAO
// scraping. The FDOR statewide fallback and the PAO address search the live
// lookup also tries are NOT replayed (the roll audit stands in for the
// address search), so `matched_now` means "the county roll answers", not
// "the live lookup would price it".
//
// Stop points (first stage that does not pass wins):
//   matched_now                  the parcel at the point survives the guards, or the typed
//                                number is on the roll, for a non-commercial (or unit-scoped) row
//   commercial_no_suite_path     the parcel matched but the stored snapshot is commercial and was
//                                not unit/suite scoped (the whole building would be sized);
//                                parcel_recovered says whether the match is new
//   gis_error                    a county query failed/timed out (never a roll verdict)
//   address_text_miss            the street is not on the roll under the typed spelling
//   number_not_on_roll           the street exists, the typed house number does not
//   point_parcel_dropped:<why>   a parcel sits at the point but a guard dropped it
//   county_unknown               no county on the row or from the audit, and none of the serviced
//                                counties has a parcel at the point (or no coordinates)
//   no_parcel_at_point           county known, no parcel at the stored point
//   point_lookup_unsupported     county has no point layer (Hillsborough): inconclusive
//
// The stored lat/lng is the geocode point but its location_type is not
// stored; the replay assumes ROOFTOP (`--precision=interpolated` replays the
// stricter new-plat rule). The geocoder's canonical address is not stored
// either, so the stored normalized (typed) address stands in for it.
//
// Output: a summary table by stop point (rows, commercial rows) on stdout and
// a per-row TSV at --out (default under os.tmpdir()). Rows print the
// normalized ADDRESS and its stored lat/lng only — never names, phones or
// emails (the query does not select them). The TSV's address, lat, lng and
// county_used columns are what a --cases entry needs.
//
// Usage (repo root), NESTED like ops/agents/agents-report.js: the outer run
// supplies DATABASE_PUBLIC_URL (the public proxy; the portal service only
// has the internal URL), the inner run the portal's GATE_* variables. The
// parcel guards read GATE_CONDO_UNIT_FOLIO at call time, so under the
// Postgres service alone an ON gate would replay as OFF; the script prints
// each guard gate's on/off at startup so that is visible.
//   railway run --service Postgres -- railway run --service waves-customer-portal \
//     node server/scripts/property-lookup-replay.js \
//     [--since=90d] [--status=no_parcel|all-failed|sample-clean=N] \
//     [--address-like='%FL 70%'] [--limit=500] [--out=/tmp/replay.tsv]
//   node server/scripts/property-lookup-replay.js --cases=cases.json   # no DB
//
// Flags:
//   --since=90d        rows whose last attempt (else creation) is this recent (Nd or Nh)
//   --status=          no_parcel (default) | all-failed (parcel_id null) | sample-clean=N
//                      (N random resolved rows — the no-regression side)
//   --address-like=    ILIKE pattern on the stored address (wrapped in % when none given)
//   --limit=           row cap for no_parcel / all-failed (default 500)
//   --cases=<json>     fixed cases instead of the DB: [{ name, address, lat, lng,
//                      county?, locationType?, snapshot?, storedParcelId?, expect? }]
//                      `expect` is a stop point; any mismatch exits 1
//   --precision=       rooftop (default) | interpolated
//   --concurrency=     parallel rows, 1-3 (default 2)
//   --delay-ms=        pause after each row per worker (default 250); Manatee's WAF is touchy
//   --out=<path>       TSV path

const os = require('os');
const path = require('path');
const fs = require('fs');

const DEFAULT_SINCE_DAYS = 90;
const DEFAULT_LIMIT = 500;
const MAX_CONCURRENCY = 3;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_DELAY_MS = 250;

// Gates the replayed parcel guards read at call time (feature-gates.js
// condoUnitFolioLive: on only when exactly 'true'). A new gate a guard starts
// reading belongs here so a run without it is visible.
const GUARD_GATES = ['GATE_CONDO_UNIT_FOLIO'];

class UsageError extends Error {}

function formatGuardGates(env) {
  return GUARD_GATES.map((name) => `${name}=${env[name] === 'true' ? 'on' : 'off'}`).join(' ');
}

const POSITIVE_INT = /^[1-9]\d*$/;

const textFlag = (flag, field, what) => (value) => {
  if (!value) throw new UsageError(`${flag} needs ${what}`);
  return { [field]: value };
};

const intFlag = (flag, field, pattern, what, clamp = (n) => n) => (value) => {
  if (!pattern.test(value)) throw new UsageError(`${flag} needs ${what}`);
  return { [field]: clamp(Number(value)) };
};

// flag -> parser returning the args fields it sets (throws UsageError).
const FLAG_PARSERS = new Map([
  ['since', (value) => {
    const m = /^(\d+)([dh])$/.exec(value);
    if (!m || Number(m[1]) < 1) throw new UsageError('--since needs Nd or Nh, e.g. --since=90d');
    const n = Number(m[1]);
    return m[2] === 'd' ? { sinceDays: n, sinceHours: null } : { sinceHours: n, sinceDays: null };
  }],
  ['status', (value) => {
    const sample = /^sample-clean=(\d+)$/.exec(value);
    if (sample) {
      if (Number(sample[1]) < 1) throw new UsageError('--status=sample-clean=N needs N >= 1');
      return { status: 'sample-clean', sampleSize: Number(sample[1]) };
    }
    if (value === 'no_parcel' || value === 'all-failed') return { status: value };
    throw new UsageError(`--status must be one of no_parcel, all-failed, sample-clean=N (got ${JSON.stringify(value)})`);
  }],
  ['address-like', textFlag('--address-like', 'addressLike', 'a pattern')],
  ['limit', intFlag('--limit', 'limit', POSITIVE_INT, 'a positive integer')],
  ['cases', textFlag('--cases', 'cases', 'a json file path')],
  ['out', textFlag('--out', 'out', 'a path')],
  ['precision', (value) => {
    if (value !== 'rooftop' && value !== 'interpolated') throw new UsageError('--precision must be rooftop or interpolated');
    return { precision: value };
  }],
  // Manatee's WAF rejects bursts as readily as OR/AND clauses: hard cap.
  ['concurrency', intFlag('--concurrency', 'concurrency', POSITIVE_INT, 'a positive integer', (n) => Math.min(n, MAX_CONCURRENCY))],
  ['delay-ms', intFlag('--delay-ms', 'delayMs', /^\d+$/, 'a non-negative integer')],
]);

function parseArgs(argv) {
  const args = {
    sinceDays: DEFAULT_SINCE_DAYS,
    sinceHours: null,
    status: 'no_parcel',
    sampleSize: null,
    addressLike: null,
    limit: DEFAULT_LIMIT,
    cases: null,
    out: null,
    precision: 'rooftop',
    concurrency: DEFAULT_CONCURRENCY,
    delayMs: DEFAULT_DELAY_MS,
  };
  for (const raw of argv) {
    if (!raw.startsWith('--')) throw new UsageError(`unexpected argument ${JSON.stringify(raw)}`);
    const [key, ...rest] = raw.slice(2).split('=');
    if (!FLAG_PARSERS.has(key)) throw new UsageError(`unknown flag --${key}`);
    Object.assign(args, FLAG_PARSERS.get(key)(rest.join('=')));
  }
  return args;
}

// Row-selection SQL. Only the jsonb keys the replay reads are pulled out of
// the snapshot / record, so no owner names (property_record carries them)
// ever leave the database. `since` keys on the last attempt when there is
// one: rows are upserted by address, so a re-failure of an old address would
// otherwise fall outside "the last 90 days".
function buildSelectionQuery(args) {
  const where = [];
  const values = [];
  const bind = (v) => { values.push(v); return `$${values.length}`; };

  const interval = args.sinceHours != null ? `${args.sinceHours} hours` : `${args.sinceDays ?? DEFAULT_SINCE_DAYS} days`;
  where.push(`COALESCE(last_attempt_at, created_at) >= NOW() - ${bind(interval)}::interval`);

  if (args.status === 'no_parcel') {
    where.push(`last_attempt_status = ${bind('no_parcel')}`);
  } else if (args.status === 'all-failed') {
    // parcel_id is filled only from a GIS parcel; a lookup the PAO address
    // search resolved keeps it null but carries the parcel on the record —
    // that is a success, not a failure.
    where.push(
      'parcel_id IS NULL',
      "COALESCE(property_record->'_raw'->>'parcelId', '') = ''",
      "COALESCE(last_attempt_status, '') <> 'resolved'",
    );
  } else if (args.status === 'sample-clean') {
    // Resolved = a parcel on the row AND a stored record (stub rows have none).
    where.push('parcel_id IS NOT NULL', 'property_record IS NOT NULL');
  } else {
    throw new UsageError(`unsupported status ${args.status}`);
  }

  if (args.addressLike) {
    const pattern = args.addressLike.includes('%') ? args.addressLike : `%${args.addressLike}%`;
    where.push(`normalized_address ILIKE ${bind(pattern)}`);
  }

  const sample = args.status === 'sample-clean';
  const limit = sample ? args.sampleSize : (args.limit || DEFAULT_LIMIT);
  const text = `SELECT normalized_address, lat, lng, parcel_id, county, last_attempt_status, created_at,
  jsonb_build_object(
    'isCommercial', enriched_snapshot->'isCommercial',
    'category', enriched_snapshot->'category',
    'commercialSubtype', enriched_snapshot->'commercialSubtype',
    'commercialDetectionSource', enriched_snapshot->'commercialDetectionSource',
    'unitScopedLookup', enriched_snapshot->'unitScopedLookup',
    'addressAudit', enriched_snapshot->'addressAudit',
    'fieldVerifyFlags', enriched_snapshot->'fieldVerifyFlags'
  ) AS snapshot
FROM property_lookups
WHERE ${where.join('\n  AND ')}
ORDER BY ${sample ? 'random()' : 'COALESCE(last_attempt_at, created_at) DESC'}
LIMIT ${bind(limit)}`;
  return { text, values };
}

// Read-only by construction: the session is set READ ONLY before the select,
// and checked back so a pooler that ignored the SET fails loudly instead of
// silently allowing writes.
async function fetchRowsFromDb(args, { Client = require('pg').Client, env = process.env } = {}) {
  const url = env.DATABASE_PUBLIC_URL;
  if (!url || url === 'undefined' || url === 'null') {
    throw new UsageError('DATABASE_PUBLIC_URL not set — run via: railway run --service Postgres -- railway run --service waves-customer-portal node server/scripts/property-lookup-replay.js ... (or use --cases)');
  }
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('SET default_transaction_read_only = on');
    const check = await client.query('SHOW default_transaction_read_only');
    if (check.rows?.[0]?.default_transaction_read_only !== 'on') {
      throw new Error('could not put the session in read-only mode — aborting');
    }
    const { text, values } = buildSelectionQuery(args);
    const result = await client.query(text, values);
    return result.rows;
  } finally {
    await client.end().catch(() => {});
  }
}

function loadCases(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(parsed) ? parsed : parsed.cases;
  if (!Array.isArray(list)) throw new UsageError('--cases file must be a JSON array (or { "cases": [...] })');
  return list.map((c, i) => {
    if (!c || typeof c.address !== 'string' || !c.address.trim()) {
      throw new UsageError(`case ${i} needs an address`);
    }
    return {
      case_name: c.name || `case-${i + 1}`,
      normalized_address: c.address.toUpperCase(),
      lat: c.lat ?? null,
      lng: c.lng ?? null,
      parcel_id: c.storedParcelId ?? null,
      county: c.county ?? null,
      last_attempt_status: c.storedStatus ?? null,
      created_at: null,
      locationType: c.locationType || null,
      snapshot: c.snapshot || {},
      expect: c.expect || null,
    };
  });
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// What the live lookup hands the county steps: the geocoder's hint. Only
// coordinates and a county survive in the table, so the rest is the minimum
// the audit's county gate and the precision rule read.
function buildGeoContext(row, opts = {}) {
  const lat = numOrNull(row.lat);
  const lng = numOrNull(row.lng);
  const locationType = row.locationType
    || (opts.precision === 'interpolated' ? 'RANGE_INTERPOLATED' : 'ROOFTOP');
  return {
    lat,
    lng,
    county: row.county || null,
    state: 'FL',
    partialMatch: false,
    locationType,
  };
}

function summarizeAudit(audit, errors) {
  if (errors.length && !audit) return { status: 'error', errors };
  if (!audit) return { status: 'no_signal', errors };
  return {
    status: 'ran',
    streetExists: audit.streetExists === true,
    hasExactMatch: audit.hasExactMatch === true,
    nearestNumbers: Array.isArray(audit.nearestNumbers) ? audit.nearestNumbers : [],
    county: audit.county || null,
    errors,
  };
}

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

// The row's own identity fields, carried on every result (the replay ones and
// the "this row threw" fallback). lat/lng ride along so a DB row can be turned
// into a --cases entry from the TSV.
function rowIdentity(row) {
  return {
    address: String(row.normalized_address || '').trim(),
    lat: numOrNull(row.lat),
    lng: numOrNull(row.lng),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    storedStatus: row.last_attempt_status,
    storedParcelId: row.parcel_id,
    storedCounty: row.county,
    caseName: row.case_name,
    expect: row.expect,
    snapshot: row.snapshot,
  };
}

// Step 1: street / number on the roll.
async function auditStep(address, geo, deps) {
  const diag = { errors: [] };
  let audit = null;
  try {
    audit = await deps.auditAddressHouseNumber(address, geo, { typedAddress: address, diag });
  } catch (err) {
    diag.errors.push({ county: null, aborted: false, error: errText(err) });
  }
  return summarizeAudit(audit, diag.errors);
}

// Step 2: the parcel at the stored point, then the live guards.
async function pointStep(address, geo, countyHint, deps) {
  if (geo.lat === null || geo.lng === null) return { status: 'skipped', reason: 'no_coordinates', errors: [] };
  // The county module answers situs searches only for a county with a point
  // layer (none for Hillsborough): no point query is made, so it is
  // inconclusive — never a "no parcel at the point" miss.
  if (countyHint && !deps.pointLookupCounties.has(deps.normalizeCountyName(countyHint))) {
    return { status: 'skipped', reason: 'point_lookup_unsupported_county', errors: [] };
  }
  const diag = { errors: [] };
  let parcel = null;
  try {
    parcel = await deps.lookupCountyParcelByPoint(geo.lat, geo.lng, { county: countyHint ?? undefined, diag });
  } catch (err) {
    diag.errors.push({ county: countyHint, aborted: false, error: errText(err) });
  }
  if (!parcel) return { status: diag.errors.length ? 'error' : 'none', errors: diag.errors };

  const guarded = deps.applyGisParcelGuards(parcel, {
    searchAddress: address,
    address,
    gisPrecision: deps.parcelGisPrecision(geo),
    diag: null,
  });
  // A kept parcel may be a unit parcel resolved out of an aggregate; a dropped
  // one is reported as the parcel the point found.
  const shown = guarded.parcel || parcel;
  return {
    status: guarded.parcel ? 'kept' : 'dropped',
    ...(guarded.parcel ? {} : { dropReason: guarded.dropReason || 'unknown' }),
    parcelId: shown.parcelId || null,
    situs: shown.situsAddress || null,
    county: shown.county || null,
    errors: [],
  };
}

// Run the three free steps for ONE row. `deps` carries the lookup functions
// (injected in tests; the real modules in main) so nothing here touches the
// network on its own.
async function replayRow(row, deps, opts = {}) {
  const identity = rowIdentity(row);
  const geo = buildGeoContext(row, opts);
  const audit = await auditStep(identity.address, geo, deps);
  // The audit's county is evidence only when the street was FOUND there: a
  // negative audit reports counties[0] as a placeholder, and hinting the
  // point query with it would skip the county the point is really in
  // (a Sarasota-side Longboat Key row with a typo would read Manatee).
  const countyUsed = row.county || (audit.streetExists ? audit.county : null);
  const point = await pointStep(identity.address, geo, countyUsed, deps);
  return { ...identity, countyUsed, audit, point };
}

// Pure: replay result -> stop point. The FIRST rule that matches wins, so the
// order is the contract (see the header for why each stage ranks where it does).
const auditRan = (r) => r.audit.status === 'ran';
const pointDropped = (r) => r.point.status === 'dropped';
// A point parcel that a guard dropped is a verdict against that parcel; the
// roll having the number elsewhere does not make the match.
const parcelFound = (r) => r.point.status === 'kept' || (auditRan(r) && r.audit.hasExactMatch && !pointDropped(r));

const STOP_RULES = [
  { stop: 'commercial_no_suite_path', when: (r) => parcelFound(r) && r.snapshot.isCommercial === true && r.snapshot.unitScopedLookup !== true },
  { stop: 'matched_now', when: parcelFound },
  { stop: 'gis_error', when: (r) => (r.point.status === 'error' || r.audit.status === 'error') && !pointDropped(r) },
  { stop: 'address_text_miss', when: (r) => auditRan(r) && !r.audit.streetExists },
  { stop: 'number_not_on_roll', when: (r) => auditRan(r) && r.audit.streetExists && !r.audit.hasExactMatch },
  { stop: 'point_parcel_dropped', detail: (r) => r.point.dropReason, when: pointDropped },
  { stop: 'point_lookup_unsupported', when: (r) => r.point.reason === 'point_lookup_unsupported_county' },
  { stop: 'county_unknown', when: (r) => !r.countyUsed },
  { stop: 'no_parcel_at_point', when: () => true },
];

function classifyReplay(r) {
  const rule = STOP_RULES.find((candidate) => candidate.when(r));
  return rule.detail ? `${rule.stop}:${rule.detail(r)}` : rule.stop;
}

function normalizeParcelId(id) {
  return String(id ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function finalizeResult(r) {
  const stop = classifyReplay(r);
  const parcelRecovered = !r.storedParcelId
    && (stop === 'matched_now' || stop === 'commercial_no_suite_path');
  const storedResolved = Boolean(r.storedParcelId);
  const matched = stop === 'matched_now' || stop === 'commercial_no_suite_path';
  const expectOk = r.expect ? (stop === r.expect || stop.startsWith(`${r.expect}:`)) : null;
  return {
    ...r,
    stop,
    parcelRecovered,
    // A row the live lookup resolved that the replay can no longer match: the
    // no-regression signal for sample-clean runs.
    // Same parcel, not just "some match": a guard or geometry change that
    // keeps a DIFFERENT parcel, or an audit hit with no point parcel, is a
    // regression on the clean side.
    regression: storedResolved && !(matched && r.point?.status === 'kept'
      && normalizeParcelId(r.point.parcelId) === normalizeParcelId(r.storedParcelId)),
    expectOk,
  };
}

async function runReplay(rows, deps, opts = {}) {
  const concurrency = Math.max(1, Math.min(opts.concurrency || DEFAULT_CONCURRENCY, MAX_CONCURRENCY));
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const results = new Array(rows.length);
  let next = 0;
  let done = 0;
  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= rows.length) return;
      let replayed;
      try {
        replayed = await replayRow(rows[i], deps, opts);
      } catch (err) {
        // Whatever goes wrong inside one row must not sink the batch.
        replayed = {
          ...rowIdentity(rows[i]),
          audit: { status: 'error', errors: [{ error: errText(err) }] },
          point: { status: 'error', errors: [{ error: errText(err) }] },
        };
      }
      results[i] = finalizeResult(replayed);
      done += 1;
      if (opts.onProgress) opts.onProgress(done, rows.length);
      if (delayMs > 0) await sleep(delayMs);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return results;
}

function summarizeResults(results) {
  const byStop = new Map();
  for (const r of results) {
    const entry = byStop.get(r.stop) || { stop: r.stop, rows: 0, commercial: 0 };
    entry.rows += 1;
    if (r.snapshot?.isCommercial === true) entry.commercial += 1;
    byStop.set(r.stop, entry);
  }
  const table = [...byStop.values()].sort((a, b) => b.rows - a.rows || a.stop.localeCompare(b.stop));
  return {
    total: results.length,
    commercial: results.filter((r) => r.snapshot?.isCommercial === true).length,
    table,
    regressions: results.filter((r) => r.regression).length,
    recovered: results.filter((r) => r.parcelRecovered).length,
    expectFailures: results.filter((r) => r.expectOk === false),
  };
}

function formatSummary(summary) {
  const width = Math.max(10, ...summary.table.map((t) => t.stop.length));
  const lines = [
    `${'stop point'.padEnd(width)}  ${'rows'.padStart(6)}  ${'commercial'.padStart(10)}  ${'share'.padStart(6)}`,
    `${'-'.repeat(width)}  ${'-'.repeat(6)}  ${'-'.repeat(10)}  ${'-'.repeat(6)}`,
  ];
  for (const t of summary.table) {
    const share = summary.total ? `${Math.round((t.rows / summary.total) * 100)}%` : '0%';
    lines.push(`${t.stop.padEnd(width)}  ${String(t.rows).padStart(6)}  ${String(t.commercial).padStart(10)}  ${share.padStart(6)}`);
  }
  lines.push(`${'total'.padEnd(width)}  ${String(summary.total).padStart(6)}  ${String(summary.commercial).padStart(10)}`);
  lines.push('');
  lines.push(`parcel recovered (stored row had none): ${summary.recovered}`);
  lines.push(`regressions (stored row resolved, replay no longer matches): ${summary.regressions}`);
  if (summary.expectFailures.length) {
    lines.push(`expectation failures: ${summary.expectFailures.length}`);
    for (const f of summary.expectFailures) {
      lines.push(`  ${f.caseName || f.address}: expected ${f.expect}, got ${f.stop}`);
    }
  }
  return lines.join('\n');
}

const TSV_COLUMNS = [
  'address', 'lat', 'lng', 'stop', 'parcel_recovered', 'regression', 'stored_status', 'stored_parcel_id', 'county_used',
  'audit_status', 'street_exists', 'exact_number', 'nearest_numbers', 'audit_county',
  'point_status', 'point_drop_reason', 'point_parcel_id', 'point_situs',
  'is_commercial', 'commercial_source', 'commercial_subtype', 'unit_scoped', 'category', 'field_verify_flags',
  'stored_audit_street_exists', 'created_at', 'case_name', 'expected', 'expect_ok', 'errors',
];

function tsvCell(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[\t\r\n]+/g, ' ');
}

function resultToTsvRow(r) {
  const snap = r.snapshot || {};
  const audit = r.audit || {};
  const point = r.point || {};
  const flags = Array.isArray(snap.fieldVerifyFlags)
    ? snap.fieldVerifyFlags.map((f) => f?.field).filter(Boolean).join(',')
    : '';
  const errors = [...(audit.errors || []), ...(point.errors || [])]
    .map((e) => [e.county, e.aborted ? 'timeout' : null, e.error].filter(Boolean).join(':'))
    .join(' | ');
  const cells = {
    address: r.address,
    lat: r.lat,
    lng: r.lng,
    stop: r.stop,
    parcel_recovered: r.parcelRecovered,
    regression: r.regression,
    stored_status: r.storedStatus,
    stored_parcel_id: r.storedParcelId,
    county_used: r.countyUsed,
    audit_status: audit.status,
    street_exists: audit.status === 'ran' ? audit.streetExists : '',
    exact_number: audit.status === 'ran' ? audit.hasExactMatch : '',
    nearest_numbers: Array.isArray(audit.nearestNumbers) ? audit.nearestNumbers.join(',') : '',
    audit_county: audit.county,
    point_status: point.status,
    point_drop_reason: point.dropReason,
    point_parcel_id: point.parcelId,
    point_situs: point.situs,
    is_commercial: snap.isCommercial === true ? 'true' : snap.isCommercial === false ? 'false' : '',
    commercial_source: snap.commercialDetectionSource,
    commercial_subtype: snap.commercialSubtype,
    unit_scoped: snap.unitScopedLookup === true ? 'true' : snap.unitScopedLookup === false ? 'false' : '',
    category: snap.category,
    field_verify_flags: flags,
    stored_audit_street_exists: snap.addressAudit && typeof snap.addressAudit.streetExists === 'boolean' ? snap.addressAudit.streetExists : '',
    created_at: r.createdAt,
    case_name: r.caseName,
    expected: r.expect,
    expect_ok: r.expectOk === null || r.expectOk === undefined ? '' : r.expectOk,
    errors,
  };
  return TSV_COLUMNS.map((c) => tsvCell(cells[c])).join('\t');
}

function formatTsv(results) {
  return `${[TSV_COLUMNS.join('\t'), ...results.map(resultToTsvRow)].join('\n')}\n`;
}

function defaultOutPath(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join(os.tmpdir(), `property-lookup-replay-${stamp}.tsv`);
}

async function main(argv = process.argv.slice(2), env = process.env) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`[property-lookup-replay] ${err.message}`);
      return 2;
    }
    throw err;
  }
  // The county layers answer null when disabled, which would read as a wall of
  // roll misses.
  if (env.COUNTY_PARCEL_GIS_DISABLED === '1' || env.COUNTY_PARCEL_GIS_DISABLED === 'true') {
    console.error('[property-lookup-replay] COUNTY_PARCEL_GIS_DISABLED is set — every county query would read as a miss. Unset it and re-run.');
    return 2;
  }
  // The lookup modules log every county query at info level; keep stdout for
  // the summary.
  if (!env.LOG_LEVEL) process.env.LOG_LEVEL = 'error';

  let rows;
  try {
    rows = args.cases ? loadCases(args.cases) : await fetchRowsFromDb(args, { env });
  } catch (err) {
    console.error(`[property-lookup-replay] ${err.message}`);
    return err instanceof UsageError ? 2 : 1;
  }
  rows = rows.map((row) => ({ ...row, snapshot: row.snapshot || {} }));
  console.log(`[property-lookup-replay] ${rows.length} row(s) from ${args.cases ? `cases file` : `property_lookups (${args.status})`}`);
  console.log(`[property-lookup-replay] parcel-guard gates in this environment: ${formatGuardGates(env)} (off = unset here; run nested under the portal service to replay production's gates)`);

  // Required here, not at the top: the pure helpers above load without the
  // service layer (the unit tests rely on that), and a checkout's own lookup
  // code is what runs.
  const aiLookup = require(path.join(__dirname, '..', 'services', 'property-lookup', 'ai-property-lookup'));
  const countyGis = require(path.join(__dirname, '..', 'services', 'property-lookup', 'county-parcel-gis'));
  const deps = {
    auditAddressHouseNumber: aiLookup.auditAddressHouseNumber,
    lookupCountyParcelByPoint: countyGis.lookupCountyParcelByPoint,
    parcelGisPrecision: aiLookup._private.parcelGisPrecision,
    applyGisParcelGuards: aiLookup._private.applyGisParcelGuards,
    pointLookupCounties: new Set(Object.keys(countyGis._private.COUNTY_LAYERS)),
    // Stored county text varies ("MANATEE", "Manatee County"); the live
    // lookup canonicalizes it the same way before choosing a layer.
    normalizeCountyName: countyGis.normalizeCountyName,
  };

  const results = await runReplay(rows, deps, {
    precision: args.precision,
    concurrency: args.concurrency,
    delayMs: args.delayMs,
    onProgress: (done, total) => {
      if (done % 25 === 0 || done === total) console.error(`[property-lookup-replay] ${done}/${total}`);
    },
  });

  const outPath = args.out || defaultOutPath();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, formatTsv(results));
  const summary = summarizeResults(results);
  console.log('');
  console.log(formatSummary(summary));
  console.log('');
  console.log(`per-row TSV: ${outPath}`);
  return summary.expectFailures.length ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => {
    console.error(`[property-lookup-replay] failed: ${err?.message || err}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  buildSelectionQuery,
  fetchRowsFromDb,
  loadCases,
  buildGeoContext,
  formatGuardGates,
  main,
  replayRow,
  classifyReplay,
  finalizeResult,
  runReplay,
  summarizeResults,
  formatSummary,
  formatTsv,
  defaultOutPath,
  UsageError,
  TSV_COLUMNS,
};
