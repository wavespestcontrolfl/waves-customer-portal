// Non-database half of the 20261019220000 migration check. The fixture update
// itself is proved by the opt-in PostgreSQL suite beside it.
const migration = require('../models/migrations/20261019220000_estimate_extension_notice_pdf_note_fixture');
const first = require('../models/migrations/20261019200000_estimate_email_pdf_note');

const { blankSeededNote, SEEDED_NOTE, TEMPLATE_KEY } = migration._private;

describe('estimate extension notice fixture migration: the transform', () => {
  test('blanks exactly the note 20261019200000 seeded and keeps every other key', () => {
    expect(blankSeededNote({ first_name: 'Sam', estimate_pdf_note: SEEDED_NOTE }))
      .toEqual({ first_name: 'Sam', estimate_pdf_note: '' });
    expect(blankSeededNote(JSON.stringify({ estimate_pdf_note: SEEDED_NOTE }))).toEqual({ estimate_pdf_note: '' });
  });

  test('an admin-edited, already blank, missing or unreadable value is left alone', () => {
    expect(blankSeededNote({ estimate_pdf_note: 'Admin-edited note' })).toBeNull();
    expect(blankSeededNote({ estimate_pdf_note: '' })).toBeNull();
    expect(blankSeededNote({ first_name: 'Sam' })).toBeNull();
    expect(blankSeededNote('not json')).toBeNull();
    expect(blankSeededNote(null)).toBeNull();
    expect(blankSeededNote([SEEDED_NOTE])).toBeNull();
  });

  test('is idempotent and does not mutate its input', () => {
    const payload = { estimate_pdf_note: SEEDED_NOTE };
    const once = blankSeededNote(payload);
    expect(payload.estimate_pdf_note).toBe(SEEDED_NOTE);
    expect(blankSeededNote(once)).toBeNull();
  });

  test('targets the auto-renew notice and the text 20261019200000 really seeded', () => {
    expect(TEMPLATE_KEY).toBe('estimate.extension_notice');
    const plan = first._private.PLANS.find((p) => p.key === TEMPLATE_KEY);
    expect(plan.fixture.estimate_pdf_note).toBe(SEEDED_NOTE);
  });

  test('is data-only with a no-op down', async () => {
    await expect(migration.down()).resolves.toBeUndefined();
    expect(Object.keys(migration).sort()).toEqual(['_private', 'down', 'up']);
  });
});
