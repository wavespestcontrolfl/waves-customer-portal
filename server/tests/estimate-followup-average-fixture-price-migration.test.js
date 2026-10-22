// Non-database half of the 20261021020000 migration check. The fixture update
// itself is proved by the opt-in PostgreSQL suite beside it.
const migration = require('../models/migrations/20261021020000_estimate_followup_average_fixture_price');
const note = require('../models/migrations/20261021010000_estimate_followup_average_note');
const { emailParts, buildMonthlyAverage } = require('../../shared/estimate-monthly-average.cjs');

const { replaceSeededPrice, KEYS, OLD_PRICE, NEW_PRICE } = migration._private;

describe('estimate follow-up average fixture price migration', () => {
  test('covers exactly the four templates 20261021010000 added the note to', () => {
    expect([...KEYS].sort()).toEqual(note._private.PLANS.map((p) => p.key).sort());
  });

  test('the new text is exactly the live single-service price row', () => {
    const model = buildMonthlyAverage({
      services: [{ key: 'pest', label: 'Pest Control', perApplication: 94, visits: 4 }],
      planMonthly: 31.33,
    });
    expect(emailParts(model, null).priceLine).toBe(NEW_PRICE);
  });

  test('the old text is what 20260526000008 seeded for these templates', () => {
    const source = require('node:fs').readFileSync(require.resolve('../models/migrations/20260526000008_deepen_quote_estimate_email_templates'), 'utf8');
    expect(source).toContain(`price_summary: '${OLD_PRICE}'`);
  });

  test('replaces exactly the old seeded value and keeps every other key', () => {
    expect(replaceSeededPrice({ first_name: 'Sam', price_summary: OLD_PRICE })).toEqual({ first_name: 'Sam', price_summary: NEW_PRICE });
    expect(replaceSeededPrice(JSON.stringify({ price_summary: OLD_PRICE }))).toEqual({ price_summary: NEW_PRICE });
  });

  test('an edited, current, blank, missing or unreadable value is left alone', () => {
    expect(replaceSeededPrice({ price_summary: '$99/mo' })).toBeNull();
    expect(replaceSeededPrice({ price_summary: NEW_PRICE })).toBeNull();
    expect(replaceSeededPrice({ price_summary: '' })).toBeNull();
    expect(replaceSeededPrice({ first_name: 'Sam' })).toBeNull();
    expect(replaceSeededPrice('not json')).toBeNull();
    expect(replaceSeededPrice(null)).toBeNull();
    expect(replaceSeededPrice([OLD_PRICE])).toBeNull();
  });

  test('is idempotent, pure, and data-only with a no-op down', async () => {
    const payload = { price_summary: OLD_PRICE };
    const once = replaceSeededPrice(payload);
    expect(payload.price_summary).toBe(OLD_PRICE);
    expect(replaceSeededPrice(once)).toBeNull();
    await expect(migration.down()).resolves.toBeUndefined();
    expect(Object.keys(migration).sort()).toEqual(['_private', 'down', 'up']);
  });
});
