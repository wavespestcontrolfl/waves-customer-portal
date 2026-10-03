// The bad-review bell's "needs an answer" query on a real PostgreSQL: 1-4
// stars, written since the boundary, at an active location, not dismissed,
// still on Google, and no real reply by the Reviews page's own rule (none, or
// an unpublished '[DRAFT] …').
// Every row is written inside one transaction that is rolled back.
const { randomUUID } = require('node:crypto');

// CI's DB-gated step selects suites by this exact line.
const SKIP = !process.env.DATABASE_URL;
const connection = process.env.DATABASE_URL;

jest.setTimeout(60000);

(SKIP ? describe.skip : describe)('bad-review bell needs-answer query (PostgreSQL)', () => {
  let database;
  let trx;
  beforeAll(async () => {
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    trx = await database.transaction();
  });
  afterAll(async () => { await trx?.rollback(); await database?.destroy(); });

  test('only unanswered 1-4 star reviews written since the boundary', async () => {
    const { needsAnswerQuery } = require('../services/review-low-rating-alert');
    const since = new Date('2026-10-01T00:00:00Z');
    const after = '2026-10-02T12:00:00Z';
    const row = (name, over = {}) => ({ id: randomUUID(), google_review_id: `test-${randomUUID()}`, location_id: 'bradenton', reviewer_name: name, star_rating: 2, review_text: 'x', review_created_at: after, ...over });
    const rows = {
      open: row('Open One'),
      draft: row('Draft Reply', { review_reply: '[DRAFT] Thanks for the feedback.' }),
      oneStar: row('One Star', { star_rating: 1 }),
      replied: row('Replied', { review_reply: 'We are sorry, calling you today.' }),
      dismissed: row('Dismissed', { dismissed: true }),
      gone: row('Left Google', { missing_since: new Date('2026-10-02T13:00:00Z') }),
      fourStar: row('Four Star', { star_rating: 4 }),
      fiveStar: row('Five Star', { star_rating: 5 }),
      before: row('Before Boundary', { review_created_at: '2026-09-30T23:00:00Z' }),
      retired: row('Retired Location', { location_id: 'retired-location' }),
    };
    await trx('google_reviews').insert(Object.values(rows));
    const found = await needsAnswerQuery(trx, since).whereIn('id', Object.values(rows).map((r) => r.id));
    expect(found.map((r) => r.id).sort()).toEqual([rows.open.id, rows.draft.id, rows.oneStar.id, rows.fourStar.id].sort());
  });
});
