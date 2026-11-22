/**
 * The Waves Pest Insider "Your home" tokens in sendCampaign (services/newsletter-sender.js): a body that
 * carries them gives every reader BOTH keys. The block shows only on a send with a planned audience, for a
 * reader whose facts name its current link (as adopted at the per-chunk re-check) and whose mailbox holds that
 * customer and no one else, and only when the block passes the send check; every other reader, a refused
 * block and an unreadable facts read give ''. A body without the tokens gives the substitutions it always
 * did, with no facts read at all.
 */
const mockSendBroadcast = jest.fn(async () => ({ messageId: 'sg-batch-1', recipientCount: 1 }));
const mockLoadHomeFacts = jest.fn();
const mockFriendCents = jest.fn();
const mockLiveSettings = jest.fn();
const mockWarn = jest.fn();

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: (...a) => mockWarn(...a), debug: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: () => true,
  sendBroadcast: mockSendBroadcast,
  unsubscribeUrl: jest.fn((t) => `https://portal/unsub/${t}`),
}));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({})) }));
jest.mock('../services/pest-insider/home', () => ({
  ...jest.requireActual('../services/pest-insider/home'),
  loadHomeFacts: (...args) => mockLoadHomeFacts(...args),
}));
// The friend's credit in cents, as the referral program's live setting gives it (0 = no amount to state).
jest.mock('../services/referral-engine', () => ({
  step2FriendCreditCentsOf: (...args) => mockFriendCents(...args),
  getLiveSettings: (...args) => mockLiveSettings(...args),
}));

const db = require('../models/db');
db.raw = jest.fn(async () => ({ rowCount: 0, rows: [] }));
db.transaction = jest.fn(async (cb) => cb({ raw: db.raw }));
const { sendCampaign } = require('../services/newsletter-sender');
const render = require('../services/pest-insider/render');
const { renderIssue, HOME_TOKEN, HOME_TEXT_TOKEN, homeBlock } = render;
const { REFERRAL_TAIL, REFERRAL_TOKEN, REFERRAL_TEXT_TOKEN, referralTail, referralLine } = require('../services/pest-insider/referral-line');
const { POST_URLS } = require('../services/pest-insider/posts');
const { isHeldOut, addressKey } = require('../services/pest-insider/audience');

const [POST] = [...POST_URLS];
const ISSUE = renderIssue({
  subject: 'Synthetic subject',
  preview: 'Synthetic preview',
  lead: { headline: 'Dry eggs, wet future', sentences: [{ text: 'The CDC says eggs survive 8 months.' }], postUrl: POST },
  idItem: { text: 'It raises a generation in about a week.', species: { slug: 'aedes-mosquito', name: 'Aedes Mosquito' } },
});
const HOME = { lastVisit: { date: '2026-11-10', line: 'lawn' }, sinceDate: '2024-03-05' };
// The send's own clock is real time: a last visit dated in the past reads as a block, never as the future.
const BLOCK = homeBlock(HOME);

// Tiny knex-shaped chain helper. Mirrors the pattern used in
// invoice-receipt-email-idempotency.test.js / portal-url.test.js so the
// failure surface stays familiar.
// `result` may be a function of the query's whereRaw calls ([sql, bindings] pairs), for a
// re-check whose rows depend on the SQL it was given.
function chain({ first, result, returning, count, updated, onUpdate, onWhereIn } = {}) {
  const q = {};
  const raws = [];
  ['where', 'whereRaw', 'whereNot', 'whereNotIn', 'whereNotNull', 'whereNull',
   'whereNotExists', 'select', 'orderBy', 'limit', 'leftJoin', 'join', 'joinRaw', 'forUpdate',
   // excludeMarketingOptedOut's pre-filtering CTE (codex #5165) — a no-op
   // chain link here, same as every other query-shape method above.
   'withMaterialized']
    .forEach((m) => { q[m] = jest.fn(() => q); });
  q.whereIn = jest.fn((...args) => {
    if (onWhereIn) onWhereIn(...args);
    return q;
  });
  q.whereRaw = jest.fn((sql, bindings) => { raws.push([sql, bindings]); return q; });
  const rows = () => (typeof result === 'function' ? result(raws) : (result ?? []));
  q.first = jest.fn(async () => first);
  q.count = jest.fn(() => ({
    first: jest.fn(async () => ({ c: count ?? 0 })),
  }));
  q.insert = jest.fn(() => ({
    onConflict: jest.fn(() => ({ ignore: jest.fn(async () => result || []) })),
    returning: jest.fn(async () => returning || []),
  }));
  q.update = jest.fn((payload) => {
    if (onUpdate) onUpdate(payload);
    return {
    returning: jest.fn(async () => returning ?? []),
    then: (resolve) => Promise.resolve(updated ?? 0).then(resolve),
    };
  });
  q.then = (resolve, reject) => Promise.resolve().then(rows).then(resolve, reject);
  q.catch = (reject) => Promise.resolve().then(rows).catch(reject);
  return q;
}



// Synthetic customer ids outside the Pest Insider holdout (a held-out customer's reader is never mailed).
const kept = (n) => {
  for (let i = 0; ; i += 1) {
    const id = `00000000-0000-4000-8000-${String(n * 1000 + i).padStart(12, '0')}`;
    if (!isHeldOut(id)) return id;
  }
};
const [C1, C3, C_OLD, C_NEW, C_OTHER, C_LAST] = [1, 3, 4, 5, 6, 7].map(kept);

const emailOf = (id) => ({ 1: 'a@example.com', 2: 'b@example.com', 3: 'c@example.com' }[id] || `u${id}@example.com`);
const PLAN = (ids) => ({ subscriber_ids: ids, holdout: 'pest-insider', address_keys: Object.fromEntries(ids.map((id) => [id, addressKey(emailOf(id))])) });

// `mailbox`: subscriber id -> the customers behind its mailbox, as the planned audience's own query reads them
// (withMailboxCustomers). `atDispatch`: subscriber id -> the customer linked at the per-chunk re-check, when it moved.
// `dropped`: subscriber ids the per-chunk re-check no longer returns (ineligible at dispatch). `chunks`: how many
// batches of 500 the send makes. `events` records the order of table reads and loader calls.
function buildDb({ send, subscribers, deliveries, mailbox = {}, atDispatch = {}, extraCustomers = 0, dropped = [], chunks = 1, events = [] }) {
  const planned = Boolean(send.segment_filter);
  const withMailbox = (rows) => rows.map((r) => ({ ...r, ...(planned ? { mailbox_customer_ids: r.id in mailbox ? mailbox[r.id] : [] } : {}) }));
  const recheck = () => chain({ result: withMailbox(subscribers.filter((s) => !dropped.includes(s.id)).map((s) => ({
    id: s.id, customer_id: s.id in atDispatch ? atDispatch[s.id] : (s.customer_id ?? null), email: s.email,
  }))) });
  const times = (n, make) => Array.from({ length: n }, make);
  const queues = {
    newsletter_sends: [
      chain({ first: send }),
      chain({ updated: 1, returning: [{ id: send.id }] }),
      ...times(chunks, () => chain({ updated: 1 })),
      chain({ updated: 1 }),
      chain({ first: null }),
    ],
    newsletter_subscribers: [
      chain({ count: subscribers.length, result: withMailbox(subscribers.map((s) => ({ id: s.id, customer_id: s.customer_id ?? null, email: s.email }))) }),
      chain({ result: subscribers }),
      ...times(chunks, recheck),
    ],
    newsletter_send_deliveries: [
      chain({ first: null }),
      chain({}),
      chain({ result: deliveries }),
      ...(dropped.length ? [chain({ updated: dropped.length })] : []),
      ...times(chunks, (_, i) => chain({ updated: Math.min(500, subscribers.length - dropped.length - i * 500) })),
      chain({ count: 0 }),
    ],
    customers: [
      chain({ result: subscribers.filter((s) => s.customer_id).map((s) => ({ id: s.customer_id, city: 'Test City', lawn_type: null })) }),
      ...times(extraCustomers, () => chain({ result: Object.values(atDispatch).filter(Boolean).map((id) => ({ id, city: 'Test City', lawn_type: null })) })),
    ],
    customer_turf_profiles: times(1 + extraCustomers, () => chain({ result: [] })),
    pest_insider_issues: [chain({ updated: 1 })],
    newsletter_calendar: [chain({ updated: 1 })],
  };
  db.mockImplementation((table) => {
    const queue = queues[table];
    if (!queue || !queue.length) throw new Error(`Unexpected db table: ${table} (queue exhausted)`);
    events.push(table);
    return queue.shift();
  });
  return events;
}

const SUBS = [
  { id: 1, email: emailOf(1), unsubscribe_token: 'tok-a', customer_id: C1, first_name: 'Ann' },
  { id: 2, email: emailOf(2), unsubscribe_token: 'tok-b', customer_id: null, first_name: null },
  { id: 3, email: emailOf(3), unsubscribe_token: 'tok-c', customer_id: C3, first_name: null },
];
const DELIVERIES = SUBS.map((s) => ({ id: `d-${s.id}`, subscriber_id: s.id, status: 'queued', ab_variant: null }));
// 501 readers make two batches (500 + 1): readers 1 and 501 have customers, the rest are leads.
const MANY = Array.from({ length: 501 }, (_, i) => {
  const id = i + 1;
  return { id, email: emailOf(id), unsubscribe_token: `tok-${id}`, customer_id: { 1: C1, 501: C_LAST }[id] ?? null, first_name: null };
});
const MANY_DELIVERIES = MANY.map((s) => ({ id: `d-${s.id}`, subscriber_id: s.id, status: 'queued', ab_variant: null }));
const MANY_PLAN = PLAN(MANY.map((s) => s.id));
// The facts a read returns for one reader: its customer, the address read, the visit.
const factsFor = (customerId, over = {}) => ({ customerId, address: 'a@example.com', ...HOME, ...over });
const sendRow = (over = {}) => ({
  id: 'send-1', status: 'draft', html_body: ISSUE.html_body, text_body: ISSUE.text_body, subject: ISSUE.subject,
  from_email: 'newsletter@wavespestcontrol.com', from_name: 'Waves', reply_to: 'contact@wavespestcontrol.com',
  segment_filter: PLAN([1, 2, 3]), subject_b: null, newsletter_type: 'pest-insider-monthly', ...over,
});
const recipients = (batch = 0) => mockSendBroadcast.mock.calls[batch][0].recipients;
const BASE_KEYS = ['{{greeting-name}}', '{{city}}', '{{grass-type}}'];
const homeWarnings = () => mockWarn.mock.calls.map((c) => c[0]).filter((m) => /Your home/.test(m));
const expectEmpty = (r) => {
  expect(r.substitutions[HOME_TOKEN]).toBe('');
  expect(r.substitutions[HOME_TEXT_TOKEN]).toBe('');
};
const expectBlock = (r) => {
  expect(r.substitutions[HOME_TOKEN]).toBe(BLOCK.html);
  expect(r.substitutions[HOME_TEXT_TOKEN]).toBe(BLOCK.text);
};
const one = (over = {}) => ({ send: sendRow({ segment_filter: PLAN([1]) }), subscribers: [SUBS[0]], deliveries: [DELIVERIES[0]], mailbox: { 1: [C1] }, ...over });

const GATE = 'GATE_PEST_INSIDER_AUTO_SEND';
const gateBefore = process.env[GATE];
beforeEach(() => {
  jest.clearAllMocks();
  mockLoadHomeFacts.mockReset();
  mockFriendCents.mockReset();
  mockFriendCents.mockReturnValue(0);
  mockLiveSettings.mockReset();
  mockLiveSettings.mockResolvedValue({ program_active: true });
  process.env[GATE] = 'true';
});
afterAll(() => {
  if (gateBefore === undefined) delete process.env[GATE];
  else process.env[GATE] = gateBefore;
});

describe('sendCampaign: the "Your home" tokens', () => {
  test('every reader gets both keys: the block for a reader whose facts and mailbox name its one customer, empty for the rest', async () => {
    buildDb({ send: sendRow(), subscribers: SUBS, deliveries: DELIVERIES, mailbox: { 1: [C1], 3: [C3] } });
    mockLoadHomeFacts.mockResolvedValue(new Map([[1, factsFor(C1)]]));

    const result = await sendCampaign('send-1');

    expect(result.accepted).toBe(3);
    // One read for the batch's readers, by subscriber id, through the module's own loader.
    expect(mockLoadHomeFacts).toHaveBeenCalledTimes(1);
    expect(mockLoadHomeFacts.mock.calls[0][0]).toBe(db);
    expect([...mockLoadHomeFacts.mock.calls[0][1]].sort()).toEqual([1, 2, 3]);
    const [withFacts, noCustomer, noFacts] = recipients();
    for (const r of [withFacts, noCustomer, noFacts]) {
      expect(Object.keys(r.substitutions)).toEqual(expect.arrayContaining([HOME_TOKEN, HOME_TEXT_TOKEN]));
    }
    expectBlock(withFacts);
    expect(withFacts.substitutions[HOME_TEXT_TOKEN]).toContain('(lawn care)');
    expectEmpty(noCustomer);
    expectEmpty(noFacts);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  // (A Waves Pest Insider issue with no plan never sends at all: audienceRefusal stops it first.)
  test('a send with no planned audience gives every reader empty values and reads no facts, token or not', async () => {
    buildDb({ send: sendRow({ segment_filter: null, newsletter_type: 'free-form' }), subscribers: SUBS, deliveries: DELIVERIES });
    mockLoadHomeFacts.mockResolvedValue(new Map([[1, factsFor(C1)]]));

    await sendCampaign('send-1');

    expect(mockLoadHomeFacts).not.toHaveBeenCalled();
    for (const r of recipients()) expectEmpty(r);
  });

  test('another newsletter that carries the Pest Insider audience plan and the tokens shows no block and reads no facts', async () => {
    buildDb({ send: sendRow({ newsletter_type: 'free-form' }), subscribers: SUBS, deliveries: DELIVERIES, mailbox: { 1: [C1] } });
    mockLoadHomeFacts.mockResolvedValue(new Map([[1, factsFor(C1)]]));

    await sendCampaign('send-1');

    expect(mockLoadHomeFacts).not.toHaveBeenCalled();
    for (const r of recipients()) expectEmpty(r);
  });

  test.each([undefined, 'false', '1'])('with GATE_PEST_INSIDER_AUTO_SEND = %p an issue sent by hand carries no block and reads no facts', async (value) => {
    if (value === undefined) delete process.env[GATE];
    else process.env[GATE] = value;
    buildDb(one());
    mockLoadHomeFacts.mockResolvedValue(new Map([[1, factsFor(C1)]]));

    await sendCampaign('send-1');

    expect(mockLoadHomeFacts).not.toHaveBeenCalled();
    expect(recipients()).toHaveLength(1);
    expectEmpty(recipients()[0]);
  });

  test('the facts are read once per batch, after that batch\'s eligibility re-check, for exactly the readers it mails', async () => {
    const events = buildDb({ send: sendRow(), subscribers: SUBS, deliveries: DELIVERIES, mailbox: { 1: [C1], 3: [C3] }, dropped: [3], events: [] });
    mockLoadHomeFacts.mockImplementation(async () => { events.push('loader'); return new Map([[1, factsFor(C1)]]); });

    await sendCampaign('send-1');

    expect(mockLoadHomeFacts).toHaveBeenCalledTimes(1);
    // Reader 3 failed the re-check and is skipped: it is not read, and not mailed.
    expect([...mockLoadHomeFacts.mock.calls[0][1]].sort()).toEqual([1, 2]);
    expect(recipients().map((r) => r.email)).toEqual([emailOf(1), emailOf(2)]);
    // The guard, the selection and the re-check all read newsletter_subscribers before the facts do.
    expect(events.slice(0, events.indexOf('loader')).filter((t) => t === 'newsletter_subscribers')).toHaveLength(3);
    expect(events.indexOf('loader')).toBe(events.lastIndexOf('loader'));
    expectBlock(recipients()[0]);
  });

  test('each batch reads its own readers: two batches, two reads; facts gone at dispatch give \'\' even though an earlier read had that reader', async () => {
    const events = buildDb({ send: sendRow({ segment_filter: MANY_PLAN }), subscribers: MANY, deliveries: MANY_DELIVERIES, mailbox: { 1: [C1], 501: [C_LAST] }, chunks: 2, events: [] });
    mockLoadHomeFacts
      .mockImplementationOnce(async () => { events.push('loader'); return new Map([[1, factsFor(C1)]]); })
      .mockImplementationOnce(async () => { events.push('loader'); return new Map(); });

    await sendCampaign('send-1');

    expect(mockSendBroadcast).toHaveBeenCalledTimes(2);
    expect(mockLoadHomeFacts).toHaveBeenCalledTimes(2);
    const [first, second] = mockLoadHomeFacts.mock.calls.map((c) => [...c[1]]);
    expect(first).toHaveLength(500);
    expect(first[0]).toBe(1);
    expect(second).toEqual([501]);
    // The second read comes after the first batch went out: never before the re-check of its own batch.
    expect(mockSendBroadcast.mock.invocationCallOrder[0]).toBeLessThan(mockLoadHomeFacts.mock.invocationCallOrder[1]);
    expect(events.slice(0, events.indexOf('loader')).filter((t) => t === 'newsletter_subscribers')).toHaveLength(3);
    expectBlock(recipients(0)[0]);
    expectEmpty(recipients(1)[0]);
  });

  test('a failed read in one batch gives \'\' for that batch\'s readers, one warning, and the send goes on', async () => {
    buildDb({ send: sendRow({ segment_filter: MANY_PLAN }), subscribers: MANY, deliveries: MANY_DELIVERIES, mailbox: { 1: [C1], 501: [C_LAST] }, chunks: 2 });
    mockLoadHomeFacts
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(new Map([[501, factsFor(C_LAST, { address: emailOf(501) })]]));

    const result = await sendCampaign('send-1');

    expect(result.accepted).toBe(501);
    expect(mockSendBroadcast).toHaveBeenCalledTimes(2);
    for (const r of recipients(0)) expectEmpty(r);
    expectBlock(recipients(1)[0]);
    expect(homeWarnings()).toHaveLength(1);
    expect(homeWarnings()[0]).toContain('db down');
    expect(homeWarnings()[0]).not.toMatch(/@example/);
  });

  test.each([
    ['no customers behind it', []],
    ['an unreadable list', null],
    ['another customer behind it too', [C1, C_OTHER]],
    ['only another customer behind it', [C_OTHER]],
  ])('a reader whose mailbox has %s gets empty values', async (_label, ids) => {
    buildDb(one({ mailbox: { 1: ids } }));
    mockLoadHomeFacts.mockResolvedValue(new Map([[1, factsFor(C1)]]));

    await sendCampaign('send-1');

    expect(mockLoadHomeFacts).toHaveBeenCalledTimes(1);
    expectEmpty(recipients()[0]);
  });

  test('facts for another customer than the reader\'s current link give empty values', async () => {
    buildDb(one());
    mockLoadHomeFacts.mockResolvedValue(new Map([[1, factsFor(C_OTHER)]]));

    await sendCampaign('send-1');

    expectEmpty(recipients()[0]);
  });

  test('facts read for another address than the one the batch mails give empty values; the same address in another letter case does not', async () => {
    buildDb(one());
    mockLoadHomeFacts.mockResolvedValue(new Map([[1, factsFor(C1, { address: 'old-address@example.com' })]]));
    await sendCampaign('send-1');
    expectEmpty(recipients()[0]);

    jest.clearAllMocks();
    mockLoadHomeFacts.mockReset();
    buildDb(one({ subscribers: [{ ...SUBS[0], email: ' A@Example.COM ' }] }));
    mockLoadHomeFacts.mockResolvedValue(new Map([[1, factsFor(C1)]]));
    await sendCampaign('send-1');
    expectBlock(recipients()[0]);

    // Facts with no address at all show nothing.
    jest.clearAllMocks();
    mockLoadHomeFacts.mockReset();
    buildDb(one());
    mockLoadHomeFacts.mockResolvedValue(new Map([[1, factsFor(C1, { address: '' })]]));
    await sendCampaign('send-1');
    expectEmpty(recipients()[0]);
  });

  test('a reader relinked at dispatch gets the block of the read made after the adoption, for its NEW link', async () => {
    const events = buildDb(one({ subscribers: [{ ...SUBS[0], customer_id: C_OLD }], mailbox: { 1: [C_NEW] }, atDispatch: { 1: C_NEW }, extraCustomers: 1, events: [] }));
    mockLoadHomeFacts.mockImplementation(async () => { events.push('loader'); return new Map([[1, factsFor(C_NEW)]]); });

    await sendCampaign('send-1');

    // One read only, and after the relinked link's personalization was loaded (the adoption).
    expect(mockLoadHomeFacts).toHaveBeenCalledTimes(1);
    expect(events.indexOf('loader')).toBeGreaterThan(events.lastIndexOf('customers'));
    expectBlock(recipients()[0]);
  });

  test('a reader relinked at dispatch gets \'\' when the read still names the old link, finds nothing, or fails', async () => {
    for (const answer of [
      () => Promise.resolve(new Map([[1, factsFor(C_OLD)]])),
      () => Promise.resolve(new Map()),
      () => Promise.reject(new Error('db down')),
    ]) {
      jest.clearAllMocks();
      mockLoadHomeFacts.mockReset();
      buildDb(one({ subscribers: [{ ...SUBS[0], customer_id: C_OLD }], mailbox: { 1: [C_NEW] }, atDispatch: { 1: C_NEW }, extraCustomers: 1 }));
      mockLoadHomeFacts.mockImplementation(answer);

      await sendCampaign('send-1');

      expectEmpty(recipients()[0]);
    }
  });

  test('when the facts cannot be read, one warning, both keys empty for everyone, and the send still goes out', async () => {
    buildDb({ send: sendRow(), subscribers: SUBS, deliveries: DELIVERIES, mailbox: { 1: [C1], 3: [C3] } });
    mockLoadHomeFacts.mockRejectedValue(new Error('db down'));

    const result = await sendCampaign('send-1');

    expect(result.accepted).toBe(3);
    expect(mockSendBroadcast).toHaveBeenCalledTimes(1);
    for (const r of recipients()) expectEmpty(r);
    expect(homeWarnings()).toHaveLength(1);
    expect(homeWarnings()[0]).toContain('db down');
  });

  test('a block the send check refuses leaves that reader empty and is counted in one warning for the send', async () => {
    buildDb({ send: sendRow(), subscribers: SUBS, deliveries: DELIVERIES, mailbox: { 1: [C1], 3: [C3] } });
    mockLoadHomeFacts.mockResolvedValue(new Map([[1, factsFor(C1)], [3, factsFor(C3, { address: emailOf(3) })]]));
    const spy = jest.spyOn(render, 'homeBlockErrors').mockReturnValue(['blocked']);
    try {
      expect((await sendCampaign('send-1')).accepted).toBe(3);
    } finally {
      spy.mockRestore();
    }
    for (const r of recipients()) expectEmpty(r);
    expect(homeWarnings()).toHaveLength(1);
    expect(homeWarnings()[0]).toContain('2 reader(s)');
  });

  test('a send check that throws fails closed for that reader, never the send', async () => {
    buildDb({ send: sendRow(), subscribers: SUBS, deliveries: DELIVERIES, mailbox: { 1: [C1], 3: [C3] } });
    mockLoadHomeFacts.mockResolvedValue(new Map([[1, factsFor(C1)]]));
    const spy = jest.spyOn(render, 'homeBlockErrors').mockImplementation(() => { throw new Error('validator broke'); });
    try {
      expect((await sendCampaign('send-1')).accepted).toBe(3);
    } finally {
      spy.mockRestore();
    }
    expectEmpty(recipients()[0]);
  });

  test('a body without the tokens gives the substitutions it always did and reads no facts', async () => {
    buildDb({
      send: sendRow({ html_body: '<p>Body</p>', text_body: 'Body' }),
      subscribers: SUBS,
      deliveries: DELIVERIES,
      mailbox: { 1: [C1], 3: [C3] },
    });

    await sendCampaign('send-1');

    expect(mockLoadHomeFacts).not.toHaveBeenCalled();
    for (const r of recipients()) {
      expect(Object.keys(r.substitutions)).toEqual(BASE_KEYS.concat(['{{feedback}}', '{{feedback-text}}'].filter((k) => k in r.substitutions)));
      expect(r.substitutions).not.toHaveProperty(HOME_TOKEN);
      expect(r.substitutions).not.toHaveProperty(HOME_TEXT_TOKEN);
    }
    expect(recipients()[0].substitutions).toMatchObject({ '{{greeting-name}}': ', Ann', '{{city}}': 'Test City', '{{grass-type}}': 'St. Augustine' });
  });

  test('a body that holds only a variant spelling is not a "Your home" send: no read, no keys, the variant is not hidden', async () => {
    buildDb({ send: sendRow({ html_body: '<p>Body {{ PI-Home }}</p>', text_body: 'Body {{PI-HOME-TEXT}}' }), subscribers: SUBS, deliveries: DELIVERIES, mailbox: { 1: [C1], 3: [C3] } });

    await sendCampaign('send-1');

    expect(mockLoadHomeFacts).not.toHaveBeenCalled();
    for (const r of recipients()) expect(Object.keys(r.substitutions).filter((k) => /pi-home/i.test(k))).toEqual([]);
  });

  test('one reader\'s substitutions with a poll, the reaction footer and the block stay under SendGrid\'s 10,000 bytes', () => {
    const { PEST_INSIDER_POLL_IDS, buildQuizSubstitutions } = require('../services/newsletter-quiz');
    const { buildFeedbackSubstitutions, ensureFeedbackToken } = require('../services/newsletter-feedback');
    const poll = renderIssue({
      subject: 's', preview: 'p',
      lead: { headline: 'h', sentences: [{ text: 'The CDC says eggs survive 8 months.' }], postUrl: POST },
      idItem: { text: 'It raises a generation.', species: { slug: 'aedes-mosquito', name: 'Aedes Mosquito' } },
      pollQuizId: PEST_INSIDER_POLL_IDS[0],
    });
    // The body as sendCampaign scans it: with the reaction footer it appends.
    const ensured = ensureFeedbackToken({ html: poll.html_body, text: poll.text_body });
    const body = `${ensured.html}\n${ensured.text}`;
    const token = '00000000-0000-4000-8000-000000000000';
    const block = render.homeSubstitutions({ lastVisit: { date: '2025-12-02', line: 'tree_shrub' }, sinceDate: '2024-03-05' }).substitutions;
    const feedback = buildFeedbackSubstitutions(body, { token });
    expect(Object.keys(feedback).length).toBeGreaterThan(0);
    const subs = {
      '{{greeting-name}}': ', Alexandria-Josephine', '{{city}}': 'Lakewood Ranch', '{{grass-type}}': 'St. Augustine',
      ...buildQuizSubstitutions(body, { token }), ...feedback, ...block,
      // The referral line, at its longest: the amount form.
      [REFERRAL_TOKEN]: referralLine(referralTail(123456)).html,
      [REFERRAL_TEXT_TOKEN]: referralLine(referralTail(123456)).text,
      '{{unsubscribe_url}}': `https://portal/unsub/${token}`,
    };
    expect(block[HOME_TOKEN]).not.toBe('');
    const bytes = Object.entries(subs).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(String(v)), 0);
    expect(bytes).toBeLessThan(10000);
  });
});

describe('sendCampaign: the referral line', () => {
  const FIRST = referralLine(REFERRAL_TAIL);
  const PAID = referralLine(referralTail(5000));
  const NONE = { html: '', text: '' };
  const URL = 'https://www.wavespestcontrol.com/referral/';
  const WORDS_FIRST = `Know a neighbor fighting the same bugs? Send them our way — referrals are the nicest compliment we get.\n${URL}`;
  const WORDS_PAID = `Know a neighbor fighting the same bugs? Send them our way. They get a $50 credit after their first plan service.\n${URL}`;
  const lineOf = (r) => ({ html: r.substitutions[REFERRAL_TOKEN], text: r.substitutions[REFERRAL_TEXT_TOKEN] });
  const mailed = (batch = 0) => mockSendBroadcast.mock.calls[batch][0];
  const three = (over = {}) => ({ send: sendRow(), subscribers: SUBS, deliveries: DELIVERIES, mailbox: { 1: [C1], 3: [C3] }, ...over });
  const twoBatches = () => ({ send: sendRow({ segment_filter: MANY_PLAN }), subscribers: MANY, deliveries: MANY_DELIVERIES, mailbox: { 1: [C1], 501: [C_LAST] }, chunks: 2 });
  const { recordTouchpoint } = require('../services/conversations');
  const touchpointOf = (customerId) => recordTouchpoint.mock.calls.map((c) => c[0]).find((t) => t.customerId === customerId);

  test('the mailed parts hold the tokens as stored, and every reader gets both keys: the first form while there is no amount to state', async () => {
    buildDb(three());
    mockLoadHomeFacts.mockResolvedValue(new Map());

    await sendCampaign('send-1');

    expect(mailed().html.split(REFERRAL_TOKEN)).toHaveLength(2);
    expect(mailed().text.split(REFERRAL_TEXT_TOKEN)).toHaveLength(2);
    for (const part of [ISSUE.html_body, ISSUE.text_body, mailed().html, mailed().text]) {
      expect(part).not.toContain('Know a neighbor');
      expect(part).not.toMatch(/\$\s?\d/);
    }
    expect(recipients()).toHaveLength(3);
    for (const r of recipients()) expect(lineOf(r)).toEqual(FIRST);
    expect(FIRST.text).toBe(`${WORDS_FIRST}\n\n`);
    // One read of the program for the batch, not one for each reader; the amount comes from that same row.
    expect(mockLiveSettings).toHaveBeenCalledTimes(1);
    expect(mockFriendCents).toHaveBeenCalledTimes(1);
    expect(mockFriendCents).toHaveBeenCalledWith({ program_active: true });
    expect(touchpointOf(C1).body).toContain(`${WORDS_FIRST}\n\nCatch you next time.`);
  });

  test('with an amount in the live setting, every reader gets the amount line, a customer or not', async () => {
    buildDb(three());
    mockLoadHomeFacts.mockResolvedValue(new Map());
    mockFriendCents.mockReturnValue(5000);

    await sendCampaign('send-1');

    for (const r of recipients()) expect(lineOf(r)).toEqual(PAID);
    expect(PAID.text).toBe(`${WORDS_PAID}\n\n`);
    expect(touchpointOf(C1).body).toContain(`${WORDS_PAID}\n\nCatch you next time.`);
  });

  test('a paused referral program: every reader gets no line, the history records none, and the batch goes out', async () => {
    buildDb(three());
    mockLoadHomeFacts.mockResolvedValue(new Map());
    mockLiveSettings.mockResolvedValue({ program_active: false });

    await sendCampaign('send-1');

    expect(mockSendBroadcast).toHaveBeenCalledTimes(1);
    expect(recipients()).toHaveLength(3);
    for (const r of recipients()) expect(lineOf(r)).toEqual(NONE);
    const { body } = touchpointOf(C1);
    expect(body).not.toContain('Know a neighbor');
    expect(body).not.toContain('/referral/');
    expect(body).not.toContain('{{pi-');
    expect(body).toContain('/pest-identifier/\n\nCatch you next time.');
  });

  test('a referral program that cannot be read: no line, and the batch still goes out', async () => {
    buildDb(three());
    mockLoadHomeFacts.mockResolvedValue(new Map());
    // Also with an amount the gate would state: there is one read, and no line without it.
    mockFriendCents.mockReturnValue(5000);
    mockLiveSettings.mockRejectedValue(new Error('settings table gone'));

    await sendCampaign('send-1');

    expect(mockSendBroadcast).toHaveBeenCalledTimes(1);
    for (const r of recipients()) expect(lineOf(r)).toEqual(NONE);
    expect(touchpointOf(C1).body).not.toContain('Know a neighbor');
  });

  test('the program is read once per batch: a change of the amount between two batches applies from the second batch on, in the mail and in the history', async () => {
    buildDb(twoBatches());
    mockLoadHomeFacts.mockResolvedValue(new Map());
    mockFriendCents.mockReturnValueOnce(5000).mockReturnValueOnce(0);

    await sendCampaign('send-1');

    expect(mockSendBroadcast).toHaveBeenCalledTimes(2);
    expect(mockLiveSettings).toHaveBeenCalledTimes(2);
    expect(mockFriendCents).toHaveBeenCalledTimes(2);
    expect(recipients(0)).toHaveLength(500);
    for (const r of recipients(0)) expect(lineOf(r)).toEqual(PAID);
    expect(recipients(1).map(lineOf)).toEqual([FIRST]);
    // The second read comes after the first batch went out.
    expect(mockSendBroadcast.mock.invocationCallOrder[0]).toBeLessThan(mockLiveSettings.mock.invocationCallOrder[1]);
    // Each customer's touchpoint records the offer as that customer's batch was mailed it.
    expect(touchpointOf(C1).body).toContain(WORDS_PAID);
    expect(touchpointOf(C_LAST).body).toContain(WORDS_FIRST);
    expect(touchpointOf(C_LAST).body).not.toMatch(/\$\s?\d/);
    for (const c of [C1, C_LAST]) expect(touchpointOf(c).body).not.toContain('{{pi-');
  });

  test('a pause between two batches takes the line out of the second batch, in the mail and in the history', async () => {
    buildDb(twoBatches());
    mockLoadHomeFacts.mockResolvedValue(new Map());
    mockLiveSettings.mockResolvedValueOnce({ program_active: true }).mockResolvedValueOnce({ program_active: false });

    await sendCampaign('send-1');

    expect(mockSendBroadcast).toHaveBeenCalledTimes(2);
    for (const r of recipients(0)) expect(lineOf(r)).toEqual(FIRST);
    expect(recipients(1).map(lineOf)).toEqual([NONE]);
    expect(touchpointOf(C1).body).toContain(WORDS_FIRST);
    expect(touchpointOf(C_LAST).body).not.toContain('Know a neighbor');
  });

  test('an issue with no text part: the history is written from the HTML part, with the line that batch was mailed', async () => {
    buildDb(three({ send: sendRow({ text_body: null }) }));
    mockLoadHomeFacts.mockResolvedValue(new Map());
    mockFriendCents.mockReturnValue(5000);

    await sendCampaign('send-1');

    for (const r of recipients()) expect(lineOf(r)).toEqual(PAID);
    const { body } = touchpointOf(C1);
    expect(body).toContain('Send them our way. They get a $50 credit after their first plan service.');
    expect(body).not.toContain('{{pi-');
    expect(body).not.toContain('nicest compliment');
  });

  test('the line follows the referral program alone: an issue sent with GATE_PEST_INSIDER_AUTO_SEND off states the amount too', async () => {
    delete process.env[GATE];
    buildDb(one());
    mockFriendCents.mockReturnValue(5000);

    await sendCampaign('send-1');

    expect(lineOf(recipients()[0])).toEqual(PAID);
    expect(touchpointOf(C1).body).toContain(WORDS_PAID);
  });

  test('another newsletter that holds the tokens gets the first form for every reader, in the mail and in the history, and reads nothing', async () => {
    buildDb(three({ send: sendRow({ newsletter_type: 'free-form', segment_filter: null }) }));
    mockFriendCents.mockReturnValue(5000);
    mockLiveSettings.mockResolvedValue({ program_active: false });

    await sendCampaign('send-1');

    for (const r of recipients()) expect(lineOf(r)).toEqual(FIRST);
    expect(touchpointOf(C1).body).toContain(WORDS_FIRST);
    expect(mockFriendCents).not.toHaveBeenCalled();
    expect(mockLiveSettings).not.toHaveBeenCalled();
  });

  test('an issue with no token (its line typed in by hand) is mailed as stored: no key, no read, no amount', async () => {
    const typed = (part) => part.split(REFERRAL_TOKEN).join('<p>Tell a friend. Thank you!</p>\n').split(REFERRAL_TEXT_TOKEN).join('Tell a friend. Thank you!\n\n');
    buildDb(three({ send: sendRow({ html_body: typed(ISSUE.html_body), text_body: typed(ISSUE.text_body) }) }));
    mockLoadHomeFacts.mockResolvedValue(new Map());
    mockFriendCents.mockReturnValue(5000);

    await sendCampaign('send-1');

    for (const part of [mailed().html, mailed().text]) {
      expect(part).toContain('Tell a friend. Thank you!');
      expect(part).not.toMatch(/\$\s?\d/);
    }
    for (const r of recipients()) {
      expect(r.substitutions).not.toHaveProperty(REFERRAL_TOKEN);
      expect(r.substitutions).not.toHaveProperty(REFERRAL_TEXT_TOKEN);
    }
    expect(touchpointOf(C1).body).toContain('Tell a friend. Thank you!\n\nCatch you next time.');
    expect(mockFriendCents).not.toHaveBeenCalled();
    expect(mockLiveSettings).not.toHaveBeenCalled();
  });
});

describe('every surface without a reader strips both tokens', () => {
  const { stripPersonalizationTokens } = require('../services/newsletter-draft');
  const { renderSendPreview } = require('../services/newsletter-proof');
  const { neutralizeHomeTokens } = require('../services/pest-insider/home');

  test('stripPersonalizationTokens (archive, RSS feed, touchpoint body) leaves the issue as it reads with no block', () => {
    for (const [part, token] of [[ISSUE.html_body, HOME_TOKEN], [ISSUE.text_body, HOME_TEXT_TOKEN]]) {
      expect(part).toContain(token);
      const stripped = stripPersonalizationTokens(part);
      expect(stripped).not.toContain('{{pi-');
      // The "Your home" tokens go, and the referral line stands in its form with no amount.
      const first = referralLine(REFERRAL_TAIL);
      expect(stripped).toBe(neutralizeHomeTokens(part).split(REFERRAL_TOKEN).join(first.html).split(REFERRAL_TEXT_TOKEN).join(first.text));
      expect(stripped.split('referrals are the nicest compliment we get.')).toHaveLength(2);
    }
    expect(stripPersonalizationTokens(`a ${HOME_TOKEN} b ${HOME_TEXT_TOKEN} {{city}}`)).toBe('a  b  your area');
  });

  test('a variant spelling is no token: every surface keeps it visible, so it is never hidden behind a clean-looking copy', async () => {
    const variants = '{{ PI-Home }} {{PI-HOME-TEXT}} {{ pi-home-text }}';
    expect(stripPersonalizationTokens(`a ${variants} b`)).toBe(`a ${variants} b`);
    db.mockImplementation(() => chain({ first: null, result: [] }));
    const { html, text } = await renderSendPreview(sendRow({ status: 'draft', segment_filter: null, html_body: `<p>${variants}</p>`, text_body: variants }), 'owner@example.com');
    for (const part of [html, text]) expect(part).toContain(variants);
  });

  test('the owner\'s FYI/proof copy shows neither token and no block', async () => {
    db.mockImplementation(() => chain({ first: null, result: [] }));
    const { html, text } = await renderSendPreview(sendRow({ status: 'draft', segment_filter: null }), 'owner@example.com');
    for (const part of [html, text]) {
      expect(part).not.toMatch(/pi-home/);
      expect(part).not.toContain('Your home');
      expect(part).toContain('Aedes Mosquito');
    }
    expect(text).toContain('Catch you next time.');
    // No block and no extra blank line: the referral line follows the last section after one blank line.
    expect(text).toContain('/pest-identifier/\n\nKnow a neighbor fighting the same bugs?');
  });

  test('the owner\'s FYI/proof copy shows the referral line a reader would get now: the first form, the amount line, or no line', async () => {
    const copy = async () => {
      db.mockImplementation(() => chain({ first: null, result: [] }));
      return renderSendPreview(sendRow({ status: 'draft', segment_filter: null }), 'owner@example.com');
    };
    const stored = await copy();
    expect(stored.text).toContain('Send them our way — referrals are the nicest compliment we get.\nhttps://www.wavespestcontrol.com/referral/\n\nCatch you next time.');
    expect(stored.html).toContain('>Send them our way</a> — referrals are the nicest compliment we get.</p>');

    mockFriendCents.mockReturnValue(5000);
    const paid = await copy();
    expect(paid.text).toContain('Send them our way. They get a $50 credit after their first plan service.\nhttps://www.wavespestcontrol.com/referral/\n\nCatch you next time.');
    expect(paid.html).toContain('>Send them our way</a>. They get a $50 credit after their first plan service.</p>');
    for (const part of [stored.html, stored.text, paid.html, paid.text]) expect(part).not.toContain('{{pi-referral');
    for (const part of [paid.html, paid.text]) expect(part).not.toContain('nicest compliment');

    // Another newsletter that holds the tokens shows the first form, whatever the setting holds.
    db.mockImplementation(() => chain({ first: null, result: [] }));
    const other = await renderSendPreview(sendRow({ status: 'draft', segment_filter: null, newsletter_type: 'free-form' }), 'owner@example.com');
    expect(other.text).toContain('Send them our way — referrals are the nicest compliment we get.');
    expect(other.html).not.toContain('{{pi-referral');

    // An issue with no text part of its own: the FYI copy's text is only its banner, and the HTML line is still filled.
    db.mockImplementation(() => chain({ first: null, result: [] }));
    const banner = await renderSendPreview(sendRow({ status: 'draft', segment_filter: null, text_body: 'FYI: this issue goes out Thursday.' }), 'owner@example.com');
    expect(banner.html).toContain('>Send them our way</a>. They get a $50 credit after their first plan service.</p>');
    expect(banner.text).toContain('FYI: this issue goes out Thursday.');

    // A paused referral program: the owner sees the issue without the line, as a reader would get it.
    mockFriendCents.mockReturnValue(0);
    mockLiveSettings.mockResolvedValue({ program_active: false });
    const paused = await copy();
    for (const part of [paused.html, paused.text]) {
      expect(part).not.toContain('Know a neighbor');
      expect(part).not.toContain('/referral/');
      expect(part).not.toContain('{{pi-referral');
    }
    expect(paused.text).toContain('/pest-identifier/\n\nCatch you next time.');
  });
});
