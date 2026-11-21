/**
 * Waves Newsletter polls against real Postgres:
 * - newsletterIssuePolls reads one newsletter type's poll history from the
 *   issues readers got: the polls of the newest two, and every poll such an
 *   issue carried, in either body part, by the sender's own reach rule. A
 *   'failed' send that reached readers before it stopped counts, and so does
 *   one whose only proof is a reader's spam report; a draft, a send that
 *   reached no reader (a 'sent' one whose recipients all dropped out, or whose
 *   every message hard-bounced) and another type's issue never count. An
 *   issue with no send time sorts by its first delivery.
 * - recordQuizResponse records a poll vote only from an issue that carried
 *   that poll.
 * Real Postgres, because these are a LIKE over the stored bodies, an EXISTS
 * and a subquery over the delivery rows, and the vote's row update.
 * Runs in CI's DB-gated step or this worktree's private QA database; every
 * test runs in one transaction that is rolled back, so no row stays.
 */
jest.setTimeout(60000);

// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  return db;
});
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const { randomUUID } = require('crypto');

postgres('Waves Newsletter polls (real Postgres)', () => {
  const db = require('../models/db');
  const {
    newsletterIssuePolls, chooseNewsletterPoll, recordQuizResponse, NEWSLETTER_POLL_IDS,
  } = require('../services/newsletter-quiz');
  const [P1, P2, P3, P4] = NEWSLETTER_POLL_IDS;
  let database;
  const HOUR = 60 * 60 * 1000;
  const daysAgo = (days) => new Date(Date.now() - days * 24 * HOUR);
  const newType = () => `poll-test-${randomUUID()}`;

  // Inserts issues and their delivery rows; returns each issue's delivery rows
  // ({ id, engagement_token }) in order. A 'sent' issue gets one delivered row
  // unless it lists its own. textOnly puts the poll in the plain-text part only.
  async function insertIssues(type, rows) {
    const inserted = await db('newsletter_sends').insert(rows.map((row) => ({
      subject: 'Synthetic poll issue',
      html_body: `<p>Synthetic</p>${row.poll && !row.textOnly ? `{{quiz:${row.poll}}}` : ''}<p>End</p>`,
      text_body: row.poll ? `Synthetic\n{{quiz-text:${row.poll}}}` : 'Synthetic',
      auto_share_social: false,
      newsletter_type: row.type || type,
      status: row.status || 'sent',
      sent_at: row.sentAt || null,
      ...(row.createdAt ? { created_at: row.createdAt } : {}),
    }))).returning(['id']);
    const out = [];
    for (const [i, row] of rows.entries()) {
      const listed = row.deliveries || ((row.status || 'sent') === 'sent' ? [{ status: 'sent', sentAt: row.sentAt }] : []);
      const deliveries = listed.map((d) => ({
        send_id: inserted[i].id,
        subscriber_id: d.subscriberId || null,
        email: `poll-test-${randomUUID().slice(0, 8)}@example.invalid`,
        status: d.status,
        sent_at: d.sentAt || null,
        bounced_at: d.bouncedAt || null,
        complained_at: d.complainedAt || null,
        ...(d.answered ? { quiz_id: d.answered.quizId, quiz_answer: d.answered.answer, quiz_answered_at: d.answered.at } : {}),
      }));
      out.push(deliveries.length
        ? await db('newsletter_send_deliveries').insert(deliveries).returning(['id', 'engagement_token'])
        : []);
    }
    return out;
  }

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    const worktreeId = String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '');
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1' && /^[a-f0-9]{32}$/.test(worktreeId)
      && target.pathname === `/waves_qa_${worktreeId}`;
    if (!ci && !ownedQA) throw new Error('Use the isolated CI database or this worktree\'s private QA database');
    // The driver copies every query parameter of a connection string into its
    // settings, so the pool gets the parts checked above, never the URL text.
    if (target.search) throw new Error('DATABASE_URL must not carry query parameters');
    database = require('knex')({
      client: 'pg',
      connection: {
        host: target.hostname,
        port: target.port ? Number(target.port) : undefined,
        user: decodeURIComponent(target.username) || undefined,
        password: decodeURIComponent(target.password) || undefined,
        database: target.pathname.slice(1),
      },
      pool: { min: 0, max: 2 },
    });
  });

  beforeEach(async () => { db.connection = await database.transaction(); });
  afterEach(async () => { await db.connection?.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  test('only issues of this type that reached readers count; the newest two decide the gap', async () => {
    const TYPE = newType();
    await insertIssues(TYPE, [
      { poll: P1, sentAt: daysAgo(35) },
      { poll: null, sentAt: daysAgo(28) },
      { poll: null, sentAt: daysAgo(21) },
      // Its deadline stopped it after the first batch: 'failed', yet readers got P2.
      { poll: P2, status: 'failed', sentAt: daysAgo(14), deliveries: [{ status: 'sent', sentAt: daysAgo(14) }, { status: 'queued' }] },
      { poll: null, sentAt: daysAgo(7) },
      // None of these reached a reader of this newsletter.
      { poll: P3, status: 'draft' },
      { poll: P4, status: 'failed', sentAt: daysAgo(3), deliveries: [{ status: 'failed' }] },
      // 'sent', but every recipient dropped out before dispatch. The issue row
      // reads 'sent' with a send time; only its delivery row says no one got it.
      { poll: P4, sentAt: daysAgo(2), deliveries: [{ status: 'skipped' }] },
      { poll: P3, type: newType(), sentAt: daysAgo(1) },
    ]);

    const history = await newsletterIssuePolls({ newsletterType: TYPE });
    expect(history.recent).toEqual([null, P2]);
    expect([...history.used].sort()).toEqual([P1, P2].sort());
    expect(chooseNewsletterPoll(history)).toBeNull();

    // A second issue without a poll opens the gap: the next poll is P3, even
    // though a draft and another newsletter type carried it, and P4 stays
    // unused because no reader got either issue that carried it.
    await insertIssues(TYPE, [{ poll: null, sentAt: new Date(Date.now() - HOUR) }]);
    const later = await newsletterIssuePolls({ newsletterType: TYPE });
    expect(later.recent).toEqual([null, null]);
    expect(chooseNewsletterPoll(later)).toBe(P3);
    expect(later.used).not.toContain(P4);
  });

  test('a partly delivered issue with no send time sorts by its first delivery, not its draft time', async () => {
    const TYPE = newType();
    await insertIssues(TYPE, [
      { poll: null, sentAt: daysAgo(14) },
      { poll: null, sentAt: daysAgo(7) },
      // Drafted 40 days ago; a worker failed after its first batch yesterday,
      // so the issue row has no sent_at and no schedule.
      { poll: P1, status: 'failed', createdAt: daysAgo(40), deliveries: [{ status: 'sent', sentAt: daysAgo(1) }, { status: 'queued' }] },
    ]);
    const history = await newsletterIssuePolls({ newsletterType: TYPE });
    expect(history.recent).toEqual([P1, null]);
    expect(chooseNewsletterPoll(history)).toBeNull();
  });

  test('a poll carried only in the plain-text part counts too', async () => {
    const TYPE = newType();
    await insertIssues(TYPE, [
      { poll: null, sentAt: daysAgo(14) },
      { poll: P1, textOnly: true, sentAt: daysAgo(7) },
    ]);
    const history = await newsletterIssuePolls({ newsletterType: TYPE });
    expect(history.recent).toEqual([P1, null]);
    expect(history.used).toEqual([P1]);
    expect(chooseNewsletterPoll(history)).toBeNull();
  });

  test('the sender\'s reach rule decides: a hard-bounced issue does not count; a reader\'s spam report does', async () => {
    const TYPE = newType();
    await insertIssues(TYPE, [
      { poll: null, sentAt: daysAgo(21) },
      // SendGrid took the message (sent_at), then the address hard-bounced.
      { poll: P1, sentAt: daysAgo(14), deliveries: [{ status: 'bounced', sentAt: daysAgo(14), bouncedAt: daysAgo(14) }] },
      // The sender lost SendGrid's answer; the reader's own spam report proves the message arrived.
      { poll: P2, status: 'failed', createdAt: daysAgo(7), deliveries: [{ status: 'complained', complainedAt: daysAgo(6) }] },
    ]);
    const history = await newsletterIssuePolls({ newsletterType: TYPE });
    expect(history.used).toEqual([P2]);
    expect(history.recent).toEqual([P2, null]);
  });

  test('a poll vote counts only from an issue that carried that poll', async () => {
    const TYPE = newType();
    const [sub] = await db('newsletter_subscribers')
      .insert({ email: `poll-test-${randomUUID().slice(0, 8)}@example.invalid`, status: 'active', source: 'public_form' })
      .returning(['id']);
    const earlier = { quizId: 'pest-pressure-v1', answer: 'ants', at: daysAgo(10) };
    const [[withPoll], [withoutPoll]] = await insertIssues(TYPE, [
      { poll: P2, sentAt: daysAgo(3), deliveries: [{ status: 'sent', sentAt: daysAgo(3), subscriberId: sub.id }] },
      { poll: null, sentAt: daysAgo(10), deliveries: [{ status: 'sent', sentAt: daysAgo(10), subscriberId: sub.id, answered: earlier }] },
    ]);
    const answerOf = async (row) => db('newsletter_send_deliveries').where({ id: row.id })
      .first('quiz_id', 'quiz_answer', 'quiz_answered_at');

    // The older issue never showed P2: its token records nothing, and the
    // answer already on that row stays.
    await expect(recordQuizResponse({ token: withoutPoll.engagement_token, quizId: P2, answerKey: 'road-trip' }))
      .resolves.toEqual({ ok: false, reason: 'not-in-issue' });
    expect(await answerOf(withoutPoll)).toEqual({ quiz_id: earlier.quizId, quiz_answer: earlier.answer, quiz_answered_at: earlier.at });

    await expect(recordQuizResponse({ token: withPoll.engagement_token, quizId: P2, answerKey: 'road-trip' }))
      .resolves.toEqual({ ok: true, reason: 'tagged' });
    expect(await answerOf(withPoll)).toEqual(expect.objectContaining({ quiz_id: P2, quiz_answer: 'road-trip' }));
  });
});
