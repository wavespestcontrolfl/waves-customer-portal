/**
 * applyWaitlistTags is one atomic UPDATE against the CURRENT tags (Codex
 * #5454 r1 P2): earlier zip:/city:/waitlist tags are replaced, every other tag
 * is kept in order — including one another writer appended after the caller's
 * snapshot — and only a pending row is touched. Synthetic rows; rolled back.
 */
const path = require('path');
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('applyWaitlistTags on PostgreSQL', () => {
  let knex;
  let applyWaitlistTags;
  beforeAll(() => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
    ({ applyWaitlistTags } = require('../services/newsletter-subscribers'));
  });
  afterAll(async () => { if (knex) await knex.destroy(); });

  test('keeps a concurrently appended tag; replaces location tags; pending only', async () => {
    const tag = `waitlist-pg-${Date.now()}`;
    const ROLLBACK = new Error('rollback');
    await expect(knex.transaction(async (trx) => {
      const [pending] = await trx('newsletter_subscribers')
        .insert({ email: `${tag}-p@example.com`, status: 'pending', tags: JSON.stringify(['vip', 'zip:33570', 'city:old-town', 'out_of_area_waitlist']) })
        .returning(['id', 'tags']);
      const [active] = await trx('newsletter_subscribers')
        .insert({ email: `${tag}-a@example.com`, status: 'active', tags: JSON.stringify(['vip']) })
        .returning(['id', 'tags']);
      // Another writer appends after the caller's snapshot was taken.
      await trx.raw(`UPDATE newsletter_subscribers SET tags = tags || '["quiz:termites"]'::jsonb WHERE id = ?`, [pending.id]);

      const n = await applyWaitlistTags(pending, ['zip:33573', 'city:ruskin'], {}, trx);
      expect(n).toBe(1);
      const row = await trx('newsletter_subscribers').where({ id: pending.id }).first('tags');
      const tags = typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags;
      expect(tags).toEqual(['vip', 'quiz:termites', 'out_of_area_waitlist', 'zip:33573', 'city:ruskin']);

      expect(await applyWaitlistTags(active, ['zip:33573'], {}, trx)).toBe(0);
      const act = await trx('newsletter_subscribers').where({ id: active.id }).first('tags');
      expect(typeof act.tags === 'string' ? JSON.parse(act.tags) : act.tags).toEqual(['vip']);
      throw ROLLBACK;
    })).rejects.toBe(ROLLBACK);
  });
});
