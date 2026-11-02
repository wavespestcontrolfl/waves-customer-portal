/**
 * Public Pest Pressure Index service (GET /api/public/pest-pressure-index,
 * GATE_PUBLIC_PEST_PRESSURE_INDEX): the pure grouping / rounding / suppression
 * function, the window, the CSV, the query text and the 1-hour cache. The route
 * (gate, CORS, status codes, headers) is pinned in
 * public-pest-pressure-index-route.test.js. All rows are synthetic.
 */
jest.mock('../models/db', () => { const m = jest.fn(); m.fn = { now: () => 'now()' }; return m; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const svc = require('../services/public-pest-pressure-index');
const { DEFAULT_CONFIG } = require('../services/pest-pressure/config');
const { INTERNAL_TEST_CUSTOMERS, INTERNAL_TEST_CUSTOMER_IDS } = require('../services/internal-test-customers');

const {
  computePublicPestPressureIndex, windowFor, toCsv, getPublicPestPressureIndex, MIN_VISITS, SCALE_LABELS, CSV_HEADER,
} = svc;
const { buildQuery, countyForZip, csvCell, _clearCache } = svc._private;

// Mon 2026-11-02, 10:00 AM ET. Window end = 2026-11-01; 90 days back = 2026-08-04,
// so the cutover floor 2026-09-24 decides the start.
const NOW = new Date('2026-11-02T15:00:00Z');
const MANATEE_ZIP = '34205'; // Bradenton
const SARASOTA_ZIP = '34236'; // Sarasota

let seq = 0;
function visits(count, overrides = {}) {
  return Array.from({ length: count }, () => {
    seq += 1;
    return {
      customer_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      first_name: `Test${seq}`,
      last_name: 'Customer',
      zip: MANATEE_ZIP,
      service_line: 'pest',
      service_date: '2026-10-15',
      tap_rating: 2,
      is_tap: true,
      ...overrides,
    };
  });
}
const find = (body, county, line) => body.groups.find((g) => g.county === county && g.service_line === line);

beforeEach(() => { seq = 0; _clearCache(); jest.clearAllMocks(); });

describe('window', () => {
  test('ends yesterday ET (inclusive); the cutover floor beats end - 89 days', () => {
    expect(windowFor(NOW)).toEqual({ start: '2026-09-24', end: '2026-11-01', days: 39 });
  });

  test('uses the ET date, not the UTC date: 9:30 PM ET on Nov 2 is already Nov 3 in UTC', () => {
    expect(windowFor(new Date('2026-11-03T02:30:00Z')).end).toBe('2026-11-01');
    // 12:30 AM ET Nov 3 (04:30Z; EST after the Nov 1 change) -> yesterday is Nov 2.
    expect(windowFor(new Date('2026-11-03T05:30:00Z')).end).toBe('2026-11-02');
  });

  test('later than 89 days past the cutover: a full 90 days, end - 89', () => {
    expect(windowFor(new Date('2027-01-20T15:00:00Z'))).toEqual({ start: '2026-10-22', end: '2027-01-19', days: 90 });
  });

  test('exactly on the boundary: end - 89 equals the cutover date', () => {
    // end 2026-12-22 -> 89 days before is 2026-09-24
    expect(windowFor(new Date('2026-12-23T15:00:00Z'))).toEqual({ start: '2026-09-24', end: '2026-12-22', days: 90 });
  });

  test('before the cutover has a full day behind it: empty window, zero days', () => {
    expect(windowFor(new Date('2026-09-20T15:00:00Z')).days).toBe(0);
    expect(computePublicPestPressureIndex(visits(25), { now: new Date('2026-09-20T15:00:00Z') }).groups).toEqual([]);
  });

  test('rows outside [start, end] are dropped: before the floor, today, and after', () => {
    const rows = [
      ...visits(MIN_VISITS, { service_date: '2026-09-23' }), // blended era
      ...visits(MIN_VISITS, { service_date: '2026-11-02' }), // today, not yet complete
      ...visits(MIN_VISITS, { service_date: '2026-11-01', tap_rating: 3 }), // end, inclusive
      ...visits(MIN_VISITS, { service_date: '2026-09-24', tap_rating: 1, service_line: 'lawn' }), // start, inclusive
    ];
    const body = computePublicPestPressureIndex(rows, { now: NOW });
    expect(body.groups.map((g) => [g.service_line, g.visits, g.average])).toEqual([['lawn', 20, 1], ['pest', 20, 3]]);
  });

  test('accepts Date objects for service_date', () => {
    const rows = visits(MIN_VISITS, { service_date: new Date('2026-10-15T00:00:00Z') });
    expect(computePublicPestPressureIndex(rows, { now: NOW }).groups).toHaveLength(1);
  });
});

describe('what counts', () => {
  test('technician taps only: a row flagged not-a-tap is dropped, as is a missing or out-of-range value', () => {
    const rows = [
      ...visits(MIN_VISITS),
      ...visits(5, { is_tap: false, tap_rating: 5 }),
      ...visits(5, { tap_rating: null }),
      ...visits(5, { tap_rating: 7 }),
      ...visits(5, { tap_rating: -1 }),
      ...visits(5, { tap_rating: 'abc' }),
    ];
    const body = computePublicPestPressureIndex(rows, { now: NOW });
    expect(body.groups).toEqual([{ county: 'Manatee', service_line: 'pest', visits: 20, average: 2, median: 2 }]);
    expect(body.hidden_groups).toBe(0);
  });

  test('numeric strings from pg count (numeric columns arrive as strings)', () => {
    const rows = visits(MIN_VISITS, { tap_rating: '3.0' });
    expect(find(computePublicPestPressureIndex(rows, { now: NOW }), 'Manatee', 'pest').average).toBe(3);
  });

  test('an admin override does not change the count: only the tap value is read', () => {
    // applyOverride rewrites service_records.pressure_index and displayed_score but keeps the
    // technicianActivityRating component, so a row's overridden score must never be averaged.
    const rows = visits(MIN_VISITS, { tap_rating: 1, pressure_index: 5, displayed_score: 5 });
    const group = find(computePublicPestPressureIndex(rows, { now: NOW }), 'Manatee', 'pest');
    expect(group.average).toBe(1);
    expect(group.median).toBe(1);
  });

  test('a ZIP that does not map to one county drops the visit (unknown, malformed, empty, out of state)', () => {
    const rows = [
      ...visits(MIN_VISITS),
      ...visits(MIN_VISITS, { zip: '90210' }),
      ...visits(MIN_VISITS, { zip: null }),
      ...visits(MIN_VISITS, { zip: '' }),
      ...visits(MIN_VISITS, { zip: 'ABCDE' }),
      ...visits(MIN_VISITS, { zip: '342' }),
    ];
    const body = computePublicPestPressureIndex(rows, { now: NOW });
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].county).toBe('Manatee');
    expect(body.hidden_groups).toBe(0); // dropped visits do not form hidden groups
  });

  test('ZIP+4 and padded ZIPs use the first 5 characters', () => {
    expect(countyForZip('34205-1234')).toBe('Manatee');
    expect(countyForZip(' 34205 ')).toBe('Manatee');
    expect(countyForZip('34236')).toBe('Sarasota');
    expect(countyForZip('')).toBeNull();
  });

  test('internal test customers are dropped by name (any case, any spacing of the stored parts) and by id', () => {
    const [name] = INTERNAL_TEST_CUSTOMERS;
    const [first, ...rest] = name.split(' ');
    const last = rest.join(' ');
    const rows = [
      ...visits(MIN_VISITS),
      ...visits(15, { first_name: first.toUpperCase(), last_name: last.toUpperCase(), tap_rating: 5 }),
      ...visits(15, { first_name: first, last_name: last, tap_rating: 5 }),
      ...visits(15, { customer_id: INTERNAL_TEST_CUSTOMER_IDS[0], tap_rating: 5 }),
    ];
    const body = computePublicPestPressureIndex(rows, { now: NOW });
    expect(body.groups).toEqual([{ county: 'Manatee', service_line: 'pest', visits: 20, average: 2, median: 2 }]);
  });

  test('service line: trimmed; blank or missing becomes "unknown"', () => {
    const rows = [
      ...visits(MIN_VISITS, { service_line: ' pest ' }),
      ...visits(MIN_VISITS, { service_line: null }),
      ...visits(MIN_VISITS, { service_line: '  ' }),
    ];
    const body = computePublicPestPressureIndex(rows, { now: NOW });
    expect(body.groups.map((g) => [g.service_line, g.visits])).toEqual([['pest', 20], ['unknown', 40]]);
  });
});

describe('suppression', () => {
  test('19 visits are hidden and counted; 20 are published', () => {
    const rows = [
      ...visits(19, { service_line: 'lawn' }),
      ...visits(20, { service_line: 'pest' }),
      ...visits(3, { service_line: 'mosquito' }),
      ...visits(MIN_VISITS - 1, { zip: SARASOTA_ZIP }),
    ];
    const body = computePublicPestPressureIndex(rows, { now: NOW });
    expect(body.min_visits).toBe(20);
    expect(body.groups.map((g) => `${g.county}/${g.service_line}/${g.visits}`)).toEqual(['Manatee/pest/20']);
    expect(body.hidden_groups).toBe(3);
    // A hidden group is never named anywhere in the answer or the CSV.
    const wire = JSON.stringify(body) + toCsv(body);
    expect(wire).not.toMatch(/lawn|mosquito|Sarasota/);
  });

  test('visits are split by county before the floor: 12 + 12 is two hidden groups, not one published', () => {
    const rows = [...visits(12), ...visits(12, { zip: SARASOTA_ZIP })];
    const body = computePublicPestPressureIndex(rows, { now: NOW });
    expect(body.groups).toEqual([]);
    expect(body.hidden_groups).toBe(2);
  });

  test('no rows: an empty but well-formed answer', () => {
    const body = computePublicPestPressureIndex([], { now: NOW });
    expect(body.groups).toEqual([]);
    expect(body.hidden_groups).toBe(0);
    expect(computePublicPestPressureIndex(undefined, { now: NOW }).groups).toEqual([]);
  });
});

describe('numbers', () => {
  test('average and median round to 1 decimal', () => {
    // 20 visits: 7 x 3 and 13 x 2 -> mean 2.35 -> 2.4 (never 2.3); median 2.
    const rows = [...visits(7, { tap_rating: 3 }), ...visits(13, { tap_rating: 2 })];
    const g = find(computePublicPestPressureIndex(rows, { now: NOW }), 'Manatee', 'pest');
    expect(g).toEqual({ county: 'Manatee', service_line: 'pest', visits: 20, average: 2.4, median: 2 });
  });

  test('1/3 repeating rounds down, 2/3 rounds up', () => {
    const third = [...visits(7, { tap_rating: 1 }), ...visits(14, { tap_rating: 0 })]; // 21 visits, mean 0.333
    const twoThirds = [...visits(14, { tap_rating: 1, service_line: 'lawn' }), ...visits(7, { tap_rating: 0, service_line: 'lawn' })];
    const body = computePublicPestPressureIndex([...third, ...twoThirds], { now: NOW });
    expect(find(body, 'Manatee', 'pest').average).toBe(0.3);
    expect(find(body, 'Manatee', 'lawn').average).toBe(0.7);
  });

  test('median of an even count is the mean of the middle two; odd takes the middle', () => {
    const even = [...visits(10, { tap_rating: 1 }), ...visits(10, { tap_rating: 2 })]; // middle two: 1 and 2
    const odd = [...visits(10, { tap_rating: 1, service_line: 'lawn' }), ...visits(1, { tap_rating: 4, service_line: 'lawn' }), ...visits(10, { tap_rating: 5, service_line: 'lawn' })];
    const body = computePublicPestPressureIndex([...even, ...odd], { now: NOW });
    expect(find(body, 'Manatee', 'pest').median).toBe(1.5);
    expect(find(body, 'Manatee', 'lawn').median).toBe(4);
  });
});

describe('shape and order', () => {
  test('sorted by county, then service line, and the document has the contract keys in order', () => {
    const rows = [
      ...visits(20, { zip: SARASOTA_ZIP, service_line: 'pest' }),
      ...visits(20, { zip: MANATEE_ZIP, service_line: 'pest' }),
      ...visits(20, { zip: MANATEE_ZIP, service_line: 'lawn' }),
      ...visits(20, { zip: SARASOTA_ZIP, service_line: 'lawn' }),
      ...visits(20, { zip: MANATEE_ZIP, service_line: 'mosquito' }),
    ];
    const body = computePublicPestPressureIndex(rows, { now: NOW });
    expect(body.groups.map((g) => `${g.county}/${g.service_line}`)).toEqual([
      'Manatee/lawn', 'Manatee/mosquito', 'Manatee/pest', 'Sarasota/lawn', 'Sarasota/pest',
    ]);
    expect(Object.keys(body)).toEqual([
      'name', 'region', 'window', 'scale', 'min_visits', 'groups', 'hidden_groups', 'source', 'license', 'citation', 'page_url', 'generated_at',
    ]);
    expect(Object.keys(body.groups[0])).toEqual(['county', 'service_line', 'visits', 'average', 'median']);
    expect(body.name).toBe('Waves Pest Pressure Index');
    expect(body.region).toBe('Southwest Florida');
    expect(body.window).toEqual({ start: '2026-09-24', end: '2026-11-01', days: 39 });
    expect(body.license).toEqual({ name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' });
    expect(body.page_url).toBe('https://www.wavespestcontrol.com/pest-pressure-index/');
    expect(body.citation).toBe('Waves Pest Control. Southwest Florida Pest Pressure Index. https://www.wavespestcontrol.com/pest-pressure-index/');
    expect(body.source).toBe('Completed Waves Pest Control service visits rated by the technician on site. Not a survey and not a forecast.');
    expect(body.generated_at).toBe(NOW.toISOString());
  });

  test('no customer-level fields leak into the answer', () => {
    const rows = visits(MIN_VISITS, { first_name: 'Zzyzx', last_name: 'Quuxington', zip: MANATEE_ZIP });
    const wire = JSON.stringify(computePublicPestPressureIndex(rows, { now: NOW }));
    expect(wire).not.toMatch(/Zzyzx|Quuxington|34205|00000000-0000/);
  });

  test('scale: 0-5 with the six technician labels, which still match the settings defaults', () => {
    const { scale } = computePublicPestPressureIndex([], { now: NOW });
    expect(scale).toEqual({
      min: 0,
      max: 5,
      labels: { 0: 'None', 1: 'Very Low', 2: 'Low', 3: 'Moderate', 4: 'Elevated', 5: 'High' },
      meaning: "Technician's on-site pest activity rating at a completed Waves service visit.",
    });
    // Each integer tap resolves to the same name in the default label bands.
    const { resolveLabel } = require('../services/pest-pressure/label');
    for (const n of [0, 1, 2, 3, 4, 5]) {
      expect(resolveLabel(n, DEFAULT_CONFIG.labels).name).toBe(SCALE_LABELS[n]);
    }
  });
});

describe('CSV', () => {
  test('header, published groups only, one decimal, window columns', () => {
    const rows = [...visits(20, { tap_rating: 3 }), ...visits(20, { zip: SARASOTA_ZIP, service_line: 'lawn', tap_rating: 1 }), ...visits(5, { service_line: 'mosquito' })];
    const csv = toCsv(computePublicPestPressureIndex(rows, { now: NOW }));
    expect(csv).toBe([
      'county,service_line,visits,average,median,window_start,window_end',
      'Manatee,pest,20,3.0,3.0,2026-09-24,2026-11-01',
      'Sarasota,lawn,20,1.0,1.0,2026-09-24,2026-11-01',
      '',
    ].join('\n'));
    expect(csv.split('\n')[0]).toBe(CSV_HEADER);
  });

  test('no published group: the header alone', () => {
    expect(toCsv(computePublicPestPressureIndex([], { now: NOW }))).toBe(`${CSV_HEADER}\n`);
  });

  test('cells with commas or quotes are quoted; formula starters are neutralized', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell('pest')).toBe('pest');
    expect(csvCell(20)).toBe('20');
  });
});

describe('query', () => {
  test('tap-only with jsonb_exists (never the ? operator), window and internal exclusions bound, no PII selected beyond the grouping inputs', () => {
    const { sql, bindings } = buildQuery({ start: '2026-09-24', end: '2026-11-01' });
    expect(sql).toContain("jsonb_exists(pps.component_scores, 'technicianActivityRating')");
    expect(sql).toContain("service_records.status = 'completed'");
    expect(sql).toContain("(pps.component_scores->'technicianActivityRating'->>'value') IS NOT NULL");
    expect(sql).toContain("pps.component_scores->'technicianActivityRating'->>'value' AS tap_rating");
    expect(sql).not.toContain('service_records.pressure_index');
    expect(sql).toContain('JOIN pest_pressure_scores pps ON pps.service_record_id = service_records.id');
    expect(sql).not.toMatch(/component_scores\s*\?/);
    // Every ? is a binding: two dates, then the names, then the ids.
    expect((sql.match(/\?/g) || []).length).toBe(bindings.length);
    expect(bindings).toEqual(['2026-09-24', '2026-11-01', ...INTERNAL_TEST_CUSTOMERS, ...INTERNAL_TEST_CUSTOMER_IDS]);
    expect(sql).toContain("LOWER(COALESCE(customers.first_name, '') || ' ' || COALESCE(customers.last_name, ''))");
  });
});

describe('getPublicPestPressureIndex', () => {
  const fakeKnex = (rowsOrError) => ({
    raw: jest.fn(async () => {
      if (rowsOrError instanceof Error) throw rowsOrError;
      return { rows: rowsOrError };
    }),
  });

  test('runs the query once and serves the cache for an hour, then recomputes', async () => {
    const knex = fakeKnex(visits(MIN_VISITS));
    const first = await getPublicPestPressureIndex({ now: NOW, knex });
    expect(first.status).toBe('ok');
    expect(first.body.groups).toHaveLength(1);
    expect(first.csv.startsWith(CSV_HEADER)).toBe(true);

    const soon = await getPublicPestPressureIndex({ now: new Date(NOW.getTime() + 59 * 60 * 1000), knex });
    expect(soon.body).toBe(first.body);
    expect(knex.raw).toHaveBeenCalledTimes(1);

    const later = await getPublicPestPressureIndex({ now: new Date(NOW.getTime() + 61 * 60 * 1000), knex });
    expect(later.body).not.toBe(first.body);
    expect(knex.raw).toHaveBeenCalledTimes(2);
  });

  test('concurrent misses share one query', async () => {
    const knex = fakeKnex(visits(MIN_VISITS));
    await Promise.all([1, 2, 3].map(() => getPublicPestPressureIndex({ now: NOW, knex })));
    expect(knex.raw).toHaveBeenCalledTimes(1);
  });

  test('a database error is "unavailable", is logged without leaking, and is not cached', async () => {
    const failing = fakeKnex(new Error('select * from customers: connection refused'));
    expect(await getPublicPestPressureIndex({ now: NOW, knex: failing })).toEqual({ status: 'unavailable' });
    const ok = fakeKnex(visits(MIN_VISITS));
    expect((await getPublicPestPressureIndex({ now: NOW, knex: ok })).status).toBe('ok');
  });
});
