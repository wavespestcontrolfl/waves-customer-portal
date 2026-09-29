jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => sql);
  mock.transaction = jest.fn(async (cb) => cb(mock));
  return mock;
});
// Default OFF so the existing limiter test still sees the dark-gate 400;
// the cross-sell click tests turn it on for themselves.
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/service-report/cross-sell', () => ({ buildReportCrossSell: jest.fn() }));
jest.mock('../services/service-report/click-estimate-mint', () => ({ mintReportClickEstimate: jest.fn() }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn().mockResolvedValue(null) }));
jest.mock('../config', () => ({
  s3: { bucket: 'test-bucket', region: 'us-east-1' },
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({})),
  GetObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));
jest.mock('../services/pest-pressure/orchestrate', () => ({
  runAndSwallowErrors: jest.fn().mockResolvedValue(null),
  calculateAndPersistForServiceRecord: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/pest-pressure/store', () => ({
  loadActiveConfig: jest.fn(),
  loadScoreForServiceRecord: jest.fn(),
  loadHistoryForCustomer: jest.fn().mockResolvedValue([]),
}));


// Pest report expectations (GATE_PEST_REPORT_EXPECTATIONS): a PDF/static
// render must never bake a still-accumulating trailing 7-day rain window
// into a permanently cached document. application-conditions.js stamps
// every week-weather result with `windowClosed` (true once the window ends
// before today, ET). The live page may show an unsettled reading; every
// other render gets NO weekWeather while the window is open, so the rain
// block is absent rather than frozen on a number that later changes.
const fs = require('fs');
const path = require('path');
const { settledWeekWeatherForRender } = require('../routes/reports-public');

const SETTLED = { rainInches: 0.6, rainConfidence: 'high', et0Inches: null, dailyRain: null, rainSource: 'open-meteo', windowClosed: true };
const UNSETTLED = { ...SETTLED, rainInches: 0.2, windowClosed: false };

describe('settledWeekWeatherForRender', () => {
  test('live view keeps a settled week but drops an open one (codex P2 round 5: an open window is a forecast, not a measurement)', () => {
    expect(settledWeekWeatherForRender(SETTLED, 'live')).toBe(SETTLED);
    expect(settledWeekWeatherForRender(UNSETTLED, 'live')).toBeNull();
  });

  test('a PDF/static render keeps a settled week', () => {
    expect(settledWeekWeatherForRender(SETTLED, 'pdf')).toBe(SETTLED);
    expect(settledWeekWeatherForRender(SETTLED, 'static')).toBe(SETTLED);
  });

  test('a PDF/static render drops an unsettled week entirely (no rain-derived bytes cached)', () => {
    expect(settledWeekWeatherForRender(UNSETTLED, 'pdf')).toBeNull();
    expect(settledWeekWeatherForRender(UNSETTLED, 'static')).toBeNull();
  });

  test('a result without the windowClosed stamp is treated as unsettled off the live page (fail closed)', () => {
    const { windowClosed, ...unstamped } = SETTLED;
    expect(settledWeekWeatherForRender(unstamped, 'pdf')).toBeNull();
    expect(settledWeekWeatherForRender(null, 'pdf')).toBeNull();
    expect(settledWeekWeatherForRender(undefined, 'live')).toBeNull();
  });

  test('the v1 response builder routes the resolved week through the settle check before buildPestReportV2', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'reports-public.js'), 'utf8');
    // codex P1 2026-09-29 round 3: weekWeather now comes from
    // expectationFactsOut.weekWeather — the pinned value report-data.js's
    // buildReportV1Data already resolved — never a separate fetch here.
    expect(source).toMatch(/const weekWeather = settledWeekWeatherForRender\(expectationFactsOut\.weekWeather \?\? null, mode\);[\s\S]{0,900}buildPestReportV2\(\{/);
  });
});

// codex P1 2026-09-29 round 3 (pre-push audit on round 2's own P2 fix): a
// preflight fetch racing its own deadline in ONE process invocation cannot
// know what the browser's own, INDEPENDENT live /data fetch — a SEPARATE
// invocation — will resolve moments later. A successful preflight followed
// by a browser-side timeout would cache a PDF (under the stable pest-line
// key) that disagrees with what the browser actually rendered.
//
// Fixed the same way the lawn water balance already solves this: FREEZE
// the settled answer onto service_records.structured_notes.pestWeekWeather
// (first-writer-wins), inside buildReportV1Data itself — the ONE canonical
// resolution every caller (the direct PDF route, pdf-queue.js, and the
// browser's own live /data fetch) shares. There is no separate preflight
// fetch left to disagree with the render.
describe('resolvePestWeekWeather / resolvePestWeekWeatherForBuild — the pin (report-data.js)', () => {
  const ORIGINAL_GATE = process.env.GATE_PEST_REPORT_EXPECTATIONS;
  const GEOCODED = {
    id: 'svc-pest-1',
    service_line: 'pest',
    customer_latitude: 27.4,
    customer_longitude: -82.5,
    service_date: '2026-07-16',
    structured_notes: {},
  };

  function toCoordinateStub(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  // Same knex-stub shape as lawn-week-weather-freeze.test.js's makeKnex —
  // `stored` is what a read-back finds when this writer LOSES the
  // conditional update.
  function makePestKnex({ matched = 1, stored = null } = {}) {
    const state = { wheres: [], raws: [], patches: [], reads: 0 };
    const knex = jest.fn((table) => {
      expect(table).toBe('service_records');
      const chain = {
        where: jest.fn((c) => { state.wheres.push(c); return chain; }),
        whereRaw: jest.fn((sql) => { state.raws.push(sql); return chain; }),
        update: jest.fn(async (patch) => { state.patches.push(patch); return matched; }),
        first: jest.fn(async () => {
          state.reads += 1;
          return stored ? { structured_notes: { pestWeekWeather: stored } } : { structured_notes: {} };
        }),
      };
      return chain;
    });
    knex.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
    return { knex, state };
  }

  function mockWeekWeather(impl) {
    jest.doMock('../services/service-report/application-conditions', () => ({
      toCoordinate: toCoordinateStub,
      fetchServiceWeekWeather: impl,
    }));
  }

  beforeEach(() => {
    process.env.GATE_PEST_REPORT_EXPECTATIONS = 'true';
    jest.resetModules();
  });
  afterEach(() => {
    process.env.GATE_PEST_REPORT_EXPECTATIONS = ORIGINAL_GATE;
    jest.dontMock('../services/service-report/application-conditions');
  });

  test('gate off: the resolver never fetches or writes', async () => {
    process.env.GATE_PEST_REPORT_EXPECTATIONS = 'false';
    const fetchServiceWeekWeather = jest.fn();
    mockWeekWeather(fetchServiceWeekWeather);
    const { resolvePestWeekWeather } = require('../services/service-report/report-data');
    const { knex, state } = makePestKnex();
    await expect(resolvePestWeekWeather(GEOCODED, 'pest', knex)).resolves.toEqual({ weekWeather: null, uncacheable: false, reason: null });
    expect(fetchServiceWeekWeather).not.toHaveBeenCalled();
    expect(state.patches).toHaveLength(0);
  });

  test('non-pest line: never fetches, even with the gate on', async () => {
    const fetchServiceWeekWeather = jest.fn();
    mockWeekWeather(fetchServiceWeekWeather);
    const { resolvePestWeekWeather } = require('../services/service-report/report-data');
    const { knex } = makePestKnex();
    await expect(resolvePestWeekWeather(GEOCODED, 'lawn', knex)).resolves.toEqual({ weekWeather: null, uncacheable: false, reason: null });
    expect(fetchServiceWeekWeather).not.toHaveBeenCalled();
  });

  test('no coordinates: PENDING (the geocoder backstop may fill them) — never fetches, but uncacheable so no PDF is stored blank', async () => {
    const fetchServiceWeekWeather = jest.fn();
    mockWeekWeather(fetchServiceWeekWeather);
    const { resolvePestWeekWeather } = require('../services/service-report/report-data');
    const { knex } = makePestKnex();
    const noCoords = { ...GEOCODED, customer_latitude: null, customer_longitude: null };
    await expect(resolvePestWeekWeather(noCoords, 'pest', knex)).resolves.toEqual({ weekWeather: null, uncacheable: true, reason: 'no_coordinates' });
    expect(fetchServiceWeekWeather).not.toHaveBeenCalled();
  });

  test('no coordinates but the completion-time identity snapshot FROZE mapCenter: permanent, cacheable (codex P2 round 5 — the geocoder never repairs a completed report)', async () => {
    const fetchServiceWeekWeather = jest.fn();
    mockWeekWeather(fetchServiceWeekWeather);
    const { resolvePestWeekWeather } = require('../services/service-report/report-data');
    const { knex } = makePestKnex();
    const frozen = { ...GEOCODED, customer_latitude: null, customer_longitude: null, report_identity_snapshot: { mapCenter: null, customer: { name: 'Fixture Customer' } } };
    await expect(resolvePestWeekWeather(frozen, 'pest', knex)).resolves.toEqual({ weekWeather: null, uncacheable: false, reason: null });
    expect(fetchServiceWeekWeather).not.toHaveBeenCalled();
    // A snapshot that omitted mapCenter entirely (customer row missing at
    // completion) is NOT frozen coordinates — still pending.
    const unfrozen = { ...frozen, report_identity_snapshot: { customer: null } };
    await expect(resolvePestWeekWeather(unfrozen, 'pest', knex)).resolves.toMatchObject({ uncacheable: true, reason: 'no_coordinates' });
  });

  test('already frozen (pinned): reads back the stored value, never fetches again — same rain line, cacheable', async () => {
    const STORED = { rainInches: 0.6, windowClosed: true, rainConfidence: 'high', et0Inches: null, dailyRain: null, rainSource: 'open-meteo', frozenAt: '2026-07-17T00:00:00.000Z' };
    const fetchServiceWeekWeather = jest.fn();
    mockWeekWeather(fetchServiceWeekWeather);
    const { resolvePestWeekWeather } = require('../services/service-report/report-data');
    const pinned = { ...GEOCODED, structured_notes: { pestWeekWeather: STORED } };
    const { knex } = makePestKnex();
    await expect(resolvePestWeekWeather(pinned, 'pest', knex)).resolves.toEqual({ weekWeather: STORED, uncacheable: false, reason: null });
    expect(fetchServiceWeekWeather).not.toHaveBeenCalled();
  });

  test('provider outage (fetch throws): nothing frozen, uncacheable', async () => {
    mockWeekWeather(jest.fn().mockRejectedValue(new Error('provider unavailable')));
    const { resolvePestWeekWeather } = require('../services/service-report/report-data');
    const { knex, state } = makePestKnex();
    await expect(resolvePestWeekWeather(GEOCODED, 'pest', knex)).resolves.toEqual({ weekWeather: null, uncacheable: true, reason: 'unavailable' });
    expect(state.patches).toHaveLength(0);
  });

  test('closed window, provider returned nothing usable (both sources missed): nothing frozen, uncacheable', async () => {
    mockWeekWeather(jest.fn().mockResolvedValue({ rainInches: null, windowClosed: true }));
    const { resolvePestWeekWeather } = require('../services/service-report/report-data');
    const { knex, state } = makePestKnex();
    const result = await resolvePestWeekWeather(GEOCODED, 'pest', knex);
    expect(result.uncacheable).toBe(true);
    // transient (codex P2 round 5): the queue's failure ladder, not a midnight wait
    expect(result.reason).toBe('unavailable');
    expect(state.patches).toHaveLength(0);
  });

  test('open window (still accumulating): NOT frozen, uncacheable with reason open_window (time-dependent — the queue waits for midnight)', async () => {
    const FETCHED = { rainInches: 0.2, windowClosed: false, rainConfidence: null };
    mockWeekWeather(jest.fn().mockResolvedValue(FETCHED));
    const { resolvePestWeekWeather } = require('../services/service-report/report-data');
    const { knex, state } = makePestKnex();
    await expect(resolvePestWeekWeather(GEOCODED, 'pest', knex)).resolves.toEqual({ weekWeather: FETCHED, uncacheable: true, reason: 'open_window' });
    expect(state.patches).toHaveLength(0);
    // settledWeekWeatherForRender (tested above) keeps this open reading
    // off EVERY render (codex P2 round 5) — this resolver itself is
    // mode-agnostic, matching the lawn freeze's own mode-independence.
  });

  test('settled + freeze succeeds: cacheable, via a first-writer-wins UPDATE guarded on the key\'s absence', async () => {
    const FETCHED = { rainInches: 1.2, windowClosed: true, et0Inches: 0.3, dailyRain: [{ date: '2026-07-15', inches: 1.2 }], rainConfidence: 'high', rainSource: 'open-meteo' };
    mockWeekWeather(jest.fn().mockResolvedValue(FETCHED));
    const { resolvePestWeekWeather } = require('../services/service-report/report-data');
    const { knex, state } = makePestKnex();
    const result = await resolvePestWeekWeather(GEOCODED, 'pest', knex);
    expect(result.uncacheable).toBe(false);
    expect(result.weekWeather).toMatchObject({ rainInches: 1.2, windowClosed: true });
    expect(state.raws[0]).toMatch(/pestWeekWeather/);
    expect(state.raws[0]).toMatch(/IS NULL/i);
    expect(state.patches[0].structured_notes.__raw).toContain("jsonb_build_object('pestWeekWeather'");
  });

  test('freeze write failure (lost the conditional UPDATE and the read-back finds nothing usable): uncacheable', async () => {
    const FETCHED = { rainInches: 1.2, windowClosed: true, rainConfidence: null };
    mockWeekWeather(jest.fn().mockResolvedValue(FETCHED));
    const { resolvePestWeekWeather } = require('../services/service-report/report-data');
    const { knex } = makePestKnex({ matched: 0, stored: null });
    const result = await resolvePestWeekWeather(GEOCODED, 'pest', knex);
    expect(result.uncacheable).toBe(true);
    expect(result.reason).toBe('unfrozen'); // transient
    expect(result.weekWeather).toEqual(FETCHED);
  });

  test('lost the race but the WINNER already froze a value: adopts the winner\'s value (never this render\'s own numbers), cacheable', async () => {
    const WINNER = { rainInches: 0.9, windowClosed: true, rainConfidence: 'high', et0Inches: null, dailyRain: null, rainSource: 'mrms' };
    const FETCHED = { rainInches: 1.5, windowClosed: true, rainConfidence: null };
    mockWeekWeather(jest.fn().mockResolvedValue(FETCHED));
    const { resolvePestWeekWeather } = require('../services/service-report/report-data');
    const { knex } = makePestKnex({ matched: 0, stored: WINNER });
    const result = await resolvePestWeekWeather(GEOCODED, 'pest', knex);
    expect(result.uncacheable).toBe(false);
    expect(result.weekWeather).toEqual(WINNER);
  });

  // The exact scenario the finding named: a preflight (the pre-render pass)
  // resolves and freezes; a SECOND build (simulating the browser's own,
  // independent live /data fetch) then reads the SAME pinned value with NO
  // provider call at all — so the two can never disagree.
  test('two builds of the same visit: a preflight freezes, then a second build reads the pinned value with NO provider call — same rain line, cacheable', async () => {
    const FETCHED = { rainInches: 0.8, windowClosed: true, et0Inches: 0.2, dailyRain: null, rainConfidence: 'high', rainSource: 'open-meteo' };
    const fetchServiceWeekWeather = jest.fn().mockResolvedValue(FETCHED);
    mockWeekWeather(fetchServiceWeekWeather);
    const { resolvePestWeekWeather } = require('../services/service-report/report-data');

    // A single, STATEFUL structured_notes store — exactly what the real
    // service_records row is: one persisted value both "builds" read/write
    // through, simulating the DB's own atomic jsonb merge.
    let structuredNotes = {};
    const knex = jest.fn((table) => {
      expect(table).toBe('service_records');
      const chain = {
        where: () => chain,
        whereRaw: () => chain,
        update: async (patch) => {
          if (structuredNotes.pestWeekWeather) return 0; // key already present -> lost the race
          structuredNotes = { ...structuredNotes, pestWeekWeather: JSON.parse(patch.structured_notes.bindings[0]) };
          return 1;
        },
        first: async () => ({ structured_notes: structuredNotes }),
      };
      return chain;
    });
    knex.raw = (sql, bindings) => ({ __raw: sql, bindings });

    // First "build" — the pre-render preflight (direct route / pdf-queue).
    const first = await resolvePestWeekWeather(GEOCODED, 'pest', knex);
    expect(first.uncacheable).toBe(false);
    expect(fetchServiceWeekWeather).toHaveBeenCalledTimes(1);

    // Second "build" — the browser's own independent live /data fetch,
    // reading the SAME service row after the first build's freeze landed.
    const second = await resolvePestWeekWeather({ ...GEOCODED, structured_notes: structuredNotes }, 'pest', knex);
    expect(fetchServiceWeekWeather).toHaveBeenCalledTimes(1); // still just once
    expect(second.uncacheable).toBe(false);
    expect(second.weekWeather).toEqual(first.weekWeather);
  });
});

describe('resolvePestWeekWeatherForBuild — bounded to ~1200ms on the LIVE request path only', () => {
  const ORIGINAL_GATE = process.env.GATE_PEST_REPORT_EXPECTATIONS;
  const GEOCODED = {
    id: 'svc-pest-2',
    service_line: 'pest',
    customer_latitude: 27.4,
    customer_longitude: -82.5,
    service_date: '2026-07-16',
    structured_notes: {},
  };

  function toCoordinateStub(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  beforeEach(() => {
    process.env.GATE_PEST_REPORT_EXPECTATIONS = 'true';
    jest.resetModules();
  });
  afterEach(() => {
    process.env.GATE_PEST_REPORT_EXPECTATIONS = ORIGINAL_GATE;
    jest.dontMock('../services/service-report/application-conditions');
  });

  test('LIVE + a slow fetch (never settling within the deadline): the timed-out caller gets the UNAVAILABLE sentinel and never itself writes a freeze', async () => {
    jest.useFakeTimers();
    let updateCalls = 0;
    jest.doMock('../services/service-report/application-conditions', () => ({
      toCoordinate: toCoordinateStub,
      fetchServiceWeekWeather: () => new Promise(() => {}), // never settles
    }));
    const { resolvePestWeekWeatherForBuild } = require('../services/service-report/report-data');
    const knex = jest.fn(() => {
      const chain = {
        where: () => chain,
        whereRaw: () => chain,
        update: async () => { updateCalls += 1; return 1; },
        first: async () => ({ structured_notes: {} }),
      };
      return chain;
    });
    knex.raw = (sql, bindings) => ({ __raw: sql, bindings });

    const promise = resolvePestWeekWeatherForBuild(GEOCODED, 'pest', knex, 'live');
    jest.advanceTimersByTime(1200);
    await expect(promise).resolves.toEqual({
      weekWeather: { rainInches: null, windowClosed: false, unavailable: true },
      uncacheable: true,
      reason: 'unavailable',
    });
    // The timed-out caller itself never wrote a freeze — a timed-out
    // request must not persist anything (the still-running background
    // lookup, if it ever settles, is what may freeze the real answer).
    expect(updateCalls).toBe(0);
    jest.useRealTimers();
  });

  test('LIVE + a fast fetch: resolves with the normal (frozen) result, not the sentinel', async () => {
    const SETTLED = { rainInches: 0.6, windowClosed: true, rainConfidence: null };
    jest.doMock('../services/service-report/application-conditions', () => ({
      toCoordinate: toCoordinateStub,
      fetchServiceWeekWeather: jest.fn().mockResolvedValue(SETTLED),
    }));
    const { resolvePestWeekWeatherForBuild } = require('../services/service-report/report-data');
    const knex = jest.fn(() => {
      const chain = {
        where: () => chain,
        whereRaw: () => chain,
        update: async () => 1,
        first: async () => ({ structured_notes: {} }),
      };
      return chain;
    });
    knex.raw = (sql, bindings) => ({ __raw: sql, bindings });
    const result = await resolvePestWeekWeatherForBuild(GEOCODED, 'pest', knex, 'live');
    expect(result.uncacheable).toBe(false);
    expect(result.weekWeather).toMatchObject({ rainInches: 0.6, windowClosed: true });
  });

  test('non-live (pdf/static/undefined) is NEVER bounded — a background pre-render pass is not a live UX concern, matching the lawn water balance', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'service-report', 'report-data.js'), 'utf8');
    expect(source).toMatch(/if \(mode !== 'live'\) return resolvePestWeekWeather\(service, serviceLine, knex\);/);
  });
});

// codex P1 2026-09-29 round 3: BOTH PDF cache-decision sites now read
// `pestWeekWeatherUncacheable` straight off the object buildReportV1Data
// returns — no separate preflight fetch anywhere.
describe('BOTH PDF cache-decision sites read the pin, with no separate preflight fetch', () => {
  test('pdf-queue.js: resolvePestWeekWeatherForBuild is wired into buildReportV1Data itself, called by every path', () => {
    const reportData = fs.readFileSync(path.join(__dirname, '..', 'services', 'service-report', 'report-data.js'), 'utf8');
    expect(reportData).toMatch(/await resolvePestWeekWeatherForBuild\(service, serviceLine, knex, opts\.mode\)/);
    // Public marker only — no raw provider numbers land on the object this
    // function returns; those stay server-internal via expectationFactsOut.
    expect(reportData).toMatch(/pestWeekWeatherUncacheable,[\s\S]{0,700}?pestWeekWeatherPendingReason: pestWeekWeatherPendingReason \|\| null,\s*\n\s*mowingHeight,/);
  });

  test('pdf-queue.js never composes pestReportV2 and no longer calls any separate pest-weather preflight', () => {
    const pdfQueue = fs.readFileSync(path.join(__dirname, '..', 'services', 'service-report', 'pdf-queue.js'), 'utf8');
    expect(pdfQueue).not.toMatch(/buildPestReportV2/);
    expect(pdfQueue).not.toMatch(/pestWeekWeatherUncacheableForPdf/);
    expect(pdfQueue).not.toMatch(/fetchPestWeekWeatherForCache/);
  });

  test('pest-report-v2.js no longer exports the removed preflight helper', () => {
    const { pestWeekWeatherUncacheableForPdf } = require('../services/service-report/pest-report-v2');
    expect(pestWeekWeatherUncacheableForPdf).toBeUndefined();
  });

  test('both cache-decision sites still branch on the SAME field name', () => {
    const reportsPublic = fs.readFileSync(path.join(__dirname, '..', 'routes', 'reports-public.js'), 'utf8');
    const pdfQueue = fs.readFileSync(path.join(__dirname, '..', 'services', 'service-report', 'pdf-queue.js'), 'utf8');
    for (const src of [reportsPublic, pdfQueue]) {
      expect(src).toMatch(/renderedData\?\.pestWeekWeatherUncacheable/);
    }
    // reports-public.js branches AROUND the putReportPdf call, same as the
    // lawn guard immediately above it.
    expect(reportsPublic).toMatch(/renderedData\?\.pestWeekWeatherUncacheable\)[\s\S]{0,600}\} else if/);
    // pdf-queue.js returns the bytes with no key rather than storing.
    expect(pdfQueue).toMatch(/renderedData\?\.pestWeekWeatherUncacheable\)[\s\S]{0,1400}uncached: true/);
  });
});

// codex P2 2026-09-29 (round 2): rainChance is the PROBABILITY of any
// measurable precipitation, not its intensity — a 70% chance of light rain
// is not "heavy rain right after a treatment can reduce it". Intensity now
// reads ONLY from the forecast text (storm/thunderstorm/heavy rain).
describe('fetchPestRainForecastHeavySafe — probability alone never marks heavy rain', () => {
  const SERVICE = { customer_latitude: 27.4, customer_longitude: -82.5 };

  beforeEach(() => { jest.resetModules(); });
  afterEach(() => { jest.dontMock('../services/weather-forecast'); });

  test('rainChance 70 + "Light Rain" text: NOT heavy', async () => {
    jest.doMock('../services/weather-forecast', () => ({
      getDailyRainOutlookBounded: jest.fn().mockResolvedValue({
        '2026-07-16': { rainChance: 70, shortForecast: 'Light Rain' },
      }),
    }));
    const { fetchPestRainForecastHeavySafe } = require('../routes/reports-public');
    await expect(fetchPestRainForecastHeavySafe(SERVICE)).resolves.toBe(false);
  });

  test('a high rainChance with no storm/heavy-rain text anywhere: NOT heavy, regardless of the percentage', async () => {
    jest.doMock('../services/weather-forecast', () => ({
      getDailyRainOutlookBounded: jest.fn().mockResolvedValue({
        '2026-07-16': { rainChance: 95, shortForecast: 'Mostly Cloudy' },
      }),
    }));
    const { fetchPestRainForecastHeavySafe } = require('../routes/reports-public');
    await expect(fetchPestRainForecastHeavySafe(SERVICE)).resolves.toBe(false);
  });

  test('"Thunderstorms" forecast text: heavy, even with a low rainChance', async () => {
    jest.doMock('../services/weather-forecast', () => ({
      getDailyRainOutlookBounded: jest.fn().mockResolvedValue({
        '2026-07-16': { rainChance: 30, shortForecast: 'Thunderstorms' },
      }),
    }));
    const { fetchPestRainForecastHeavySafe } = require('../routes/reports-public');
    await expect(fetchPestRainForecastHeavySafe(SERVICE)).resolves.toBe(true);
  });

  test('"heavy rain" forecast text also qualifies', async () => {
    jest.doMock('../services/weather-forecast', () => ({
      getDailyRainOutlookBounded: jest.fn().mockResolvedValue({
        '2026-07-16': { rainChance: null, shortForecast: 'Heavy Rain Likely' },
      }),
    }));
    const { fetchPestRainForecastHeavySafe } = require('../routes/reports-public');
    await expect(fetchPestRainForecastHeavySafe(SERVICE)).resolves.toBe(true);
  });

  test('no outlook at all: fail-open false', async () => {
    jest.doMock('../services/weather-forecast', () => ({
      getDailyRainOutlookBounded: jest.fn().mockResolvedValue(null),
    }));
    const { fetchPestRainForecastHeavySafe } = require('../routes/reports-public');
    await expect(fetchPestRainForecastHeavySafe(SERVICE)).resolves.toBe(false);
  });
});

// codex P1 2026-09-29 round 4: a report reopened weeks after the visit is
// still a LIVE view — without a recency floor it would run TODAY's NWS
// forecast and print a "heavy rain right after a treatment" caveat against
// a treatment applied long ago. "Recent" = within the last 2 ET calendar
// days (today, yesterday, or the day before).
describe('isRecentServiceDate — recency floor for the live forecast fetch', () => {
  const { isRecentServiceDate } = require('../routes/reports-public');
  // Anchor "now" at a fixed ET noon so the test is not sensitive to when it
  // actually runs.
  const NOW = new Date('2026-07-16T16:00:00Z'); // noon ET (UTC-4, July)

  test('service today: recent', () => {
    expect(isRecentServiceDate('2026-07-16', NOW)).toBe(true);
  });

  test('service yesterday: recent', () => {
    expect(isRecentServiceDate('2026-07-15', NOW)).toBe(true);
  });

  test('service 2 days ago (the boundary): recent', () => {
    expect(isRecentServiceDate('2026-07-14', NOW)).toBe(true);
  });

  test('service 3 days ago: not recent', () => {
    expect(isRecentServiceDate('2026-07-13', NOW)).toBe(false);
  });

  test('service 10 days ago: not recent', () => {
    expect(isRecentServiceDate('2026-07-06', NOW)).toBe(false);
  });

  test('a Date object (as a Postgres DATE column arrives) works the same as its equivalent string', () => {
    expect(isRecentServiceDate(new Date('2026-07-16T00:00:00.000Z'), NOW)).toBe(true);
    expect(isRecentServiceDate(new Date('2026-07-06T00:00:00.000Z'), NOW)).toBe(false);
  });

  test('missing or unparseable service_date: not recent (fail closed, no forecast)', () => {
    expect(isRecentServiceDate(null, NOW)).toBe(false);
    expect(isRecentServiceDate(undefined, NOW)).toBe(false);
    expect(isRecentServiceDate('not-a-date', NOW)).toBe(false);
  });

  test('the live forecast fetch is wired behind isRecentServiceDate (source wiring)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'reports-public.js'), 'utf8');
    expect(source).toMatch(/expectationsGateOn && mode === 'live' && isRecentServiceDate\(service\.service_date\)\s*\n\s*\? await fetchPestRainForecastHeavySafe\(service\)/);
  });
});

// codex P2 2026-09-28 round 4: the week-weather lookup is OPT-IN. Only the
// callers that render the expectations block pay for it; a caller that
// passes no options (the public map.svg handler) never fetches, never pins,
// and stays cacheable.
describe('pest week-weather lookup is opt-in per caller (source wiring)', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  test('buildReportV1Data resolves the week only when opts.pestWeekWeather === true', () => {
    const src = read('services/service-report/report-data.js');
    expect(src).toMatch(/const pestWeekWeatherEligible = opts\.pestWeekWeather === true[\s\S]{0,300}?pestWeekWeatherEligible\n\s*\? await resolvePestWeekWeatherForBuild\(service, serviceLine, knex, opts\.mode\)\n\s*: \{ weekWeather: null, uncacheable: false, reason: null \}/);
  });

  test('buildServiceReportV1ResponseData threads its own pestExpectationsWeather opt-in through to pestWeekWeather (codex P2 #5137 deferred finding a)', () => {
    const src = read('routes/reports-public.js');
    expect(src).toMatch(/pinnedLawnHistoryIdentity,[^\n]*\bexpectationFactsOut,[\s\S]{0,400}?pestWeekWeather: pestExpectationsWeather,\n\s*\}\);/);
  });

  test('the /data response builder (which also serves the direct PDF route) opts in; the Q&A endpoint (/ask) does not', () => {
    const src = read('routes/reports-public.js');
    // Direct PDF route.
    expect(src).toMatch(/mode: 'pdf', pestPressureConfig,[\s\S]{0,700}?pestExpectationsWeather: true,/);
    // /data route.
    expect(src).toMatch(/composeOffers: true, planSummary: true, upcomingVisitsCard: true, nearYou: true,[\s\S]{0,500}?pestExpectationsWeather: true,/);
    // /ask calls the builder with only `{ mode: 'live' }` — no opt-in, so it
    // never pays for either weather lookup (answerServiceReportQuestion
    // never reads data.pestReportV2.expectations).
    expect(src).toMatch(/const data = await buildServiceReportV1ResponseData\(service, req\.params\.token, \{ mode: 'live' \}\);/);
  });

  test('the live heavy-rain NWS forecast fetch is also gated on pestExpectationsWeather, not mode/recency alone', () => {
    const src = read('routes/reports-public.js');
    expect(src).toMatch(/const forecastHeavyRain = pestExpectationsWeather && expectationsGateOn && mode === 'live' && isRecentServiceDate\(service\.service_date\)/);
  });

  test('pdf-queue opts in', () => {
    const src = read('services/service-report/pdf-queue.js');
    expect(src).toMatch(/buildReportV1Data\(service, reportToken, knex, \{[^\n]*pestWeekWeather: true \}\);/);
  });

  test('the public map.svg handler passes no options and so never resolves weather', () => {
    const src = read('routes/reports-public.js');
    expect(src).toMatch(/const data = await buildReportV1Data\(service, req\.params\.token\);/);
  });
});

describe('pending reasons drive the queue retry shape and the render eligibility (source wiring, codex P2 round 5)', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  test('buildReportV1Data exposes pestWeekWeatherPendingReason beside the boolean', () => {
    const src = read('services/service-report/report-data.js');
    expect(src).toMatch(/pestWeekWeatherUncacheable,\n[\s\S]{0,600}?pestWeekWeatherPendingReason: pestWeekWeatherPendingReason \|\| null,/);
  });

  test('weather resolution is skipped for cockroach-family typed reports and when PEST_REPORT_V2 is off', () => {
    const src = read('services/service-report/report-data.js');
    expect(src).toMatch(/const pestWeekWeatherEligible = opts\.pestWeekWeather === true\n\s*&& process\.env\.PEST_REPORT_V2 === 'true'\n\s*&& !require\('\.\/pest-report-v2'\)\.isCockroachTypedReportType\(typedSnapshot\?\.type\);/);
  });

  test('pdf-queue maps open_window → unsettled (defer), no_coordinates → its own pending reason, everything else → unavailable (transient)', () => {
    const src = read('services/service-report/pdf-queue.js');
    expect(src).toMatch(/pending === 'open_window' \? 'pest_week_weather_unsettled'\n\s*: pending === 'no_coordinates' \? 'pest_week_weather_no_coordinates'\n\s*: 'pest_week_weather_unavailable'/);
    expect(src).toMatch(/const TRANSIENT_UNCACHED_REASONS = new Set\(\['unfrozen', 'pest_week_weather_unavailable'\]\);/);
    expect(src).toMatch(/!TRANSIENT_UNCACHED_REASONS\.has\(result\.uncachedReason\) && queuedSinceMs < PENDING_DEFER_GRACE_MS/);
  });
});
