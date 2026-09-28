// GATE_REPORT_PRODUCT_COPY's report_copy.pets_kids is a re-entry-adjacent
// claim, so reportProductCopyForApplicationProduct (report-product-copy.js)
// screens it through the SAME stripFixedReentryTiming mechanism
// precaution_summary/reentry_summary use at the payload boundary — but at
// the SOURCE, for every mode (live included), not only the non-live sweep
// those two pre-existing catalog fields go through. AGENTS.md bans a fixed
// re-entry/drying MINUTE figure on any customer surface.

const { stripFixedReentryTiming, REENTRY_SAFE_COPY } = require('../services/social-media');
const { REPORT_PRODUCT_COPY } = require('../config/report-product-copy');
const { reportProductCopyForApplicationProduct } = require('../services/service-report/report-product-copy');

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

// codex P2 2026-09-28: reportProductCopyForApplicationProduct must run
// stripFixedReentryTiming on pets_kids BEFORE screening it, not after — a
// fixed-minute claim itself trips the compliance screen's own fixed-reentry
// check, so screening the RAW text first would drop the whole copy block
// (how_it_works + also_labeled_for too) instead of letting the now-sanitized
// pets_kids line through. Synthetic config entry — jest.mock isolates this
// from the real 12 owner-approved lines, none of which carry a fixed figure.
describe('reportProductCopyForApplicationProduct — screen runs AFTER the reentry-timing sanitizer', () => {
  const ORIGINAL = process.env.GATE_REPORT_PRODUCT_COPY;
  afterEach(() => {
    process.env.GATE_REPORT_PRODUCT_COPY = ORIGINAL;
    jest.resetModules();
  });

  it('carries the REENTRY_SAFE_COPY replacement rather than dropping the block', () => {
    jest.resetModules();
    jest.doMock('../config/report-product-copy', () => ({
      reportProductCopyFor: () => ({
        how_it_works: 'A synthetic test entry for the reorder guard.',
        also_labeled_for: 'Synthetic pests.',
        pets_kids: 'Wait 30 minutes before re-entering treated areas.',
      }),
    }));
    const { reportProductCopyForApplicationProduct } = require('../services/service-report/report-product-copy');
    const copy = reportProductCopyForApplicationProduct({ product_name: 'Synthetic Product', epa_reg_number: '00000-0000' });
    expect(copy).not.toBeNull();
    expect(copy.pets_kids).toBe(REENTRY_SAFE_COPY);
    expect(copy.how_it_works).toBe('A synthetic test entry for the reorder guard.');
    jest.dontMock('../config/report-product-copy');
  });
});
