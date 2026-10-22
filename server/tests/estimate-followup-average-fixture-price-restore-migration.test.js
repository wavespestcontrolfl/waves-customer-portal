// Non-database half of the 20261021030000 migration check. The fixture update
// itself is proved by the opt-in PostgreSQL suite beside it.
const migration = require('../models/migrations/20261021030000_estimate_followup_average_fixture_price_restore');
const previous = require('../models/migrations/20261021020000_estimate_followup_average_fixture_price');
const note = require('../models/migrations/20261021010000_estimate_followup_average_note');

const { versionShowsAverage, restoreSeededPrice, KEYS, AVERAGE_PRICE, SEEDED_PRICE } = migration._private;
const BLOCKS = [
  { type: 'details', rows: [{ label: 'Estimate', value: '{{price_summary}}' }] },
  { type: 'paragraph', content: '{{estimate_average_note}}' },
];

describe('estimate follow-up average fixture price restore migration', () => {
  test('its literals are exactly what the two earlier migrations wrote and replaced', () => {
    expect(AVERAGE_PRICE).toBe(previous._private.NEW_PRICE);
    expect(SEEDED_PRICE).toBe(previous._private.OLD_PRICE);
    expect([...KEYS].sort()).toEqual(note._private.PLANS.map((p) => p.key).sort());
  });

  test('the support test matches the sender: both tokens in blocks, and in a non-blank text body', () => {
    expect(versionShowsAverage({ blocks: BLOCKS, text_body: null })).toBe(true);
    expect(versionShowsAverage({ blocks: JSON.stringify(BLOCKS), text_body: '  ' })).toBe(true);
    expect(versionShowsAverage({ blocks: BLOCKS, text_body: 'x {{price_summary}} {{estimate_average_note}}' })).toBe(true);
    expect(versionShowsAverage({ blocks: BLOCKS, text_body: 'Custom text' })).toBe(false);
    expect(versionShowsAverage({ blocks: BLOCKS, text_body: 'x {{estimate_average_note}}' })).toBe(false);
    expect(versionShowsAverage({ blocks: [BLOCKS[0]], text_body: null })).toBe(false);
    expect(versionShowsAverage({ blocks: [BLOCKS[1]], text_body: null })).toBe(false);
    expect(versionShowsAverage(null)).toBe(false);
  });

  test('restores exactly the average sample and keeps every other key', () => {
    expect(restoreSeededPrice({ first_name: 'Sam', price_summary: AVERAGE_PRICE })).toEqual({ first_name: 'Sam', price_summary: SEEDED_PRICE });
    expect(restoreSeededPrice(JSON.stringify({ price_summary: AVERAGE_PRICE }))).toEqual({ price_summary: SEEDED_PRICE });
  });

  test('an edited, already-seeded, blank, missing or unreadable value is left alone', () => {
    expect(restoreSeededPrice({ price_summary: '$99/mo' })).toBeNull();
    expect(restoreSeededPrice({ price_summary: SEEDED_PRICE })).toBeNull();
    expect(restoreSeededPrice({ price_summary: '' })).toBeNull();
    expect(restoreSeededPrice({ first_name: 'Sam' })).toBeNull();
    expect(restoreSeededPrice('not json')).toBeNull();
    expect(restoreSeededPrice(null)).toBeNull();
    expect(restoreSeededPrice([AVERAGE_PRICE])).toBeNull();
  });

  test('is idempotent, pure, and data-only with a no-op down', async () => {
    const payload = { price_summary: AVERAGE_PRICE };
    const once = restoreSeededPrice(payload);
    expect(payload.price_summary).toBe(AVERAGE_PRICE);
    expect(restoreSeededPrice(once)).toBeNull();
    await expect(migration.down()).resolves.toBeUndefined();
    expect(Object.keys(migration).sort()).toEqual(['_private', 'down', 'up']);
  });
});
