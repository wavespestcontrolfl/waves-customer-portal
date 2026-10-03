/**
 * The lane-neutral assurance migration (20261003120000): the seeded letter's
 * "billed at your current rate" sentence becomes one that is true for
 * per-application, monthly-dues and prepaid customers; down() restores it;
 * an operator-edited paragraph is never overwritten.
 */
const seed = require('../models/migrations/20261001200000_rate_review_letter_email_template');
const migration = require('../models/migrations/20261003120000_rate_review_letter_lane_neutral_assurance');

const { OLD_SENTENCE, NEW_SENTENCE } = migration._private;

function fakeKnex(blocks) {
  const store = {
    email_templates: [{ id: 't1', template_key: 'billing.rate_review_notice', active_version_id: 'v1' }],
    email_template_versions: [{ id: 'v1', blocks: JSON.stringify(blocks) }],
  };
  const knex = (table) => {
    let filter = () => true;
    const q = {
      where(cond) { filter = (r) => Object.entries(cond).every(([k, v]) => r[k] === v); return q; },
      first: async () => store[table].find(filter),
      update: async (patch) => { store[table].filter(filter).forEach((r) => Object.assign(r, patch)); return 1; },
    };
    return q;
  };
  knex.schema = { hasTable: async () => true };
  knex.store = store;
  return knex;
}

const paragraph = (blocks) => blocks.find((b) => typeof b.content === 'string' && b.content.includes('Same team, same products')).content;

describe('rate review letter — lane-neutral assurance', () => {
  test('the seeded paragraph carries the per-application-only sentence; the new one names all three lanes', () => {
    expect(paragraph(seed._private.TEMPLATE.blocks)).toContain(OLD_SENTENCE);
    expect(NEW_SENTENCE).toMatch(/applications completed before it are billed at your current rate/);
    expect(NEW_SENTENCE).toMatch(/monthly dues stay at your current amount through the month before it/);
    expect(NEW_SENTENCE).toMatch(/a prepaid plan stays exactly as it is until it renews/);
    expect(NEW_SENTENCE).not.toBe(OLD_SENTENCE);
  });

  test('up rewrites only the active version\'s sentence; down restores the seeded text byte for byte', async () => {
    const knex = fakeKnex(seed._private.TEMPLATE.blocks);
    await migration.up(knex);
    const after = JSON.parse(knex.store.email_template_versions[0].blocks);
    expect(paragraph(after)).toContain(NEW_SENTENCE);
    expect(paragraph(after)).not.toContain(OLD_SENTENCE);
    await migration.down(knex);
    expect(JSON.parse(knex.store.email_template_versions[0].blocks)).toEqual(seed._private.TEMPLATE.blocks);
  });

  test('an operator-edited paragraph is left alone (no match, no write)', async () => {
    const edited = seed._private.TEMPLATE.blocks.map((b) => (typeof b.content === 'string' && b.content.includes('Same team') ? { ...b, content: 'Our own wording.' } : b));
    const knex = fakeKnex(edited);
    const before = knex.store.email_template_versions[0].blocks;
    await migration.up(knex);
    expect(knex.store.email_template_versions[0].blocks).toBe(before);
  });

  test('a missing template or version is a no-op', async () => {
    const knex = fakeKnex(seed._private.TEMPLATE.blocks);
    knex.store.email_templates[0].active_version_id = null;
    await expect(migration.up(knex)).resolves.toBeUndefined();
    await expect(migration.down(knex)).resolves.toBeUndefined();
  });
});
