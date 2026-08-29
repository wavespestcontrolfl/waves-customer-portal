/**
 * The lawn report attaches the weekly plan only to a service at the HOME the
 * sweep decided it for — full premise identity, unit included (GH codex #3565
 * r8 P1 + pre-push P1). Source pin on the binding predicate.
 */
const fs = require('fs');
const path = require('path');
const { premiseStampConflicts, stampedAddressDiverges } = require('../services/stamped-address');

describe('week-plan premise binding', () => {
  test('report-data gates the plan on stampedAddressDiverges OR premiseStampConflicts against the snapshot home', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/service-report/report-data.js'), 'utf8');
    expect(src).toMatch(/const servicedElsewhere = !!snapshot && !planBindsToService\(snapshot, service\);/);
    expect(src).toMatch(/if \(snapshot\?\.plan && !servicedElsewhere\) \{/);
    // …and the cache signature applies the same binding, so an address change re-keys cached PDFs.
    expect(src).toMatch(/weekPlanSentAt = snapshot\?\.sentAt && planBindsToService\(snapshot, premise\) \? new Date\(snapshot\.sentAt\)\.toISOString\(\) : null;/);
    // The canonical lookup is STRICT and outside the fail-open prefs catch: a failure propagates (render refused), never plan=none.
    expect(src).toMatch(/const snapshot = await loadCurrentWeekPlan\(service\.customer_id, \{ strict: true \}\);/);
    // The report renderer receives the snapshot's restriction (hour constraints).
    expect(src).toMatch(/renderWeekPlanReport\(snapshot\.plan, \{ runMinutes: [^}]*, restriction: snapshot\.restriction \|\| null \}\)/);
  });

  test('two units in one building are different homes; the same premise is not', () => {
    const home = { service_address_line1: '100 Main St', service_address_line2: 'Unit 4', service_address_city: 'Bradenton', service_address_zip: '34205' };
    const otherUnit = { ...home, service_address_line2: 'Unit 7' };
    const unitless = { ...home, service_address_line2: null };
    expect(premiseStampConflicts(otherUnit, home)).toBe(true);
    expect(premiseStampConflicts(unitless, home)).toBe(true); // a one-sided unit diverges
    expect(premiseStampConflicts({ ...home }, home)).toBe(false);
    // The street/zip/city leg alone would have treated the units as one home.
    expect(stampedAddressDiverges({ service_address_line1: '100 Main St', service_address_city: 'Bradenton', service_address_zip: '34205', customer_address_line1: '100 Main St', customer_city: 'Bradenton', customer_zip: '34205' })).toBe(false);
  });
});

describe('planBindsToService', () => {
  const { planBindsToService } = require('../services/irrigation-week-plan');
  const snap = { decisionInputs: { home: { addressLine1: '100 Main St', addressLine2: 'Unit 4', city: 'Bradenton', zip: '34205' } } };
  test('binds only to the same premise; rental / moved / other unit do not', () => {
    expect(planBindsToService(snap, { address_line1: '100 Main St', address_line2: 'Unit 4', city: 'Bradenton', zip: '34205' })).toBe(true);
    expect(planBindsToService(snap, { address_line1: '100 Main St', address_line2: 'Unit 7', city: 'Bradenton', zip: '34205' })).toBe(false);
    expect(planBindsToService(snap, { address_line1: '9 Beach Rd', address_line2: null, city: 'Port Charlotte', zip: '33948' })).toBe(false);
    // gh-r37: same street + same ZIP with a postal-city alias (Bradenton ↔ Lakewood Ranch) is the SAME home — the plan stays bound.
    expect(planBindsToService(snap, { address_line1: '100 Main St', address_line2: 'Unit 4', city: 'Lakewood Ranch', zip: snap.decisionInputs.home.zip })).toBe(true);
    expect(planBindsToService(snap, { address_line1: '100 Main Street Unit 4', address_line2: null, city: null, zip: null })).toBe(true); // suffix + inline unit + missing place ≠ contradiction
    expect(planBindsToService({ decisionInputs: {} }, { address_line1: '9 Beach Rd' })).toBe(true); // no home recorded → legacy snapshot, no binding
  });
});

describe('visitInPlanWeek (codex gh-r14: no historical watering-in credit)', () => {
  const { visitInPlanWeek } = require('../services/irrigation-week-plan');
  const snap = { weekEnding: '2026-08-23', decisionInputs: { planWeekEnd: '2026-08-30' } };
  test('a visit inside the plan week (Mon..Sun after week_ending) counts', () => {
    expect(visitInPlanWeek(snap, '2026-08-24')).toBe(true);
    expect(visitInPlanWeek(snap, new Date('2026-08-30T15:00:00Z'))).toBe(true);
  });
  test('the completed week, an older visit, and a visit past planWeekEnd do not', () => {
    expect(visitInPlanWeek(snap, '2026-08-23')).toBe(false);
    expect(visitInPlanWeek(snap, '2026-07-10')).toBe(false);
    expect(visitInPlanWeek(snap, '2026-08-31')).toBe(false);
  });
  test('falls back to week_ending + 7 without planWeekEnd; missing dates never credit', () => {
    expect(visitInPlanWeek({ weekEnding: '2026-08-23', decisionInputs: {} }, '2026-08-30')).toBe(true);
    expect(visitInPlanWeek({ weekEnding: '2026-08-23', decisionInputs: {} }, '2026-08-31')).toBe(false);
    expect(visitInPlanWeek({ weekEnding: null }, '2026-08-24')).toBe(false);
    expect(visitInPlanWeek(snap, null)).toBe(false);
  });
  test('report-data stamps the rendered plan with visitInPlanWeek for the assessment date', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'service-report', 'report-data.js'), 'utf8');
    expect(src).toMatch(/visitInPlanWeek: visitInPlanWeek\(snapshot, assessment\.service_date\)/);
  });
});

describe('cache-key premise resolution (codex gh-r16: partial lookup rows must not match every snapshot)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'service-report', 'report-data.js'), 'utf8');
  test('resolveCanonicalLawnRender resolves the premise before binding the snapshot, and binds against it', () => {
    expect(src).toMatch(/const premise = await loadServicePremise\(service, knex\);/);
    expect(src).toMatch(/planBindsToService\(snapshot, premise\)/);
    expect(src).toMatch(/premise\.stamped_address_diverges !== true/);
  });
  test('loadServicePremise reads the same stamped-else-home columns as the full render row', () => {
    const fn = src.slice(src.indexOf('async function loadServicePremise'), src.indexOf('async function lawnAssessmentPdfSignature'));
    expect(fn).toMatch(/COALESCE\(ss\.service_address_line1, customers\.address_line1\) as address_line1/);
    expect(fn).toMatch(/stampedDivergesSql\('ss', 'customers'\)\} as stamped_address_diverges/);
    expect(fn).toMatch(/if \(!row\) throw new Error/);
  });
  test('loadServicePremise is a no-op on a full row and resolves a partial one through the join', async () => {
    const { loadServicePremise } = require('../services/service-report/report-data');
    const full = { id: 'sr1', address_line1: '1 Main St', stamped_address_diverges: false };
    expect(await loadServicePremise(full, () => { throw new Error('must not query'); })).toBe(full);
    const calls = [];
    const chain = {
      where(w) { calls.push(['where', w]); return chain; },
      leftJoin(...a) { calls.push(['leftJoin', a[0]]); return chain; },
      first: async () => ({ address_line1: '9 Rental Rd', address_line2: null, city: 'Bradenton', zip: '34205', stamped_address_diverges: true }),
    };
    const knex = Object.assign(() => chain, { raw: (sql) => sql });
    const out = await loadServicePremise({ id: 'sr1', customer_id: 'c1' }, knex);
    expect(out).toMatchObject({ id: 'sr1', customer_id: 'c1', address_line1: '9 Rental Rd', stamped_address_diverges: true });
    expect(calls).toEqual(expect.arrayContaining([['where', { 'service_records.id': 'sr1' }], ['leftJoin', 'scheduled_services as ss']]));
    const gone = { where() { return gone; }, leftJoin() { return gone; }, first: async () => null };
    await expect(loadServicePremise({ id: 'gone' }, Object.assign(() => gone, { raw: (x) => x }))).rejects.toThrow(/premise unavailable/);
  });
  test('reports-public maps a refused week-plan pin to 409 like a refused assessment pin', () => {
    const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'reports-public.js'), 'utf8');
    expect(route).toMatch(/err\?\.code === 'pinned_assessment_unavailable' \|\| err\?\.code === 'pinned_week_plan_unavailable'/);
  });
});

describe('strict plan pin outranks the live gate/premise visibility checks (codex gh-r17)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'service-report', 'report-data.js'), 'utf8');
  test('a string pin refuses when the gate is off or the premise now diverges, BEFORE the visibility gate', () => {
    const pin = src.indexOf("if (typeof pinnedWeekPlanSentAt === 'string') {");
    const gate = src.indexOf("if (featureGates.isEnabled('irrigationWeekPlan') && service.stamped_address_diverges !== true) {", pin);
    expect(pin).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(pin);
    const block = src.slice(pin, gate);
    expect(block).toMatch(/if \(!featureGates\.isEnabled\('irrigationWeekPlan'\)\) throw new PinnedWeekPlanUnavailable\('gate_off'\);/);
    expect(block).toMatch(/if \(service\.stamped_address_diverges === true\) throw new PinnedWeekPlanUnavailable\('premise_diverged'\);/);
  });
  test('a string pin whose snapshot no longer binds to this premise (mirror moved, no stamp) refuses too (codex gh-r18)', () => {
    expect(src).toMatch(/if \(servicedElsewhere && typeof pinnedWeekPlanSentAt === 'string'\) throw new PinnedWeekPlanUnavailable\('premise_diverged'\);/);
  });
});

describe('report water context withholds every irrigation source after a move (codex gh-r25)', () => {
  const { buildLawnWaterContext, reportScheduleUnconfirmed } = require('../services/service-report/report-data');
  const prefs = { irrigation_run_minutes: 20, watering_days: JSON.stringify(['Mon']), irrigation_system_type: JSON.stringify(['spray']), irrigation_inches_per_week: null, irrigation_confirmed_fields: '[]', irrigation_home_changed_at: '2026-08-28T00:00:00Z', irrigation_system: true };
  test('portal, turf-profile and assessment figures all withhold; confirmed prefs restore them', () => {
    const args = { assessment: { irrigation_inches_per_week: 0.9 }, turfProfile: { irrigation_inches_per_week: 1.1 }, propertyPrefs: prefs, completionRainfall7dInches: 0.3 };
    expect(reportScheduleUnconfirmed(args)).toBe(true);
    const moved = buildLawnWaterContext({ ...args, scheduleUnconfirmed: true });
    expect(moved.irrigationInchesPerWeek ?? null).toBe(null);
    const confirmed = buildLawnWaterContext({ ...args, propertyPrefs: { ...prefs, irrigation_confirmed_fields: JSON.stringify(['irrigation_run_minutes', 'watering_days', 'irrigation_system_type']) } });
    expect(confirmed.irrigationInchesPerWeek).toBeGreaterThan(0);
    // Tech-only schedule after a move is unconfirmed too.
    expect(reportScheduleUnconfirmed({ assessment: {}, turfProfile: { irrigation_inches_per_week: 1.1 }, propertyPrefs: { irrigation_home_changed_at: '2026-08-28T00:00:00Z', irrigation_confirmed_fields: '[]' } })).toBe(true);
    expect(reportScheduleUnconfirmed({ assessment: {}, turfProfile: { irrigation_inches_per_week: 1.1 }, propertyPrefs: { irrigation_confirmed_fields: '[]' } })).toBe(false);
  });
  test('the render wires the flag and the PDF signature stamps the move + confirmation state', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'service-report', 'report-data.js'), 'utf8');
    expect(src).toMatch(/scheduleUnconfirmed: lawnScheduleUnconfirmed,/);
    expect(src).toMatch(/waterContext\.scheduleUnconfirmed = lawnScheduleUnconfirmed;/);
    expect(src).toMatch(/:moved=\$\{prefs\?\.irrigation_home_changed_at/);
  });
});

describe('lawn-report-v2 mapWater carries the moved-home flag and withholds snapshot totals (hook P1 on a40e19f53)', () => {
  const { mapWater } = require('../services/service-report/lawn-report-v2');
  const snapshot = { status: 'high', rain_7day_inches: 0.4, irrigation_inches_per_week: 1.2, total_water_7day_inches: 1.6, target_water_inches_per_week: 0.75, confidence: 'medium' };
  test('area-snapshot path: unconfirmed → the snapshot (figures AND status) is skipped entirely (codex gh-r39)', () => {
    // The stored status was computed from the withheld figures — the card must
    // not show a high/low verdict from the former home's schedule; the live
    // context answers instead (unknown status, no stale totals).
    const w = mapWater({ rainfallInches7d: null, scheduleUnconfirmed: true, weekPlan: { title: 'p' } }, snapshot);
    expect(w.source).toBe('irrigation_advice');
    expect(w.status).toBe('unknown');
    expect(w.irrigationInches).toBe(null);
    expect(w.totalInches).toBe(null);
    expect(w.scheduleOnFile).toBe(false);
    expect(w.scheduleUnconfirmed).toBe(true);
    expect(w.explanation).toMatch(/re-entry after your address change/);
    expect(w.explanation).not.toMatch(/schedule on file/);
    expect(w.weekPlan).toEqual({ title: 'p' });
    const ok = mapWater({ rainfallInches7d: null }, snapshot);
    expect(ok.source).toBe('area_snapshot');
    expect(ok.irrigationInches).toBe(1.2);
    expect(ok.totalInches).toBe(1.6);
    expect(ok.scheduleUnconfirmed).toBe(false);
  });
  test('advice path carries the flag', () => {
    expect(mapWater({ rainfallInches7d: 0.3, irrigationAdvice: { profileMissing: true }, scheduleUnconfirmed: true }).scheduleUnconfirmed).toBe(true);
    expect(mapWater({ rainfallInches7d: 0.3, irrigationAdvice: { profileMissing: false } }).scheduleUnconfirmed).toBe(false);
  });
});
