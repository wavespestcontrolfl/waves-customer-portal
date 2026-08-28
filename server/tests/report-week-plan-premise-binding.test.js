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
    expect(src).toMatch(/weekPlanSentAt = snapshot\?\.sentAt && planBindsToService\(snapshot, service\) \? new Date\(snapshot\.sentAt\)\.toISOString\(\) : null;/);
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
