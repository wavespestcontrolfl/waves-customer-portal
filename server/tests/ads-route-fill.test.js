// Route fill record (services/ads/route-fill.js): the pure decision and list diff, recordRun(), and the cron's step
// recordRouteFill(). The record says
// what a route-following fill ad would do. What it must never do: change anything in Google (the Google mock below
// has the two READ functions only, so any write would throw), say "base" for a campaign that fails a check, or
// count a change that would empty a campaign's location list.

jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));

const mockBuild = jest.fn();
const mockLoadInput = jest.fn();
jest.mock('../services/ads/route-areas', () => ({
  LINES: { pest: 'general', lawn: 'lawn' },
  buildRouteAreas: mockBuild,
  loadRouteAreasInput: mockLoadInput,
}));

const mockGoogle = { readCampaignGeoTargets: jest.fn(), findPostalGeoTargets: jest.fn() };
jest.mock('../services/ads/google-ads', () => mockGoogle);
jest.mock('../models/db', () => jest.fn(() => { throw new Error('the tests pass their own connection'); }));

const logger = require('../services/logger');
const routeFill = require('../services/ads/route-fill');

const NOW = new Date('2026-11-23T15:00:03Z'); // 10:00 AM ET, Monday Nov 23, 2026

const campaign = (over = {}) => ({
  id: 'c-pest',
  campaign_name: 'Waves Fill - Pest (route)',
  platform: 'google_ads',
  campaign_type: '2',
  platform_campaign_id: '24535212382',
  status: 'active',
  metadata: { route_line: 'pest' },
  ...over,
});
const LAWN = { id: 'c-lawn', campaign_name: 'Waves Fill - Lawn (route)', platform_campaign_id: '24535212391', metadata: JSON.stringify({ route_line: 'lawn' }) };

// A route-areas record with what the record reads: the tick, the two dates and each line's ZIPs and areas.
const record = ({ pest = ['34202', '34211'], lawn = [], tick = '2026-11-23T10' } = {}) => ({
  at: NOW.toISOString(),
  tick,
  dates: ['2026-11-23', '2026-11-24'],
  lines: {
    pest: { card_line: 'general', zips: pest, areas: pest.length ? ['ranch'] : [] },
    lawn: { card_line: 'lawn', zips: lawn, areas: lawn.length ? ['north_river'] : [] },
  },
});

// Where a campaign shows, as readCampaignGeoTargets returns it: Search or not, its location option, its targets.
const location = (geoId) => ({ resourceName: `customers/1/campaignCriteria/9~${geoId}`, type: 'LOCATION', geoId: String(geoId) });
const radius = (id) => ({ resourceName: `customers/1/campaignCriteria/9~${id}`, type: 'PROXIMITY', geoId: null });
const group = (id) => ({ resourceName: `customers/1/campaignCriteria/9~${id}`, type: 'LOCATION_GROUP', geoId: null });
const shows = (targets, over = {}) => ({ search: true, presenceOnly: true, targets, ...over });

/** A knex stand-in: ad_campaigns rows, a system_settings store, and a transaction that rolls back on a throw. */
function fakeConn({ campaigns = [campaign()], settings = {}, failKey = null } = {}) {
  const store = { ...settings };
  const state = { tables: [], filters: [] };
  const table = (target) => (name) => {
    state.tables.push(name);
    if (name === 'ad_campaigns') {
      const b = {
        where: (col, v) => { state.filters.push([col, v]); return b; },
        then: (resolve, reject) => Promise.resolve(campaigns).then(resolve, reject),
      };
      return b;
    }
    if (name === 'system_settings') {
      return {
        where: ({ key }) => ({ first: () => Promise.resolve(key in target ? { key, value: target[key] } : null) }),
        insert: (row) => ({
          onConflict: () => ({
            merge: () => {
              if (row.key === failKey) return Promise.reject(new Error('write refused'));
              target[row.key] = row.value;
              return Promise.resolve();
            },
          }),
        }),
      };
    }
    throw new Error(`Unexpected table in test: ${name}`);
  };
  const conn = table(store);
  conn.transaction = async (fn) => {
    const draft = { ...store };
    const out = await fn(table(draft));
    Object.assign(store, draft);
    return out;
  };
  return { conn, store, state };
}

const saved = (store, key) => JSON.parse(store[key]);
const entryOf = (out, id) => out.campaigns.find((c) => c.campaign_id === id);

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadInput.mockResolvedValue({ the: 'input' });
  mockBuild.mockReturnValue(record());
  mockGoogle.readCampaignGeoTargets.mockResolvedValue(shows([]));
  mockGoogle.findPostalGeoTargets.mockResolvedValue({ 34202: '9012001', 34211: '9012002' });
});

describe('routeLineOf', () => {
  test('reads metadata.route_line from an object or from JSON text; any other value is no line', () => {
    expect(routeFill.routeLineOf({ metadata: { route_line: 'pest' } })).toBe('pest');
    expect(routeFill.routeLineOf({ metadata: '{"route_line":"lawn","budget_hold":{"mode":"stop"}}' })).toBe('lawn');
    expect(routeFill.routeLineOf({ metadata: { route_line: 'termite' } })).toBeNull();
    expect(routeFill.routeLineOf({ metadata: '{not json' })).toBeNull();
    expect(routeFill.routeLineOf({ metadata: null })).toBeNull();
    expect(routeFill.routeLineOf(undefined)).toBeNull();
  });

  test('the lines are the lines of the route-areas record', () => {
    expect(routeFill.ROUTE_LINES).toEqual(['pest', 'lawn']);
  });
});

describe('decideLine (pure)', () => {
  test('a line with ZIPs runs at base in those ZIPs; the reason names the dates, the areas and the count', () => {
    expect(routeFill.decideLine(record(), 'pest')).toEqual({
      line: 'pest',
      budget_mode: 'base',
      zips: ['34202', '34211'],
      areas: ['ranch'],
      reason: 'Route rule: pest room on 2026-11-23 and 2026-11-24 in ranch (2 ZIPs)',
    });
  });

  test('a line with no ZIPs drops to stop and names no list', () => {
    expect(routeFill.decideLine(record(), 'lawn')).toEqual({
      line: 'lawn',
      budget_mode: 'stop',
      zips: [],
      areas: [],
      reason: 'Route rule: no lawn technician with room on 2026-11-23 and 2026-11-24',
    });
  });

  test('a record without the line is an error, never a silent stop', () => {
    expect(() => routeFill.decideLine({ dates: [], lines: {} }, 'pest')).toThrow('the route record has no pest line');
  });
});

describe('diffLocations (pure)', () => {
  test('adds the wanted ids the campaign lacks and removes every location that is not wanted', () => {
    const current = [location(9012001), location(9012777), location(1015116)]; // a wanted ZIP, another ZIP, a city
    expect(routeFill.diffLocations(current, ['9012001', '9012002'])).toEqual({
      add: ['9012002'],
      remove: ['customers/1/campaignCriteria/9~9012777', 'customers/1/campaignCriteria/9~1015116'],
    });
  });

  test('a radius and a location group are removed: only a wanted place stays', () => {
    const current = [location(9012001), radius(555), group(777)];
    expect(routeFill.diffLocations(current, ['9012001'])).toEqual({
      add: [],
      remove: ['customers/1/campaignCriteria/9~555', 'customers/1/campaignCriteria/9~777'],
    });
  });

  test('an equal list changes nothing', () => {
    expect(routeFill.diffLocations([location(9012001), location(9012002)], ['9012002', '9012001'])).toEqual({ add: [], remove: [] });
  });
});

describe('recordRun', () => {
  test('with no marked campaign it reads the campaign list and nothing more', async () => {
    const { conn, store, state } = fakeConn({ campaigns: [campaign({ metadata: null }), campaign({ id: 'c-2', metadata: { route_line: 'termite' } })] });
    const out = await routeFill.recordRun({ now: NOW, conn });
    expect(out).toEqual({ tick: null, campaigns: [], problems: [] });
    expect(state.tables).toEqual(['ad_campaigns']);
    expect(state.filters).toEqual([['platform', 'google_ads']]);
    expect(mockLoadInput).not.toHaveBeenCalled();
    expect(mockGoogle.readCampaignGeoTargets).not.toHaveBeenCalled();
    expect(mockGoogle.findPostalGeoTargets).not.toHaveBeenCalled();
    expect(store).toEqual({});
  });

  test('only a marked campaign that is active or paused is in the record', async () => {
    mockBuild.mockReturnValue(record({ pest: ['34202'], lawn: ['34211'] }));
    const { conn } = fakeConn({
      campaigns: [
        campaign(),
        campaign({ ...LAWN, status: 'paused' }),
        campaign({ id: 'c-ended', status: 'ended' }),
        campaign({ id: 'c-plain', metadata: null }),
      ],
    });
    const out = await routeFill.recordRun({ now: NOW, conn });
    expect(out.campaigns.map((c) => [c.campaign_id, c.status, c.line])).toEqual([['c-pest', 'active', 'pest'], ['c-lawn', 'paused', 'lawn']]);
  });

  test('counts the change to the ZIP list and records the run', async () => {
    mockGoogle.readCampaignGeoTargets.mockResolvedValue(shows([location(9012001), location(9012777)]));
    const { conn, store } = fakeConn();
    const out = await routeFill.recordRun({ now: NOW, conn });

    expect(mockLoadInput).toHaveBeenCalledWith(conn, NOW);
    expect(mockBuild).toHaveBeenCalledWith({ the: 'input' });
    expect(mockGoogle.readCampaignGeoTargets).toHaveBeenCalledWith('24535212382');
    expect(out.problems).toEqual([]);
    expect(out.tick).toBe('2026-11-23T10');
    expect(entryOf(out, 'c-pest')).toMatchObject({
      line: 'pest',
      budget_mode: 'base',
      zips: ['34202', '34211'],
      targets: { ok: true, add: 1, remove: 1, unmapped: [], current: 2 },
    });

    const last = saved(store, routeFill.LAST_KEY);
    expect(last).toMatchObject({ at: NOW.toISOString(), tick: '2026-11-23T10', mode: 'shadow', dates: ['2026-11-23', '2026-11-24'] });
    expect(last.campaigns).toEqual([expect.objectContaining({
      campaign_id: 'c-pest', platform_campaign_id: '24535212382', campaign_name: 'Waves Fill - Pest (route)', status: 'active',
      line: 'pest', budget_mode: 'base', zips: ['34202', '34211'], areas: ['ranch'],
    })]);
    expect(saved(store, routeFill.HISTORY_KEY)).toEqual([{
      at: NOW.toISOString(), tick: '2026-11-23T10', mode: 'shadow',
      campaigns: [{ campaign_id: 'c-pest', line: 'pest', status: 'active', budget_mode: 'base', zips: 2, areas: ['ranch'], targets: { ok: true, add: 1, remove: 1, unmapped: 0 } }],
    }]);
  });

  test('a radius on the campaign counts as a removal: the ad would show in the ZIP list only', async () => {
    mockGoogle.readCampaignGeoTargets.mockResolvedValue(shows([location(9012001), location(9012002), radius(555)]));
    const { conn } = fakeConn();
    const out = await routeFill.recordRun({ now: NOW, conn });
    expect(entryOf(out, 'c-pest')).toMatchObject({ budget_mode: 'base', targets: { ok: true, add: 0, remove: 1, current: 3 } });
  });

  test('a list that is already right counts no change', async () => {
    mockGoogle.readCampaignGeoTargets.mockResolvedValue(shows([location(9012001), location(9012002)]));
    const { conn } = fakeConn();
    const out = await routeFill.recordRun({ now: NOW, conn });
    expect(entryOf(out, 'c-pest')).toMatchObject({ budget_mode: 'base', targets: { ok: true, add: 0, remove: 0, current: 2 } });
    expect(out.problems).toEqual([]);
  });

  // A list that is already right does not excuse a failed check: the ad would still show where it must not.
  const rightList = [location(9012001), location(9012002)];
  const FAILED_CHECKS = [
    ['is not a Search campaign in Google', shows(rightList, { search: false }), 'the Google campaign is not a Search campaign'],
    ['is not "Presence" only', shows(rightList, { presenceOnly: false }), 'the campaign location option is not "Presence": set it in Google Ads'],
    ['cannot be read', null, 'Google did not answer the location read'],
  ];

  test.each(FAILED_CHECKS)('a campaign that %s gets no base budget and is a problem', async (_name, answer, error) => {
    mockGoogle.readCampaignGeoTargets.mockResolvedValue(answer);
    const { conn, store } = fakeConn();
    const out = await routeFill.recordRun({ now: NOW, conn });
    expect(entryOf(out, 'c-pest')).toMatchObject({ budget_mode: null, targets: { ok: false, add: 0, remove: 0, error } });
    expect(saved(store, routeFill.HISTORY_KEY)[0].campaigns[0]).toMatchObject({ budget_mode: null, targets: { ok: false } });
    expect(out.problems).toEqual([`Waves Fill - Pest (route): ${error}`]);
  });

  test('a read that throws is that campaign\'s problem, not a crash', async () => {
    mockGoogle.readCampaignGeoTargets.mockRejectedValue(new Error('socket hang up'));
    const { conn } = fakeConn();
    const out = await routeFill.recordRun({ now: NOW, conn });
    expect(entryOf(out, 'c-pest')).toMatchObject({ budget_mode: null, targets: { ok: false, error: 'socket hang up' } });
    expect(out.problems).toEqual(['Waves Fill - Pest (route): socket hang up']);
  });

  test('no ZIPs means stop and the list left as it is (an empty list shows everywhere); the campaign is still checked', async () => {
    mockBuild.mockReturnValue(record({ pest: [] }));
    mockGoogle.readCampaignGeoTargets.mockResolvedValue(shows([location(9012777)]));
    const { conn } = fakeConn();
    const out = await routeFill.recordRun({ now: NOW, conn });
    expect(entryOf(out, 'c-pest')).toMatchObject({ budget_mode: 'stop', zips: [], targets: { ok: true, add: 0, remove: 0, unmapped: [], current: 1 } });
    expect(mockGoogle.findPostalGeoTargets).not.toHaveBeenCalled();
    expect(mockGoogle.readCampaignGeoTargets).toHaveBeenCalledWith('24535212382');
    expect(out.problems).toEqual([]);
  });

  test.each(FAILED_CHECKS)('on a day with no ZIPs, a campaign that %s is a problem, and its stop stands (a stop lowers the budget)', async (_name, answer, error) => {
    mockBuild.mockReturnValue(record({ pest: [] }));
    mockGoogle.readCampaignGeoTargets.mockResolvedValue(answer);
    const { conn } = fakeConn();
    const out = await routeFill.recordRun({ now: NOW, conn });
    expect(entryOf(out, 'c-pest')).toMatchObject({ budget_mode: 'stop', targets: { ok: false, error } });
    expect(out.problems).toEqual([`Waves Fill - Pest (route): ${error}`]);
  });

  test('one campaign whose locations cannot be read does not change the other campaign\'s entry', async () => {
    mockBuild.mockReturnValue(record({ pest: ['34202'], lawn: ['34211'] }));
    mockGoogle.readCampaignGeoTargets.mockResolvedValueOnce(null).mockResolvedValueOnce(shows([]));
    const { conn } = fakeConn({ campaigns: [campaign(), campaign(LAWN)] });
    const out = await routeFill.recordRun({ now: NOW, conn });
    expect(entryOf(out, 'c-pest')).toMatchObject({ budget_mode: null, targets: { ok: false } });
    expect(entryOf(out, 'c-lawn')).toMatchObject({ budget_mode: 'base', targets: { ok: true, add: 1, remove: 0 } });
    expect(out.problems).toEqual(['Waves Fill - Pest (route): Google did not answer the location read']);
  });

  test('a marked campaign with no Google campaign id cannot be checked: no base budget, and a problem', async () => {
    const { conn } = fakeConn({ campaigns: [campaign({ platform_campaign_id: null })] });
    const out = await routeFill.recordRun({ now: NOW, conn });
    expect(entryOf(out, 'c-pest')).toMatchObject({ budget_mode: null, targets: { ok: false, error: 'the campaign has no Google campaign id' } });
    expect(mockGoogle.readCampaignGeoTargets).not.toHaveBeenCalled();
    expect(out.problems).toEqual(['Waves Fill - Pest (route): the campaign has no Google campaign id']);
  });

  test('a route record that cannot be built throws, and nothing is recorded', async () => {
    mockLoadInput.mockRejectedValue(new Error('db down'));
    const { conn, store } = fakeConn();
    await expect(routeFill.recordRun({ now: NOW, conn })).rejects.toThrow('db down');
    expect(store).toEqual({});
  });
});

describe('recordRun: ZIP to Google location id', () => {
  test('the ZIPs of every campaign are asked from Google once for the run, and no id is stored', async () => {
    mockBuild.mockReturnValue(record({ pest: ['34202', '34211'], lawn: ['34211'] }));
    const { conn, store } = fakeConn({ campaigns: [campaign(), campaign(LAWN)] });
    await routeFill.recordRun({ now: NOW, conn });
    await routeFill.recordRun({ now: new Date(NOW.getTime() + 2 * 3600 * 1000), conn });
    // Asked again on the next run: Google can retire an id, and a stored one would then be wrong.
    expect(mockGoogle.findPostalGeoTargets.mock.calls).toEqual([[['34202', '34211']], [['34202', '34211']]]);
    expect(Object.keys(store).sort()).toEqual([routeFill.HISTORY_KEY, routeFill.LAST_KEY].sort());
  });

  test('an id from Google that is not digits is not used: that ZIP counts as one Google does not have', async () => {
    mockGoogle.findPostalGeoTargets.mockResolvedValue({ 34202: 'geoTargetConstants/1', 34211: '9012002' });
    const { conn } = fakeConn();
    const out = await routeFill.recordRun({ now: NOW, conn });
    expect(entryOf(out, 'c-pest').targets).toMatchObject({ ok: true, add: 1, unmapped: ['34202'] });
  });

  test('a ZIP Google does not have is left out and named; the rest of the list still counts', async () => {
    mockGoogle.findPostalGeoTargets.mockResolvedValue({ 34202: '9012001' });
    const { conn } = fakeConn();
    const out = await routeFill.recordRun({ now: NOW, conn });
    expect(entryOf(out, 'c-pest')).toMatchObject({ budget_mode: 'base', targets: { ok: true, add: 1, remove: 0, unmapped: ['34211'] } });
    // Named where a person reads it: the reason and a warning. Not a problem: the tick does not fail.
    expect(entryOf(out, 'c-pest').reason).toMatch(/\(2 ZIPs\); no Google location for 34211$/);
    expect(logger.warn).toHaveBeenCalledWith('[ads-route-fill] Waves Fill - Pest (route): no Google location id for ZIP 34211');
    expect(out.problems).toEqual([]);
  });

  test('when no ZIP of the list has an id there is no base budget, and the campaign is not read', async () => {
    mockGoogle.findPostalGeoTargets.mockResolvedValue({});
    const { conn } = fakeConn();
    const out = await routeFill.recordRun({ now: NOW, conn });
    expect(mockGoogle.readCampaignGeoTargets).not.toHaveBeenCalled();
    expect(entryOf(out, 'c-pest')).toMatchObject({ budget_mode: null, targets: { ok: false, unmapped: ['34202', '34211'] } });
    expect(out.problems).toEqual(['Waves Fill - Pest (route): no ZIP of the list has a Google location id']);
  });

  test('a failed lookup gives no base budget for a campaign with ZIPs; a campaign with no ZIPs keeps its stop', async () => {
    mockBuild.mockReturnValue(record({ pest: ['34202'], lawn: [] }));
    mockGoogle.findPostalGeoTargets.mockResolvedValue(null);
    const { conn } = fakeConn({ campaigns: [campaign(), campaign(LAWN)] });
    const out = await routeFill.recordRun({ now: NOW, conn });
    expect(entryOf(out, 'c-pest')).toMatchObject({ budget_mode: null, targets: { ok: false, error: 'Google did not answer the ZIP lookup' } });
    // The lawn line has no ZIPs: it needs no lookup, so its stop stands.
    expect(entryOf(out, 'c-lawn')).toMatchObject({ budget_mode: 'stop', targets: { ok: true, unmapped: [] } });
    expect(out.problems).toEqual(['Waves Fill - Pest (route): Google did not answer the ZIP lookup']);
  });
});

describe('recordRun: the saved rows', () => {
  test('a second run of the same tick replaces its history entry; another tick adds one', async () => {
    const { conn, store } = fakeConn();
    await routeFill.recordRun({ now: NOW, conn });
    await routeFill.recordRun({ now: new Date(NOW.getTime() + 4000), conn });
    expect(saved(store, routeFill.HISTORY_KEY)).toHaveLength(1);
    expect(saved(store, routeFill.HISTORY_KEY)[0].at).toBe(new Date(NOW.getTime() + 4000).toISOString());

    mockBuild.mockReturnValue(record({ tick: '2026-11-23T12' }));
    await routeFill.recordRun({ now: new Date(NOW.getTime() + 2 * 3600 * 1000), conn });
    expect(saved(store, routeFill.HISTORY_KEY).map((e) => e.tick)).toEqual(['2026-11-23T10', '2026-11-23T12']);
  });

  test('the history keeps the last 120 entries and survives a stored value that is not a list', async () => {
    const old = Array.from({ length: 130 }, (_, i) => ({ tick: `old-${i}`, campaigns: [] }));
    const full = fakeConn({ settings: { [routeFill.HISTORY_KEY]: JSON.stringify(old) } });
    await routeFill.recordRun({ now: NOW, conn: full.conn });
    const history = saved(full.store, routeFill.HISTORY_KEY);
    expect(history).toHaveLength(120);
    expect(history[0].tick).toBe('old-11');
    expect(history[119].tick).toBe('2026-11-23T10');

    const broken = fakeConn({ settings: { [routeFill.HISTORY_KEY]: '{"not":"a list"}' } });
    await routeFill.recordRun({ now: NOW, conn: broken.conn });
    expect(saved(broken.store, routeFill.HISTORY_KEY)).toHaveLength(1);
  });

  test('a save that fails writes neither row and is named as a problem; the run still comes back', async () => {
    const { conn, store } = fakeConn({ failKey: routeFill.HISTORY_KEY });
    const out = await routeFill.recordRun({ now: NOW, conn });
    expect(store[routeFill.LAST_KEY]).toBeUndefined();
    expect(store[routeFill.HISTORY_KEY]).toBeUndefined();
    expect(out.problems).toEqual(['the run was not saved: write refused']);
    expect(entryOf(out, 'c-pest')).toMatchObject({ budget_mode: 'base' });
  });
});

describe('recordRouteFill (the cron step)', () => {
  test('a clean run returns the run and logs no error', async () => {
    const { conn } = fakeConn();
    const out = await routeFill.recordRouteFill({ now: NOW, conn });
    expect(out.tick).toBe('2026-11-23T10');
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('a run with no marked campaign is a clean tick', async () => {
    const { conn } = fakeConn({ campaigns: [campaign({ metadata: null })] });
    await expect(routeFill.recordRouteFill({ now: NOW, conn })).resolves.toEqual({ tick: null, campaigns: [], problems: [] });
  });

  test('a run with a problem logs each problem with its tick and throws, so job_health shows the failed tick', async () => {
    mockGoogle.readCampaignGeoTargets.mockResolvedValue(null);
    const { conn, store } = fakeConn({ failKey: routeFill.HISTORY_KEY });
    await expect(routeFill.recordRouteFill({ now: NOW, conn })).rejects.toThrow(
      'route fill record: 2 problem(s) in tick 2026-11-23T10, first: Waves Fill - Pest (route): Google did not answer the location read',
    );
    expect(logger.error).toHaveBeenCalledWith('[ads-route-fill] tick 2026-11-23T10: Waves Fill - Pest (route): Google did not answer the location read');
    expect(logger.error).toHaveBeenCalledWith('[ads-route-fill] tick 2026-11-23T10: the run was not saved: write refused');
    expect(store).toEqual({});
  });
});
