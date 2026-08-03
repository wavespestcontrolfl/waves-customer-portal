// Freezing the week's weather onto the record (owner ruling 2026-08-03).
//
// Keying the weather fetch to the service date already made a report stable
// across renders — but only while the ANSWER for that date stayed the same.
// Flipping GATE_RAIN_MRMS changed the provider underneath and issued reports
// silently restated their rainfall: a live token went 1.15" to 3.23" for a
// visit days earlier. A report token is a permanent, shareable customer
// document, so the first successful render freezes the week and every later
// render replays it.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const { freezeLawnWeekWeather } = require('../services/service-report/report-data');

const WEEK = {
  rainInches: 3.23,
  et0Inches: 1.4,
  dailyRain: [{ date: '2026-07-30', inches: 1.1 }],
  rainConfidence: 'high',
  rainSource: 'mrms',
  frozenAt: '2026-08-03T04:00:00.000Z',
};

// knex stub capturing the UPDATE and its predicate.
function makeKnex({ matched = 1 } = {}) {
  const state = { wheres: [], raws: [], patches: [] };
  const knex = jest.fn((table) => {
    expect(table).toBe('service_records');
    const chain = {
      where: jest.fn((c) => { state.wheres.push(c); return chain; }),
      whereRaw: jest.fn((sql) => { state.raws.push(sql); return chain; }),
      update: jest.fn(async (patch) => { state.patches.push(patch); return matched; }),
    };
    return chain;
  });
  knex.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  return { knex, state };
}

describe('freezeLawnWeekWeather', () => {
  test('writes the week under lawnWeekWeather via an ATOMIC jsonb merge', async () => {
    const { knex, state } = makeKnex();
    await expect(freezeLawnWeekWeather('svc-1', WEEK, knex)).resolves.toBe(true);

    expect(state.wheres[0]).toEqual({ id: 'svc-1' });
    const patch = state.patches[0];
    // Never a whole-column rewrite: structured_notes also carries completion SMS
    // state and the frozen lawn synthesis, and a read-modify-write here would
    // clobber a concurrent write to those.
    expect(patch.structured_notes.__raw).toContain('||');
    expect(patch.structured_notes.__raw).toContain('jsonb');
    expect(JSON.parse(patch.structured_notes.bindings[0])).toEqual({ lawnWeekWeather: WEEK });
  });

  // The race this closes: a live view and a PDF render can render the same
  // record concurrently and — mid provider-flip — resolve DIFFERENT weeks. A
  // read-then-write would let the later one overwrite what the customer was
  // already shown.
  test('FIRST WRITER WINS — the guard is in the UPDATE predicate, not a prior read', async () => {
    const { knex, state } = makeKnex();
    await freezeLawnWeekWeather('svc-1', WEEK, knex);

    expect(state.raws).toHaveLength(1);
    expect(state.raws[0]).toMatch(/lawnWeekWeather/);
    expect(state.raws[0]).toMatch(/IS NULL/i);
    // No SELECT preceded it — the predicate IS the guard.
    expect(state.wheres).toHaveLength(1);
  });

  test('reports false when another render already froze the week', async () => {
    const { knex } = makeKnex({ matched: 0 });
    await expect(freezeLawnWeekWeather('svc-1', WEEK, knex)).resolves.toBe(false);
  });

  // A failed freeze must never fail a report view; the next render retries.
  test('a write error is swallowed and reported, not thrown', async () => {
    const knex = jest.fn(() => ({
      where: () => ({ whereRaw: () => ({ update: async () => { throw new Error('deadlock'); } }) }),
    }));
    knex.raw = jest.fn(() => ({}));
    await expect(freezeLawnWeekWeather('svc-1', WEEK, knex)).resolves.toBe(false);
    expect(require('../services/logger').warn).toHaveBeenCalled();
  });

  test('nothing to freeze is a no-op', async () => {
    const { knex, state } = makeKnex();
    await expect(freezeLawnWeekWeather(null, WEEK, knex)).resolves.toBe(false);
    await expect(freezeLawnWeekWeather('svc-1', null, knex)).resolves.toBe(false);
    expect(state.patches).toHaveLength(0);
  });
});

describe('freeze contract in the render path', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../services/service-report/report-data.js'), 'utf8');

  test('a frozen week SHORT-CIRCUITS the live weather fetch', () => {
    // If the fetch still ran, the report would keep drifting with the provider
    // and the freeze would be decorative.
    expect(source).toMatch(/frozenWeekWeather[\s\S]{0,400}?fetchServiceWeekWeather/);
    expect(source).toMatch(/const frozenWeekWeather = parseJsonObject\(service\.structured_notes\)\.lawnWeekWeather/);
  });

  test('only a RESOLVED week is frozen', () => {
    // Persisting a null would lock in "no rainfall known" forever, turning a
    // transient provider outage into a permanently blank water card.
    expect(source).toMatch(/if \(completionRainfall7dInches != null\) \{\s*\n\s*await freezeLawnWeekWeather\(/);
  });
});
