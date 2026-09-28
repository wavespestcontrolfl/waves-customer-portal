// GATE_REPORT_PRODUCT_COPY's report_copy.pets_kids is a re-entry-adjacent
// claim, so it rides the SAME compliance sweep as
// applications[].product.precaution_summary / reentry_summary at the
// non-live payload boundary (reports-public.js) — AGENTS.md bans a fixed
// re-entry/drying MINUTE figure on any customer surface. This pins two
// things: (1) none of the 12 owner-approved pets_kids lines are mangled by
// the sweep (they carry no fixed-minute figure), and (2) the mechanism the
// sweep reuses (stripFixedReentryTiming) actually replaces one that would.

const { stripFixedReentryTiming } = require('../services/social-media');
const { REPORT_PRODUCT_COPY } = require('../config/report-product-copy');
const fs = require('fs');
const path = require('path');

const REENTRY_SAFE_COPY = 'Ready once dry — your technician confirms timing.';

describe('report_copy.pets_kids vs the fixed-reentry-timing compliance sweep', () => {
  it('none of the 12 owner-approved pets_kids lines are altered by stripFixedReentryTiming', () => {
    for (const entry of REPORT_PRODUCT_COPY) {
      const { text, changed } = stripFixedReentryTiming(entry.petsKids, REENTRY_SAFE_COPY);
      expect(changed).toBe(false);
      expect(text).toBe(entry.petsKids);
    }
  });

  it('a fixed-minute re-entry claim (never approved, but proves the mechanism) IS replaced', () => {
    const { text, changed } = stripFixedReentryTiming('Wait 30 minutes before re-entering treated areas.', REENTRY_SAFE_COPY);
    expect(changed).toBe(true);
    expect(text).toBe(REENTRY_SAFE_COPY);
  });

  // Wiring proof, same house pattern as reports-public-events.test.js's
  // source-text assertions for call sites too deep in the response builder
  // to unit-test cheaply: confirms the non-live sweep actually reaches
  // report_copy.pets_kids, not just precaution_summary/reentry_summary.
  it('reports-public.js sweeps report_copy.pets_kids in the same non-live block as precaution_summary/reentry_summary', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/reports-public.js'), 'utf8');
    const block = src.slice(src.indexOf("if (mode !== 'live') {"), src.indexOf("if (mode !== 'live') {") + 1200);
    expect(block).toMatch(/precaution_summary = strip\(app\.product\.precaution_summary\)/);
    expect(block).toMatch(/reentry_summary = strip\(app\.product\.reentry_summary\)/);
    expect(block).toMatch(/report_copy\.pets_kids/);
    expect(block).toMatch(/strip\(app\.product\.report_copy\.pets_kids\)/);
  });
});
