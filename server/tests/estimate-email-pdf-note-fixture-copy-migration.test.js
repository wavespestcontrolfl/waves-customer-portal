// Non-database half of the 20261019230000 migration check. The fixture update
// itself is proved by the opt-in PostgreSQL suite beside it.
const migration = require('../models/migrations/20261019230000_estimate_email_pdf_note_fixture_copy');
const first = require('../models/migrations/20261019200000_estimate_email_pdf_note');
const { ESTIMATE_EMAIL_PDF_NOTES } = require('../services/pdf/estimate-doc-pdf');

const { replaceSeededNote, PLANS, OLD_DELIVERY, NEW_DELIVERY, OLD_FOLLOW_UP, NEW_FOLLOW_UP, FOLLOW_UP_KEYS } = migration._private;

describe('estimate email PDF note fixture copy migration', () => {
  test('the new text is exactly what the live emails carry today', () => {
    expect(NEW_DELIVERY).toBe(ESTIMATE_EMAIL_PDF_NOTES.delivery);
    expect(NEW_FOLLOW_UP).toBe(ESTIMATE_EMAIL_PDF_NOTES.followUp);
    for (const text of [NEW_DELIVERY, NEW_FOLLOW_UP]) expect(text).not.toMatch(/start date|first visit|get started|set your/i);
  });

  test('the old text is exactly what 20261019200000 seeded', () => {
    const seeded = Object.fromEntries(first._private.PLANS.map((p) => [p.key, p.fixture.estimate_pdf_note]));
    expect(seeded['estimate.delivery']).toBe(OLD_DELIVERY);
    for (const key of FOLLOW_UP_KEYS) expect(seeded[key]).toBe(OLD_FOLLOW_UP);
  });

  test('covers the delivery template and every follow-up key except the auto-renew notice', () => {
    expect(PLANS.flatMap((p) => p.keys).sort()).toEqual(
      first._private.PLANS.map((p) => p.key).filter((k) => k !== 'estimate.extension_notice').sort(),
    );
    expect(FOLLOW_UP_KEYS).not.toContain('estimate.extension_notice');
    expect(FOLLOW_UP_KEYS).toHaveLength(12);
  });

  test('replaces exactly the old seeded value and keeps every other key', () => {
    expect(replaceSeededNote({ first_name: 'Sam', estimate_pdf_note: OLD_DELIVERY }, OLD_DELIVERY, NEW_DELIVERY))
      .toEqual({ first_name: 'Sam', estimate_pdf_note: NEW_DELIVERY });
    expect(replaceSeededNote(JSON.stringify({ estimate_pdf_note: OLD_FOLLOW_UP }), OLD_FOLLOW_UP, NEW_FOLLOW_UP))
      .toEqual({ estimate_pdf_note: NEW_FOLLOW_UP });
  });

  test('an edited, current, blank, mismatched-kind, missing or unreadable value is left alone', () => {
    expect(replaceSeededNote({ estimate_pdf_note: 'Admin-edited' }, OLD_DELIVERY, NEW_DELIVERY)).toBeNull();
    expect(replaceSeededNote({ estimate_pdf_note: NEW_DELIVERY }, OLD_DELIVERY, NEW_DELIVERY)).toBeNull();
    expect(replaceSeededNote({ estimate_pdf_note: '' }, OLD_FOLLOW_UP, NEW_FOLLOW_UP)).toBeNull();
    // The follow-up sample on a delivery plan (and the reverse) is not this plan's seed.
    expect(replaceSeededNote({ estimate_pdf_note: OLD_FOLLOW_UP }, OLD_DELIVERY, NEW_DELIVERY)).toBeNull();
    expect(replaceSeededNote({ first_name: 'Sam' }, OLD_DELIVERY, NEW_DELIVERY)).toBeNull();
    expect(replaceSeededNote('not json', OLD_DELIVERY, NEW_DELIVERY)).toBeNull();
    expect(replaceSeededNote(null, OLD_DELIVERY, NEW_DELIVERY)).toBeNull();
    expect(replaceSeededNote([OLD_DELIVERY], OLD_DELIVERY, NEW_DELIVERY)).toBeNull();
  });

  test('is idempotent, pure, and data-only with a no-op down', async () => {
    const payload = { estimate_pdf_note: OLD_DELIVERY };
    const once = replaceSeededNote(payload, OLD_DELIVERY, NEW_DELIVERY);
    expect(payload.estimate_pdf_note).toBe(OLD_DELIVERY);
    expect(replaceSeededNote(once, OLD_DELIVERY, NEW_DELIVERY)).toBeNull();
    await expect(migration.down()).resolves.toBeUndefined();
    expect(Object.keys(migration).sort()).toEqual(['_private', 'down', 'up']);
  });
});
