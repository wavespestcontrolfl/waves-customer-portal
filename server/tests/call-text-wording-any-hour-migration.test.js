/**
 * 20260928050000_call_text_wording_any_hour — the copy itself. (FROZEN: this
 * migration already ran on a PR preview and must never be edited in place —
 * its sms_template_variants sync and audit-log changed-row tracking were
 * added by the superseding 20260928060000_call_text_wording_variants_audit
 * instead.)
 *
 * DB-backed up()/down() behavior for BOTH migrations together (the base-row
 * CAS, the variant sync, admin-edit preservation, and the audit-log
 * changed-row tracking down() reverts from, in the real 050000-then-060000
 * order) is covered against a real PostgreSQL schema in
 * call-text-wording-any-hour-migration-postgres.test.js. This file pins only
 * the wording itself:
 *  - missed_call_text_back keeps {callback_clause} required and its exact
 *    "call back anytime{callback_clause}" shape, with the new reassurance
 *    leading;
 *  - voicemail_quote_link keeps its existing message and link untouched
 *    (only the reassurance is inserted).
 */
const migration = require('../models/migrations/20260928050000_call_text_wording_any_hour');
const { REQUIRED_TEMPLATE_PLACEHOLDERS } = require('../routes/admin-sms-templates');

const { _SWAPS: SWAPS } = migration;
const byKey = Object.fromEntries(SWAPS.map(([key, expect_, set]) => [key, { expect: expect_, set }]));

test('missed_call_text_back: keeps {callback_clause} required and the exact "call back anytime" ending, with the new reassurance leading', () => {
  const { set } = byKey.missed_call_text_back;
  expect(REQUIRED_TEMPLATE_PLACEHOLDERS.missed_call_text_back).toEqual(['callback_clause']);
  expect(set).toContain('{callback_clause}');
  expect(set).toContain('Someone from the Waves team will follow up as soon as possible');
  expect(set).not.toMatch(/reply stop/i);
  expect(set).not.toMatch(/Waves Pest Control/i);

  // Renders naturally with and without a known dialed line (callbackClause()
  // in missed-call-text-back.js — '' or ' at (941) 297-5749').
  expect(set.replace('{callback_clause}', ''))
    .toBe("Hi there, it's Waves. Sorry we missed your call. Someone from the Waves team will follow up as soon as possible. You can also text us here with what you need, or call back anytime.");
  expect(set.replace('{callback_clause}', ' at (941) 297-5749'))
    .toBe("Hi there, it's Waves. Sorry we missed your call. Someone from the Waves team will follow up as soon as possible. You can also text us here with what you need, or call back anytime at (941) 297-5749.");
});

test('voicemail_quote_link: keeps the existing message and link untouched, only adds the reassurance', () => {
  const { set } = byKey.voicemail_quote_link;
  expect(set).toBe(
    "Hello {first_name}, it's Waves Pest Control. We got your message about {service_label}, and your quote is here: {quote_url}\n\n"
    + "Someone from the Waves team will follow up as soon as possible. Or reply and we'll call you back.\n\n"
    + 'Reply STOP to opt out.',
  );
  // Every token from the prior body is still present, unchanged.
  expect(set).toContain("Hello {first_name}, it's Waves Pest Control.");
  expect(set).toContain('{service_label}');
  expect(set).toContain('your quote is here: {quote_url}');
  expect(set).toContain("Or reply and we'll call you back.");
  expect(set).toContain('Reply STOP to opt out.');
});
