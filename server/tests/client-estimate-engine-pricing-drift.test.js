const fs = require('fs');
const path = require('path');

const clientEstimatorPath = path.resolve(__dirname, '../../client/src/lib/estimateEngine.js');

describe('deprecated client estimator pricing drift guards', () => {
  let source;

  beforeAll(() => {
    source = fs.readFileSync(clientEstimatorPath, 'utf8');
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
    expect(source).toContain('const fp = Math.max(150, otP(Math.max(150, Math.round(bpp * 1.30))));');
  });
});
