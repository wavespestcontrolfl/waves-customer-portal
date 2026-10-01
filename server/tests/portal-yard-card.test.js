/**
 * "Your yard this month" card (GATE_PORTAL_YARD_CALENDAR):
 *  - GET /api/feed/yard answers {available:false} with the gate off and never
 *    builds the card; on, it resolves the place exactly as /weather does
 *  - the read model: ET month, in-season items only, grass mapping (unknown /
 *    mixed / missing show every grass), the hidden-on-other-grasses count,
 *    plan lines from the ownership loader, home pests tagged by plan line,
 *    and the last completed lawn visit with its report link, property-scoped
 */

const OCT_NOON_UTC = new Date('2026-10-15T16:00:00Z');

const LAWN_PLAN = ['lawn_care'];

function fakeKnex(row, calls = []) {
  const builder = {
    leftJoin: () => builder,
    select: () => builder,
    orderBy: () => builder,
    limit: () => builder,
    where(arg, ...rest) {
      if (typeof arg === 'function') arg.call(builder);
      else calls.push(['where', arg, ...rest]);
      return builder;
    },
    whereRaw: (...a) => { calls.push(['whereRaw', ...a]); return builder; },
    orWhereRaw: (...a) => { calls.push(['orWhereRaw', ...a]); return builder; },
    orWhereNull: (...a) => { calls.push(['orWhereNull', ...a]); return builder; },
    whereNull: (...a) => { calls.push(['whereNull', ...a]); return builder; },
    first: async () => (Array.isArray(row) ? row[0] : row),
    // Awaiting the builder itself resolves the list read.
    then(resolve, reject) {
      const rows = Array.isArray(row) ? row : (row ? [row] : []);
      return Promise.resolve(rows).then(resolve, reject);
    },
  };
  const knex = (table) => { calls.push(['table', table]); return builder; };
  return knex;
}

const PLACE = { slug: 'venice-fl', label: 'Venice, FL' };

let ownedKeys;
let grassContext;
let forecastPests;
let weatherAvailable;
let loaders;
let service;

beforeEach(() => {
  jest.resetModules();
  ownedKeys = LAWN_PLAN;
  grassContext = { grassType: 'st_augustine' };
  forecastPests = [];
  weatherAvailable = true;
  loaders = {
    loadOwnedRecurringServiceKeys: jest.fn(async () => {
      if (ownedKeys instanceof Error) throw ownedKeys;
      return ownedKeys;
    }),
    loadCustomerGrassContext: jest.fn(async () => grassContext),
  };
  jest.doMock('../models/db', () => ({}));
  jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
  jest.doMock('../services/waveguard-existing-services', () => ({ loadOwnedRecurringServiceKeys: loaders.loadOwnedRecurringServiceKeys }));
  jest.doMock('../services/lawn-grass-context', () => ({ loadCustomerGrassContext: loaders.loadCustomerGrassContext }));
  jest.doMock('../services/pest-forecast/forecast', () => ({
    getForecast: jest.fn(async () => {
      if (forecastPests instanceof Error) throw forecastPests;
      return { pests: forecastPests, weather: { available: weatherAvailable } };
    }),
  }));
  service = require('../services/portal-yard-card');
});

const build = (over = {}) => service.buildYardCard({
  customerId: 'cust-1', place: PLACE, scope: null, now: OCT_NOON_UTC, knex: fakeKnex(null), ...over,
});

describe('plan lines are scoped to the selected property', () => {
  const property = { id: 'p2', is_primary: false, address_line1: '12 Palm Ave', address_line2: null, city: 'Venice', zip: '34285' };

  test('an unscoped session reads customer-wide ownership', async () => {
    await build();
    expect(loaders.loadOwnedRecurringServiceKeys.mock.calls[0][2]).toEqual({ streetScope: null });
  });

  test('a scoped session reads ownership only at that property, strict locality', async () => {
    await build({ scope: { customerId: 'cust-1', enabled: true, multi: true, scoped: true, property } });
    const { streetScope } = loaders.loadOwnedRecurringServiceKeys.mock.calls[0][2];
    expect(streetScope.estimateStreet).toBeTruthy();
    expect(streetScope.requireSharedLocality).toBe(true);
  });

  test('a closed scope (every property retired) claims no plan and never reads ownership', async () => {
    const card = await build({ scope: { customerId: 'cust-1', enabled: true, multi: false, scoped: true, closed: true, property: null } });
    expect(loaders.loadOwnedRecurringServiceKeys).not.toHaveBeenCalled();
    expect(Object.values(card.plan).some(Boolean)).toBe(false);
  });

  test('a scoped property with no readable street claims no plan at all', async () => {
    const card = await build({ scope: { customerId: 'cust-1', enabled: true, multi: true, scoped: true, property: { id: 'p3', is_primary: false } } });
    expect(loaders.loadOwnedRecurringServiceKeys).not.toHaveBeenCalled();
    expect(card.plan).toEqual({ lawn: false, pest: false, treeShrub: false, mosquito: false, rodent: false, termite: false });
  });
});

describe('month, location and items', () => {
  test('uses the ET month, so ET-evening Oct 31 is still October', async () => {
    const card = await build({ now: new Date('2026-11-01T02:00:00Z') });
    expect(card.month).toBe(10);
    expect(card.monthName).toBe('October');
    expect(card.location).toEqual({ slug: 'venice-fl', label: 'Venice, FL', city: 'Venice' });
  });

  test('items are in season only (level 2-3) and peak first', async () => {
    const card = await build({});
    expect(card.items.length).toBeGreaterThan(0);
    expect(card.items.every((i) => i.level >= 2)).toBe(true);
    const levels = card.items.map((i) => i.level);
    expect(levels).toEqual([...levels].sort((a, b) => b - a));
    expect(card.items.find((i) => i.id === 'large-patch')).toBeUndefined(); // off season in October
  });

  test('info-only entries are flagged and sort after actionable ones of the same level', async () => {
    const card = await build({ now: new Date('2026-06-15T16:00:00Z') });
    const peakShrubs = card.items.filter((i) => i.level === 3 && i.category === 'shrub');
    expect(peakShrubs.some((i) => i.infoOnly)).toBe(true);
    const firstInfo = peakShrubs.findIndex((i) => i.infoOnly);
    expect(peakShrubs.slice(firstInfo).every((i) => i.infoOnly)).toBe(true);
    expect(peakShrubs.slice(0, firstInfo).every((i) => !i.infoOnly)).toBe(true);
  });
});

describe('grass mapping and hidden count', () => {
  test.each([
    ['st_augustine', 'sta', true],
    ['bahia', 'bah', true],
    ['zoysia', 'zoy', true],
    ['bermuda', 'ber', true],
    ['mixed', 'all', false],
    ['unknown', 'all', false],
    [null, 'all', false],
  ])('%s -> %s (known %s)', async (grassType, key, known) => {
    grassContext = { grassType };
    const card = await build({});
    expect(card.grass.key).toBe(key);
    expect(card.grass.known).toBe(known);
    expect(card.grass.mixed).toBe(grassType === 'mixed');
  });

  test('a grass-specific customer is not shown other grasses lawn items and gets a hidden count', async () => {
    grassContext = { grassType: 'st_augustine' };
    const sta = await build({});
    grassContext = { grassType: null };
    const all = await build({});
    const lawnIds = (card) => card.items.filter((i) => i.category === 'lawn').map((i) => i.id);
    expect(lawnIds(sta)).not.toContain('mole-cricket');
    expect(lawnIds(all)).toContain('mole-cricket');
    expect(sta.hiddenCount).toBe(lawnIds(all).length - lawnIds(sta).length);
    expect(sta.hiddenCount).toBe(1);
    expect(all.hiddenCount).toBe(0);
  });

  test('a SECONDARY saved property gets every grass: the turf profile is the primary house\'s', async () => {
    const scope = { enabled: true, scoped: true, closed: false, property: { id: 'prop-b', is_primary: false } };
    const card = await build({ scope });
    expect(card.grass).toEqual({ key: 'all', known: false, mixed: false, label: null });
    expect(loaders.loadCustomerGrassContext).not.toHaveBeenCalled();
  });

  test('a grass lookup failure shows every grass and says unavailable, never "not set"', async () => {
    loaders.loadCustomerGrassContext.mockRejectedValue(new Error('boom'));
    const card = await build({});
    expect(card.grass).toEqual({ key: 'all', known: false, mixed: false, label: null, unavailable: true });
  });

  test('the grass read is strict, so a failed query is not an unset profile', async () => {
    await build({});
    expect(loaders.loadCustomerGrassContext.mock.calls[0][2]).toEqual({ strict: true });
  });
});

describe('plan lines', () => {
  test('maps the ownership keys onto the card\'s lines', async () => {
    ownedKeys = ['pest_control', 'lawn_care', 'tree_shrub', 'mosquito', 'rodent_bait', 'termite_foam'];
    const card = await build({});
    expect(card.plan).toEqual({ lawn: true, pest: true, treeShrub: true, mosquito: true, rodent: true, termite: true });
  });

  test('a pest-only customer owns neither lawn nor tree & shrub', async () => {
    ownedKeys = ['pest_control'];
    const card = await build({});
    expect(card.plan).toMatchObject({ pest: true, lawn: false, treeShrub: false, mosquito: false, rodent: false });
  });

  test('an ownership lookup failure fails the card instead of claiming "not in your plan"', async () => {
    ownedKeys = new Error('catalog join failed');
    await expect(build({})).rejects.toThrow('catalog join failed');
  });

  test('a failed property-street read on a scoped session also fails the card', async () => {
    const property = { id: 'p2', is_primary: false, address_line1: '12 Palm Ave', city: 'Venice', zip: '34285' };
    const boom = () => { throw new Error('db down'); };
    await expect(build({ scope: { enabled: true, scoped: true, property }, knex: boom })).rejects.toThrow('db down');
  });
});

describe('home pests', () => {
  const PESTS = [
    { key: 'mosquitoes', label: 'Mosquitoes', score10: 8, level: 'high', note: 'm' },
    { key: 'ants', label: 'Ants', score10: 6, level: 'elevated', note: 'a' },
    { key: 'rodents', label: 'Rodents', score10: 4, level: 'moderate', note: 'r' },
    { key: 'subterranean_termites', label: 'Termites', score10: 5, level: 'moderate', note: 't' },
    { key: 'wasps', label: 'Wasps', score10: 3, level: 'low', note: 'w' },
  ];

  test('pest-only: ants in plan; mosquito and rodent are separate lines, not in plan; low scores and unowned termite are left out', async () => {
    ownedKeys = ['pest_control'];
    forecastPests = PESTS;
    const card = await build({});
    expect(card.homePests.map((p) => [p.key, p.line, p.inPlan])).toEqual([
      ['mosquitoes', 'mosquito', false],
      ['ants', 'pest', true],
      ['rodents', 'rodent', false],
    ]);
  });

  test('an owner of mosquito and termite service sees them in plan', async () => {
    ownedKeys = ['pest_control', 'mosquito', 'termite_bait'];
    forecastPests = PESTS;
    const card = await build({});
    const byKey = Object.fromEntries(card.homePests.map((p) => [p.key, p.inPlan]));
    expect(byKey).toMatchObject({ mosquitoes: true, ants: true, rodents: false, subterranean_termites: true });
  });

  test('German roaches and fleas are specialty services, never in a general pest plan', async () => {
    ownedKeys = ['pest_control'];
    forecastPests = [
      { key: 'german_roach', label: 'German roaches', score10: 6, level: 'elevated', note: 'g' },
      { key: 'fleas_ticks', label: 'Fleas & ticks', score10: 5, level: 'moderate', note: 'f' },
      { key: 'palmetto_roach', label: 'Palmetto bugs', score10: 5, level: 'moderate', note: 'p' },
    ];
    const card = await build({});
    expect(card.homePests.map((p) => [p.key, p.line, p.inPlan])).toEqual([
      ['german_roach', 'specialty', false],
      ['fleas_ticks', 'specialty', false],
      ['palmetto_roach', 'pest', true],
    ]);
  });

  test('forecast failure drops the pest list, not the card, and marks it unavailable (not an all-clear)', async () => {
    ownedKeys = ['pest_control', 'lawn_care'];
    forecastPests = new Error('weather down');
    const card = await build({});
    expect(card.homePests).toEqual([]);
    expect(card.homePestsLive).toBe(false);
    expect(card.homePestsUnavailable).toBe(true);
    expect(card.items.length).toBeGreaterThan(0);
  });

  test('a plan without the Home pests tab never reads the forecast', async () => {
    const forecast = require('../services/pest-forecast/forecast');
    for (const keys of [['lawn_care'], ['tree_shrub'], ['lawn_care', 'tree_shrub']]) {
      ownedKeys = keys;
      const card = await build({});
      expect(card.homePests).toEqual([]);
      expect(card.homePestsUnavailable).toBe(false);
    }
    expect(forecast.getForecast).not.toHaveBeenCalled();
    ownedKeys = [];
    await build({});
    expect(forecast.getForecast).toHaveBeenCalledTimes(1);
  });

  test('showsHomePests matches the client tab rule', () => {
    const { showsHomePests } = service._test;
    const plan = (over) => ({ lawn: false, pest: false, treeShrub: false, mosquito: false, rodent: false, termite: false, ...over });
    expect(showsHomePests(plan({}))).toBe(true);
    expect(showsHomePests(plan({ lawn: true }))).toBe(false);
    expect(showsHomePests(plan({ treeShrub: true }))).toBe(false);
    expect(showsHomePests(plan({ lawn: true, mosquito: true }))).toBe(true);
    expect(showsHomePests(plan({ treeShrub: true, termite: true }))).toBe(true);
  });

  test('live weather: homePestsLive true; weather down (seasonal baseline): false, pests still listed', async () => {
    ownedKeys = ['pest_control', 'lawn_care'];
    forecastPests = [{ key: 'ants', label: 'Ants', score10: 6, level: 'elevated', note: 'a' }];
    expect((await build({})).homePestsLive).toBe(true);
    weatherAvailable = false;
    const card = await build({});
    expect(card.homePestsLive).toBe(false);
    expect(card.homePests).toHaveLength(1);
  });
});

describe('last lawn visit', () => {
  const row = (over = {}) => ({
    id: 'sr-1', service_date: '2026-09-18', service_line: 'lawn', service_type: 'Lawn Care', report_view_token: 'tok123', structured_notes: null, completion_source: null, ...over,
  });

  test('returns the date and the /report/<token> link the services route uses', async () => {
    const card = await build({ knex: fakeKnex(row()) });
    expect(card.lastLawnVisit).toEqual({ date: '2026-09-18', reportUrl: '/report/tok123' });
  });

  test('no completed lawn visit -> null', async () => {
    const card = await build({ knex: fakeKnex(undefined) });
    expect(card.lastLawnVisit).toBeNull();
  });

  test.each([
    ['no token', row({ report_view_token: null })],
    ['internal-only typed delivery', row({ structured_notes: JSON.stringify({ typedReportDelivery: 'internal_only' }) })],
    ['project completion', row({ completion_source: 'project_completion' })],
  ])('%s: the visit shows, the link does not', async (_name, r) => {
    const card = await build({ knex: fakeKnex(r) });
    expect(card.lastLawnVisit).toEqual({ date: '2026-09-18', reportUrl: null });
  });

  test('only completed visits for this customer, lawn by canonical line or legacy label', async () => {
    const calls = [];
    const rows = [
      row({ id: 'sr-pest', service_date: '2026-09-25', service_line: 'pest', service_type: 'Pest Control' }),
      row({ id: 'sr-legacy', service_date: '2026-09-20', service_line: null, service_type: 'Fertilization', report_view_token: 'legacy' }),
      row({ id: 'sr-old', service_date: '2026-08-01' }),
    ];
    const card = await build({ knex: fakeKnex(rows, calls) });
    expect(calls).toContainEqual(['where', { 'service_records.customer_id': 'cust-1', 'service_records.status': 'completed' }]);
    expect(card.lastLawnVisit).toEqual({ date: '2026-09-20', reportUrl: '/report/legacy' });
  });

  test('a canonical lawn line wins over a label that says otherwise', async () => {
    const rows = [row({ service_line: 'lawn', service_type: 'Chinch Bug', report_view_token: 'chinch' })];
    const card = await build({ knex: fakeKnex(rows) });
    expect(card.lastLawnVisit.reportUrl).toBe('/report/chinch');
  });

  test('a selected secondary property scopes the visit to that property; the primary also takes unstamped visits', async () => {
    // Readable streets, so the scoped plan still owns lawn and the scan runs.
    const street = { address_line1: '12 Palm Ave', city: 'Venice', zip: '34285' };
    const secondary = { enabled: true, scoped: true, closed: false, property: { id: 'prop-b', is_primary: false, ...street } };
    const calls = [];
    await build({ scope: secondary, knex: fakeKnex(row(), calls) });
    expect(calls).toContainEqual(['where', 'scheduled_services.property_id', 'prop-b']);
    expect(calls.find((c) => c[0] === 'orWhereNull')).toBeUndefined();

    const primary = { enabled: true, scoped: true, closed: false, property: { id: 'prop-a', is_primary: true, ...street } };
    const primaryCalls = [];
    await build({ scope: primary, knex: fakeKnex(row(), primaryCalls) });
    expect(primaryCalls).toContainEqual(['where', 'scheduled_services.property_id', 'prop-a']);
    expect(primaryCalls).toContainEqual(['orWhereNull', 'scheduled_services.property_id']);
  });

  test('every property retired matches nothing', async () => {
    const closed = { enabled: true, scoped: true, closed: true, property: null };
    const calls = [];
    // The card itself skips the scan (a closed scope owns no lawn); the
    // reader still matches nothing if asked.
    await service._test.loadLastLawnVisit('cust-1', closed, fakeKnex(row(), calls), { lawn: true });
    expect(calls).toContainEqual(['whereRaw', '1 = 0']);
  });

  test('a plan without lawn never scans for a lawn visit', async () => {
    ownedKeys = ['pest_control'];
    const calls = [];
    const card = await build({ knex: fakeKnex(row(), calls) });
    expect(card.lastLawnVisit).toBeNull();
    expect(calls).toEqual([]);
  });

  test('a lookup failure drops the visit row, not the card', async () => {
    const boom = () => { throw new Error('db down'); };
    const card = await build({ knex: boom });
    expect(card.lastLawnVisit).toBeNull();
    expect(card.items.length).toBeGreaterThan(0);
  });
});

describe('GET /api/feed/yard', () => {
  let handler;
  let buildYardCard;
  let gateLive;
  let scopeResult;
  let scopeRejects;

  beforeEach(() => {
    jest.resetModules();
    gateLive = false;
    scopeRejects = false;
    scopeResult = { enabled: false };
    buildYardCard = jest.fn(async () => ({ month: 10 }));
    jest.doMock('../middleware/auth', () => ({ authenticate: (req, res, next) => next() }));
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/newsletter-feed', () => ({ getPublishedPosts: jest.fn(async () => []) }));
    jest.doMock('../services/local-news-store', () => ({}));
    jest.doMock('../services/pest-forecast/forecast', () => ({ getForecast: jest.fn() }));
    jest.doMock('../config/feature-gates', () => ({ portalYardCalendarLive: () => gateLive }));
    jest.doMock('../services/account-properties', () => ({
      resolveSessionScope: jest.fn(async () => { if (scopeRejects) throw new Error('db'); return scopeResult; }),
      resolvedScopePayload: (sc) => ({ echoed: sc }),
    }));
    jest.doMock('../services/portal-yard-card', () => ({ buildYardCard }));
    const router = require('../routes/feed');
    handler = router.stack.find((l) => l.route && l.route.path === '/yard').route.stack[0].handle;
  });

  async function get(req) {
    let body;
    let error;
    const res = { json: (b) => { body = b; return res; } };
    await handler({ customerId: 'cust-1', ...req }, res, (e) => { error = e; });
    if (error) throw error;
    return body;
  }

  test('gate off: {available:false} and nothing is built', async () => {
    expect(await get({ customer: { city: 'Venice' } })).toEqual({ available: false });
    expect(buildYardCard).not.toHaveBeenCalled();
  });

  test('gate on: the place is resolved like /weather (selected property first) and the scope passed through', async () => {
    gateLive = true;
    scopeResult = { enabled: true, scoped: true };
    const body = await get({ customer: { city: 'Sarasota', zip: '34236' }, property: { city: 'Venice', zip: '34285' } });
    // The resolved scope is echoed for the client's scopeEchoMismatch check.
    expect(body).toEqual({ available: true, month: 10, propertyScope: { echoed: { enabled: true, scoped: true } } });
    const args = buildYardCard.mock.calls[0][0];
    expect(args.customerId).toBe('cust-1');
    expect(args.place.slug).toBe('venice-fl');
    expect(args.scope).toEqual({ enabled: true, scoped: true });
  });

  test('gate on: a card build failure goes to next(err), so the client keeps the old widget', async () => {
    gateLive = true;
    buildYardCard.mockRejectedValue(new Error('plan lookup failed'));
    await expect(get({ customer: { city: 'Venice' } })).rejects.toThrow('plan lookup failed');
  });

  test('gate on: a scope lookup failure is an error, never an unscoped card', async () => {
    gateLive = true;
    scopeRejects = true;
    await expect(get({ customer: { city: 'Venice' } })).rejects.toThrow('db');
    expect(buildYardCard).not.toHaveBeenCalled();
  });
});
