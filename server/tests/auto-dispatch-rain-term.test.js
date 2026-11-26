// Rain term, shadow only (owner 2026-11-26, GATE_AUTO_DISPATCH_RAIN_TERM): the forecast read, the day wetness, the
// per-visit verdict with its two landing floors, and the proof that off mode reads nothing and shadow moves nothing.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/auto-dispatch/candidate-slots', () => ({
  DAY_OPEN: 8 * 60, DAY_CLOSE: 17 * 60, findValidCandidateSlots: jest.fn(),
}));
// The catalog read is faked (no database here); rainFitFor stays the real classifier.
jest.mock('../services/scheduling/rain-fit', () => ({
  ...jest.requireActual('../services/scheduling/rain-fit'),
  withCatalogKeys: jest.fn(async (items) => items.map((i) => (i.serviceKey ? i : i.name))),
}));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));

const candidateSlots = require('../services/auto-dispatch/candidate-slots');
const flexTier = require('../services/auto-dispatch/flex-tier');
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

const run = { runId: 'run9', today: TODAY, nowDate: NOW };

function visit(over = {}) {
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

const cand = (date, technician_id = 't1') => ({ date, technician_id, start_time: '09:00' });
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
    expect((await run1(wet, visit({ service_type: 'WaveGuard Assessment' }), flexGuard(visit()))).reason).toBe('not_outdoor');
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
