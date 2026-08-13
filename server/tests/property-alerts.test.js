// Property alerts engine (portal roadmap bet 6, owner rulings 2026-08-13:
// push + bell; launch rules rain/skip-irrigation + clean-inspection
// reassurance). Pins the honesty rules (partial rain window never alerts,
// findings veto the "no activity" claim), the frequency caps, and the
// gate/shadow + route contracts.

jest.mock('../services/lawn-water-area', () => ({
  ...jest.requireActual('../services/lawn-water-area'),
  getAreaRainfall: jest.fn(async () => null),
}));
jest.mock('../services/notification-service', () => ({
  notifyCustomer: jest.fn(async () => ({ id: 'note-1' })),
}));

const { getAreaRainfall } = require('../services/lawn-water-area');
const NotificationService = require('../services/notification-service');
const {
  runPropertyAlertsSweep,
  _test: {
    triggeredRainAreas, rainRuleCandidates, reassuranceRuleCandidates,
    candidatePassesCaps, deliverAlert, RAIN_ALERT_INCHES, CHINCH_SEASON_MONTHS,
  },
} = require('../services/property-alerts');

const daysAgoDate = (n) => new Date(Date.now() - n * 24 * 3600 * 1000);
const daysAgoDay = (n) => daysAgoDate(n).toISOString().slice(0, 10);

// Table-keyed knex fake: rows resolve from `tables`, inserts are captured.
// Object-form where criteria ARE honored (the caps exact-key probe depends
// on it); 2-arg/range wheres are no-ops like the other suites' fakes.
function knexFor(tables = {}) {
  const inserts = [];
  const fn = (table) => {
    const rows = tables[table] || [];
    const filters = [];
    const matches = (row) => filters.every((f) => Object.entries(f).every(
      ([key, value]) => !(key in row) || row[key] === value
    ));
    const q = {
      where(criteria) {
        if (criteria && typeof criteria === 'object') filters.push(criteria);
        return q;
      },
      whereIn() { return q; },
      whereNull() { return q; },
      whereNotNull() { return q; },
      join() { return q; },
      groupBy() { return q; },
      orderBy() { return q; },
      limit() { return q; },
      select: async () => rows.filter(matches),
      first: async () => rows.filter(matches)[0] || null,
      insert(row) {
        inserts.push({ table, row });
        return {
          onConflict: () => ({
            ignore: () => ({
              returning: async () => (tables.__conflict ? [] : [{ id: 'alert-1' }]),
            }),
          }),
        };
      },
    };
    return q;
  };
  fn.__inserts = inserts;
  return fn;
}

// A "now" inside chinch season (July) and one outside (January).
const JULY_NOW = new Date('2026-07-15T16:00:00Z');
const JAN_NOW = new Date('2026-01-15T16:00:00Z');

beforeEach(() => {
  jest.clearAllMocks();
  getAreaRainfall.mockImplementation(async () => null);
  NotificationService.notifyCustomer.mockImplementation(async () => ({ id: 'note-1' }));
  delete process.env.GATE_PROPERTY_ALERTS;
});

describe('rain rule', () => {
  test('a partial window (null rainfall) never alerts — undercounts stay silent', async () => {
    const knex = knexFor({ lawn_water_areas: [{ id: 'area-1', rain_adjustment_factor: 1 }] });
    getAreaRainfall.mockImplementation(async () => null);
    const triggered = await triggeredRainAreas({ knex });
    expect(triggered.size).toBe(0);
  });

  test('calibration factor applies before the threshold', async () => {
    const knex = knexFor({ lawn_water_areas: [{ id: 'area-1', rain_adjustment_factor: 0.5 }] });
    // Raw 2.0" × 0.5 = 1.0" adjusted — below the 1.5" threshold.
    getAreaRainfall.mockImplementation(async () => 2.0);
    expect((await triggeredRainAreas({ knex })).size).toBe(0);
    // Raw 4.0" × 0.5 = 2.0" — over.
    getAreaRainfall.mockImplementation(async () => 4.0);
    const triggered = await triggeredRainAreas({ knex });
    expect(triggered.get('area-1')).toBe(2);
  });

  test('candidates carry the adjusted figure and a window-scoped dedupe key', async () => {
    const knex = knexFor({
      lawn_water_areas: [{ id: 'area-1', rain_adjustment_factor: 1 }],
      'customers as c': [{ id: 'cust-1', lawn_water_area_id: 'area-1' }],
    });
    getAreaRainfall.mockImplementation(async () => 2.1);
    const candidates = await rainRuleCandidates({ knex });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].ruleKey).toBe('rain_skip_irrigation');
    expect(candidates[0].body).toContain('2.1"');
    expect(candidates[0].dedupeKey).toMatch(/^rain_skip_irrigation:\d{4}-\d{2}-\d{2}$/);
    expect(candidates[0].body).not.toMatch(/safe/i);
  });
});

describe('reassurance rule', () => {
  const VISIT = (over = {}) => ({
    service_record_id: 'sr-1',
    customer_id: 'cust-1',
    service_type: 'Lawn Care Program',
    service_date: daysAgoDay(9),
    ...over,
  });

  test('fires only in chinch season', async () => {
    expect(CHINCH_SEASON_MONTHS.has(6)).toBe(true); // July
    const knex = knexFor({ 'service_records as sr': [VISIT()], service_findings: [] });
    expect(await reassuranceRuleCandidates({ now: JAN_NOW, knex })).toEqual([]);
  });

  test('a clean recent lawn visit produces the reassurance with true recency', async () => {
    const visitDay = '2026-07-06'; // 9 days before JULY_NOW
    const knex = knexFor({
      'service_records as sr': [VISIT({ service_date: visitDay })],
      service_findings: [{ service_record_id: 'sr-1', category: 'no_activity', severity: 'info' }],
    });
    const candidates = await reassuranceRuleCandidates({ now: JULY_NOW, knex });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].body).toContain('9 days ago');
    // The claim matches the generic no_activity evidence — never a
    // chinch-specific assertion the visit did not record (codex #3390 P1).
    expect(candidates[0].body).toContain('no lawn issues were found');
    expect(candidates[0].body).not.toContain('no chinch bug activity');
    expect(candidates[0].dedupeKey).toBe('lawn_inspection_reassurance:sr-1');
  });

  test('any real finding on the visit vetoes the "no activity" claim', async () => {
    const knex = knexFor({
      'service_records as sr': [VISIT({ service_date: '2026-07-06' })],
      service_findings: [{ service_record_id: 'sr-1', category: 'observation', severity: 'moderate' }],
    });
    expect(await reassuranceRuleCandidates({ now: JULY_NOW, knex })).toEqual([]);
  });

  test('an info-severity finding vetoes too — severity never launders a finding into "clean"', async () => {
    const knex = knexFor({
      'service_records as sr': [VISIT({ service_date: '2026-07-06' })],
      service_findings: [
        { service_record_id: 'sr-1', category: 'no_activity' },
        { service_record_id: 'sr-1', category: 'conducive_condition', severity: 'info' },
      ],
    });
    expect(await reassuranceRuleCandidates({ now: JULY_NOW, knex })).toEqual([]);
  });

  test('a visit with NO findings rows proves nothing and never reassures', async () => {
    const knex = knexFor({
      'service_records as sr': [VISIT({ service_date: '2026-07-06' })],
      service_findings: [],
    });
    expect(await reassuranceRuleCandidates({ now: JULY_NOW, knex })).toEqual([]);
  });

  test('non-lawn visits never carry the lawn claim', async () => {
    const knex = knexFor({
      'service_records as sr': [VISIT({ service_type: 'Quarterly Pest Control', service_date: '2026-07-06' })],
      service_findings: [],
    });
    expect(await reassuranceRuleCandidates({ now: JULY_NOW, knex })).toEqual([]);
  });
});

describe('frequency caps', () => {
  const CANDIDATE = {
    customerId: 'cust-1',
    ruleKey: 'rain_skip_irrigation',
    dedupeKey: 'rain_skip_irrigation:2026-07-14',
    cooldownDays: 7,
  };

  test('ANY alert within the cross-rule window blocks a new one', async () => {
    const knex = knexFor({
      customer_alerts: [{ customer_id: 'cust-1', rule_key: 'lawn_inspection_reassurance', dedupe_key: 'other', fired_at: daysAgoDate(2) }],
    });
    expect(await candidatePassesCaps(CANDIDATE, { knex })).toBe(false);
  });

  test('an old alert outside every window passes', async () => {
    const knex = knexFor({
      customer_alerts: [{ customer_id: 'cust-1', rule_key: 'rain_skip_irrigation', dedupe_key: 'old', fired_at: daysAgoDate(30) }],
    });
    expect(await candidatePassesCaps(CANDIDATE, { knex })).toBe(true);
  });

  test('the exact dedupe key never refires regardless of age (unbounded probe)', async () => {
    // 30 days old — far outside every cooldown window; only the dedicated
    // unbounded exact-key probe can catch it (codex #3390 P2).
    const knex = knexFor({
      customer_alerts: [{ customer_id: 'cust-1', rule_key: 'rain_skip_irrigation', dedupe_key: CANDIDATE.dedupeKey, fired_at: daysAgoDate(30) }],
    });
    expect(await candidatePassesCaps(CANDIDATE, { knex })).toBe(false);
  });
});

describe('delivery', () => {
  const CANDIDATE = {
    customerId: 'cust-1', ruleKey: 'rain_skip_irrigation',
    dedupeKey: 'rain_skip_irrigation:2026-07-14',
    title: 'Heavy rain in your area', body: 'body', payload: {},
  };

  test('notify FIRST (weather_alerts preference key), ledger only after a durable bell', async () => {
    const knex = knexFor({});
    const outcome = await deliverAlert(CANDIDATE, { knex });
    expect(outcome.delivered).toBe(true);
    expect(NotificationService.notifyCustomer).toHaveBeenCalledWith(
      'cust-1', 'lawn_health', CANDIDATE.title, CANDIDATE.body,
      expect.objectContaining({ dedupeKey: CANDIDATE.dedupeKey, preferenceKey: 'weather_alerts' }),
    );
    expect(knex.__inserts).toHaveLength(1);
    expect(knex.__inserts[0].table).toBe('customer_alerts');
  });

  test('a preference opt-out ledgers NOTHING — no portal row, no consumed cap', async () => {
    NotificationService.notifyCustomer.mockImplementation(async () => ({ id: null, suppressed: true }));
    const knex = knexFor({});
    const outcome = await deliverAlert(CANDIDATE, { knex });
    expect(outcome).toEqual({ delivered: false, reason: 'preference_disabled' });
    expect(knex.__inserts).toHaveLength(0);
  });

  test('a notify failure (null) ledgers nothing so the next sweep can retry', async () => {
    NotificationService.notifyCustomer.mockImplementation(async () => null);
    const knex = knexFor({});
    const outcome = await deliverAlert(CANDIDATE, { knex });
    expect(outcome).toEqual({ delivered: false, reason: 'notify_failed' });
    expect(knex.__inserts).toHaveLength(0);
  });

  test('a deduped bell (multi-pod re-fire) still backfills the ledger row without a second push', async () => {
    NotificationService.notifyCustomer.mockImplementation(async () => ({ id: 'note-1', deduped: true }));
    const knex = knexFor({});
    const outcome = await deliverAlert(CANDIDATE, { knex });
    expect(outcome).toEqual({ delivered: true, deduped: true });
    expect(knex.__inserts).toHaveLength(1);
  });

  test("a customer's own quiet hours skip delivery entirely — no bell, no ledger, no consumed cap", async () => {
    const knex = knexFor({
      notification_prefs: [{ customer_id: 'cust-1', quiet_hours_start: '00:00', quiet_hours_end: '23:59' }],
    });
    const outcome = await deliverAlert(CANDIDATE, { knex });
    expect(outcome).toEqual({ delivered: false, reason: 'quiet_hours' });
    expect(NotificationService.notifyCustomer).not.toHaveBeenCalled();
    expect(knex.__inserts).toHaveLength(0);
  });

  test('no quiet-hours window configured → delivery proceeds', async () => {
    const knex = knexFor({
      notification_prefs: [{ customer_id: 'cust-1', quiet_hours_start: null, quiet_hours_end: null }],
    });
    const outcome = await deliverAlert(CANDIDATE, { knex });
    expect(outcome.delivered).toBe(true);
  });
});

describe('sweep gate', () => {
  test('gate off: shadow-logs candidates, delivers nothing', async () => {
    const knex = knexFor({
      lawn_water_areas: [{ id: 'area-1', rain_adjustment_factor: 1 }],
      'customers as c': [{ id: 'cust-1', lawn_water_area_id: 'area-1' }],
      'service_records as sr': [],
    });
    getAreaRainfall.mockImplementation(async () => 3.0);
    const summary = await runPropertyAlertsSweep({ now: JAN_NOW, knex });
    expect(summary.gate).toBe('off');
    expect(summary.candidates).toBe(1);
    expect(summary.delivered).toBe(0);
    expect(NotificationService.notifyCustomer).not.toHaveBeenCalled();
    expect(knex.__inserts).toHaveLength(0);
  });

  test('gate on: candidates flow through caps to delivery', async () => {
    process.env.GATE_PROPERTY_ALERTS = 'true';
    const knex = knexFor({
      lawn_water_areas: [{ id: 'area-1', rain_adjustment_factor: 1 }],
      'customers as c': [{ id: 'cust-1', lawn_water_area_id: 'area-1' }],
      'service_records as sr': [],
      customer_alerts: [],
    });
    getAreaRainfall.mockImplementation(async () => 3.0);
    const summary = await runPropertyAlertsSweep({ now: JAN_NOW, knex });
    expect(summary.gate).toBe('on');
    expect(summary.delivered).toBe(1);
    expect(NotificationService.notifyCustomer).toHaveBeenCalledTimes(1);
  });
});

describe('route contract', () => {
  const express = require('express');
  let server = null;
  const listen = (app) => new Promise((resolve) => {
    server = app.listen(0, () => resolve(`http://127.0.0.1:${server.address().port}`));
  });

  function appWithGate(gateOn) {
    jest.doMock('../middleware/auth', () => ({
      authenticate: (req, _res, nextFn) => { req.customerId = 'cust-1'; nextFn(); },
    }));
    jest.doMock('../services/property-alerts', () => ({
      listCustomerAlerts: async () => [{ id: 'a1', ruleKey: 'rain_skip_irrigation', title: 't', body: 'b', firedAt: new Date().toISOString() }],
    }));
    let router;
    jest.isolateModules(() => { router = require('../routes/property-alerts'); });
    const app = express();
    app.use((req, _res, nextFn) => {
      process.env.GATE_PROPERTY_ALERTS = gateOn ? 'true' : '';
      nextFn();
    });
    app.use('/api/property-alerts', router);
    return app;
  }

  afterEach(async () => {
    delete process.env.GATE_PROPERTY_ALERTS;
    jest.dontMock('../middleware/auth');
    jest.dontMock('../services/property-alerts');
    if (server) { await new Promise((resolve) => server.close(resolve)); server = null; }
  });

  test('gate off answers available:false; gate on lists alerts', async () => {
    const offBase = await listen(appWithGate(false));
    const off = await fetch(`${offBase}/api/property-alerts/`);
    expect(await off.json()).toEqual({ available: false, reason: 'disabled' });
    await new Promise((resolve) => server.close(resolve)); server = null;

    const onBase = await listen(appWithGate(true));
    const on = await (await fetch(`${onBase}/api/property-alerts/`)).json();
    expect(on.available).toBe(true);
    expect(on.alerts).toHaveLength(1);
  });
});
