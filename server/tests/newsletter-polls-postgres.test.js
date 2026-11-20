/**
 * newsletterIssuePolls reads one newsletter type's poll history from its SENT
 * issues: the polls of the newest two, and every poll a sent issue carried.
 * A draft, a failed issue and another type's issue never count, because no
 * reader of this newsletter saw them. Real Postgres, because the history is a
 * LIKE over the stored html_body plus a sent_at order.
 * Self-skips unless DATABASE_URL is set (CI's DB-gated suites step).
 * Safe on a shared database: synthetic rows under newsletter types no real
 * issue uses, asserted by type, removed after.
 */
jest.setTimeout(60000);

const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../models/db', () => require('knex')({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: { min: 0, max: 2 },
}));
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const { randomUUID } = require('crypto');

postgres('newsletterIssuePolls (real Postgres)', () => {
  const db = require('../models/db');
  const { newsletterIssuePolls, chooseNewsletterPoll, NEWSLETTER_POLL_IDS } = require('../services/newsletter-quiz');
  const [P1, P2, P3, P4] = NEWSLETTER_POLL_IDS;
  const TYPE = `poll-test-${randomUUID()}`;
  const OTHER_TYPE = `poll-test-${randomUUID()}`;
  const created = [];
  const HOUR = 60 * 60 * 1000;
  const daysAgo = (days) => new Date(Date.now() - days * 24 * HOUR);

  async function insertIssues(rows) {
    const inserted = await db('newsletter_sends').insert(rows.map((row) => ({
      subject: 'Synthetic poll issue',
      html_body: `<p>Synthetic</p>${row.poll ? `{{quiz:${row.poll}}}` : ''}<p>End</p>`,
      text_body: 'Synthetic',
      auto_share_social: false,
      newsletter_type: row.type || TYPE,
      status: row.status || 'sent',
      sent_at: row.sentAt || null,
    }))).returning(['id']);
    created.push(...inserted.map((r) => r.id));
  }

  afterAll(async () => {
    if (created.length) await db('newsletter_sends').whereIn('id', created).del();
    await db.destroy();
  });

  test('only sent issues of this type count; the newest two decide the gap', async () => {
    await insertIssues([
      { poll: P1, sentAt: daysAgo(35) },
      { poll: null, sentAt: daysAgo(28) },
      { poll: null, sentAt: daysAgo(21) },
      { poll: P2, sentAt: daysAgo(14) },
      { poll: null, sentAt: daysAgo(7) },
      // None of these reached a reader of this newsletter.
      { poll: P3, status: 'draft' },
      { poll: P4, status: 'failed' },
      { poll: P3, type: OTHER_TYPE, sentAt: daysAgo(1) },
    ]);

    const history = await newsletterIssuePolls({ newsletterType: TYPE });
    expect(history.recent).toEqual([null, P2]);
    expect([...history.used].sort()).toEqual([P1, P2].sort());
    expect(chooseNewsletterPoll(history)).toBeNull();

    // A second issue without a poll opens the gap: the next poll is P3, even
    // though a draft and another newsletter type already carried it.
    await insertIssues([{ poll: null, sentAt: new Date(Date.now() - HOUR) }]);
    const later = await newsletterIssuePolls({ newsletterType: TYPE });
    expect(later.recent).toEqual([null, null]);
    expect(chooseNewsletterPoll(later)).toBe(P3);
  });
});
