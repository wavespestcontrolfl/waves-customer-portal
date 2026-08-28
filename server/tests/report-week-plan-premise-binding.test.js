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
});
