// ops/agents/arrival-timing-report.js — the pure half and its read-only guard. The report decides whether
// GATE_ARRIVAL_ENGINE_OFF can be flipped, so a wrong sign, a wrong arrival match or a still stretch carried across
// an engine-off would mislead that call.
jest.mock('../models/db', () => jest.fn());

const path = require('path');
const report = require(path.join(__dirname, '..', '..', 'ops', 'agents', 'arrival-timing-report.js'));

const HOUSE = { lat: 27.35, lng: -82.45 };
const at = (hhmmss) => `2026-10-20T${hhmmss}Z`;
const sampleAt = (hhmmss, overrides = {}) => ({ trip: 'trip-1', ...HOUSE, speed: 0, ms: Date.parse(at(hhmmss)), ...overrides });

describe('arrival-timing-report', () => {
  test('the GPS arrival that set arrived_at is the closest audit row within 2 minutes, metadata parsed', () => {
    const rows = [
      { created_at: at('13:40:00'), metadata: { decision_reason: 'inside_immediate_radius' } },
      { created_at: at('14:00:40'), metadata: '{"decision_reason":"inside_arrival_radius_slow","distance_meters":140}' },
      { created_at: at('14:01:30'), metadata: { decision_reason: 'inside_immediate_radius' } },
    ];
    expect(report.gpsArrivalFor(rows, at('14:00:00')).metadata)
      .toEqual({ decision_reason: 'inside_arrival_radius_slow', distance_meters: 140 });
    expect(report.gpsArrivalFor(rows, at('14:20:00'))).toBeNull(); // a tap or a sibling set this stamp
    expect(report.gpsArrivalFor(rows, null)).toBeNull();
  });

  test('a visit row: positive minutes = marked before the truck parked; the arrival source is named', () => {
    const leg = { scheduled_service_id: '17309f13-aaaa-4bbb-8ccc-000000000001', service_date: '2026-10-20', status: 'matched', gps_arrived_at: at('14:03:00') };
    const gps = { metadata: { decision_reason: 'inside_arrival_radius_slow', distance_meters: 140, ignition: null } };
    expect(report.visitRow({ leg, visit: { arrived_at: at('14:00:00') }, gps })).toEqual({
      visit: '17309f13', day: '2026-10-20', status: 'matched', arrival: 'gps',
      rule: 'inside_arrival_radius_slow', distanceM: 140, ignition: null, earlyMin: 3,
    });
    expect(report.visitRow({ leg, visit: { arrived_at: at('14:05:00') }, gps: null }))
      .toMatchObject({ arrival: 'other', rule: null, earlyMin: -2 });
    expect(report.visitRow({ leg: { ...leg, status: 'no_stop', gps_arrived_at: null }, visit: { arrived_at: null }, gps: null }))
      .toMatchObject({ arrival: 'none', earlyMin: null });
  });

  test('the summary times only GPS arrivals with a stop, by rule, and counts the ones without one', () => {
    const row = (earlyMin, rule, extra = {}) => ({ status: 'matched', arrival: 'gps', rule, distanceM: 100, ignition: null, earlyMin, ...extra });
    const summary = report.summarize([
      row(0.5, 'inside_immediate_radius', { distanceM: 40 }),
      row(2, 'inside_arrival_radius_slow'),
      row(4, 'inside_arrival_radius_slow'),
      row(6, 'inside_arrival_radius_slow'),
      row(-1, 'inside_arrival_radius_slow'),
      row(null, 'inside_immediate_radius', { status: 'no_stop', ignition: false }),
      { status: 'matched', arrival: 'other', rule: null, distanceM: null, ignition: null, earlyMin: 9 },
    ]);
    expect(summary.visits).toBe(7);
    expect(summary.arrivals).toEqual({ gps: 6, other: 1 });
    expect(summary.byStatus).toEqual({ matched: 6, no_stop: 1 });
    expect(summary.gpsVsParked).toEqual({
      n: 5, medianMin: 2, p75Min: 4, p90Min: 6, maxMin: 6, over1Min: 3, over3Min: 2, over5Min: 1, afterParking: 1,
    });
    expect(summary.byRule.inside_arrival_radius_slow).toMatchObject({ n: 4, medianMin: 2, medianDistanceM: 100 });
    expect(summary.byRule.inside_immediate_radius).toMatchObject({ n: 1, medianDistanceM: 40 });
    expect(summary.gpsWithoutStop).toBe(1);
    expect(summary.gpsWithIgnitionOff).toBe(1);
  });

  test('a still stretch stays on one trip and one spot; the longest silence is the widest gap between samples', () => {
    const window = { fromMs: Date.parse(at('15:00:00')), toMs: Date.parse(at('15:12:00')) };
    const samples = [
      sampleAt('14:50:00'), // before the window
      sampleAt('15:00:00', { speed: 15, lat: HOUSE.lat + 0.004 }),
      sampleAt('15:02:00'), sampleAt('15:04:00'), sampleAt('15:08:00'), // 6 min still, then a 4 min silence
      sampleAt('15:09:00', { trip: 'trip-2' }), // the engine went off and on: a new stretch
      sampleAt('15:10:00', { trip: 'trip-2' }),
      sampleAt('15:11:00', { trip: 'trip-2', lat: HOUSE.lat + 0.0005 }), // moved 55 m: a new stretch
    ];
    expect(report.stillEvidence(samples, window)).toEqual({ samples: 7, longestStillS: 360, longestSilenceS: 240 });
  });

  test('the silence also counts from the arrival to the first sample and from the last sample to completion', () => {
    const window = { fromMs: Date.parse(at('15:00:00')), toMs: Date.parse(at('15:30:00')) };
    // Bouncie went quiet 10 seconds after the arrival: 29 min 50 s of silence, not 10 s.
    expect(report.stillEvidence([sampleAt('15:00:00'), sampleAt('15:00:10')], window).longestSilenceS).toBe(1790);
    // the first sample came 20 minutes after the arrival
    expect(report.stillEvidence([sampleAt('15:20:00'), sampleAt('15:25:00'), sampleAt('15:30:00')], window).longestSilenceS)
      .toBe(1200);
    // no sample during the visit: silent throughout
    expect(report.stillEvidence([sampleAt('14:50:00')], window)).toEqual({ samples: 0, longestStillS: 0, longestSilenceS: 1800 });
  });

  test('trip events: GPS points and end times are counted per normalized type', () => {
    const tally = {};
    report.tallyEvent(tally, { event_type: 'trip-end', payload: { end: { timestamp: at('14:03:10'), odometer: 100 } } });
    report.tallyEvent(tally, { event_type: 'tripEnd', payload: '{"end":{"timestamp":"2026-10-20T15:00:00Z","gps":{"lat":27.35,"lon":-82.45}}}' });
    report.tallyEvent(tally, { event_type: 'trip-start', payload: { start: { timestamp: at('14:40:00'), gps: { lat: 27.35, lon: -82.45 } } } });
    expect(tally).toEqual({
      'trip-end': { rows: 2, withGps: 1, withEndTime: 2 },
      'trip-start': { rows: 1, withGps: 1, withEndTime: 0 },
    });
  });

  test('a technician-day trip link could not judge is reported, never silently dropped from the numbers', async () => {
    const leg = (id) => ({ scheduled_service_id: id, status: 'matched' });
    const linkDay = jest.fn(async (conn, day) => (day === '2026-10-21'
      ? { errors: 2, rows: { legs: [leg('b')] } }
      : { errors: 0, rows: { legs: [leg('a')] } }));

    const result = await report.linkedLegs(linkDay, 'conn', ['2026-10-20', '2026-10-21'], 175);

    expect(linkDay).toHaveBeenCalledWith('conn', '2026-10-20', { dryRun: true, radius: 175 });
    expect(result).toEqual({ legs: [leg('a'), leg('b')], failed: [{ day: '2026-10-21', technicianDays: 2 }] });
  });

  test('the read-only guard runs only when Postgres refuses the write probe', async () => {
    const conn = (outcome) => ({ raw: jest.fn(() => outcome) });
    await expect(report.assertReadOnly(conn(Promise.reject(new Error('cannot execute UPDATE in a read-only transaction')))))
      .resolves.toBeUndefined();
    await expect(report.assertReadOnly(conn(Promise.resolve({ rowCount: 0 })))).rejects.toThrow('READ-ONLY SELF-CHECK FAILED');
    await expect(report.assertReadOnly(conn(Promise.reject(new Error('relation does not exist')))))
      .rejects.toThrow('without the read-only rejection');
  });
});
