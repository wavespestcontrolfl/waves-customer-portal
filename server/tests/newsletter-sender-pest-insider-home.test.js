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

const db = require('../models/db');
db.raw = jest.fn(async () => ({ rowCount: 0, rows: [] }));
db.transaction = jest.fn(async (cb) => cb({ raw: db.raw }));
const { sendCampaign } = require('../services/newsletter-sender');
const render = require('../services/pest-insider/render');
const { renderIssue, HOME_TOKEN, HOME_TEXT_TOKEN, homeBlock } = render;
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
const home = (customerId, over = {}) => ({ customerId, ...HOME, ...over });
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
const [C1, C3, C_OLD, C_NEW, C_OTHER] = [1, 3, 4, 5, 6].map(kept);

const EMAILS = { 1: 'a@example.com', 2: 'b@example.com', 3: 'c@example.com' };
const PLAN = (ids) => ({ subscriber_ids: ids, holdout: 'pest-insider', address_keys: Object.fromEntries(ids.map((id) => [id, addressKey(EMAILS[id])])) });

// `mailbox`: subscriber id -> the customers behind its mailbox, as the planned audience's own query reads them
// (withMailboxCustomers). `atDispatch`: subscriber id -> the customer linked at the per-chunk re-check, when it moved.
function buildDb({ send, subscribers, deliveries, mailbox = {}, atDispatch = {}, extraCustomers = 0 }) {
  const planned = Boolean(send.segment_filter);
  const withMailbox = (rows) => rows.map((r) => ({ ...r, ...(planned ? { mailbox_customer_ids: r.id in mailbox ? mailbox[r.id] : [] } : {}) }));
  const queues = {
    newsletter_sends: [
      chain({ first: send }),
      chain({ updated: 1, returning: [{ id: send.id }] }),
      chain({ updated: 1 }),
      chain({ updated: 1 }),
      chain({ first: null }),
    ],
    newsletter_subscribers: [
      chain({ count: subscribers.length, result: withMailbox(subscribers.map((s) => ({ id: s.id, customer_id: s.customer_id ?? null, email: s.email }))) }),
      chain({ result: subscribers }),
      chain({ result: withMailbox(subscribers.map((s) => ({
        id: s.id, customer_id: s.id in atDispatch ? atDispatch[s.id] : (s.customer_id ?? null), email: s.email,
      }))) }),
    ],
    newsletter_send_deliveries: [
      chain({ first: null }),
      chain({}),
      chain({ result: deliveries }),
      chain({ updated: subscribers.length }),
      chain({ count: 0 }),
    ],
    customers: [
      chain({ result: subscribers.filter((s) => s.customer_id).map((s) => ({ id: s.customer_id, city: 'Test City', lawn_type: null })) }),
      ...Array.from({ length: extraCustomers }, () => chain({ result: Object.values(atDispatch).filter(Boolean).map((id) => ({ id, city: 'Test City', lawn_type: null })) })),
    ],
    customer_turf_profiles: Array.from({ length: 1 + extraCustomers }, () => chain({ result: [] })),
    pest_insider_issues: [chain({ updated: 1 })],
    newsletter_calendar: [chain({ updated: 1 })],
  };
  db.mockImplementation((table) => {
    const queue = queues[table];
    if (!queue || !queue.length) throw new Error(`Unexpected db table: ${table} (queue exhausted)`);
    return queue.shift();
  });
}

const SUBS = [
  { id: 1, email: EMAILS[1], unsubscribe_token: 'tok-a', customer_id: C1, first_name: 'Ann' },
  { id: 2, email: EMAILS[2], unsubscribe_token: 'tok-b', customer_id: null, first_name: null },
  { id: 3, email: EMAILS[3], unsubscribe_token: 'tok-c', customer_id: C3, first_name: null },
];
const DELIVERIES = SUBS.map((s) => ({ id: `d-${s.id}`, subscriber_id: s.id, status: 'queued', ab_variant: null }));
const PLANNED = PLAN([1, 2, 3]);
const sendRow = (over = {}) => ({
  id: 'send-1', status: 'draft', html_body: ISSUE.html_body, text_body: ISSUE.text_body, subject: ISSUE.subject,
  from_email: 'newsletter@wavespestcontrol.com', from_name: 'Waves', reply_to: 'contact@wavespestcontrol.com',
  segment_filter: PLANNED, subject_b: null, ...over,
});
const recipients = () => mockSendBroadcast.mock.calls[0][0].recipients;
const BASE_KEYS = ['{{greeting-name}}', '{{city}}', '{{grass-type}}'];
const homeWarnings = () => mockWarn.mock.calls.map((c) => c[0]).filter((m) => /Your home/.test(m));
const expectEmpty = (r) => {
  expect(r.substitutions[HOME_TOKEN]).toBe('');
  expect(r.substitutions[HOME_TEXT_TOKEN]).toBe('');
};

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadHomeFacts.mockReset();
});

describe('sendCampaign: the "Your home" tokens', () => {
  test('every reader gets both keys: the block for a reader whose facts and mailbox name its one customer, empty for the rest', async () => {
    buildDb({ send: sendRow(), subscribers: SUBS, deliveries: DELIVERIES, mailbox: { 1: [C1], 3: [C3] } });
    mockLoadHomeFacts.mockResolvedValue(new Map([[1, home(C1)]]));

    const result = await sendCampaign('send-1');

    expect(result.accepted).toBe(3);
    // One read for the readers being sent, by subscriber id, through the module's own loader.
    expect(mockLoadHomeFacts).toHaveBeenCalledTimes(1);
    expect(mockLoadHomeFacts.mock.calls[0][0]).toBe(db);
    expect([...mockLoadHomeFacts.mock.calls[0][1]].sort()).toEqual([1, 2, 3]);
    const [withFacts, noCustomer, noFacts] = recipients();
    for (const r of [withFacts, noCustomer, noFacts]) {
      expect(Object.keys(r.substitutions)).toEqual(expect.arrayContaining([HOME_TOKEN, HOME_TEXT_TOKEN]));
    }
    expect(withFacts.substitutions[HOME_TOKEN]).toBe(BLOCK.html);
    expect(withFacts.substitutions[HOME_TEXT_TOKEN]).toBe(BLOCK.text);
    expect(withFacts.substitutions[HOME_TEXT_TOKEN]).toContain('(lawn care)');
    expectEmpty(noCustomer);
    expectEmpty(noFacts);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  test('a send with no planned audience gives every reader empty values and reads no facts, token or not', async () => {
    buildDb({ send: sendRow({ segment_filter: null }), subscribers: SUBS, deliveries: DELIVERIES });
    mockLoadHomeFacts.mockResolvedValue(new Map([[1, home(C1)]]));

    await sendCampaign('send-1');

    expect(mockLoadHomeFacts).not.toHaveBeenCalled();
    for (const r of recipients()) expectEmpty(r);
  });

  test.each([
    ['no customers behind it', []],
    ['an unreadable list', null],
    ['another customer behind it too', [C1, C_OTHER]],
    ['only another customer behind it', [C_OTHER]],
  ])('a reader whose mailbox has %s gets empty values', async (_label, ids) => {
    buildDb({ send: sendRow({ segment_filter: PLAN([1]) }), subscribers: [SUBS[0]], deliveries: [DELIVERIES[0]], mailbox: { 1: ids } });
    mockLoadHomeFacts.mockResolvedValue(new Map([[1, home(C1)]]));

    await sendCampaign('send-1');

    expect(mockLoadHomeFacts).toHaveBeenCalledTimes(1);
    expectEmpty(recipients()[0]);
  });

  test('facts for another customer than the reader\'s current link give empty values', async () => {
    buildDb({ send: sendRow({ segment_filter: PLAN([1]) }), subscribers: [SUBS[0]], deliveries: [DELIVERIES[0]], mailbox: { 1: [C1] } });
    mockLoadHomeFacts.mockResolvedValue(new Map([[1, home(C_OTHER)]]));

    await sendCampaign('send-1');

    expectEmpty(recipients()[0]);
  });

  test('a reader relinked at dispatch gets the NEW link\'s block, read again for that reader, never the old link\'s', async () => {
    buildDb({
      send: sendRow({ segment_filter: PLAN([1]) }), subscribers: [{ ...SUBS[0], customer_id: C_OLD }], deliveries: [DELIVERIES[0]],
      mailbox: { 1: [C_NEW] }, atDispatch: { 1: C_NEW }, extraCustomers: 1,
    });
    mockLoadHomeFacts
      .mockResolvedValueOnce(new Map([[1, home(C_OLD, { lastVisit: { date: '2026-11-02', line: 'pest' } })]]))
      .mockResolvedValueOnce(new Map([[1, home(C_NEW)]]));

    await sendCampaign('send-1');

    expect(mockLoadHomeFacts).toHaveBeenCalledTimes(2);
    expect([...mockLoadHomeFacts.mock.calls[1][1]]).toEqual([1]);
    expect(recipients()[0].substitutions[HOME_TEXT_TOKEN]).toBe(BLOCK.text);
    expect(recipients()[0].substitutions[HOME_TEXT_TOKEN]).not.toContain('November 2');
  });

  test('a reader relinked at dispatch whose new link has no facts loses the block, and so does one whose read fails', async () => {
    for (const second of [() => Promise.resolve(new Map()), () => Promise.reject(new Error('db down'))]) {
      jest.clearAllMocks();
      mockLoadHomeFacts.mockReset();
      buildDb({
        send: sendRow({ segment_filter: PLAN([1]) }), subscribers: [{ ...SUBS[0], customer_id: C_OLD }], deliveries: [DELIVERIES[0]],
        mailbox: { 1: [C_NEW] }, atDispatch: { 1: C_NEW }, extraCustomers: 1,
      });
      mockLoadHomeFacts.mockResolvedValueOnce(new Map([[1, home(C_OLD)]])).mockImplementationOnce(second);

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
    mockLoadHomeFacts.mockResolvedValue(new Map([[1, home(C1)], [3, home(C3)]]));
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
    mockLoadHomeFacts.mockResolvedValue(new Map([[1, home(C1)]]));
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
      '{{unsubscribe_url}}': `https://portal/unsub/${token}`,
    };
    expect(block[HOME_TOKEN]).not.toBe('');
    const bytes = Object.entries(subs).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(String(v)), 0);
    expect(bytes).toBeLessThan(10000);
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
      expect(stripped).not.toContain('{{pi-home');
      expect(stripped).toBe(neutralizeHomeTokens(part));
    }
    expect(stripPersonalizationTokens(`a ${HOME_TOKEN} b ${HOME_TEXT_TOKEN} {{city}}`)).toBe('a  b  your area');
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
    // No block and no extra blank line: the sign-off follows the last section after one blank line.
    expect(text).toContain('/pest-identifier/\n\nCatch you next time.');
  });
});
