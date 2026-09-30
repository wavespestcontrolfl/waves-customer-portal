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

// 20260930030000 (Codex r6 P1): the text lives on its own key, and the old
// key is switched off so a pre-#5354 sender can never text a skip-style
// pause its return date.
test('the first-visit-back text has its own key; the old key is retired', () => {
  const { _copy: { NEW_KEY, OLD_KEY, BODY } } = require('../models/migrations/20260930030000_plan_hold_restart_first_visit_template');
  expect(NEW_KEY).toBe('plan_hold_restart_first_visit');
  expect(OLD_KEY).toBe('plan_hold_resume_reminder');
  expect(BODY).toContain('{visit_date}');
  expect(BODY).not.toContain('{resume_date}');
  const rendered = BODY.replace('{first_name}', 'Longtestname').replace('{service}', 'Tree & Shrub').replace('{visit_date}', 'September 30, 2026');
  expect(countSegments(rendered)).toMatchObject({ encoding: 'GSM_7', segmentCount: 1 });
  const holds = require('fs').readFileSync(require('path').join(__dirname, '../services/cancellation-resolution/holds.js'), 'utf8');
  expect(holds).toContain("renderRequiredSmsTemplate('plan_hold_restart_first_visit'");
  expect(holds).not.toContain("renderRequiredSmsTemplate('plan_hold_resume_reminder'");
});
