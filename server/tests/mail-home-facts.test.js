/**
 * The home facts reader (services/mail/home-facts.js) with every outside call injected: no network, no database. Which
 * facts decide the size, when the permit page is read and stored, the size limits, each missing fact, each failure, the
 * two five-in-a-row stops, the kill switch of the parcel map, the permit page's own switch, and the pace. Made-up rows.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  createFactsContext, readHomeFacts, factsSummary, factsProblems, arbitrate, firstMissing, LEFT,
  PARCEL_PAUSE_MS, PERMIT_GAP_MS, PAGE_RETRY_MS, MAX_FAILURES_IN_A_ROW,
} = require('../services/mail/home-facts');

const NOW = Date.parse('2026-11-22T15:00:00Z');
const HOUR = 60 * 60 * 1000;

let seq = 0;
const makeRow = () => { seq += 1; return { parcel_pin: `PIN${String(seq).padStart(7, '0')}`, permit_no: `PMT-${seq}` }; };
const permitOf = (row, extra = {}) => ({
  permit_no: row.permit_no, type_of_work: 'New Single Family', detail_status: 'ok', detail_fetched_at: new Date(NOW - 5 * HOUR),
  co_date: '2026-10-30', conditioned_sqft: 2100, stories: 2, ...extra,
});
const blankPermit = (row, extra = {}) => permitOf(row, { detail_status: null, detail_fetched_at: null, conditioned_sqft: null, stories: null, ...extra });
const fullParcel = (extra = {}) => ({ lotSqft: 8000, livingAreaSqft: 1800, stories: 1, ...extra });

function setup({ parcel = fullParcel(), ...over } = {}) {
  const flight = { now: 0, max: 0 };
  const track = (fn) => jest.fn(async (...args) => {
    flight.now += 1;
    flight.max = Math.max(flight.max, flight.now);
    try { return await fn(...args); } finally { flight.now -= 1; }
  });
  const deps = {
    lookupParcel: track(async () => { if (parcel instanceof Error) throw parcel; return parcel; }),
    fetchPermitPage: track(async () => ({ status: 'ok', facts: { conditioned_sqft: 2400, stories: 2 } })),
    createThrottle: jest.fn(() => (fn) => fn(Number.MAX_SAFE_INTEGER)),
    recordPermitResult: track(async () => undefined),
    permitPageOn: jest.fn(() => true),
    sleep: jest.fn(async () => undefined),
    ...over,
  };
  const ctx = createFactsContext({ deps, clock: () => NOW });
  return { deps, ctx, flight, read: (row, permit) => readHomeFacts(row, permit, ctx) };
}

describe('facts and the permit page', () => {
  test('the map alone is enough: no permit page is read or stored', async () => {
    const row = makeRow();
    const t = setup();
    expect(await t.read(row, blankPermit(row))).toEqual({
      facts: { homeSqft: 1800, homeSqftSource: 'parcel_map', stories: 1, lotSqft: 8000 }, missing: null,
    });
    expect(t.deps.fetchPermitPage).not.toHaveBeenCalled();
    expect(t.deps.recordPermitResult).not.toHaveBeenCalled();
    expect(t.deps.permitPageOn).not.toHaveBeenCalled();
    expect(t.deps.lookupParcel).toHaveBeenCalledWith(row.parcel_pin);
  });

  test('a stored permit fills the home size or the stories the map lacks (source: permit plan)', async () => {
    const [a, b] = [makeRow(), makeRow()];
    const noSize = setup({ parcel: fullParcel({ livingAreaSqft: null }) });
    expect((await noSize.read(a, permitOf(a))).facts).toEqual({ homeSqft: 2100, homeSqftSource: 'permit_plan', stories: 1, lotSqft: 8000 });
    const noStories = setup({ parcel: fullParcel({ stories: null }) });
    expect((await noStories.read(b, permitOf(b, { conditioned_sqft: 2600, stories: 1.5 }))).facts)
      .toEqual({ homeSqft: 1800, homeSqftSource: 'parcel_map', stories: 1.5, lotSqft: 8000 });
    expect(noSize.deps.fetchPermitPage).not.toHaveBeenCalled();
    expect(noStories.deps.fetchPermitPage).not.toHaveBeenCalled();
  });

  test('the permit page is read and stored when the map lacks a fact and the permit has none, and its facts are used', async () => {
    const row = makeRow();
    const permit = blankPermit(row);
    const t = setup({ parcel: fullParcel({ livingAreaSqft: null }) });
    const out = await t.read(row, permit);
    expect(t.deps.fetchPermitPage).toHaveBeenCalledTimes(1);
    const [no, options] = t.deps.fetchPermitPage.mock.calls[0];
    expect(no).toBe(row.permit_no);
    expect(typeof options.polite).toBe('function');
    // Stored through the reader's own recordResult, with the permit row as its candidate.
    expect(t.deps.recordPermitResult).toHaveBeenCalledWith(permit, 'ok', { conditioned_sqft: 2400, stories: 2 }, new Date(NOW));
    expect(out.facts).toMatchObject({ homeSqft: 2400, homeSqftSource: 'permit_plan', stories: 1 });
    expect(factsSummary(t.ctx)).toMatchObject({ permitPages: 1, permitFailuresInARow: 0 });
  });

  test('a page tried in the last 20 hours is not read again; one tried 20 hours ago or more is', async () => {
    const [recent, old] = [makeRow(), makeRow()];
    const stale = (row, ms) => blankPermit(row, { detail_status: 'not_found', detail_fetched_at: new Date(NOW - ms) });
    const t = setup({ parcel: fullParcel({ stories: null }) });
    expect(await t.read(recent, stale(recent, PAGE_RETRY_MS - 1000))).toMatchObject({ missing: 'no_stories' });
    expect(t.deps.fetchPermitPage).not.toHaveBeenCalled();
    expect(await t.read(old, stale(old, PAGE_RETRY_MS))).toMatchObject({ facts: { stories: 2 }, missing: null });
    expect(t.deps.fetchPermitPage.mock.calls.map(([no]) => no)).toEqual([old.permit_no]);
  });

  test('a page with no fields is stored, and the home is missing its fact', async () => {
    const row = makeRow();
    const permit = blankPermit(row);
    const t = setup({ parcel: fullParcel({ livingAreaSqft: null }), fetchPermitPage: jest.fn(async () => ({ status: 'no_fields', facts: null })) });
    expect(await t.read(row, permit)).toEqual({
      facts: { homeSqft: null, homeSqftSource: null, stories: 1, lotSqft: 8000 }, missing: 'no_home_size',
    });
    expect(t.deps.recordPermitResult).toHaveBeenCalledWith(permit, 'no_fields', null, new Date(NOW));
  });

  test('a result that cannot be stored is counted by code, the facts of the read are still used, and the run has a problem', async () => {
    const row = makeRow();
    const t = setup({
      parcel: fullParcel({ livingAreaSqft: null }),
      recordPermitResult: jest.fn(async () => { throw Object.assign(new Error('secret row text'), { code: 'ECONNRESET' }); }),
    });
    expect((await t.read(row, blankPermit(row))).facts.homeSqft).toBe(2400);
    expect(factsProblems(t.ctx)).toEqual(['1 permit page results could not be stored (ECONNRESET: 1)']);
  });
});

describe('arbitration and missing facts', () => {
  test('the map wins for size and stories; the permit fills only what the map lacks; the lot is the map\'s only', () => {
    const permit = { conditioned_sqft: 3300, stories: 3 };
    expect(arbitrate(fullParcel({ livingAreaSqft: 1700, stories: 2 }), permit)).toEqual({ homeSqft: 1700, homeSqftSource: 'parcel_map', stories: 2, lotSqft: 8000 });
    expect(arbitrate(fullParcel({ livingAreaSqft: null, stories: null, lotSqft: null }), permit))
      .toEqual({ homeSqft: 3300, homeSqftSource: 'permit_plan', stories: 3, lotSqft: null });
    expect(arbitrate(null, null)).toEqual({ homeSqft: null, homeSqftSource: null, stories: null, lotSqft: null });
  });

  test('a size no home has is a missing fact, never an input', () => {
    expect(arbitrate(fullParcel({ livingAreaSqft: 5e9, stories: 400, lotSqft: -4 }), { conditioned_sqft: 0, stories: 0 }))
      .toEqual({ homeSqft: null, homeSqftSource: null, stories: null, lotSqft: null });
    expect(arbitrate(fullParcel({ livingAreaSqft: 1799.6, stories: 1.54, lotSqft: 7999.5 }), null))
      .toEqual({ homeSqft: 1800, homeSqftSource: 'parcel_map', stories: 1.5, lotSqft: 8000 });
    expect(arbitrate(fullParcel({ livingAreaSqft: 0.2 }), null).homeSqft).toBeNull();
  });

  test('the first fact missing is named in the order size, stories, lot', () => {
    const full = { homeSqft: 1800, stories: 1, lotSqft: 8000 };
    expect(firstMissing({ homeSqft: null, stories: null, lotSqft: null })).toBe('no_home_size');
    expect(firstMissing({ ...full, homeSqft: null })).toBe('no_home_size');
    expect(firstMissing({ ...full, stories: null, lotSqft: null })).toBe('no_stories');
    expect(firstMissing({ ...full, lotSqft: null })).toBe('no_lot_size');
    expect(firstMissing(full)).toBeNull();
  });

  test('a home with no lot size is missing it even when the permit has size and stories', async () => {
    const row = makeRow();
    const t = setup({ parcel: fullParcel({ livingAreaSqft: null, stories: null, lotSqft: null }) });
    expect(await t.read(row, permitOf(row, { conditioned_sqft: 3300, stories: 3 }))).toEqual({
      facts: { homeSqft: 3300, homeSqftSource: 'permit_plan', stories: 3, lotSqft: null }, missing: 'no_lot_size',
    });
  });
});

describe('failures', () => {
  test('a parcel map that throws is a parcel_map failure with no facts', async () => {
    const row = makeRow();
    const t = setup({ parcel: new Error('timeout') });
    expect(await t.read(row, permitOf(row))).toEqual({ failed: 'parcel_map', facts: { homeSqft: null, homeSqftSource: null, stories: null, lotSqft: null } });
  });

  test('a permit page that throws is a permit_page failure that keeps the facts the map gave; nothing is stored for it', async () => {
    const row = makeRow();
    const t = setup({ parcel: fullParcel({ livingAreaSqft: null }), fetchPermitPage: jest.fn(async () => { throw new Error('ACA down'); }) });
    expect(await t.read(row, blankPermit(row))).toEqual({
      failed: 'permit_page', facts: { homeSqft: null, homeSqftSource: null, stories: 1, lotSqft: 8000 },
    });
    expect(t.deps.recordPermitResult).not.toHaveBeenCalled();
  });
});

describe('the stops', () => {
  const rowsOf = (n) => Array.from({ length: n }, () => makeRow());

  test('five parcel map failures in a row stop the map: later rows are left, and the run has a problem', async () => {
    const t = setup({ parcel: new Error('timeout') });
    const rows = rowsOf(7);
    const outs = [];
    for (const row of rows) outs.push(await t.read(row, permitOf(row)));
    expect(outs.map((o) => o.failed || (o === LEFT ? 'left' : 'other'))).toEqual([...Array(MAX_FAILURES_IN_A_ROW).fill('parcel_map'), 'left', 'left']);
    expect(t.deps.lookupParcel).toHaveBeenCalledTimes(5);
    expect(factsSummary(t.ctx)).toMatchObject({ mapQueries: 5, mapFailuresInARow: 5, mapStopped: true, mapDisabled: false });
    expect(factsProblems(t.ctx)).toEqual(['the parcel map did not answer (5 failures in a row)']);
  });

  test('an answer from the map starts the count again: four failures, one answer, four failures do not stop it', async () => {
    const answers = [0, 0, 0, 0, 1, 0, 0, 0, 0];
    const lookupParcel = jest.fn(async () => { if (answers.shift() === 0) throw new Error('timeout'); return fullParcel(); });
    const t = setup({ lookupParcel });
    for (let i = 0; i < 9; i += 1) { const row = makeRow(); await t.read(row, permitOf(row)); }
    expect(lookupParcel).toHaveBeenCalledTimes(9);
    expect(factsSummary(t.ctx)).toMatchObject({ mapStopped: false, mapFailuresInARow: 4 });
    expect(factsProblems(t.ctx)).toEqual([]);
  });

  test('five permit page failures in a row stop the page: rows that need it are left, rows that do not are read', async () => {
    const t = setup({ parcel: fullParcel({ livingAreaSqft: null }), fetchPermitPage: jest.fn(async () => { throw new Error('ACA down'); }) });
    const outs = [];
    for (let i = 0; i < 7; i += 1) { const row = makeRow(); outs.push(await t.read(row, blankPermit(row))); }
    expect(outs.map((o) => o.failed || (o === LEFT ? 'left' : 'other'))).toEqual([...Array(5).fill('permit_page'), 'left', 'left']);
    expect(t.deps.fetchPermitPage).toHaveBeenCalledTimes(5);
    expect(factsSummary(t.ctx)).toMatchObject({ permitStopped: true, permitFailuresInARow: 5, permitPageOff: false });
    expect(factsProblems(t.ctx)).toEqual(['the permit page did not answer (5 failures in a row)']);
    // A home the map sizes fully does not need the page, so the stop does not touch it.
    const full = setup();
    full.ctx.state.pageStopped = true;
    const row = makeRow();
    expect((await full.read(row, blankPermit(row))).missing).toBeNull();
  });

  test('a page that answers (even with no fields) starts the page count again', async () => {
    const answers = [new Error('x'), new Error('x'), new Error('x'), new Error('x'), { status: 'not_found', facts: null }, new Error('x'), new Error('x'), new Error('x'), new Error('x')];
    const fetchPermitPage = jest.fn(async () => { const next = answers.shift(); if (next instanceof Error) throw next; return next; });
    const t = setup({ parcel: fullParcel({ livingAreaSqft: null }), fetchPermitPage });
    for (let i = 0; i < 9; i += 1) { const row = makeRow(); await t.read(row, blankPermit(row)); }
    expect(fetchPermitPage).toHaveBeenCalledTimes(9);
    expect(factsSummary(t.ctx)).toMatchObject({ permitStopped: false, permitFailuresInARow: 4 });
  });

  test('the parcel map\'s kill switch stops the map at once: the row is left, not failed, and the run has a problem', async () => {
    const off = Object.assign(new Error('turned off'), { code: 'parcel_map_disabled' });
    const t = setup({ parcel: off });
    const [a, b] = [makeRow(), makeRow()];
    expect(await t.read(a, permitOf(a))).toBe(LEFT);
    expect(await t.read(b, permitOf(b))).toBe(LEFT);
    expect(t.deps.lookupParcel).toHaveBeenCalledTimes(1);
    expect(factsSummary(t.ctx)).toMatchObject({ mapStopped: true, mapDisabled: true });
    expect(factsProblems(t.ctx)).toEqual(['the parcel map is turned off (COUNTY_PARCEL_GIS_DISABLED)']);
  });

  test('the permit page\'s own switch (GATE_PERMIT_DETAIL_SYNC) off: no page is fetched, the page is stopped at once, rows that need it are left', async () => {
    const t = setup({ parcel: fullParcel({ livingAreaSqft: null }), permitPageOn: jest.fn(() => false) });
    const [a, b] = [makeRow(), makeRow()];
    expect(await t.read(a, blankPermit(a))).toBe(LEFT);
    expect(await t.read(b, blankPermit(b))).toBe(LEFT);
    expect(t.deps.permitPageOn).toHaveBeenCalledTimes(1);
    expect(t.deps.fetchPermitPage).not.toHaveBeenCalled();
    expect(factsSummary(t.ctx)).toMatchObject({ permitStopped: true, permitPageOff: true, permitPages: 0 });
    expect(factsProblems(t.ctx)).toEqual(['the permit page is turned off (GATE_PERMIT_DETAIL_SYNC)']);
    // Stored facts and a page tried within 20 hours need no fetch, so the switch is not read for them.
    const stored = setup({ parcel: fullParcel({ livingAreaSqft: null }), permitPageOn: jest.fn(() => false) });
    const c = makeRow();
    expect((await stored.read(c, permitOf(c))).facts.homeSqft).toBe(2100);
    expect(stored.deps.permitPageOn).not.toHaveBeenCalled();
  });

  test('the switch is read before each fetch: turned on again, the next run (a new context) reads pages', async () => {
    let on = false;
    const deps = { permitPageOn: jest.fn(() => on) };
    const first = setup({ parcel: fullParcel({ livingAreaSqft: null }), ...deps });
    const row = makeRow();
    expect(await first.read(row, blankPermit(row))).toBe(LEFT);
    on = true;
    const second = setup({ parcel: fullParcel({ livingAreaSqft: null }), ...deps });
    expect((await second.read(row, blankPermit(row))).facts.homeSqft).toBe(2400);
  });
});

describe('pace and defaults', () => {
  test('one call at a time, 0.6 s between map queries (none before the first), the permit throttle at a 2.5 s gap', async () => {
    const t = setup();
    for (let i = 0; i < 4; i += 1) { const row = makeRow(); await t.read(row, permitOf(row)); }
    expect(t.flight.max).toBe(1);
    expect(t.deps.sleep.mock.calls).toEqual([[PARCEL_PAUSE_MS], [PARCEL_PAUSE_MS], [PARCEL_PAUSE_MS]]);
    expect(PARCEL_PAUSE_MS).toBe(600);
    expect(t.deps.createThrottle).toHaveBeenCalledTimes(1);
    expect(t.deps.createThrottle.mock.calls[0][0]).toMatchObject({ gapMs: 2500, sleep: t.deps.sleep });
    expect(PERMIT_GAP_MS).toBe(2500);
  });

  test('the default wiring reads the portal\'s own switch for the permit site at call time', () => {
    const saved = process.env.GATE_PERMIT_DETAIL_SYNC;
    try {
      const ctx = createFactsContext({ clock: () => NOW });
      process.env.GATE_PERMIT_DETAIL_SYNC = 'true';
      expect(ctx.d.permitPageOn()).toBe(true);
      process.env.GATE_PERMIT_DETAIL_SYNC = 'false';
      expect(ctx.d.permitPageOn()).toBe(false);
      delete process.env.GATE_PERMIT_DETAIL_SYNC;
      expect(ctx.d.permitPageOn()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.GATE_PERMIT_DETAIL_SYNC; else process.env.GATE_PERMIT_DETAIL_SYNC = saved;
    }
  });

  test('the default parcel read treats the kill switch and an empty answer as failures it can tell apart', async () => {
    const gis = require('../services/property-lookup/county-parcel-gis');
    const disabled = jest.spyOn(gis, 'countyParcelGisDisabled');
    const lookup = jest.spyOn(gis, 'lookupCountyParcelAttributesById');
    try {
      const { d } = createFactsContext({ clock: () => NOW });
      disabled.mockReturnValue(true);
      await expect(d.lookupParcel('PIN0000001')).rejects.toMatchObject({ code: 'parcel_map_disabled' });
      expect(lookup).not.toHaveBeenCalled();
      disabled.mockReturnValue(false);
      lookup.mockResolvedValue(null);
      await expect(d.lookupParcel('PIN0000001')).rejects.toMatchObject({ code: 'parcel_map_no_answer' });
      lookup.mockResolvedValue({ lotSqft: 5000 });
      await expect(d.lookupParcel('PIN0000001')).resolves.toEqual({ lotSqft: 5000 });
      expect(lookup).toHaveBeenCalledWith('Manatee', 'PIN0000001');
    } finally {
      disabled.mockRestore();
      lookup.mockRestore();
    }
  });

  test('nothing but counts and codes is reported: no parcel number or permit number in the summary or the problems', async () => {
    const t = setup({ parcel: Object.assign(new Error('PIN0000099 PMT-99'), { code: 'ETIMEDOUT' }) });
    for (let i = 0; i < 6; i += 1) { const row = makeRow(); await t.read(row, permitOf(row)); }
    const text = JSON.stringify([factsSummary(t.ctx), factsProblems(t.ctx)]);
    expect(text).not.toMatch(/PIN|PMT/);
  });
});
