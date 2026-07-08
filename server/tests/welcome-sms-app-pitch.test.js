/**
 * Contract for migration 20260708000010_welcome_sms_app_pitch.
 *
 * The migration is a targeted sentence swap — it only fires when the exact
 * seeded pitch sentence is present (admin edits pass through untouched). That
 * makes exact-match drift the failure mode: if OLD_PITCH doesn't byte-match
 * what 20260516000011 seeded (and prod still carries, modulo the appended
 * STOP line), the migration silently no-ops and the welcome SMS keeps
 * pointing at the raw portal URL. So the test pins OLD_PITCH to the seeding
 * migration's source, and sanity-checks the replacement copy.
 */
const fs = require('fs');
const path = require('path');

const { OLD_PITCH, NEW_PITCH } = require('../models/migrations/20260708000010_welcome_sms_app_pitch');

describe('welcome SMS app-pitch migration contract', () => {
  test('OLD_PITCH byte-matches the sentence 20260516000011 seeded', () => {
    const seedSource = fs.readFileSync(
      path.join(__dirname, '../models/migrations/20260516000011_new_recurring_customer_sms_template.js'),
      'utf8',
    );
    expect(seedSource).toContain(OLD_PITCH);
  });

  test('NEW_PITCH points at the app page and drops the raw portal URL', () => {
    expect(NEW_PITCH).toContain('wavespestcontrol.com/app');
    expect(NEW_PITCH).not.toContain('portal.wavespestcontrol.com');
  });

  test('swap does not grow the message into extra SMS segments', () => {
    // Seeded body ≈ 250 chars ≈ 2 GSM segments; NEW_PITCH being no longer
    // than OLD_PITCH guarantees the swap can't add a third.
    expect(NEW_PITCH.length).toBeLessThanOrEqual(OLD_PITCH.length);
    // A single non-GSM char (em-dash, smart quote) re-encodes the WHOLE
    // message as UCS-2 and doubles the segment count — keep it plain ASCII.
    expect(NEW_PITCH).toMatch(/^[\x20-\x7E\n]*$/);
  });

  test('replacement introduces no unresolved template variables', () => {
    const vars = NEW_PITCH.match(/\{(\w+)\}/g) || [];
    expect(vars).toEqual([]);
  });
});
