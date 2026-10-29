/**
 * GET /api/admin/sms-templates no longer seeds the default templates (it used to INSERT .. ON CONFLICT DO NOTHING of every
 * default on the first list of each process). That is only safe because the migrations already hold every default, so this
 * runs against a migrated database and fails if any default template is missing: a later migration that deletes a default row
 * would otherwise have been quietly repaired by the page and now would show a gap.
 */
const SKIP = !process.env.DATABASE_URL;

(SKIP ? describe.skip : describe)('SMS template defaults after the migrations (real PG)', () => {
  let db;
  beforeAll(() => { db = require('../models/db'); });
  afterAll(async () => { if (db) await db.destroy(); });

  test('every default template key has a row, and the table has the columns the list reads', async () => {
    const { TEMPLATES } = require('../models/migrations/20260514000002_tighten_sms_template_copy');
    const rows = await db('sms_templates').select('template_key');
    const have = new Set(rows.map((row) => row.template_key));
    expect(TEMPLATES.map((template) => template.template_key).filter((key) => !have.has(key))).toEqual([]);
    expect(await db.schema.hasColumn('sms_templates', 'trigger_event_key')).toBe(true);
  });
});
