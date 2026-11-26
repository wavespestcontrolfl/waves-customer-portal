// Rain term, shadow only (owner 2026-11-26, GATE_AUTO_DISPATCH_RAIN_TERM): the forecast read, the day wetness, the
// per-visit verdict with its two landing floors, and the proof that off mode reads nothing and shadow moves nothing.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/auto-dispatch/candidate-slots', () => ({
  DAY_OPEN: 8 * 60, DAY_CLOSE: 17 * 60, findValidCandidateSlots: jest.fn(),
  // The writer's own read-only occupancy probe: keeps the slots it is given unless a test says taken.
  _internals: { filterAndScoreSharedModelCandidates: jest.fn(async (_svc, _geo, slots) => slots) },
}));
// The visit's stored services read is faked (no database here); rainFitFor stays the real classifier.
let mockCurrentType = 'Pest Control Service';
jest.mock('../services/scheduling/rain-fit', () => ({
  ...jest.requireActual('../services/scheduling/rain-fit'),
  storedVisitServices: jest.fn(async () => ({ own: [{ name: mockCurrentType, key: '' }], siblings: [], span: null })),
  withCatalogKeys: jest.fn(async (items) => items.map((i) => i.name)),
}));
// A shadow never calls apply.js (its grouped-move guard writes): every export is a spy the tests expect untouched.
jest.mock('../services/auto-dispatch/apply', () => ({
  previewGroupMove: jest.fn(), applyAutoDispatchMove: jest.fn(), makeMemberGuard: jest.fn(), makeMoveGuard: jest.fn(),
  unitMoveSize: jest.fn(), revalidatePlacement: jest.fn(),
}));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));

const candidateSlots = require('../services/auto-dispatch/candidate-slots');
const db = require('../models/db');
const flexTier = require('../services/auto-dispatch/flex-tier');
const apply = require('../services/auto-dispatch/apply');
const rainFit = require('../services/scheduling/rain-fit');
const rainTerm = require('../services/auto-dispatch/rain-term');
const { ZONE_COORDS } = require('../services/scheduling/forecast-zones');
const { recordAuditEvent } = require('../services/audit-log');
const gates = require('../config/feature-gates');

const TODAY = '2026-11-26';
const NOW = new Date('2026-11-26T09:10:00Z'); // 4:10 AM ET
const VISIT_DATE = '2026-11-29'; // 3 days out
const ENV = 'GATE_AUTO_DISPATCH_RAIN_TERM';

// Every hour of the given days, with the chance of rain per day.
function hoursFor(popByDay) {
  const out = [];
  for (const [day, pop] of Object.entries(popByDay)) {
    for (let h = 0; h < 24; h++) {
      out.push({ startTime: `${day}T${String(h).padStart(2, '0')}:00:00-05:00`, rainChance: pop });
    }
  }
  return out;
}

const WET_DAYS = {
  '2026-11-29': 90, '2026-11-30': 10, '2026-12-01': 85, '2026-12-02': 10,
};

const run = {
  runId: 'run9', today: TODAY, nowDate: NOW, config: { guardMode: 'flex' }, lockBoundary: '2026-11-28',
};

function visit(over = {}) {
  mockCurrentType = over.service_type || 'Pest Control Service';
  return {
    id: 'v1', scheduled_date: VISIT_DATE, technician_id: 't1', zone: 'sarasota', service_type: 'Pest Control Service', ...over,
  };
}

function flexGuard(service) {
  const neighbors = {};
  const window = flexTier.flexTierMoveWindow({
    origDate: service.scheduled_date, anchorDate: service.scheduled_date, today: TODAY, neighbors, radiusDays: 5,
  });
  return { window, meta: { mode: 'flex', anchor: service.scheduled_date, neighbors, radius_days: 5, window } };
}

const cand = (date, technician_id = 't1', start_time = '09:00') => ({
  date, technician_id, start_time, end_time: '10:00',
});
const freshEval = () => ({ kind: 'no_change', audit: { constraints: { lock_boundary: '2026-11-28' } } });

async function stateWith(read) {
  process.env[ENV] = 'shadow';
  return rainTerm.start(run, { read });
}

let prevEnv;
beforeEach(() => {
  jest.clearAllMocks();
  prevEnv = process.env[ENV];
  delete process.env[ENV];
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env[ENV]; else process.env[ENV] = prevEnv;
});

describe('mode', () => {
  test.each([[undefined], ['true'], ['false'], ['on'], [' shadow'], ['SHADOW']])('%p is off: no forecast call, no state', async (value) => {
    if (value !== undefined) process.env[ENV] = value;
    const read = jest.fn();
    expect(gates.autoDispatchRainTermMode()).toBe('off');
    expect(await rainTerm.start(run, { read })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  test('exactly shadow records', () => {
    process.env[ENV] = 'shadow';
    expect(gates.autoDispatchRainTermMode()).toBe('shadow');
  });

  test('off: the hook touches nothing and finish writes nothing', async () => {
    const evalResult = freshEval();
    const before = JSON.stringify(evalResult);
    await rainTerm.note(null, { service: visit(), evalResult, run });
    expect(JSON.stringify(evalResult)).toBe(before);
    expect(await rainTerm.finish(null, run)).toBeNull();
    expect(recordAuditEvent).not.toHaveBeenCalled();
    expect(rainTerm.kept(evalResult)).toEqual({});
  });
});

describe('forecast read', () => {
  test('one free read per area, 10 s wait, one retry, unread areas listed', async () => {
    const calls = [];
    const read = jest.fn(async (lat, lng, opts) => {
      calls.push({ lat, lng, opts });
      if (lat === ZONE_COORDS.palmetto.lat) return null;
      return hoursFor(WET_DAYS);
    });
    const state = await stateWith(read);
    expect(state.unread).toEqual(['palmetto']);
    expect([...state.forecast.keys()].sort()).toEqual(Object.keys(ZONE_COORDS).filter((z) => z !== 'palmetto').sort());
    // Six areas, one extra try for the area that did not answer.
    expect(read).toHaveBeenCalledTimes(Object.keys(ZONE_COORDS).length + 1);
    expect(calls.every((c) => c.opts.fetchTimeoutMs === 10000)).toBe(true);
    expect([...state.forecast.get('sarasota').keys()]).toEqual(['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
  });

  test('a read that throws leaves the area unread and never throws', async () => {
    const state = await stateWith(async () => { throw new Error('nws down'); });
    expect(state.unread.length).toBe(Object.keys(ZONE_COORDS).length);
    expect(state.forecast.size).toBe(0);
  });

  test('day wetness: the work-hour mean of clamp((chance - 30) / 50)', () => {
    expect(rainTerm.dayWetness(hoursFor({ [VISIT_DATE]: 90 }), VISIT_DATE)).toBe(1);
    expect(rainTerm.dayWetness(hoursFor({ [VISIT_DATE]: 30 }), VISIT_DATE)).toBe(0);
    expect(rainTerm.dayWetness(hoursFor({ [VISIT_DATE]: 55 }), VISIT_DATE)).toBeCloseTo(0.5, 5);
    // A day with no hours is unread, not dry.
    expect(rainTerm.dayWetness(hoursFor({ '2026-11-30': 90 }), VISIT_DATE)).toBeNull();
    expect(rainTerm.dayWetness(null, VISIT_DATE)).toBeNull();
    // Hours outside the work day do not count: rain at night only is a dry day.
    const nightOnly = hoursFor({ [VISIT_DATE]: 0 }).map((h) => (Number(h.startTime.slice(11, 13)) < 8 ? { ...h, rainChance: 100 } : h));
    expect(rainTerm.dayWetness(nightOnly, VISIT_DATE)).toBe(0);
  });
});

describe('per-visit verdict', () => {
  const allWet = async () => stateWith(async () => hoursFor(WET_DAYS));

  test('a wet outdoor day with a drier free slot: both floors recorded, nothing else changes', async () => {
    const state = await allWet();
    const service = visit();
    const guard = flexGuard(service);
    // 11-30 lands only under the 73-hour floor; 12-02 lands under both. A slot with another technician is ignored.
    candidateSlots.findValidCandidateSlots.mockResolvedValue({
      candidates: [cand('2026-11-30'), cand('2026-12-02'), cand('2026-11-30', 't2'), cand('2026-12-01')],
    });
    const evalResult = freshEval();
    await rainTerm.note(state, {
      service, prefs: {}, ctx: { tierMeta: guard.meta }, guard, evalResult, run,
    });
    const row = evalResult.audit.constraints.rain_term;
    expect(row).toMatchObject({
      mode: 'shadow', area: 'sarasota', lead_days: 3, would_move: true, would_move_73h: true, reason: 'drier_date_found',
    });
    expect(row.current).toMatchObject({ date: VISIT_DATE, wetness: 1, score: 1 });
    expect(row.best_5day).toMatchObject({ date: '2026-12-02', wetness: 0 });
    expect(row.best_73h).toMatchObject({ date: '2026-11-30', wetness: 0 });
    // The rest of the audit is as the run left it.
    expect(evalResult.audit.constraints.lock_boundary).toBe('2026-11-28');
    expect(evalResult.kind).toBe('no_change');
  });

  test('a date only the 73-hour floor allows: would_move stays false', async () => {
    const state = await allWet();
    const service = visit();
    const guard = flexGuard(service);
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ candidates: [cand('2026-11-30')] });
    const evalResult = freshEval();
    await rainTerm.note(state, {
      service, prefs: {}, ctx: {}, guard, evalResult, run,
    });
    const row = evalResult.audit.constraints.rain_term;
    expect(row).toMatchObject({
      would_move: false, would_move_73h: true, best_5day: null, reason: 'drier_date_only_with_73h_floor',
    });
    expect(row.best_73h.date).toBe('2026-11-30');
    expect(state.counts.would_move_73h_only).toBe(1);
  });

  test('a date that is wet too is no answer', async () => {
    const state = await allWet();
    const service = visit();
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ candidates: [cand('2026-12-01')] });
    const evalResult = freshEval();
    await rainTerm.note(state, {
      service, prefs: {}, ctx: {}, guard: flexGuard(service), evalResult, run,
    });
    expect(evalResult.audit.constraints.rain_term).toMatchObject({ would_move: false, best_5day: null, best_73h: null, reason: 'no_drier_date' });
  });

  test('the drier-date search runs with the arrival search on, no road reader, and the run ctx untouched', async () => {
    const state = await allWet();
    const service = visit();
    const guard = flexGuard(service);
    const ctx = { arrivalSearch: false, roadTravel: { lookup: jest.fn() }, tierWindow: guard.window, tierMeta: guard.meta };
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ candidates: [] });
    await rainTerm.note(state, {
      service, prefs: { p: 1 }, ctx, guard, evalResult: freshEval(), run,
    });
    expect(candidateSlots.findValidCandidateSlots).toHaveBeenCalledTimes(1);
    const [, prefsArg, searchCtx] = candidateSlots.findValidCandidateSlots.mock.calls[0];
    expect(prefsArg).toEqual({ p: 1 });
    expect(searchCtx.arrivalSearch).toBe(true);
    expect(searchCtx.roadTravel).toBeNull();
    // The 73-hour window starts before the run's own 5-day window does.
    expect(searchCtx.tierWindow.dateTo).toBe(guard.window.dateTo);
    expect((searchCtx.tierWindow.dayMoveFrom || searchCtx.tierWindow.dateFrom) < guard.window.dayMoveFrom).toBe(true);
    expect(ctx.arrivalSearch).toBe(false);
    expect(ctx.roadTravel).not.toBeNull();
    expect(ctx.tierWindow).toBe(guard.window);
  });

  test.each([
    ['out of range', { scheduled_date: '2026-12-05' }, null],
    ['too soon', { scheduled_date: '2026-11-28' }, null],
  ])('%s: no row, no search', async (_name, over) => {
    const state = await allWet();
    const evalResult = freshEval();
    await rainTerm.note(state, {
      service: visit(over), prefs: {}, ctx: {}, guard: null, evalResult, run,
    });
    expect(evalResult.audit.constraints.rain_term).toBeUndefined();
    expect(candidateSlots.findValidCandidateSlots).not.toHaveBeenCalled();
    expect(state.counts.out_of_range).toBe(1);
  });

  test('a dry day, an indoor visit, an unread area and a visit with no band each say why and search nothing', async () => {
    const dry = await stateWith(async () => hoursFor({ ...WET_DAYS, [VISIT_DATE]: 20 }));
    const wet = await allWet();
    const unread = await stateWith(async () => null);
    const run1 = async (state, service, guard) => {
      const evalResult = freshEval();
      await rainTerm.note(state, {
        service, prefs: {}, ctx: {}, guard, evalResult, run,
      });
      return evalResult.audit.constraints.rain_term;
    };
    expect((await run1(dry, visit(), flexGuard(visit()))).reason).toBe('dry_enough');
    const assessment = visit({ service_type: 'WaveGuard Assessment' });
    expect((await run1(wet, assessment, flexGuard(assessment))).reason).toBe('not_outdoor');
    expect((await run1(unread, visit(), flexGuard(visit()))).reason).toBe('no_forecast');
    expect((await run1(wet, visit(), { window: null, meta: null })).reason).toBe('no_flex_band');
    // A stop no forecast rule places has no area (forecast-zones.js stopForecastZone).
    expect((await run1(wet, visit({ zone: null, customer_city: 'Nowhere', customer_zip: '00000' }), flexGuard(visit()))).reason).toBe('no_forecast_area');
    expect(candidateSlots.findValidCandidateSlots).not.toHaveBeenCalled();
  });

  test('a day 6 visit never triggers: the lead trust keeps its score under the bar', async () => {
    const state = await stateWith(async () => hoursFor({ '2026-12-02': 100 }));
    const evalResult = freshEval();
    await rainTerm.note(state, {
      service: visit({ scheduled_date: '2026-12-02' }), prefs: {}, ctx: {}, guard: flexGuard(visit({ scheduled_date: '2026-12-02' })), evalResult, run,
    });
    expect(evalResult.audit.constraints.rain_term).toMatchObject({ reason: 'dry_enough', lead_days: 6, current: { wetness: 1, score: 0.25 } });
  });

  test('the search budget stops the searches, and a search error is recorded without throwing', async () => {
    const state = await allWet();
    state.searches = rainTerm.MAX_SEARCHES_PER_RUN;
    const service = visit();
    const capped = freshEval();
    await rainTerm.note(state, {
      service, prefs: {}, ctx: {}, guard: flexGuard(service), evalResult: capped, run,
    });
    expect(capped.audit.constraints.rain_term.reason).toBe('search_budget');
    state.searches = 0;
    candidateSlots.findValidCandidateSlots.mockRejectedValue(Object.assign(new Error('boom'), { code: 'X1' }));
    const broke = freshEval();
    await rainTerm.note(state, {
      service, prefs: {}, ctx: {}, guard: flexGuard(service), evalResult: broke, run,
    });
    expect(broke.audit.constraints.rain_term).toMatchObject({ reason: 'error', error: 'X1', would_move: false });
    expect(state.counts.errors).toBe(1);
  });

  test('the run summary lists counts and unread areas; carry keeps the pass-1 row on the pass-2 re-evaluation', async () => {
    const state = await stateWith(async (lat) => (lat === ZONE_COORDS.palmetto.lat ? null : hoursFor(WET_DAYS)));
    const service = visit();
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ candidates: [cand('2026-12-02')] });
    const pass1 = freshEval();
    await rainTerm.note(state, {
      service, prefs: {}, ctx: {}, guard: flexGuard(service), evalResult: pass1, run,
    });
    const pass2 = { kind: 'move', audit: { constraints: { threshold: 15 } } };
    rainTerm.carry({ audit: pass1.audit }, pass2);
    expect(pass2.audit.constraints).toMatchObject({ threshold: 15, rain_term: { would_move: true } });
    expect(rainTerm.kept(pass2)).toEqual({ rain_term: pass1.audit.constraints.rain_term });
    const summary = await rainTerm.finish(state, run);
    expect(summary).toMatchObject({
      mode: 'shadow', in_range: 1, searches: 1, unread_areas: ['palmetto'], drier_date_found: 1,
    });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'auto_dispatch.rain_term_shadow', resource_id: 'run9', metadata: expect.objectContaining({ in_range: 1 }),
    }));
  });
});

describe('review fixes (Codex pre-push)', () => {
  const allWet = async () => stateWith(async () => hoursFor(WET_DAYS));
  const noteVisit = async (state, service, over = {}) => {
    const evalResult = freshEval();
    await rainTerm.note(state, {
      service, prefs: { p: 1 }, ctx: {}, guard: flexGuard(service), evalResult, run, ...over,
    });
    return evalResult.audit.constraints.rain_term;
  };

  test('the whole visit is classified: add-ons and live siblings count, read by the move screens\' own reader', async () => {
    const state = await allWet();
    // The visit's own service is rain-OK, a sibling on the same stop is a spray: the stop is outdoor.
    rainFit.storedVisitServices.mockResolvedValueOnce({
      own: [{ name: 'WaveGuard Assessment', key: '' }], siblings: [{ name: 'Exterior Pest Spray', key: '' }], span: null,
    });
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ candidates: [cand('2026-12-02')] });
    const row = await noteVisit(state, visit({ service_type: 'WaveGuard Assessment' }));
    expect(row.reason).toBe('drier_date_found');
    expect(rainFit.storedVisitServices).toHaveBeenCalledWith('v1', { moveAlone: false }, expect.anything());
    // Every service rain-OK: not outdoor.
    rainFit.storedVisitServices.mockResolvedValueOnce({
      own: [{ name: 'WaveGuard Assessment', key: '' }], siblings: [{ name: 'Interior Inspection', key: '' }], span: null,
    });
    expect((await noteVisit(state, visit({ service_type: 'WaveGuard Assessment' }))).reason).toBe('not_outdoor');
  });

  test('a service list that cannot be read in full is an error, never not_outdoor', async () => {
    const state = await allWet();
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ candidates: [cand('2026-12-02')] });
    rainFit.storedVisitServices.mockResolvedValueOnce(null);
    expect(await noteVisit(state, visit({ service_type: 'WaveGuard Assessment' }))).toMatchObject({ reason: 'error', would_move: false, error: 'SERVICES_UNREAD' });
    // A failed catalog read (strict) is an error too.
    rainFit.withCatalogKeys.mockRejectedValueOnce(new Error('catalog down'));
    expect((await noteVisit(state, visit())).reason).toBe('error');
    expect(rainFit.withCatalogKeys).toHaveBeenLastCalledWith(expect.any(Array), expect.anything(), { strict: true });
    expect(candidateSlots.findValidCandidateSlots).not.toHaveBeenCalled();
  });

  test('the writer\'s occupancy probe vets the slot: a taken slot is skipped, an unreadable probe leaves a candidate only', async () => {
    const state = await allWet();
    const probe = candidateSlots._internals.filterAndScoreSharedModelCandidates;
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ candidates: [cand('2026-11-30'), cand('2026-12-02')] });
    // 12-02 is taken: the 5-day answer is none, and the 73-hour answer is the 11-30 slot.
    probe.mockImplementation(async (_svc, _geo, slots) => slots.filter((slot) => slot.date !== '2026-12-02'));
    const taken = await noteVisit(state, visit());
    expect(taken.best_5day).toBeNull();
    expect(taken.best_73h).toMatchObject({ date: '2026-11-30' });
    const [asked, , slotsAsked, , drops] = probe.mock.calls[0];
    expect(asked.id).toBe('v1');
    expect(slotsAsked).toEqual([expect.objectContaining({ date: '2026-12-02' })]);
    expect(drops).toBeNull();
    // An unreadable probe: unverified, nothing would move, the slot is kept as a candidate.
    probe.mockRejectedValue(new Error('probe read failed'));
    const unread = await noteVisit(state, visit());
    expect(unread).toMatchObject({
      would_move: false, would_move_73h: false, best_5day: null, best_73h: null, reason: 'occupancy_unverified', candidate: { floor: '5day', date: '2026-12-02' },
    });
    // With the shared model on, the search already ran the probe on every slot: it is not asked again.
    probe.mockClear();
    process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true';
    try {
      expect(gates.autoDispatchSharedModelLive()).toBe(true);
      expect((await noteVisit(state, visit())).would_move).toBe(true);
      expect(probe).not.toHaveBeenCalled();
    } finally {
      delete process.env.GATE_AUTO_DISPATCH_SHARED_MODEL;
    }
    probe.mockReset().mockImplementation(async (_svc, _geo, slots) => slots);
  });

  test('options compare and sort on full-precision values; only the audit fields are rounded', () => {
    const wetByDate = new Map([['2026-11-30', 0.186286], ['2026-12-01', 0.099]]);
    const slots = [cand('2026-11-30'), cand('2026-12-01')];
    const band = { dateFrom: '2026-11-29', dateTo: '2026-12-04' };
    const options = rainTerm._test.drierOptions(slots, {
      service: visit(), band, run, currentWet: 1, wetByDate,
    });
    // Both read 0.22 once rounded, and 11-30 is nearer the visit's date; at full precision 12-01 is drier.
    expect(options.map((o) => o.date)).toEqual(['2026-12-01', '2026-11-30']);
    expect(options[0].expected).toBeLessThan(options[1].expected);
  });

  // The row is for a visit whose stop has another live member.
  const groupedDb = (other) => db.mockImplementation(() => {
    const chain = {
      where: (arg) => { if (typeof arg === 'function') arg({ whereNull: () => ({ orWhereNotIn: () => {} }) }); return chain; },
      whereNot: () => chain,
      first: async () => other,
    };
    return chain;
  });

  test('a visit that moves with others records its best slot as a candidate only: nothing would move, apply.js is never called', async () => {
    const state = await allWet();
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ candidates: [cand('2026-11-30'), cand('2026-12-02')] });
    groupedDb({ id: 'sibling' });
    const row = await noteVisit(state, visit({ visit_id: 'vis1' }));
    expect(row).toMatchObject({
      would_move: false, would_move_73h: false, best_5day: null, best_73h: null, reason: 'grouped_unverified',
      candidate: { floor: '5day', date: '2026-12-02', start_time: '09:00' },
    });
    // A visit with a visit_id and no other live member is ungrouped: answered as before.
    groupedDb(undefined);
    expect(await noteVisit(state, visit({ visit_id: 'vis1' }))).toMatchObject({ would_move: true, reason: 'drier_date_found' });
    // An unreadable group fails closed to grouped.
    db.mockImplementation(() => { throw new Error('read failed'); });
    expect((await noteVisit(state, visit({ visit_id: 'vis1' }))).reason).toBe('grouped_unverified');
    db.mockReset();
    // Whatever happened, rain-term never touched apply.js (its group guard writes).
    for (const fn of Object.values(apply)) expect(fn).not.toHaveBeenCalled();
    expect(require('fs').readFileSync(require.resolve('../services/auto-dispatch/rain-term'), 'utf8')).not.toMatch(/previewGroupMove\(|require\('\.\/apply'\)/);
  });

  test('the 73-hour answer falls back to the verified 5-day slot when it starts 73 hours out', async () => {
    const state = await allWet();
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ candidates: [cand('2026-12-02')] });
    const row = await noteVisit(state, visit());
    expect(row.best_5day).toMatchObject({ date: '2026-12-02' });
    expect(row.best_73h).toMatchObject({ date: '2026-12-02' });
    expect(row.would_move_73h).toBe(true);
  });

  test('the search keeps the visit\'s technician at generation and lifts the legacy cap; a full list is uncertain, not "none"', async () => {
    const state = await allWet();
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ candidates: [] });
    await noteVisit(state, visit());
    const searchCtx = candidateSlots.findValidCandidateSlots.mock.calls[0][2];
    expect(searchCtx.keepTech).toBe(true);
    expect(searchCtx.scoreCap).toBeGreaterThan(80);
    // An unassigned visit searches every technician.
    candidateSlots.findValidCandidateSlots.mockClear();
    await noteVisit(state, visit({ technician_id: null }));
    expect(candidateSlots.findValidCandidateSlots.mock.calls[0][2].keepTech).toBeUndefined();
    // A list as long as the cap may have been cut: no answer is not "no drier date".
    candidateSlots.findValidCandidateSlots.mockResolvedValue({
      candidates: Array.from({ length: searchCtx.scoreCap }, () => cand('2026-11-29', 't1')),
    });
    expect((await noteVisit(state, visit())).reason).toBe('uncertain_capped');
  });

  test('73-hour floor: the boundary date stays, and each slot starts 73 hours or more from now', async () => {
    // 10:00 AM ET Nov 26: 73 hours out is 11:00 AM Nov 29. The visit is on Nov 30 and Nov 29 is dry.
    const later = { ...run, nowDate: new Date('2026-11-26T15:00:00Z') };
    const state = await stateWith(async () => hoursFor({
      '2026-11-29': 10, '2026-11-30': 90, '2026-12-01': 90, '2026-12-02': 90,
    }));
    const service = visit({ scheduled_date: '2026-11-30' });
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ candidates: [cand('2026-11-29', 't1', '08:00'), cand('2026-11-29', 't1', '12:00')] });
    const evalResult = freshEval();
    await rainTerm.note(state, {
      service, prefs: {}, ctx: {}, guard: flexGuard(service), evalResult, run: later,
    });
    const row = evalResult.audit.constraints.rain_term;
    expect(row.best_73h).toMatchObject({ date: '2026-11-29', start_time: '12:00' });
    expect(row.best_5day).toBeNull();
    // Only an early slot on the boundary date: it starts before the floor, so no 73-hour answer.
    candidateSlots.findValidCandidateSlots.mockResolvedValue({ candidates: [cand('2026-11-29', 't1', '08:00')] });
    const early = freshEval();
    await rainTerm.note(state, {
      service, prefs: {}, ctx: {}, guard: flexGuard(service), evalResult: early, run: later,
    });
    expect(early.audit.constraints.rain_term).toMatchObject({ best_73h: null, reason: 'no_drier_date' });
  });
});

describe('no paid road call', () => {
  // The slot finder's travel source with the allowance find-time gives providerTravel:false (maxRequests 0).
  test('createSchedulingTravel({ maxRequests: 0 }).preload never sends a request', async () => {
    const prev = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = 'test-key';
    try {
      const fetchImpl = jest.fn();
      const travel = require('../services/route-optimizer').createSchedulingTravel({ maxRequests: 0, fetchImpl });
      const leg = {
        from: { lat: 27.5, lng: -82.5 }, to: { lat: 27.4, lng: -82.4 }, date: '2099-01-05', departureMin: 600,
      };
      await travel.preload([leg]);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(travel.lookup(leg).source).toBe('conservative_model');
    } finally {
      if (prev === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prev;
    }
  });
});
