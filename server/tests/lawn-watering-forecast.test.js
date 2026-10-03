// GATE_LAWN_WATERING_FORECAST (lawn report rebuild P30): the conditional water-in
// sentence frozen at completion, and the live-view radar close-out. Pure module
// plus the write gate. All HTTP is mocked; synthetic data only.

jest.mock('../services/service-report/pdf-queue', () => ({
  loadServiceRecordForPdf: jest.fn(async (id) => ({ id, service_line: 'lawn', structured_notes: '{}', customer_latitude: 27.5, customer_longitude: -82.5 })),
  ensureReportToken: jest.fn(async () => 'c'.repeat(32)),
}));
jest.mock('../services/service-report/report-data', () => ({ buildReportV1Data: jest.fn() }));
jest.mock('../services/service-report/report-consistency', () => ({ reconcileLawnReport: jest.fn(() => ({ warnings: [] })) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/service-report/application-conditions', () => ({
  ...jest.requireActual('../services/service-report/application-conditions'),
  fetchPropertyForecast: jest.fn(),
}));

const { buildReportV1Data } = require('../services/service-report/report-data');
const { fetchPropertyForecast } = require('../services/service-report/application-conditions');
const { finalizeLawnReportSynthesis } = require('../services/service-report/lawn-report-write-gate');
const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
const {
  formatInches, forecastSentence, closeOutSentence, copyIsClean, resolveWaterInForecast, frozenForecastLine,
  wholeDaysInsideWindow, observedCloseOut, attachLiveCloseOut,
} = require('../services/service-report/lawn-watering-forecast');
const { etDayWindow } = require('../services/service-report/application-conditions');
const { etDateString } = require('../utils/datetime-et');

const COMPLETED = '2026-10-06T18:40:00Z'; // Tue 2:40 PM ET
const waterIn = (rule = {}) => JSON.parse(JSON.stringify(buildWateringInstruction({
  rules: [{ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'label', ...rule }],
  completedAt: COMPLETED,
})));
const holdInstruction = () => JSON.parse(JSON.stringify(buildWateringInstruction({
  rules: [{ mode: 'hold', hold_hours: 24, source: 'label' }], completedAt: COMPLETED,
})));
const mixedInstruction = () => JSON.parse(JSON.stringify(buildWateringInstruction({
  rules: [{ mode: 'hold', hold_hours: 4, source: 'label' }, { mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 48, source: 'label' }],
  completedAt: COMPLETED,
})));
const ok = (total) => ({ status: 'ok', fetchedAt: '2026-10-06T18:41:00.000Z', precipitationInTotal: total });

describe('copy', () => {
  test('inches are written in words for quarters and plainly otherwise', () => {
    expect(formatInches(0.25)).toBe('¼ inch');
    expect(formatInches(0.5)).toBe('½ inch');
    expect(formatInches(0.75)).toBe('¾ inch');
    expect(formatInches(0.27)).toBe('0.27 inch');
    expect(formatInches(1)).toBe('1 inch');
    expect(formatInches(1.4)).toBe('1.4 inches');
    expect(formatInches(0)).toBeNull();
    expect(formatInches(null)).toBeNull();
  });

  test('the two sentences: fixed, in inches, no probability and no percent', () => {
    const sentences = [
      forecastSentence({ forecastInches: 0.4, waterInInches: 0.25, checkpointLabel: 'Wed 8 AM' }),
      forecastSentence({ forecastInches: 1.25, waterInInches: 0.5, checkpointLabel: '8 PM tonight' }),
      closeOutSentence({ measuredInches: 0.6 }),
      closeOutSentence({ measuredInches: 0.25 }),
    ];
    expect(sentences[0]).toBe('About 0.4 inch of rain is forecast by Wed 8 AM. If at least ¼ inch has fallen by then, it counts as watering in today’s treatment. If it has not, run the watering above right away.');
    expect(sentences[2]).toBe('Radar measured about 0.6 inch of rain near your address since your visit. If your lawn got that rain, it counts as watering in today’s treatment. Local totals may vary, so run the watering above if your lawn stayed dry.');
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/%|percent|chance|probab|likel|odds/i);
      expect(sentence).not.toMatch(/keep\s+off|stay\s+off|re-?entry|\bwait\b|\bdried\b|\d\s*(hours?|minutes?)\b/i);
      expect(sentence).not.toMatch(/\b(done|no need)\b/i);
      expect(sentence).toMatch(/\binch(es)?\b/);
      expect(copyIsClean(sentence)).toBe(true);
    }
    // The guard itself.
    expect(copyIsClean('A 70% chance of rain')).toBe(false);
    expect(copyIsClean('There is a chance')).toBe(false);
    expect(copyIsClean('')).toBe(false);
  });
});

describe('resolveWaterInForecast (frozen at completion)', () => {
  test('forecast known and at least the amount: one sentence with the inches, window from the instruction', async () => {
    const instruction = waterIn();
    const fetchForecast = jest.fn(async () => ok(0.4));
    const forecast = await resolveWaterInForecast({ instruction, latitude: 27.5, longitude: -82.5, fetchForecast });
    // Tue 2:40 PM ET completion, Wed 2 PM deadline: checkpoint 6 hours earlier, Wed 8 AM.
    const checkpointAt = new Date(Date.parse(instruction.waterInBy) - 6 * 3600000).toISOString();
    expect(forecast).toMatchObject({ inches: 0.4, source: 'open_meteo', windowFrom: instruction.completedAt, windowTo: checkpointAt, checkpointAt, checkpointLabel: 'Wed 8 AM' });
    expect(forecast.line).toBe('About 0.4 inch of rain is forecast by Wed 8 AM. If at least ¼ inch has fallen by then, it counts as watering in today’s treatment. If it has not, run the watering above right away.');
    // The forecast is read to the CHECKPOINT, never the deadline; the deadline is not in the sentence.
    const args = fetchForecast.mock.calls[0][0];
    expect(args.from.toISOString()).toBe(instruction.completedAt);
    expect(args.to.toISOString()).toBe(checkpointAt);
    expect(forecast.line).not.toContain(instruction.waterInByLabel);
  });

  test.each([
    ['unavailable', { status: 'unavailable', reason: 'timeout' }],
    ['incomplete (an hour had no reading)', { status: 'ok', precipitationInTotal: null }],
    ['below the label amount', ok(0.1)],
    ['a dry window', ok(0)],
    ['nothing back', null],
    ['a bad total', { status: 'ok', precipitationInTotal: 'wet' }],
  ])('%s: no sentence, today\'s instruction untouched', async (_name, result) => {
    expect(await resolveWaterInForecast({ instruction: waterIn(), latitude: 27.5, longitude: -82.5, fetchForecast: async () => result })).toBeNull();
  });

  test('a thrown fetch fails open', async () => {
    expect(await resolveWaterInForecast({ instruction: waterIn(), latitude: 27.5, longitude: -82.5, fetchForecast: async () => { throw new Error('boom'); } })).toBeNull();
  });

  test('rain forecast only AFTER the checkpoint (the deadline is the only hour that reaches the amount): no sentence', async () => {
    const instruction = waterIn();
    // Hours up to the checkpoint are dry; the fetch is asked for the checkpoint window only.
    const fetchForecast = jest.fn(async ({ to }) => (Date.parse(to) < Date.parse(instruction.waterInBy) ? ok(0.05) : ok(0.6)));
    expect(await resolveWaterInForecast({ instruction, latitude: 27.5, longitude: -82.5, fetchForecast })).toBeNull();
    expect(fetchForecast).toHaveBeenCalledTimes(1);
  });

  test('completion to checkpoint must be at least 6 hours (12 hours to the deadline): shorter windows get no sentence and no forecast read', async () => {
    const at = '2026-10-06T18:00:00Z'; // Tue 2 PM ET, on the hour
    const exact = JSON.parse(JSON.stringify(buildWateringInstruction({ rules: [{ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 12, source: 'label' }], completedAt: at })));
    const short = JSON.parse(JSON.stringify(buildWateringInstruction({ rules: [{ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 11, source: 'label' }], completedAt: at })));
    const fetchForecast = jest.fn(async () => ok(0.6));
    expect((await resolveWaterInForecast({ instruction: exact, latitude: 27.5, longitude: -82.5, fetchForecast })).checkpointLabel).toBe('8 PM tonight');
    fetchForecast.mockClear();
    expect(await resolveWaterInForecast({ instruction: short, latitude: 27.5, longitude: -82.5, fetchForecast })).toBeNull();
    expect(fetchForecast).not.toHaveBeenCalled();
    // The shipped default completion (2:40 PM, floored deadline) just short of 12 hours total.
    const tooShort = JSON.parse(JSON.stringify(buildWateringInstruction({ rules: [{ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 12, source: 'label' }], completedAt: COMPLETED })));
    expect(await resolveWaterInForecast({ instruction: tooShort, latitude: 27.5, longitude: -82.5, fetchForecast })).toBeNull();
  });

  test.each([
    ['same evening', '2026-10-06T12:00:00Z', 18, '8 PM tonight'], // 8 AM ET -> deadline 2 AM Wed, checkpoint 8 PM Tue
    ['across midnight', '2026-10-06T14:00:00Z', 24, 'Wed 4 AM'], // 10 AM ET Tue -> deadline 10 AM Wed, checkpoint 4 AM Wed
    ['late evening visit', '2026-10-07T01:00:00Z', 30, 'Wed 9 PM'], // 9 PM ET Tue -> deadline 3 AM Thu, checkpoint 9 PM Wed
  ])('checkpoint label, %s', async (_name, completedAt, byHours, expected) => {
    const instruction = JSON.parse(JSON.stringify(buildWateringInstruction({ rules: [{ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: byHours, source: 'label' }], completedAt })));
    const forecast = await resolveWaterInForecast({ instruction, latitude: 27.5, longitude: -82.5, fetchForecast: async () => ok(0.4) });
    expect(forecast.checkpointLabel).toBe(expected);
    expect(forecast.line).toContain(`forecast by ${expected}.`);
  });

  test('a hold, a hold-then-water-in and a no-claim never get a sentence and never reach the forecast', async () => {
    for (const instruction of [holdInstruction(), mixedInstruction(), buildWateringInstruction({ rules: [], completedAt: COMPLETED })]) {
      const fetchForecast = jest.fn(async () => ok(2));
      expect(await resolveWaterInForecast({ instruction, latitude: 27.5, longitude: -82.5, fetchForecast })).toBeNull();
      expect(fetchForecast).not.toHaveBeenCalled();
    }
    expect(mixedInstruction().state).toBe('hold_then_water_in');
  });

  test('the sentence is never part of lines (PDF, text and assistant read lines)', async () => {
    const instruction = waterIn();
    const before = JSON.stringify(instruction.lines);
    await resolveWaterInForecast({ instruction, latitude: 27.5, longitude: -82.5, fetchForecast: async () => ok(0.6) });
    expect(JSON.stringify(instruction.lines)).toBe(before);
    expect(instruction.lines.join(' ')).not.toMatch(/forecast|rain/i);
  });

  test('frozenForecastLine: shape-checked, water-in only, clean copy only', () => {
    const base = waterIn();
    const line = 'About ½ inch of rain is forecast by Wed 8 AM. If at least ¼ inch has fallen by then, it counts as watering in today’s treatment. If it has not, run the watering above right away.';
    expect(frozenForecastLine({ ...base, forecast: { line, inches: 0.5 } })).toBe(line);
    expect(frozenForecastLine(base)).toBeNull();
    expect(frozenForecastLine({ ...base, forecast: { line, inches: 'x' } })).toBeNull();
    expect(frozenForecastLine({ ...base, forecast: { line: 'A 40% chance of rain', inches: 0.5 } })).toBeNull();
    expect(frozenForecastLine({ ...holdInstruction(), forecast: { line, inches: 0.5 } })).toBeNull();
    expect(frozenForecastLine({ ...mixedInstruction(), forecast: { line, inches: 0.5 } })).toBeNull();
  });
});

describe('the write gate freezes the sentence (first writer wins, replays identical)', () => {
  const OLD = process.env.GATE_LAWN_WATERING_FORECAST;
  afterEach(() => {
    if (OLD === undefined) delete process.env.GATE_LAWN_WATERING_FORECAST; else process.env.GATE_LAWN_WATERING_FORECAST = OLD;
    fetchPropertyForecast.mockReset();
  });

  function fakeKnex(initialNotes = {}) {
    const state = { notes: JSON.parse(JSON.stringify(initialNotes)) };
    const knex = () => {
      const q = {};
      q.where = () => q;
      q.whereRaw = () => q;
      q.first = async () => ({ structured_notes: JSON.stringify(state.notes) });
      q.update = async ({ structured_notes: raw }) => {
        const patch = JSON.parse(raw.bindings[0]);
        if (Object.prototype.hasOwnProperty.call(patch, 'lawnWateringFreeze') && state.notes.lawnWateringFreeze) return 0;
        Object.assign(state.notes, patch);
        return 1;
      };
      return q;
    };
    knex.raw = (sql, bindings) => ({ sql, bindings });
    return { knex, state };
  }
  const reportOnce = (instruction) => buildReportV1Data.mockImplementationOnce(async (_r, _t, _k, opts) => {
    opts.wateringInstructionOut.instruction = instruction;
    return { reportV2: { smsSummary: 'sms', snapshot: { statusHeadline: 'h' }, banner: { state: instruction.state, lines: instruction.lines } } };
  });
  const run = (knex) => finalizeLawnReportSynthesis({ service: { id: 's1', service_line: 'lawn' }, knex });

  test('gate on, forecast reaches the amount: instruction.forecast is frozen, lines are byte-identical', async () => {
    process.env.GATE_LAWN_WATERING_FORECAST = 'true';
    fetchPropertyForecast.mockResolvedValue(ok(0.4));
    const instruction = waterIn();
    reportOnce(instruction);
    const { knex, state } = fakeKnex({});
    const result = await run(knex);
    const frozen = state.notes.lawnWateringFreeze.wateringInstruction;
    expect(frozen.lines).toEqual(instruction.lines);
    expect(frozen.forecast.inches).toBe(0.4);
    expect(frozen.forecast.line).toMatch(/^About 0\.4 inch of rain is forecast by Wed 8 AM\./);
    expect(result.wateringFreeze.wateringInstruction.forecast).toEqual(frozen.forecast);
    // The property's own coordinates, never a fixed point.
    expect(fetchPropertyForecast).toHaveBeenCalledWith(expect.objectContaining({ latitude: 27.5, longitude: -82.5 }));
  });

  test('forecast unavailable or incomplete: the frozen instruction is exactly today\'s', async () => {
    process.env.GATE_LAWN_WATERING_FORECAST = 'true';
    for (const result of [{ status: 'unavailable', reason: 'timeout' }, ok(null), ok(0.05)]) {
      fetchPropertyForecast.mockResolvedValue(result);
      const instruction = waterIn();
      reportOnce(instruction);
      const { knex, state } = fakeKnex({});
      await run(knex);
      expect(JSON.stringify(state.notes.lawnWateringFreeze.wateringInstruction)).toBe(JSON.stringify(instruction));
    }
  });

  test('gate off: no forecast read, frozen instruction byte-identical to today', async () => {
    delete process.env.GATE_LAWN_WATERING_FORECAST;
    fetchPropertyForecast.mockResolvedValue(ok(2));
    const instruction = waterIn();
    reportOnce(instruction);
    const { knex, state } = fakeKnex({});
    await run(knex);
    expect(fetchPropertyForecast).not.toHaveBeenCalled();
    expect(JSON.stringify(state.notes.lawnWateringFreeze.wateringInstruction)).toBe(JSON.stringify(instruction));
  });

  test('a hold never reads the forecast', async () => {
    process.env.GATE_LAWN_WATERING_FORECAST = 'true';
    fetchPropertyForecast.mockResolvedValue(ok(2));
    const instruction = holdInstruction();
    reportOnce(instruction);
    const { knex, state } = fakeKnex({});
    await run(knex);
    expect(fetchPropertyForecast).not.toHaveBeenCalled();
    expect(state.notes.lawnWateringFreeze.wateringInstruction).not.toHaveProperty('forecast');
  });

  test('an already-frozen record is never re-read or re-written: replay is identical, a later run adds nothing', async () => {
    process.env.GATE_LAWN_WATERING_FORECAST = 'true';
    fetchPropertyForecast.mockResolvedValue(ok(0.4));
    const first = fakeKnex({});
    reportOnce(waterIn());
    await run(first.knex);
    const before = JSON.stringify(first.state.notes.lawnWateringFreeze);
    // Second run, different forecast: first writer wins, nothing changes.
    fetchPropertyForecast.mockResolvedValue(ok(1.2));
    reportOnce(waterIn());
    await run(first.knex);
    expect(JSON.stringify(first.state.notes.lawnWateringFreeze)).toBe(before);
    // A record frozen BEFORE the gate was on (no forecast) never grows one.
    const legacy = { wateringInstruction: waterIn(), banner: null };
    const old = fakeKnex({ lawnWateringFreeze: legacy });
    pdfRecordWithFreeze(old.state.notes);
    fetchPropertyForecast.mockClear();
    reportOnce(waterIn());
    await run(old.knex);
    expect(fetchPropertyForecast).not.toHaveBeenCalled();
    expect(old.state.notes.lawnWateringFreeze.wateringInstruction).not.toHaveProperty('forecast');
  });
});

function pdfRecordWithFreeze(notes) {
  require('../services/service-report/pdf-queue').loadServiceRecordForPdf.mockImplementationOnce(async (id) => ({
    id, service_line: 'lawn', structured_notes: JSON.stringify(notes), customer_latitude: 27.5, customer_longitude: -82.5,
  }));
}

describe('live close-out (radar-measured rain only)', () => {
  // A 72-hour water-in: Tue 2:40 PM -> Fri 2 PM ET. Wed 10/7 and Thu 10/8 lie wholly inside.
  const longWindow = () => waterIn({ water_in_by_hours: 72 });
  const deps = (over = {}) => ({ etDayWindow, etDateString, ...over });
  const NOW = new Date('2026-10-09T12:00:00Z'); // Fri 8 AM ET, before the 2 PM deadline

  test('whole Eastern days inside the window (one-hour edge margin), already ended', () => {
    const instruction = longWindow();
    expect(wholeDaysInsideWindow(instruction, NOW, deps())).toEqual(['2026-10-07', '2026-10-08']);
    // Thu is still in progress on Thu afternoon.
    expect(wholeDaysInsideWindow(instruction, new Date('2026-10-08T18:00:00Z'), deps())).toEqual(['2026-10-07']);
  });

  test('the default 24-hour window contains no whole day: nothing to measure, no lookup', async () => {
    const instruction = waterIn();
    expect(wholeDaysInsideWindow(instruction, new Date('2026-10-08T01:00:00Z'), deps())).toEqual([]);
    const fetchMrmsDailyRain = jest.fn();
    const data = { reportV2: { banner: { state: 'water_in', expiresAt: instruction.waterInBy } } };
    await attachLiveCloseOut(data, deps({ instruction, latitude: 27.5, longitude: -82.5, now: new Date('2026-10-06T22:00:00Z'), fetchMrmsDailyRain }));
    expect(fetchMrmsDailyRain).not.toHaveBeenCalled();
    expect(data.reportV2.banner).not.toHaveProperty('observedRain');
  });

  test('measured rain at or above the amount on whole days inside the window closes it, in measured inches', () => {
    const instruction = longWindow();
    const inside = ['2026-10-07', '2026-10-08'];
    const closed = observedCloseOut(instruction, [
      { date: '2026-10-06', inches: 5 }, // the visit day: outside the window, ignored
      { date: '2026-10-07', inches: 0.1 },
      { date: '2026-10-08', inches: 0.2 },
      { date: '2026-10-09', inches: 5 }, // the deadline day: outside, ignored
    ], inside);
    expect(closed).toEqual({
      inches: 0.3, source: 'mrms', days: ['2026-10-07', '2026-10-08'],
      line: 'Radar measured about 0.3 inch of rain near your address since your visit. If your lawn got that rain, it counts as watering in today’s treatment. Local totals may vary, so run the watering above if your lawn stayed dry.',
    });
    // Exactly the amount counts.
    expect(observedCloseOut(instruction, [{ date: '2026-10-07', inches: 0.25 }], inside)).not.toBeNull();
  });

  test('below the amount, or only gap days, or rain only outside the window: no close-out', () => {
    const instruction = longWindow();
    const inside = ['2026-10-07', '2026-10-08'];
    expect(observedCloseOut(instruction, [{ date: '2026-10-07', inches: 0.1 }, { date: '2026-10-08', inches: 0.14 }], inside)).toBeNull();
    expect(observedCloseOut(instruction, [{ date: '2026-10-07', inches: null }, { date: '2026-10-08', inches: null }], inside)).toBeNull();
    expect(observedCloseOut(instruction, [{ date: '2026-10-06', inches: 2 }, { date: '2026-10-09', inches: 2 }], inside)).toBeNull();
    expect(observedCloseOut(instruction, [{ date: '2026-10-07', inches: 2 }], [])).toBeNull();
  });

  test('a hold and a hold-then-water-in never close out, whatever fell', () => {
    for (const instruction of [holdInstruction(), mixedInstruction()]) {
      expect(observedCloseOut(instruction, [{ date: '2026-10-07', inches: 3 }], ['2026-10-07'])).toBeNull();
    }
  });

  test('attach: sets banner.observedRain from the MRMS days only, with the property coordinates', async () => {
    const instruction = longWindow();
    const fetchMrmsDailyRain = jest.fn(async () => ({ days: [{ date: '2026-10-07', inches: 0.2 }, { date: '2026-10-08', inches: 0.3 }], complete: true }));
    const data = { reportV2: { banner: { state: 'water_in', expiresAt: instruction.waterInBy, lines: instruction.lines } } };
    await attachLiveCloseOut(data, deps({ instruction, latitude: 27.5, longitude: -82.5, now: NOW, fetchMrmsDailyRain }));
    expect(fetchMrmsDailyRain).toHaveBeenCalledWith({ latitude: 27.5, longitude: -82.5, start: '2026-10-07', end: '2026-10-08', signal: expect.any(AbortSignal) });
    expect(data.reportV2.banner.observedRain).toMatchObject({ inches: 0.5, source: 'mrms' });
    expect(data.reportV2.banner.lines).toEqual(instruction.lines);
  });

  test('the 2.5 s deadline wins the race AND aborts the radar request', async () => {
    const instruction = longWindow();
    let seen;
    const fetchMrmsDailyRain = jest.fn(({ signal }) => new Promise((resolve) => {
      seen = signal;
      signal.addEventListener('abort', () => resolve(null));
    }));
    const data = { reportV2: { banner: { state: 'water_in', expiresAt: instruction.waterInBy } } };
    await attachLiveCloseOut(data, deps({ instruction, latitude: 27.5, longitude: -82.5, now: NOW, fetchMrmsDailyRain, deadlineMs: 20 }));
    expect(seen.aborted).toBe(true);
    expect(data.reportV2.banner).not.toHaveProperty('observedRain');
  });

  test('a lookup that answers in time is not aborted', async () => {
    const instruction = longWindow();
    let seen;
    const fetchMrmsDailyRain = jest.fn(async ({ signal }) => { seen = signal; return { days: [{ date: '2026-10-07', inches: 0.4 }] }; });
    const data = { reportV2: { banner: { state: 'water_in', expiresAt: instruction.waterInBy } } };
    await attachLiveCloseOut(data, deps({ instruction, latitude: 27.5, longitude: -82.5, now: NOW, fetchMrmsDailyRain, deadlineMs: 500 }));
    expect(seen.aborted).toBe(false);
    expect(data.reportV2.banner.observedRain.inches).toBe(0.4);
  });

  test('fail open: radar down, slow, no coordinates, expired banner, or a hold banner leave the banner alone', async () => {
    const instruction = longWindow();
    const mk = () => ({ reportV2: { banner: { state: 'water_in', expiresAt: instruction.waterInBy } } });
    const cases = [
      [deps({ instruction, latitude: 27.5, longitude: -82.5, now: NOW, fetchMrmsDailyRain: async () => null }), mk()],
      [deps({ instruction, latitude: 27.5, longitude: -82.5, now: NOW, fetchMrmsDailyRain: async () => { throw new Error('down'); } }), mk()],
      [deps({ instruction, latitude: null, longitude: null, now: NOW, fetchMrmsDailyRain: async () => ({ days: [{ date: '2026-10-07', inches: 9 }] }) }), mk()],
      [deps({ instruction, latitude: 0, longitude: 0, now: NOW, fetchMrmsDailyRain: async () => ({ days: [{ date: '2026-10-07', inches: 9 }] }) }), mk()],
      [deps({ instruction, latitude: 27.5, longitude: -82.5, now: new Date('2026-10-12T12:00:00Z'), fetchMrmsDailyRain: async () => ({ days: [{ date: '2026-10-07', inches: 9 }] }) }), mk()],
      [deps({ instruction: holdInstruction(), latitude: 27.5, longitude: -82.5, now: NOW, fetchMrmsDailyRain: async () => ({ days: [{ date: '2026-10-07', inches: 9 }] }) }), { reportV2: { banner: { state: 'hold' } } }],
    ];
    for (const [d, data] of cases) {
      await attachLiveCloseOut(data, d);
      expect(data.reportV2.banner).not.toHaveProperty('observedRain');
    }
  });
});
