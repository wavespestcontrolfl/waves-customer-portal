/**
 * Eight-search scoreboard (server/services/seo/geo-grid-named-searches.js).
 * Pure summary over per-run aggregate rows; no DB, no HTTP.
 */
const {
  summarizeNamedSearches, weeklyScanBlockedBy, NAMED_SEARCH_CITIES, NAMED_SEARCH_KEYWORDS,
} = require('../services/seo/geo-grid-named-searches');
const { KEYWORDS } = require('../services/seo/geo-grid-tracker');

function run({ office = 'sarasota', keyword = 'pest control', date, size = 5, found = 25, avg = 4, top3 = 10, pins = size * size }) {
  return {
    office_id: office, keyword, scan_run_id: `${date}T08:00:00.000Z`, scan_date: date,
    grid_size: size, pins: String(pins), found: String(found), avg_rank: avg == null ? null : String(avg), top3: String(top3),
  };
}
const find = (rows, officeId, keyword = 'pest control') => rows.find((r) => r.officeId === officeId && r.keyword === keyword);

describe('summarizeNamedSearches', () => {
  test('always eight rows: four priority cities times pest and lawn', () => {
    const rows = summarizeNamedSearches([], ['pest control']);
    expect(rows).toHaveLength(NAMED_SEARCH_CITIES.length * NAMED_SEARCH_KEYWORDS.length);
    expect(rows).toHaveLength(8);
    expect(rows.map((r) => r.label)).toEqual([
      'Pest control in Sarasota', 'Lawn care in Sarasota',
      'Pest control in Bradenton', 'Lawn care in Bradenton',
      'Pest control in Venice', 'Lawn care in Venice',
      'Pest control in Parrish', 'Lawn care in Parrish',
    ]);
    expect(rows.every((r) => r.current === null && r.baseline === null && r.positionChange === null)).toBe(true);
  });

  test('a keyword the scan does not cover is flagged, case-insensitively', () => {
    const rows = summarizeNamedSearches([], [' Pest Control ', 'exterminator']);
    expect(find(rows, 'venice').tracked).toBe(true);
    expect(find(rows, 'venice', 'lawn care').tracked).toBe(false);
  });

  test('both named keywords are in the default scan list', () => {
    for (const { keyword } of NAMED_SEARCH_KEYWORDS) expect(KEYWORDS).toContain(keyword);
  });

  test('position is the latest run; change is against a run at least four weeks older', () => {
    const rows = summarizeNamedSearches([
      run({ date: '2026-10-04', avg: 3.24, top3: 15 }),
      run({ date: '2026-09-27', avg: 3.9, top3: 12 }), // one week back: too recent
      run({ date: '2026-09-06', avg: 5.5, top3: 10 }), // four weeks back: the baseline
      run({ date: '2026-08-30', avg: 9, top3: 2 }),
    ], ['pest control']);
    const s = find(rows, 'sarasota');
    expect(s.current).toEqual({ scanDate: '2026-10-04', gridSize: 5, pins: 25, found: 25, position: 3.2, top3Pct: 60 });
    expect(s.baseline.scanDate).toBe('2026-09-06');
    expect(s.positionChange).toBe(2.3); // moved up
    expect(s.top3Change).toBe(20);
  });

  test('a worse position is a negative change', () => {
    const s = find(summarizeNamedSearches([
      run({ date: '2026-10-04', avg: 8 }),
      run({ date: '2026-09-06', avg: 5 }),
    ], []), 'sarasota');
    expect(s.positionChange).toBe(-3);
  });

  test('no run a month back means no change, not a zero', () => {
    const s = find(summarizeNamedSearches([
      run({ date: '2026-10-04' }),
      run({ date: '2026-09-27' }),
    ], []), 'sarasota');
    expect(s.baseline).toBeNull();
    expect(s.positionChange).toBeNull();
    expect(s.top3Change).toBeNull();
  });

  test('a different grid size is never the baseline', () => {
    const s = find(summarizeNamedSearches([
      run({ date: '2026-10-04', size: 5 }),
      run({ date: '2026-09-06', size: 3 }),
      run({ date: '2026-08-30', size: 5, avg: 6 }),
    ], []), 'sarasota');
    expect(s.baseline.scanDate).toBe('2026-08-30');
  });

  test('not in any pack reads as no position and no numeric change', () => {
    const s = find(summarizeNamedSearches([
      run({ date: '2026-10-04', found: 0, avg: null, top3: 0 }),
      run({ date: '2026-09-06', avg: 7, top3: 5 }),
    ], []), 'sarasota');
    expect(s.current.position).toBeNull();
    expect(s.baseline.position).toBe(7);
    expect(s.positionChange).toBeNull();
    expect(s.top3Change).toBe(-20);
  });

  test('each office and keyword reads only its own runs', () => {
    const rows = summarizeNamedSearches([
      run({ office: 'bradenton', keyword: 'lawn care', date: '2026-10-04', avg: 2 }),
      run({ office: 'lakewood-ranch', date: '2026-10-04', avg: 1 }),
    ], []);
    expect(find(rows, 'bradenton', 'lawn care').current.position).toBe(2);
    expect(find(rows, 'bradenton').current).toBeNull();
    expect(rows.filter((r) => r.current)).toHaveLength(1);
  });
});

describe('weeklyScanBlockedBy', () => {
  const on = (...names) => (gate) => names.includes(gate);

  test('nothing is missing when every switch the Sunday scan needs is on', () => {
    expect(weeklyScanBlockedBy({ gateOn: on('geoGridTracking', 'seoIntelligence', 'cronJobs'), dataforseoConfigured: true })).toEqual([]);
  });

  test('names each missing switch, the scheduler master gate and the login included', () => {
    expect(weeklyScanBlockedBy({ gateOn: on('seoIntelligence', 'cronJobs'), dataforseoConfigured: true })).toEqual(['GATE_GEO_GRID']);
    expect(weeklyScanBlockedBy({ gateOn: on('geoGridTracking', 'cronJobs'), dataforseoConfigured: true })).toEqual(['GATE_SEO_INTELLIGENCE']);
    expect(weeklyScanBlockedBy({ gateOn: on('geoGridTracking', 'seoIntelligence'), dataforseoConfigured: true })).toEqual(['GATE_CRON_JOBS']);
    expect(weeklyScanBlockedBy({ gateOn: on('geoGridTracking', 'seoIntelligence', 'cronJobs'), dataforseoConfigured: false })).toEqual(['the DataForSEO login']);
  });
});
