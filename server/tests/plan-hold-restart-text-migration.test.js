const { _copy: { BEFORE, AFTER } } = require('../models/migrations/20260930010000_plan_hold_restart_text_names_visit');
const { _SWAPS: swaps } = require('../models/migrations/20260926120000_customer_copy_audit_sms');
const { countSegments } = require('../services/messaging/segment-counter');

// The restart text names the first visit back (owner rule 3, 2026-09-29):
// the swap starts from exactly the body the copy audit left live, and the
// long-side render stays one GSM-7 segment.
test('rewrites the copy-audit body and names the visit date', () => {
  expect(swaps.find(([key]) => key === 'plan_hold_resume_reminder')[2]).toBe(BEFORE);
  expect(AFTER).toContain('{visit_date}');
  expect(AFTER).not.toContain('{resume_date}');
  const rendered = AFTER.replace('{first_name}', 'Longtestname').replace('{service}', 'Tree & Shrub').replace('{visit_date}', 'September 30, 2026');
  expect(countSegments(rendered)).toMatchObject({ encoding: 'GSM_7', segmentCount: 1 });
});
