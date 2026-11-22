/**
 * Waves Newsletter polls against real Postgres:
 * - newsletterIssuePolls reads one newsletter type's poll history: the polls
 *   of the newest two issues readers got (by the sender's own reach rule),
 *   and every poll such an issue, or an unsent one a Resume could still mail,
 *   holds. Tokens are read as the sender renders them: either form, either
 *   part, any letter case.
 *   A 'failed' send that reached readers before it stopped counts, and so
 *   does one whose only proof is a reader's spam report; a draft, a send that
 *   reached no reader (a 'sent' one whose recipients all dropped out, or
 *   whose every message hard-bounced) and another type's issue never count.
 *   An issue with no send time sorts by its first delivery stamp.
 * - recordQuizResponse records a poll vote only from an issue that showed
 *   that poll; an issue that showed a poll takes no other quiz's answer; an
 *   issue with no poll keeps the old rule.
 * - The Waves Pest Insider (its real type key) reads its own list from its
 *   own issues, and its votes follow the same rule. An unsent Pest Insider
 *   issue holds its poll while its send row exists.
 * Real Postgres, because these are an ILIKE over the stored bodies, EXISTS
 * and subqueries over the delivery rows, and the vote's row update.
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
    newsletterIssuePolls, newsletterLastPoll, pollResultLine, chooseNewsletterPoll, recordQuizResponse,
    NEWSLETTER_POLL_IDS, PEST_INSIDER_POLL_IDS, RETIRED_PEST_INSIDER_POLL_IDS,
  } = require('../services/newsletter-quiz');
  const { etDateString } = require('../utils/datetime-et');
  const { PEST_INSIDER_TYPE } = require('../config/newsletter-types');
  const [P1, P2, P3, P4] = NEWSLETTER_POLL_IDS;
  const [PI1, PI2] = PEST_INSIDER_POLL_IDS;
  let database;
  const HOUR = 60 * 60 * 1000;
  const daysAgo = (days) => new Date(Date.now() - days * 24 * HOUR);
  const newType = () => `poll-test-${randomUUID()}`;
  // The Pest Insider tests read the real type key, so they first move any
  // issue this database already holds under it to a throwaway type. The
  // test's transaction rolls that back with everything else.
  const onlyThisTestsPestInsiderIssues = () => db('newsletter_sends')
    .where({ newsletter_type: PEST_INSIDER_TYPE }).update({ newsletter_type: newType() });

  // Inserts issues and their delivery rows; returns each issue's delivery rows
  // ({ id, engagement_token }) in order. A 'sent' issue gets one delivered row
  // unless it lists its own. textOnly puts the poll in the plain-text part only;
  // upperCase writes its tokens in capitals, which the sender also reads;
  // wrongPart puts each part's token in the other part's form.
  async function insertIssues(type, rows) {
    const inserted = await db('newsletter_sends').insert(rows.map((row) => ({
      subject: 'Synthetic poll issue',
      html_body: `<p>Synthetic</p>${row.poll && !row.textOnly
        ? `{{${row.upperCase ? 'QUIZ' : 'quiz'}${row.wrongPart ? '-text' : ''}:${row.poll}}}` : ''}<p>End</p>`,
      text_body: row.poll
        ? `Synthetic\n{{${row.upperCase ? 'QUIZ' : 'quiz'}${row.wrongPart ? '' : '-text'}:${row.poll}}}` : 'Synthetic',
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
        delivered_at: d.deliveredAt || null,
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
      // None of these reached a reader of this newsletter, and none can be resumed.
      { poll: P3, status: 'draft' },
      // SendGrid dropped its only message (its unsubscribe list): nothing left to mail.
      { poll: P4, status: 'failed', sentAt: daysAgo(3), deliveries: [{ status: 'unsubscribed' }] },
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
    // unused because no reader got either issue that carried it and neither
    // can be resumed.
    await insertIssues(TYPE, [{ poll: null, sentAt: new Date(Date.now() - HOUR) }]);
    const later = await newsletterIssuePolls({ newsletterType: TYPE });
    expect(later.recent).toEqual([null, null]);
    expect(chooseNewsletterPoll(later)).toBe(P3);
    expect(later.used).not.toContain(P4);
  });

  test.each([
    ['its first accepted batch (a worker failed after it)', { status: 'sent', sentAt: daysAgo(1) }],
    ['the webhook\'s delivery stamp (SendGrid\'s answer was lost)', { status: 'delivered', deliveredAt: daysAgo(1) }],
  ])('an issue with no send time sorts by %s, not its draft time', async (_name, firstRow) => {
    const TYPE = newType();
    await insertIssues(TYPE, [
      { poll: null, sentAt: daysAgo(14) },
      { poll: null, sentAt: daysAgo(7) },
      // Drafted 40 days ago, reached readers yesterday; the issue row has no
      // sent_at and no schedule.
      { poll: P1, status: 'failed', createdAt: daysAgo(40), deliveries: [firstRow, { status: 'queued' }] },
    ]);
    const history = await newsletterIssuePolls({ newsletterType: TYPE });
    expect(history.recent).toEqual([P1, null]);
    expect(chooseNewsletterPoll(history)).toBeNull();
  });

  test('a poll counts from either body part, in any letter case the sender reads', async () => {
    const TYPE = newType();
    await insertIssues(TYPE, [
      // Past the two-issue window: only the used list keeps P1 from coming back.
      { poll: P1, upperCase: true, sentAt: daysAgo(35) },
      { poll: null, sentAt: daysAgo(28) },
      { poll: null, sentAt: daysAgo(21) },
      { poll: P2, textOnly: true, sentAt: daysAgo(14) },
      { poll: null, sentAt: daysAgo(7) },
    ]);
    const history = await newsletterIssuePolls({ newsletterType: TYPE });
    expect(history.recent).toEqual([null, P2]);
    expect([...history.used].sort()).toEqual([P1, P2].sort());
    expect(chooseNewsletterPoll(history)).toBeNull();
  });

  test('an unsent issue a Resume could still mail holds its poll; one with no eligible reader left does not', async () => {
    const TYPE = newType();
    const [reader] = await db('newsletter_subscribers')
      .insert({ email: `poll-test-${randomUUID().slice(0, 8)}@example.invalid`, status: 'active', source: 'public_form' })
      .returning(['id']);
    await insertIssues(TYPE, [
      { poll: null, sentAt: daysAgo(21) },
      { poll: null, sentAt: daysAgo(14) },
      // Failed before SendGrid took any message; an active reader's row is
      // still retryable, and a Resume may mail it after the next issue.
      { poll: P1, status: 'failed', createdAt: daysAgo(8), deliveries: [{ status: 'queued', subscriberId: reader.id }] },
      // Failed too, but its retryable row has no active subscriber: a Resume
      // would mail no one (the sender's outstandingEligibleDeliveries).
      { poll: P3, status: 'failed', createdAt: daysAgo(9), deliveries: [{ status: 'queued' }, { status: 'skipped' }] },
    ]);
    const history = await newsletterIssuePolls({ newsletterType: TYPE });
    expect(history.recent).toEqual([null, null]);
    expect(history.used).toEqual([P1]);
    expect(chooseNewsletterPoll(history)).toBe(P2);
  });

  test('a poll token of either form in either part counts, as the sender renders it', async () => {
    const TYPE = newType();
    const [[row]] = await insertIssues(TYPE, [{ poll: P1, wrongPart: true, sentAt: daysAgo(7) }]);
    expect(await newsletterIssuePolls({ newsletterType: TYPE })).toEqual({ ids: NEWSLETTER_POLL_IDS, recent: [P1], used: [P1] });
    // The reader got working vote links, so the vote counts.
    await expect(recordQuizResponse({ token: row.engagement_token, quizId: P1, answerKey: 'beach' }))
      .resolves.toEqual({ ok: false, reason: 'no-subscriber' });
    expect(await db('newsletter_send_deliveries').where({ id: row.id }).first('quiz_id', 'quiz_answer'))
      .toEqual({ quiz_id: P1, quiz_answer: 'beach' });
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

  test('a poll vote counts only from an issue that carried that poll; a poll issue takes no other quiz\'s answer', async () => {
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
    const tagsOf = async () => (await db('newsletter_subscribers').where({ id: sub.id }).first('tags')).tags;
    const tagsBefore = await tagsOf();

    // The older issue never showed P2: its token records nothing, and the
    // answer already on that row stays.
    await expect(recordQuizResponse({ token: withoutPoll.engagement_token, quizId: P2, answerKey: 'road-trip' }))
      .resolves.toEqual({ ok: false, reason: 'not-in-issue' });
    expect(await answerOf(withoutPoll)).toEqual({ quiz_id: earlier.quizId, quiz_answer: earlier.answer, quiz_answered_at: earlier.at });

    await expect(recordQuizResponse({ token: withPoll.engagement_token, quizId: P2, answerKey: 'road-trip' }))
      .resolves.toEqual({ ok: true, reason: 'tagged' });
    expect(await answerOf(withPoll)).toEqual(expect.objectContaining({ quiz_id: P2, quiz_answer: 'road-trip' }));

    // A hand-made link with another quiz's answer neither replaces the poll
    // vote nor adds service tags.
    await expect(recordQuizResponse({ token: withPoll.engagement_token, quizId: 'pest-pressure-v1', answerKey: 'ants' }))
      .resolves.toEqual({ ok: false, reason: 'not-in-issue' });
    expect(await answerOf(withPoll)).toEqual(expect.objectContaining({ quiz_id: P2, quiz_answer: 'road-trip' }));
    expect(await tagsOf()).toEqual(tagsBefore);

    // An issue with no poll keeps the old rule: any quiz's answer counts.
    await expect(recordQuizResponse({ token: withoutPoll.engagement_token, quizId: 'pest-pressure-v1', answerKey: 'roaches' }))
      .resolves.toEqual({ ok: true, reason: 'tagged' });
    expect(await answerOf(withoutPoll)).toEqual(expect.objectContaining({ quiz_id: 'pest-pressure-v1', quiz_answer: 'roaches' }));
    expect(await tagsOf()).toEqual(expect.arrayContaining(['pest-interested', 'pest:roaches']));
  });

  test('the Waves Pest Insider reads its own list from its own issues, and a vote counts only from the issue that carried its poll', async () => {
    await onlyThisTestsPestInsiderIssues();
    const OTHER = newType();
    const [sub] = await db('newsletter_subscribers')
      .insert({ email: `poll-test-${randomUUID().slice(0, 8)}@example.invalid`, status: 'active', source: 'public_form' })
      .returning(['id']);
    // The real type key picks the Pest Insider's list.
    const toReader = (sentAt) => [{ status: 'sent', sentAt, subscriberId: sub.id }];
    const [[withPoll], [otherPoll]] = await insertIssues(PEST_INSIDER_TYPE, [
      { poll: PI1, sentAt: daysAgo(28), deliveries: toReader(daysAgo(28)) },
      // A Waves Newsletter poll's token in a Pest Insider issue is not a Pest Insider poll.
      { poll: P1, sentAt: daysAgo(14), deliveries: toReader(daysAgo(14)) },
      // Another newsletter's issue that carried PI2 does not use PI2 up here.
      { poll: PI2, type: OTHER, sentAt: daysAgo(7) },
    ]);

    // The stored-body prefilter finds a pi-poll token (it matched only nl-poll before).
    const history = await newsletterIssuePolls({ newsletterType: PEST_INSIDER_TYPE });
    expect(history).toEqual({ ids: PEST_INSIDER_POLL_IDS, recent: [null, PI1], used: [PI1] });
    expect(chooseNewsletterPoll(history)).toBeNull();
    // And the other way: a Pest Insider poll is not another newsletter's poll.
    expect(await newsletterIssuePolls({ newsletterType: OTHER })).toEqual({ ids: NEWSLETTER_POLL_IDS, recent: [null], used: [] });

    // A second issue without a Pest Insider poll opens the gap: the next poll is PI2.
    await insertIssues(PEST_INSIDER_TYPE, [{ poll: null, sentAt: daysAgo(1) }]);
    const later = await newsletterIssuePolls({ newsletterType: PEST_INSIDER_TYPE });
    expect(later.recent).toEqual([null, null]);
    expect(chooseNewsletterPoll(later)).toBe(PI2);

    const answerOf = async (row) => db('newsletter_send_deliveries').where({ id: row.id }).first('quiz_id', 'quiz_answer');
    const tagsOf = async () => (await db('newsletter_subscribers').where({ id: sub.id }).first('tags')).tags;
    const tagsBefore = await tagsOf();
    // The issue that never showed PI1 records no PI1 vote.
    await expect(recordQuizResponse({ token: otherPoll.engagement_token, quizId: PI1, answerKey: 'cup-and-card' }))
      .resolves.toEqual({ ok: false, reason: 'not-in-issue' });
    expect(await answerOf(otherPoll)).toEqual({ quiz_id: null, quiz_answer: null });
    await expect(recordQuizResponse({ token: withPoll.engagement_token, quizId: PI1, answerKey: 'cup-and-card' }))
      .resolves.toEqual({ ok: true, reason: 'tagged' });
    expect(await answerOf(withPoll)).toEqual({ quiz_id: PI1, quiz_answer: 'cup-and-card' });
    // A hand-made link with a service quiz's answer neither replaces the vote nor adds a tag.
    await expect(recordQuizResponse({ token: withPoll.engagement_token, quizId: 'pest-pressure-v1', answerKey: 'roaches' }))
      .resolves.toEqual({ ok: false, reason: 'not-in-issue' });
    expect(await answerOf(withPoll)).toEqual({ quiz_id: PI1, quiz_answer: 'cup-and-card' });
    expect(await tagsOf()).toEqual(tagsBefore);
  });

  test('a second confirmed vote from the same email replaces the first: the last vote counts', async () => {
    await onlyThisTestsPestInsiderIssues();
    const [[row]] = await insertIssues(PEST_INSIDER_TYPE, [{ poll: PI2, sentAt: daysAgo(1) }]);
    const answerOf = async () => db('newsletter_send_deliveries').where({ id: row.id }).first('quiz_id', 'quiz_answer');
    await recordQuizResponse({ token: row.engagement_token, quizId: PI2, answerKey: 'ants' });
    expect(await answerOf()).toEqual({ quiz_id: PI2, quiz_answer: 'ants' });
    await recordQuizResponse({ token: row.engagement_token, quizId: PI2, answerKey: 'spiders' });
    expect(await answerOf()).toEqual({ quiz_id: PI2, quiz_answer: 'spiders' });
  });

  test('an old issue with a retired poll is still a poll issue: the gap holds, a late vote counts, no other answer replaces it, no result line', async () => {
    await onlyThisTestsPestInsiderIssues();
    const [RETIRED] = RETIRED_PEST_INSIDER_POLL_IDS;
    const [[row]] = await insertIssues(PEST_INSIDER_TYPE, [{ poll: RETIRED, sentAt: daysAgo(3) }]);
    const answerOf = async () => db('newsletter_send_deliveries').where({ id: row.id }).first('quiz_id', 'quiz_answer');
    // The history reads it as a poll issue, so the next issue takes no poll; the retired poll is never offered.
    const history = await newsletterIssuePolls({ newsletterType: PEST_INSIDER_TYPE });
    expect(history).toEqual({ ids: PEST_INSIDER_POLL_IDS, recent: [RETIRED], used: [RETIRED] });
    expect(chooseNewsletterPoll(history)).toBeNull();
    // A late vote from that email counts.
    await recordQuizResponse({ token: row.engagement_token, quizId: RETIRED, answerKey: 'ants' });
    expect(await answerOf()).toEqual({ quiz_id: RETIRED, quiz_answer: 'ants' });
    // A hand-made link to another quiz, or to a current poll, does not replace it.
    for (const [quizId, answerKey] of [['pest-pressure-v1', 'ants'], [PI1, 'shoe']]) {
      await expect(recordQuizResponse({ token: row.engagement_token, quizId, answerKey }))
        .resolves.toEqual({ ok: false, reason: 'not-in-issue' });
    }
    expect(await answerOf()).toEqual({ quiz_id: RETIRED, quiz_answer: 'ants' });
    // The next issue reports no result for a retired poll.
    expect(await newsletterLastPoll({ newsletterType: PEST_INSIDER_TYPE, sendDate: etDateString(new Date()) })).toBeNull();
  });

  test('the last poll result reads the newest issue readers got: its own votes, one per delivery row, only its poll', async () => {
    await onlyThisTestsPestInsiderIssues();
    const voted = (quizId, answer, at = daysAgo(6)) => ({ status: 'sent', sentAt: daysAgo(7), answered: { quizId, answer, at } });
    await insertIssues(PEST_INSIDER_TYPE, [
      // An older poll issue: not the newest, so its votes never count.
      { poll: PI1, sentAt: daysAgo(30), deliveries: [{ status: 'sent', sentAt: daysAgo(30), answered: { quizId: PI1, answer: 'shoe', at: daysAgo(29) } }] },
      {
        poll: PI2,
        sentAt: daysAgo(7),
        deliveries: [
          voted(PI2, 'ants'), voted(PI2, 'ants'), voted(PI2, 'spiders'),
          // Did not vote; a vote for another quiz; an answer the poll does not define.
          { status: 'sent', sentAt: daysAgo(7) }, voted(PI1, 'shoe'), voted(PI2, 'not-a-key'),
        ],
      },
      // A newer issue nobody got (a draft) does not decide.
      { poll: PI1, status: 'draft' },
    ]);
    const sendDate = etDateString(new Date());
    const last = await newsletterLastPoll({ newsletterType: PEST_INSIDER_TYPE, sendDate });
    expect(last).toEqual({ quizId: PI2, counts: { ants: 2, spiders: 1, 'not-a-key': 1 } });
    expect(pollResultLine(last)).toBe('Last poll: Which pest is the worst house guest? The top answer was Ants.');
  });

  test('the last poll result is none when the newest issue readers got had no poll, or when it is over 45 days old', async () => {
    await onlyThisTestsPestInsiderIssues();
    const sendDate = etDateString(new Date());
    const vote = (daysOld) => [{ status: 'sent', sentAt: daysAgo(daysOld), answered: { quizId: PI2, answer: 'ants', at: daysAgo(daysOld - 1) } }];
    await insertIssues(PEST_INSIDER_TYPE, [{ poll: PI2, sentAt: daysAgo(47), deliveries: vote(47) }]);
    expect(await newsletterLastPoll({ newsletterType: PEST_INSIDER_TYPE, sendDate })).toBeNull();
    await insertIssues(PEST_INSIDER_TYPE, [{ poll: PI2, sentAt: daysAgo(43), deliveries: vote(43) }]);
    expect((await newsletterLastPoll({ newsletterType: PEST_INSIDER_TYPE, sendDate })).quizId).toBe(PI2);
    // The next issue had no poll: the line is for the issue right after a poll issue only.
    await insertIssues(PEST_INSIDER_TYPE, [{ poll: null, sentAt: daysAgo(2) }]);
    expect(await newsletterLastPoll({ newsletterType: PEST_INSIDER_TYPE, sendDate })).toBeNull();
  });

  test('an unsent Waves Pest Insider issue holds its poll while its send row exists; the flagship rule does not change', async () => {
    await onlyThisTestsPestInsiderIssues();
    // The same issues under each newsletter's own poll ids.
    const issues = ([a, b, c, d, e, f]) => [
      { poll: null, sentAt: daysAgo(28) },
      { poll: null, sentAt: daysAgo(14) },
      // Held: a HOLD reply or Cancel schedule made its send a draft again, and
      // a person can send that draft by hand on any later day.
      { poll: a, status: 'draft', createdAt: daysAgo(20) },
      // Failed before any delivery row was written: a Resume mails its whole audience.
      { poll: b, status: 'failed', createdAt: daysAgo(13) },
      // Failed with a row no Resume would mail today. A repaired reader link
      // could change that, so the poll stays held.
      { poll: c, status: 'failed', createdAt: daysAgo(12), deliveries: [{ status: 'skipped' }] },
      // Queued for its send day.
      { poll: d, status: 'scheduled', createdAt: daysAgo(2) },
      // Claimed by a worker that has not written its delivery rows yet.
      { poll: e, status: 'sending', createdAt: daysAgo(1) },
      // 'sent', but every recipient dropped out before dispatch: it can never go out again.
      { poll: f, sentAt: daysAgo(3), deliveries: [{ status: 'skipped' }] },
    ];
    const pi = PEST_INSIDER_POLL_IDS;
    await insertIssues(PEST_INSIDER_TYPE, issues(pi));
    const history = await newsletterIssuePolls({ newsletterType: PEST_INSIDER_TYPE });
    expect(history.recent).toEqual([null, null]);
    expect([...history.used].sort()).toEqual(pi.slice(0, 5).sort());
    expect(chooseNewsletterPoll(history)).toBe(pi[5]);

    // A flagship-rule newsletter: a fresh send goes out only on its own
    // Tuesday, so none of these unsent issues holds a poll.
    const TYPE = newType();
    await insertIssues(TYPE, issues(NEWSLETTER_POLL_IDS));
    const flagship = await newsletterIssuePolls({ newsletterType: TYPE });
    expect(flagship.used).toEqual([]);
    expect(chooseNewsletterPoll(flagship)).toBe(P1);
  });
});
