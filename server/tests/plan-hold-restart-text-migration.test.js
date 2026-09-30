const { _copy: first } = require('../models/migrations/20260930010000_plan_hold_restart_text_names_visit');
const { _copy: { FROM, AFTER } } = require('../models/migrations/20260930020000_plan_hold_restart_text_keeps_token');
const { _SWAPS: swaps } = require('../models/migrations/20260926120000_customer_copy_audit_sms');
const { countSegments } = require('../services/messaging/segment-counter');

// The restart text names the first visit back (owner rule 3, 2026-09-29)
// under the ORIGINAL {resume_date} token, so an old sender (rollback or a
// pod still live mid-deploy) still renders it. The final body is reached
// from the copy-audit body and from 20260930010000's, and stays one
// GSM-7 segment at long-side lengths.
test('ends on a {resume_date} body from either earlier body', () => {
  expect(swaps.find(([key]) => key === 'plan_hold_resume_reminder')[2]).toBe(first.BEFORE);
  expect(FROM).toEqual(expect.arrayContaining([first.BEFORE, first.AFTER]));
  expect(AFTER).toContain('{resume_date}');
  expect(AFTER).not.toContain('{visit_date}');
  const rendered = AFTER.replace('{first_name}', 'Longtestname').replace('{service}', 'Tree & Shrub').replace('{resume_date}', 'September 30, 2026');
  expect(countSegments(rendered)).toMatchObject({ encoding: 'GSM_7', segmentCount: 1 });
});
