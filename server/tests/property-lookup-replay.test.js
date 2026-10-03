/**
 * Property-lookup replay harness (scripts/property-lookup-replay.js): the
 * row-selection SQL, argument parsing, the stop-point classifier, and the
 * replay loop — all with injected fakes (no network, no database). Also pins
 * the two small changes the harness needed in the lookup modules: the
 * extracted applyGisParcelGuards (same decisions as the old inline guards,
 * now with a dropReason) and the county GIS `diag` out-param that tells an
 * outage apart from a genuine roll miss.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const replay = require('../scripts/property-lookup-replay');
const { _private } = require('../services/property-lookup/ai-property-lookup');
const { lookupCountyParcelByPoint, queryStreetSitusAddresses } = require('../services/property-lookup/county-parcel-gis');

const { applyGisParcelGuards, parcelGisPrecision } = _private;
const { normalizeCountyName } = require('../services/property-lookup/county-parcel-gis');

// What main() passes: the counties that have a point layer, and the same
// county-name canonicalizer the live lookup uses.
const countyDeps = { pointLookupCounties: new Set(['Manatee', 'Sarasota', 'Charlotte']), normalizeCountyName };

describe('parseArgs', () => {
  test('defaults', () => {
    const a = replay.parseArgs([]);
    expect(a).toMatchObject({ sinceDays: 90, status: 'no_parcel', limit: 500, precision: 'rooftop', concurrency: 2 });
  });

  test('flags', () => {
    const a = replay.parseArgs(['--since=12h', '--status=all-failed', '--address-like=%FL 70%', '--limit=20', '--out=/tmp/x.tsv', '--precision=interpolated', '--concurrency=9', '--delay-ms=0']);
    expect(a).toMatchObject({ sinceHours: 12, sinceDays: null, status: 'all-failed', addressLike: '%FL 70%', limit: 20, out: '/tmp/x.tsv', precision: 'interpolated', delayMs: 0 });
    // Manatee's WAF: never more than 3 in flight.
    expect(a.concurrency).toBe(3);
  });

  test('sample-clean=N', () => {
    expect(replay.parseArgs(['--status=sample-clean=40'])).toMatchObject({ status: 'sample-clean', sampleSize: 40 });
  });

  test.each([
    ['--since=90'], ['--status=bogus'], ['--status=sample-clean=0'], ['--limit=0'], ['--nope=1'], ['stray'], ['--precision=x'],
  ])('rejects %s', (flag) => {
    expect(() => replay.parseArgs([flag])).toThrow(replay.UsageError);
  });
});

describe('buildSelectionQuery', () => {
  test('default: recent no_parcel rows, newest first, parameterised', () => {
    const { text, values } = replay.buildSelectionQuery(replay.parseArgs([]));
    expect(text).toMatch(/FROM property_lookups/);
    expect(text).toMatch(/COALESCE\(last_attempt_at, created_at\) >= NOW\(\) - \$1::interval/);
    expect(text).toMatch(/last_attempt_status = \$2/);
    expect(text).toMatch(/ORDER BY COALESCE\(last_attempt_at, created_at\) DESC/);
    expect(text).toMatch(/LIMIT \$3/);
    expect(values).toEqual(['90 days', 'no_parcel', 500]);
  });

  test('never selects raw jsonb blobs, names, phones or emails', () => {
    const { text } = replay.buildSelectionQuery(replay.parseArgs([]));
    // property_record carries owner names, so it is never read into the result set.
    expect(text).not.toMatch(/property_record(?! IS (NOT )?NULL)/);
    expect(text).not.toMatch(/owner|phone|email|customer/i);
    expect(text).not.toMatch(/\bSELECT \*/);
  });

  test('all-failed filters on a missing parcel_id', () => {
    const { text, values } = replay.buildSelectionQuery(replay.parseArgs(['--status=all-failed', '--limit=7']));
    expect(text).toMatch(/parcel_id IS NULL/);
    // Address-search successes carry the parcel on the record, not the column.
    expect(text).toMatch(/property_record->'_raw'->>'parcelId'/);
    expect(text).toMatch(/<> 'resolved'/);
    expect(text).not.toMatch(/last_attempt_status = \$/);
    expect(values).toEqual(['90 days', 7]);
  });

  test('failure modes keep a payload only when it is provably the stamped attempt\'s; sample-clean is unaffected', () => {
    // A failed refresh stamps last_attempt_* but keeps the earlier success's
    // parcel, coordinates and snapshot. Exact match on attempt ids; the timing
    // window survives only for legacy rows with no ids at all.
    for (const flags of [[], ['--status=all-failed']]) {
      const { text } = replay.buildSelectionQuery(replay.parseArgs(flags));
      expect(text).toMatch(/payload_attempt_id IS NOT NULL AND payload_attempt_id = last_attempt_id/);
      // legacy window is gated on BOTH ids being NULL
      expect(text).toMatch(/payload_attempt_id IS NULL AND last_attempt_id IS NULL\s+AND \(last_attempt_at - data_saved_at\) BETWEEN \(COALESCE\(lookup_ms, 0\)::float8 \/ 1000 - 5\)/);
      expect(text).toMatch(/data_saved_at IS NULL AND property_record IS NULL/);
      // a cache hit is not a refresh: it keeps the payload it served
      expect(text).toMatch(/last_attempt_status = 'cache_hit'/);
    }
    const clean = replay.buildSelectionQuery(replay.parseArgs(['--status=sample-clean=5']));
    expect(clean.text).not.toMatch(/data_saved_at|attempt_id/);
  });

  test('selects the stored provider list (no contact columns) for the FDOR provenance check', () => {
    const { text } = replay.buildSelectionQuery(replay.parseArgs(['--status=sample-clean=5']));
    expect(text).toMatch(/'storedProviders', providers/);
  });

  test('sample-clean takes N random resolved rows', () => {
    const { text, values } = replay.buildSelectionQuery(replay.parseArgs(['--status=sample-clean=25', '--limit=3']));
    expect(text).toMatch(/parcel_id IS NOT NULL/);
    expect(text).toMatch(/property_record IS NOT NULL/);
    expect(text).toMatch(/ORDER BY random\(\)/);
    expect(values[values.length - 1]).toBe(25);
  });

  test('address-like is a bound ILIKE, wrapped in % when bare; since hours', () => {
    const bare = replay.buildSelectionQuery(replay.parseArgs(['--since=6h', '--address-like=FL 70']));
    expect(bare.text).toMatch(/normalized_address ILIKE \$3/);
    expect(bare.values).toEqual(['6 hours', 'no_parcel', '%FL 70%', 500]);
    const given = replay.buildSelectionQuery(replay.parseArgs(['--address-like=9117%']));
    expect(given.values).toContain('9117%');
    // The pattern is a bound value, never spliced into the SQL.
    const evil = replay.buildSelectionQuery(replay.parseArgs(["--address-like=x'; DROP TABLE property_lookups;--"]));
    expect(evil.text).not.toMatch(/DROP TABLE/);
  });
});

describe('fetchRowsFromDb', () => {
  function fakeClient({ show = 'on' } = {}) {
    const calls = [];
    class Client {
      constructor(cfg) { calls.push(['ctor', cfg]); }
      async connect() { calls.push(['connect']); }
      async query(text, values) {
        calls.push(['query', text, values]);
        if (/^SHOW/.test(text)) return { rows: [{ default_transaction_read_only: show }] };
        if (/^SELECT/.test(text)) return { rows: [{ normalized_address: '1 TEST ST' }] };
        return { rows: [] };
      }
      async end() { calls.push(['end']); }
    }
    return { Client, calls };
  }

  test('sets the session read-only before selecting, with TLS that skips verification', async () => {
    const { Client, calls } = fakeClient();
    const rows = await replay.fetchRowsFromDb(replay.parseArgs([]), { Client, env: { DATABASE_PUBLIC_URL: 'postgres://x' } });
    expect(rows).toEqual([{ normalized_address: '1 TEST ST' }]);
    expect(calls[0][1]).toEqual({ connectionString: 'postgres://x', ssl: { rejectUnauthorized: false } });
    const queries = calls.filter((c) => c[0] === 'query').map((c) => c[1]);
    expect(queries[0]).toBe('SET default_transaction_read_only = on');
    expect(queries[queries.length - 1]).toMatch(/^SELECT/);
    expect(queries.some((q) => /\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i.test(q))).toBe(false);
    expect(calls[calls.length - 1][0]).toBe('end');
  });

  test('refuses to select when the session did not go read-only', async () => {
    const { Client, calls } = fakeClient({ show: 'off' });
    await expect(replay.fetchRowsFromDb(replay.parseArgs([]), { Client, env: { DATABASE_PUBLIC_URL: 'postgres://x' } }))
      .rejects.toThrow(/read-only/);
    expect(calls.some((c) => c[0] === 'query' && /^SELECT/.test(c[1]))).toBe(false);
    expect(calls[calls.length - 1][0]).toBe('end');
  });

  test('needs DATABASE_PUBLIC_URL', async () => {
    await expect(replay.fetchRowsFromDb(replay.parseArgs([]), { env: {} })).rejects.toThrow(replay.UsageError);
  });
});

describe('classifyReplay', () => {
  const ran = (over = {}) => ({ status: 'ran', streetExists: true, hasExactMatch: false, nearestNumbers: [], county: 'Manatee', errors: [], ...over });
  const base = (over = {}) => ({ snapshot: {}, countyUsed: 'Manatee', storedCounty: 'Manatee', storedParcelId: null, audit: ran(), point: { status: 'none', errors: [] }, ...over });

  test('street not on the roll', () => {
    expect(replay.classifyReplay(base({ audit: ran({ streetExists: false }) }))).toBe('address_text_miss');
  });

  test('street exists, number missing', () => {
    expect(replay.classifyReplay(base())).toBe('number_not_on_roll');
  });

  test('a guard-dropped parcel carries its reason, and the street miss still ranks first', () => {
    const dropped = { status: 'dropped', dropReason: 'situs_house_number_mismatch', errors: [] };
    expect(replay.classifyReplay(base({ audit: ran({ hasExactMatch: true }), point: dropped }))).toBe('point_parcel_dropped:situs_house_number_mismatch');
    expect(replay.classifyReplay(base({ audit: ran({ streetExists: false }), point: dropped }))).toBe('address_text_miss');
    // audit gave no signal at all: the drop is the verdict
    expect(replay.classifyReplay(base({ audit: { status: 'no_signal', errors: [] }, point: dropped }))).toBe('point_parcel_dropped:situs_house_number_mismatch');
  });

  test('nothing at the point', () => {
    const noSignal = { status: 'no_signal', errors: [] };
    expect(replay.classifyReplay(base({ audit: noSignal }))).toBe('no_parcel_at_point');
    expect(replay.classifyReplay(base({ audit: noSignal, countyUsed: null }))).toBe('county_unknown');
    expect(replay.classifyReplay(base({ audit: noSignal, countyUsed: null, point: { status: 'skipped', errors: [] } }))).toBe('county_unknown');
  });

  test('no coordinates is its own inconclusive stop, ranked after the roll audit and before the fallbacks', () => {
    const noSignal = { status: 'no_signal', errors: [] };
    const skipped = { status: 'skipped', reason: 'no_coordinates', errors: [] };
    // with or without a county on the row, never a parcel miss or an unknown county
    expect(replay.classifyReplay(base({ audit: noSignal, point: skipped }))).toBe('no_coordinates');
    expect(replay.classifyReplay(base({ audit: noSignal, point: skipped, countyUsed: null }))).toBe('no_coordinates');
    // the address roll still speaks for a row with no point
    expect(replay.classifyReplay(base({ audit: ran({ streetExists: false }), point: skipped }))).toBe('address_text_miss');
    expect(replay.classifyReplay(base({ audit: ran(), point: skipped }))).toBe('number_not_on_roll');
    expect(replay.classifyReplay(base({ audit: ran({ hasExactMatch: true }), point: skipped }))).toBe('matched_now');
  });

  test('county failures are gis_error, not a roll verdict', () => {
    const err = [{ county: 'Manatee', error: 'boom' }];
    expect(replay.classifyReplay(base({ audit: { status: 'error', errors: err } }))).toBe('gis_error');
    expect(replay.classifyReplay(base({ audit: { status: 'no_signal', errors: [] }, point: { status: 'error', errors: err } }))).toBe('gis_error');
  });

  test('a kept parcel, or an exact roll number, is matched_now', () => {
    expect(replay.classifyReplay(base({ point: { status: 'kept', errors: [] } }))).toBe('matched_now');
    expect(replay.classifyReplay(base({ audit: ran({ hasExactMatch: true }) }))).toBe('matched_now');
    // a failed county query elsewhere cannot undo positive evidence
    expect(replay.classifyReplay(base({ audit: ran({ hasExactMatch: true, errors: [{ error: 'x' }] }), point: { status: 'error', errors: [{ error: 'x' }] } }))).toBe('matched_now');
  });

  test('commercial and not suite-scoped stops at the suite path once the parcel matches', () => {
    const kept = { status: 'kept', errors: [] };
    expect(replay.classifyReplay(base({ point: kept, snapshot: { isCommercial: true, unitScopedLookup: false } }))).toBe('commercial_no_suite_path');
    expect(replay.classifyReplay(base({ point: kept, snapshot: { isCommercial: true, unitScopedLookup: true } }))).toBe('matched_now');
    expect(replay.classifyReplay(base({ point: kept, snapshot: { isCommercial: false } }))).toBe('matched_now');
    // commercial but the parcel itself still fails: the earlier stop wins
    expect(replay.classifyReplay(base({ snapshot: { isCommercial: true, unitScopedLookup: false } }))).toBe('number_not_on_roll');
  });
});

describe('unsupported point-lookup county', () => {
  test('a Hillsborough row is skipped, not a parcel miss', async () => {
    const deps = {
      auditAddressHouseNumber: jest.fn().mockResolvedValue(null),
      lookupCountyParcelByPoint: jest.fn(),
      parcelGisPrecision: () => 'rooftop',
      applyGisParcelGuards: jest.fn(),
      ...countyDeps,
    };
    const row = { normalized_address: '100 EXAMPLE ST, TAMPA, FL 33610', lat: '27.9', lng: '-82.4', county: 'Hillsborough', parcel_id: null, last_attempt_status: 'no_parcel', snapshot: {} };
    const r = replay.finalizeResult(await replay.replayRow(row, deps, {}));
    expect(deps.lookupCountyParcelByPoint).not.toHaveBeenCalled();
    expect(r.point).toMatchObject({ status: 'skipped', reason: 'point_lookup_unsupported_county' });
    expect(r.stop).toBe('point_lookup_unsupported');
  });

  test('a row with no lat/lng makes no point query and reads no_coordinates', async () => {
    const deps = {
      auditAddressHouseNumber: jest.fn().mockResolvedValue(null),
      lookupCountyParcelByPoint: jest.fn(),
      parcelGisPrecision: () => null,
      applyGisParcelGuards: jest.fn(),
      ...countyDeps,
    };
    for (const county of [null, 'Manatee']) {
      const row = { normalized_address: '100 EXAMPLE ST, BRADENTON, FL 34203', lat: null, lng: null, county, parcel_id: null, last_attempt_status: 'geocode_failed', snapshot: {} };
      const r = replay.finalizeResult(await replay.replayRow(row, deps, {}));
      expect(r.point).toMatchObject({ status: 'skipped', reason: 'no_coordinates' });
      expect(r.stop).toBe('no_coordinates');
    }
    expect(deps.lookupCountyParcelByPoint).not.toHaveBeenCalled();
  });

  test('county name variants of a supported county still run the point query', async () => {
    for (const county of ['MANATEE', 'Manatee County', 'manatee']) {
      const deps = {
        auditAddressHouseNumber: jest.fn().mockResolvedValue(null),
        lookupCountyParcelByPoint: jest.fn().mockResolvedValue(null),
        parcelGisPrecision: () => 'rooftop',
        applyGisParcelGuards: jest.fn(),
        ...countyDeps,
      };
      const row = { normalized_address: '100 EXAMPLE ST, BRADENTON, FL 34203', lat: '27.4', lng: '-82.5', county, parcel_id: null, last_attempt_status: 'no_parcel', snapshot: {} };
      await replay.replayRow(row, deps, {});
      expect(deps.lookupCountyParcelByPoint).toHaveBeenCalled();
    }
  });
});

describe('finalizeResult', () => {
  test('flags recovered parcels, regressions and expectation results', () => {
    const matchedPoint = { status: 'kept', errors: [] };
    const none = { status: 'none', errors: [] };
    const audit = { status: 'no_signal', errors: [] };
    const recovered = replay.finalizeResult({ storedParcelId: null, countyUsed: 'Manatee', storedCounty: 'Manatee', snapshot: {}, audit, point: matchedPoint, expect: 'matched_now' });
    expect(recovered).toMatchObject({ stop: 'matched_now', parcelRecovered: true, regression: false, expectOk: true });
    const regressed = replay.finalizeResult({ storedParcelId: '123', countyUsed: 'Manatee', storedCounty: 'Manatee', snapshot: {}, audit, point: none });
    expect(regressed).toMatchObject({ stop: 'no_parcel_at_point', regression: true, expectOk: null });
    const sameParcel = replay.finalizeResult({ storedParcelId: '12-345', countyUsed: 'Manatee', storedCounty: 'Manatee', snapshot: {}, audit, point: { status: 'kept', parcelId: '12345', errors: [] } });
    expect(sameParcel.regression).toBe(false);
    const otherParcel = replay.finalizeResult({ storedParcelId: '123', countyUsed: 'Manatee', storedCounty: 'Manatee', snapshot: {}, audit, point: { status: 'kept', parcelId: '999', errors: [] } });
    expect(otherParcel.regression).toBe(true);
    const auditOnly = replay.finalizeResult({ storedParcelId: '123', countyUsed: 'Manatee', storedCounty: 'Manatee', snapshot: {}, audit: { status: 'ran', streetExists: true, hasExactMatch: true, errors: [] }, point: none });
    expect(auditOnly).toMatchObject({ stop: 'matched_now', regression: true });
    const prefix = replay.finalizeResult({ storedParcelId: null, countyUsed: 'Manatee', storedCounty: 'Manatee', snapshot: {}, audit, point: { status: 'dropped', dropReason: 'x', errors: [] }, expect: 'point_parcel_dropped' });
    expect(prefix.expectOk).toBe(true);
    const wrong = replay.finalizeResult({ storedParcelId: null, countyUsed: 'Manatee', storedCounty: 'Manatee', snapshot: {}, audit, point: none, expect: 'matched_now' });
    expect(wrong.expectOk).toBe(false);
  });
});

describe('regression flag: not comparable when the replay does not run the stored source', () => {
  const audit = { status: 'no_signal', errors: [] };
  const none = { status: 'none', errors: [] };
  test('no stored county: neither a regression nor a recovery can be claimed (the live geocoder hint was not persisted)', () => {
    const kept = { status: 'kept', parcelId: '999', errors: [] };
    expect(replay.finalizeResult({ storedParcelId: '123', countyUsed: null, storedCounty: null, snapshot: {}, audit, point: kept }).regression).toBeNull();
    expect(replay.finalizeResult({ storedParcelId: null, countyUsed: null, storedCounty: null, snapshot: {}, audit, point: kept }).parcelRecovered).toBeNull();
  });

  const resolved = (over) => replay.finalizeResult({ storedParcelId: '123', countyUsed: 'Manatee', storedCounty: 'Manatee', snapshot: {}, audit, point: none, ...over });

  test('a county-GIS stored parcel that the replay loses is still a regression', () => {
    expect(resolved({ snapshot: { storedProviders: ['manatee_gis', 'manatee_pao'] } }).regression).toBe(true);
    expect(resolved({ snapshot: {} }).regression).toBe(true);
  });

  test('a parcel the live FDOR statewide fallback supplied is not comparable', () => {
    const fdor = { storedProviders: ['fdor_cadastral', 'manatee_pao'] };
    expect(resolved({ snapshot: fdor }).regression).toBeNull();
    // even when the replay happens to keep a different parcel there
    expect(resolved({ snapshot: fdor, point: { status: 'kept', parcelId: '999', errors: [] } }).regression).toBeNull();
    // and a null provider list (row written before the column existed) is not a guess
    expect(resolved({ snapshot: { storedProviders: null } }).regression).toBe(true);
  });

  test('a county with no point layer, no coordinates, or a failed query is not a regression', () => {
    expect(resolved({ countyUsed: 'Hillsborough', point: { status: 'skipped', reason: 'point_lookup_unsupported_county', errors: [] } }).regression).toBeNull();
    // even when the address roll alone made the match, an unqueried point proves nothing
    const rollOnly = { status: 'ran', streetExists: true, hasExactMatch: true, errors: [] };
    const unsupported = resolved({ audit: rollOnly, point: { status: 'skipped', reason: 'point_lookup_unsupported_county', errors: [] } });
    expect(unsupported).toMatchObject({ stop: 'matched_now', regression: null });
    expect(resolved({ point: { status: 'skipped', reason: 'no_coordinates', errors: [] } })).toMatchObject({ stop: 'no_coordinates', regression: null });
    expect(resolved({ point: { status: 'error', errors: [{ error: 'timeout' }] } })).toMatchObject({ stop: 'gis_error', regression: null });
  });

  test('a row that never resolved is false, and the summary and TSV report the not-comparable count', () => {
    expect(resolved({ storedParcelId: null }).regression).toBe(false);
    const rows = [
      resolved({}),
      resolved({ snapshot: { storedProviders: ['fdor_cadastral'] } }),
      resolved({ point: { status: 'skipped', reason: 'no_coordinates', errors: [] } }),
    ];
    const summary = replay.summarizeResults(rows);
    expect(summary).toMatchObject({ regressions: 1, notComparable: 2 });
    expect(replay.formatSummary(summary)).toMatch(/not comparable \(stored parcel from a source the replay does not run\): 2/);
    const header = replay.TSV_COLUMNS;
    const cell = (r) => replay.formatTsv([r]).trim().split('\n')[1].split('\t')[header.indexOf('regression')];
    expect(rows.map(cell)).toEqual(['true', 'n/a', 'n/a']);
  });
});

describe('replayRow', () => {
  const parcel = { parcelId: '500000001', situsAddress: '6000 SAMPLE RD', county: 'Manatee' };
  const makeDeps = (over = {}) => ({
    auditAddressHouseNumber: jest.fn().mockResolvedValue({ county: 'Manatee', streetExists: true, hasExactMatch: false, nearestNumbers: [14600] }),
    lookupCountyParcelByPoint: jest.fn().mockResolvedValue(parcel),
    parcelGisPrecision,
    applyGisParcelGuards,
    ...countyDeps,
    ...over,
  });
  const row = { normalized_address: '9117 SR 99, BRADENTON, FL 34203', lat: '27.40000', lng: '-82.40000', county: null, parcel_id: null, last_attempt_status: 'no_parcel', snapshot: { isCommercial: true, unitScopedLookup: false } };

  test('a negative audit does not pick the point-query county', async () => {
    const deps = makeDeps({
      auditAddressHouseNumber: jest.fn().mockResolvedValue({ county: 'Manatee', streetExists: false, hasExactMatch: false, nearestNumbers: [] }),
    });
    await replay.replayRow({ ...row, county: null }, deps, {});
    expect(deps.lookupCountyParcelByPoint.mock.calls[0][2].county).toBeUndefined();
  });

  test('a street-only audit hit (number missing) does not pick the point-query county either', async () => {
    const deps = makeDeps({
      auditAddressHouseNumber: jest.fn().mockResolvedValue({ county: 'Manatee', streetExists: true, hasExactMatch: false, nearestNumbers: [100] }),
    });
    await replay.replayRow({ ...row, county: null }, deps, {});
    expect(deps.lookupCountyParcelByPoint.mock.calls[0][2].county).toBeUndefined();
  });

  test('plaza-storefront shape: roll has the number elsewhere, the point parcel is a different situs and is dropped', async () => {
    const deps = makeDeps();
    const r = replay.finalizeResult(await replay.replayRow(row, deps, {}));
    expect(r.stop).toBe('number_not_on_roll');
    // the stored point rides on the result so a DB row can become a --cases entry
    expect(r).toMatchObject({ lat: 27.4, lng: -82.4 });
    expect(r.point).toMatchObject({ status: 'dropped', dropReason: 'situs_house_number_mismatch', parcelId: '500000001', situs: '6000 SAMPLE RD' });
    // no stored county → the point query searches every serviced county,
    // like the live lookup (the audit's county is never a hint)
    expect(deps.lookupCountyParcelByPoint).toHaveBeenCalledWith(27.40000, -82.40000, expect.objectContaining({ county: undefined }));
    // the audit sees the typed address and the stored point
    expect(deps.auditAddressHouseNumber).toHaveBeenCalledWith(row.normalized_address, expect.objectContaining({ lat: 27.40000, locationType: 'ROOFTOP', state: 'FL' }), expect.objectContaining({ typedAddress: row.normalized_address }));
  });

  test('a point parcel whose situs agrees is kept; a commercial snapshot then stops at the suite path', async () => {
    const deps = makeDeps({
      auditAddressHouseNumber: jest.fn().mockResolvedValue({ county: 'Manatee', streetExists: true, hasExactMatch: true, nearestNumbers: [] }),
      lookupCountyParcelByPoint: jest.fn().mockResolvedValue({ ...parcel, situsAddress: '9117 STATE ROAD 99 E' }),
    });
    const r = replay.finalizeResult(await replay.replayRow({ ...row, county: 'Manatee' }, deps, {}));
    expect(r.point.status).toBe('kept');
    expect(r.stop).toBe('commercial_no_suite_path');
    expect(r.parcelRecovered).toBe(true);
    // The live point budget is passed through.
    expect(deps.lookupCountyParcelByPoint.mock.calls[0][2]).toHaveProperty('timeoutMs');
  });

  test('missing coordinates skip the point step', async () => {
    const deps = makeDeps();
    const r = await replay.replayRow({ ...row, lat: null, lng: null }, deps, {});
    expect(r.point).toMatchObject({ status: 'skipped', reason: 'no_coordinates' });
    expect(deps.lookupCountyParcelByPoint).not.toHaveBeenCalled();
  });

  test('--precision=interpolated applies the stricter new-plat rule', async () => {
    const deps = makeDeps({
      auditAddressHouseNumber: jest.fn().mockResolvedValue(null),
      lookupCountyParcelByPoint: jest.fn().mockResolvedValue({ parcelId: '1', situsAddress: '', county: 'Manatee' }),
    });
    const rooftop = await replay.replayRow({ ...row, county: 'Manatee' }, deps, { precision: 'rooftop' });
    expect(rooftop.point.status).toBe('kept');
    const interp = await replay.replayRow({ ...row, county: 'Manatee' }, deps, { precision: 'interpolated' });
    expect(interp.point).toMatchObject({ status: 'dropped', dropReason: 'interpolated_unconfirmed' });
  });

  test('a thrown or errored county call is recorded, not propagated', async () => {
    const deps = makeDeps({
      auditAddressHouseNumber: jest.fn().mockRejectedValue(new Error('waf')),
      lookupCountyParcelByPoint: jest.fn().mockImplementation(async (lat, lng, opts) => {
        opts.diag.errors.push({ county: 'Manatee', aborted: true, error: 'aborted' });
        return null;
      }),
    });
    const r = replay.finalizeResult(await replay.replayRow(row, deps, {}));
    expect(r.stop).toBe('gis_error');
    expect(r.audit.status).toBe('error');
    expect(r.point.status).toBe('error');
  });
});

describe('runReplay', () => {
  test('never exceeds the concurrency cap, pauses between rows, and survives a throwing row', async () => {
    let inFlight = 0;
    let peak = 0;
    const sleeps = [];
    const deps = {
      auditAddressHouseNumber: jest.fn(async (address) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setImmediate(r));
        inFlight -= 1;
        if (address.startsWith('BOOM')) throw new Error('x');
        return null;
      }),
      lookupCountyParcelByPoint: jest.fn().mockResolvedValue(null),
      parcelGisPrecision,
      applyGisParcelGuards,
      ...countyDeps,
    };
    const rows = ['A 1', 'BOOM 2', 'C 3', 'D 4', 'E 5', 'F 6'].map((a) => ({ normalized_address: a, lat: 1, lng: 1, county: 'Manatee', snapshot: {} }));
    const results = await replay.runReplay(rows, deps, { concurrency: 50, delayMs: 5, sleep: async (ms) => { sleeps.push(ms); } });
    expect(results).toHaveLength(6);
    expect(results.map((r) => r.address)).toEqual(rows.map((r) => r.normalized_address)); // input order kept
    expect(peak).toBeLessThanOrEqual(3);
    expect(sleeps).toHaveLength(6);
    expect(results[1].stop).toBe('gis_error');
  });
});

describe('summary and TSV', () => {
  const mk = (stop, over = {}) => ({ stop, snapshot: {}, audit: {}, point: {}, address: `1 ${stop} ST`, ...over });
  test('counts by stop with commercial counts, biggest first', () => {
    const s = replay.summarizeResults([
      mk('number_not_on_roll', { snapshot: { isCommercial: true } }),
      mk('number_not_on_roll'),
      mk('matched_now', { parcelRecovered: true }),
      mk('no_parcel_at_point', { regression: true }),
    ]);
    expect(s.total).toBe(4);
    expect(s.commercial).toBe(1);
    expect(s.table[0]).toEqual({ stop: 'number_not_on_roll', rows: 2, commercial: 1 });
    expect(s.recovered).toBe(1);
    expect(s.regressions).toBe(1);
    const text = replay.formatSummary(s);
    expect(text).toMatch(/number_not_on_roll\s+2\s+1\s+50%/);
    expect(text).toMatch(/total\s+4\s+1/);
  });

  test('TSV has one header, tab-safe cells, the address and no contact fields', () => {
    const r = replay.finalizeResult({
      address: '1 TEST\tST\nBRADENTON FL', lat: 27.4, lng: -82.5, countyUsed: 'Manatee', storedParcelId: null, storedStatus: 'no_parcel', createdAt: '2026-10-01T00:00:00.000Z',
      snapshot: { isCommercial: true, commercialDetectionSource: 'satellite_ai_property_use', commercialSubtype: 'office_retail', unitScopedLookup: false, fieldVerifyFlags: [{ field: 'address' }, { field: 'propertyType' }], addressAudit: { streetExists: false } },
      audit: { status: 'ran', streetExists: false, hasExactMatch: false, nearestNumbers: [], county: 'Manatee', errors: [] },
      point: { status: 'none', errors: [] },
    });
    const lines = replay.formatTsv([r]).replace(/\n$/, '').split('\n');
    expect(lines).toHaveLength(2);
    const header = lines[0].split('\t');
    expect(header).toEqual(replay.TSV_COLUMNS);
    const cells = lines[1].split('\t');
    expect(cells).toHaveLength(header.length);
    const get = (name) => cells[header.indexOf(name)];
    expect(get('address')).toBe('1 TEST ST BRADENTON FL');
    expect(get('lat')).toBe('27.4');
    expect(get('lng')).toBe('-82.5');
    expect(get('stop')).toBe('address_text_miss');
    expect(get('commercial_source')).toBe('satellite_ai_property_use');
    expect(get('field_verify_flags')).toBe('address,propertyType');
    expect(get('stored_audit_street_exists')).toBe('false');
    expect(header.join(' ')).not.toMatch(/customer|owner|phone|email/i);
  });
});

describe('guard gates at startup', () => {
  test('names and on/off only, on exactly when the reader is (=== "true")', () => {
    expect(replay.formatGuardGates({})).toBe('GATE_CONDO_UNIT_FOLIO=off');
    expect(replay.formatGuardGates({ GATE_CONDO_UNIT_FOLIO: 'true', DATABASE_PUBLIC_URL: 'postgres://secret' })).toBe('GATE_CONDO_UNIT_FOLIO=on');
    // feature-gates condoUnitFolioLive() is strict: 'TRUE' / '1' read OFF
    expect(replay.formatGuardGates({ GATE_CONDO_UNIT_FOLIO: 'TRUE' })).toBe('GATE_CONDO_UNIT_FOLIO=off');
  });

  test('main prints the gate line and writes lat/lng to the TSV, without touching the network', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookup-replay-test-'));
    const casesFile = path.join(dir, 'cases.json');
    const outFile = path.join(dir, 'out.tsv');
    fs.writeFileSync(casesFile, JSON.stringify([{ name: 'synthetic', address: '100 EXAMPLE RD, BRADENTON, FL 34202', lat: 27.4, lng: -82.5, county: 'Manatee' }]));
    let isolated;
    jest.isolateModules(() => {
      jest.doMock('../services/property-lookup/ai-property-lookup', () => ({
        auditAddressHouseNumber: async () => null,
        _private: { parcelGisPrecision: () => 'rooftop', applyGisParcelGuards: () => ({}), livePointQueryBudgetMs: () => 3500 },
      }));
      jest.doMock('../services/property-lookup/county-parcel-gis', () => ({
        lookupCountyParcelByPoint: async () => null,
        normalizeCountyName: (c) => c,
        _private: { COUNTY_LAYERS: { Manatee: {} } },
      }));
      isolated = require('../scripts/property-lookup-replay');
    });
    const logs = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((line) => { logs.push(String(line)); });
    try {
      const code = await isolated.main([`--cases=${casesFile}`, `--out=${outFile}`, '--delay-ms=0'], { GATE_CONDO_UNIT_FOLIO: 'true' });
      expect(code).toBe(0);
    } finally {
      spy.mockRestore();
      jest.dontMock('../services/property-lookup/ai-property-lookup');
      jest.dontMock('../services/property-lookup/county-parcel-gis');
    }
    expect(logs.find((l) => l.includes('parcel-guard gates'))).toMatch(/GATE_CONDO_UNIT_FOLIO=on/);
    // Addresses + coordinates: owner-only file.
    expect(fs.statSync(outFile).mode & 0o777).toBe(0o600);
    const [header, row] = fs.readFileSync(outFile, 'utf8').trim().split('\n').map((l) => l.split('\t'));
    expect(row[header.indexOf('lat')]).toBe('27.4');
    expect(row[header.indexOf('lng')]).toBe('-82.5');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('applyGisParcelGuards (extracted from lookupPropertyFromAITrio)', () => {
  const ctx = (over = {}) => ({ searchAddress: '9117 SR 99, BRADENTON, FL 34203', address: '9117 SR 99, BRADENTON, FL 34203', gisPrecision: 'rooftop', ...over });

  test('no parcel in, nothing out', () => {
    expect(applyGisParcelGuards(null, ctx())).toEqual({ parcel: null, parkParcelSignal: null, dropReason: null });
  });

  test('situs house number that disagrees drops the parcel (the plaza / Luxe Ave guard)', () => {
    const out = applyGisParcelGuards({ parcelId: '1', situsAddress: '6000 SAMPLE RD' }, ctx());
    expect(out).toMatchObject({ parcel: null, dropReason: 'situs_house_number_mismatch' });
  });

  test('agreeing, blank, or range situs keeps the parcel at rooftop precision', () => {
    const p = { parcelId: '1', situsAddress: '9117 STATE ROAD 99 E' };
    expect(applyGisParcelGuards(p, ctx()).parcel).toBe(p);
    const blank = { parcelId: '2', situsAddress: '' };
    expect(applyGisParcelGuards(blank, ctx()).parcel).toBe(blank);
  });

  test('interpolated points need a positive street-and-number match', () => {
    const blank = { parcelId: '2', situsAddress: '' };
    expect(applyGisParcelGuards(blank, ctx({ gisPrecision: 'interpolated' }))).toMatchObject({ parcel: null, dropReason: 'interpolated_unconfirmed' });
    const exact = { parcelId: '3', situsAddress: '9117 SR 99' };
    expect(applyGisParcelGuards(exact, ctx({ gisPrecision: 'interpolated' })).parcel).toBe(exact);
  });

  test('mobile-home park master parcel drops with the park marker (rooftop only)', () => {
    const park = { parcelId: '9', landUseDescription: 'Mobile Home Park', situsAddress: '' };
    const rooftop = applyGisParcelGuards(park, ctx());
    expect(rooftop).toMatchObject({ parcel: null, dropReason: 'mobile_home_park' });
    expect(rooftop.parkParcelSignal).toMatchObject({ parkConfirmed: true });
    const interp = applyGisParcelGuards(park, ctx({ gisPrecision: 'interpolated' }));
    expect(interp).toMatchObject({ parcel: null, parkParcelSignal: null, dropReason: 'mobile_home_park' });
  });

  test('an aggregate whose building lines do not include the typed address drops', () => {
    const aggregate = { parcelId: 'A', aggregated: true, situsLines: ['13510 LUXE AVE'], situsHouseNumbers: ['13510'] };
    const out = applyGisParcelGuards(aggregate, ctx({ searchAddress: '13649 LUXE AVE, X, FL', address: '13649 LUXE AVE, X, FL' }));
    expect(out).toMatchObject({ parcel: null, dropReason: 'aggregate_situs_drop' });
    const inside = applyGisParcelGuards(aggregate, ctx({ searchAddress: '13510 LUXE AVE, X, FL', address: '13510 LUXE AVE, X, FL' }));
    expect(inside.parcel).toBe(aggregate);
  });
});

describe('county GIS diag out-param', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  test('point query: an HTTP failure is recorded, a clean empty answer is not', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    const failed = { errors: [] };
    expect(await lookupCountyParcelByPoint(27.4, -82.3, { county: 'Manatee', diag: failed })).toBeNull();
    expect(failed.errors).toEqual([expect.objectContaining({ county: 'Manatee', error: expect.stringContaining('403') })]);

    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ features: [] }) });
    const clean = { errors: [] };
    expect(await lookupCountyParcelByPoint(27.4, -82.3, { county: 'Manatee', diag: clean })).toBeNull();
    expect(clean.errors).toEqual([]);
  });

  test('street query records failures through options.diag and still returns null', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
    const diag = { errors: [] };
    expect(await queryStreetSitusAddresses('Manatee', 'SAMPLE', { diag })).toBeNull();
    expect(diag.errors).toEqual([expect.objectContaining({ county: 'Manatee', error: 'network down' })]);
    // no diag supplied: unchanged behavior
    expect(await queryStreetSitusAddresses('Manatee', 'SAMPLE', {})).toBeNull();
  });
});

describe('county point lookup diag on an exhausted budget', () => {
  test('a partial unhinted search records an aborted error instead of a silent miss', async () => {
    const gis = require('../services/property-lookup/county-parcel-gis');
    const realFetch = global.fetch;
    const realNow = Date.now;
    let t = 1_000_000;
    Date.now = () => t;
    // The first county answers empty but slowly enough to spend the budget.
    global.fetch = jest.fn().mockImplementation(async () => { t += 10_000; return { ok: true, json: async () => ({ features: [] }) }; });
    const diag = { errors: [] };
    try {
      const parcel = await gis.lookupCountyParcelByPoint(27.4, -82.5, { timeoutMs: 3500, diag });
      expect(parcel).toBeNull();
      expect(diag.errors.some((e) => e.aborted)).toBe(true);
    } finally {
      global.fetch = realFetch;
      Date.now = realNow;
    }
  });
});

describe('live point budget and private output', () => {
  test('the point budget is the parcel-GIS timeout capped by the county budget', () => {
    const { _private } = require('../services/property-lookup/ai-property-lookup');
    const saved = { p: process.env.PARCEL_GIS_TIMEOUT_MS, c: process.env.COUNTY_PROPERTY_TIMEOUT_MS };
    try {
      process.env.PARCEL_GIS_TIMEOUT_MS = '9000';
      process.env.COUNTY_PROPERTY_TIMEOUT_MS = '4000';
      expect(_private.livePointQueryBudgetMs()).toBe(4000);
    } finally {
      for (const [k, v] of [['PARCEL_GIS_TIMEOUT_MS', saved.p], ['COUNTY_PROPERTY_TIMEOUT_MS', saved.c]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});
