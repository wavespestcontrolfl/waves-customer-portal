// GATE_REPORT_PRODUCT_COPY's report_copy.pets_kids is a re-entry-adjacent
// claim, so reportProductCopyForApplicationProduct (report-product-copy.js)
// screens it through the SAME stripFixedReentryTiming mechanism
// precaution_summary/reentry_summary use at the payload boundary — but at
// the SOURCE, for every mode (live included), not only the non-live sweep
// those two pre-existing catalog fields go through. AGENTS.md bans a fixed
// re-entry/drying MINUTE figure on any customer surface.

const { stripFixedReentryTiming } = require('../services/social-media');
const { REPORT_PRODUCT_COPY } = require('../config/report-product-copy');
const { reportProductCopyForApplicationProduct } = require('../services/service-report/report-product-copy');

const REENTRY_SAFE_COPY = 'Ready once dry — your technician confirms timing.';

describe('report_copy.pets_kids vs the fixed-reentry-timing compliance screen', () => {
  it('none of the 12 owner-approved pets_kids lines are altered by stripFixedReentryTiming', () => {
    for (const entry of REPORT_PRODUCT_COPY) {
      const { text, changed } = stripFixedReentryTiming(entry.petsKids, REENTRY_SAFE_COPY);
      expect(changed).toBe(false);
      expect(text).toBe(entry.petsKids);
    }
  });

  it('reportProductCopyForApplicationProduct is a no-op on today\'s config — pets_kids text is unchanged', () => {
    const copy = reportProductCopyForApplicationProduct({ product_name: 'Taurus SC', epa_reg_number: '53883-279' });
    const taurus = REPORT_PRODUCT_COPY.find((e) => e.names.includes('taurus sc'));
    expect(copy.pets_kids).toBe(taurus.petsKids);
  });

  it('a fixed-minute claim WOULD be replaced by stripFixedReentryTiming — proves the mechanism this module reuses', () => {
    const { text, changed } = stripFixedReentryTiming('Wait 30 minutes before re-entering treated areas.', REENTRY_SAFE_COPY);
    expect(changed).toBe(true);
    expect(text).toBe(REENTRY_SAFE_COPY);
  });
});
