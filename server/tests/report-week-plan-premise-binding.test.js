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
    expect(src).toMatch(/const servicedElsewhere = !!home && \([\s\S]{0,400}stampedAddressDiverges\(\{[\s\S]{0,400}\|\| premiseStampConflicts\(serviceStamp, homeStamp\)/);
    expect(src).toMatch(/if \(snapshot\?\.plan && !servicedElsewhere\) \{/);
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
