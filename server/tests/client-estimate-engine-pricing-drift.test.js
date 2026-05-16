const fs = require('fs');
const path = require('path');

const clientEstimatorPath = path.resolve(__dirname, '../../client/src/lib/estimateEngine.js');
const legacyAdminEstimatePagePath = path.resolve(__dirname, '../../client/src/pages/admin/EstimatePage.jsx');

describe('deprecated client estimator pricing drift guards', () => {
  let source;
  let legacyAdminSource;

  beforeAll(() => {
    source = fs.readFileSync(clientEstimatorPath, 'utf8');
    legacyAdminSource = fs.readFileSync(legacyAdminEstimatePagePath, 'utf8');
  });

  test('mirrors conservative pest pool cage adjustments', () => {
    expect(source).toContain('const cageAdjBySize = { SMALL: 5, MEDIUM: 8, LARGE: 12, OVERSIZED: 18 };');
  });

  test('mirrors live server pest frequency discounts', () => {
    expect(source).toContain("{ f: 4, label: 'Quarterly', disc: 1.00");
    expect(source).toContain("{ f: 6, label: 'Bi-Monthly', disc: 0.85");
    expect(source).toContain("{ f: 12, label: 'Monthly', disc: 0.70");
    expect(source).not.toContain('disc: 0.92');
  });

  test('keeps recurring roach premium retired in the client display engine', () => {
    expect(source).toContain('const roachAddOn = 0;');
    expect(source).not.toMatch(/basePrice\s*\*\s*0\.15|pp\s*\*\s*0\.15|117\s*\*\s*0\.15/);
  });

  test('keeps one-time pest floor as a final customer-facing floor', () => {
    expect(source).toContain('const fp = Math.max(199, otP(Math.max(199, Math.round(bpp * 1.75))));');
  });

  test('bed bug fallback no longer treats invalid methods as quote-both', () => {
    expect(source).toContain('Invalid bedbugMethod. Use CHEMICAL, HEAT, or HYBRID.');
    expect(source).toContain('HYBRID bed bug pricing is server-only in the deprecated v1 estimator.');
    expect(source).toContain('Deprecated v1 bed bug pricing only supports light/ready/singleFamily; use server pricing endpoint.');
    expect(source).toContain('const bedBugP = (b) => Math.round(b * urgMult);');
    expect(source).toContain('price: bedBugP(cp)');
    expect(source).not.toContain("meth !== 'HEAT'");
    expect(source).not.toContain("meth !== 'CHEMICAL'");
  });

  test('legacy admin page blocks bed bug estimates from falling back to client pricing', () => {
    expect(legacyAdminSource).toContain('const canUseServerForBedBug =');
    expect(legacyAdminSource).toContain('const hasLawnPricedService =');
    expect(legacyAdminSource).toContain('form.svcBedbug && hasLawnPricedService && !enrichedProfile && !hasManualLawnDimensions');
    expect(legacyAdminSource).toContain('Enter lot size or run Property Lookup before generating a bed bug estimate with lawn services.');
    expect(legacyAdminSource).toContain('form.svcBedbug && !canUseServerForBedBug');
    expect(legacyAdminSource).toContain('Enter home sq ft or run Property Lookup before generating a mixed bed bug estimate.');
  });
});
