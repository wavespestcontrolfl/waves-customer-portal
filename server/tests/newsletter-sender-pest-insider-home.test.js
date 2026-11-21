/**
 * The Waves Pest Insider "Your home" tokens in sendCampaign (services/newsletter-sender.js): a body that
 * carries them gives every reader BOTH keys (the reader's block, or '' for a reader with no customer, no
 * facts, a refused block, or when the facts cannot be read); a body without them gives the substitutions
 * it always did, with no facts read at all.
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

const [POST] = [...POST_URLS];
const ISSUE = renderIssue({
  subject: 'Synthetic subject',
  preview: 'Synthetic preview',
  lead: { headline: 'Dry eggs, wet future', sentences: [{ text: 'The CDC says eggs survive 8 months.' }], postUrl: POST },
  idItem: { text: 'It raises a generation in about a week.', species: { slug: 'aedes-mosquito', name: 'Aedes Mosquito' } },
});
const HOME = { lastVisit: { date: '2026-11-10', line: 'lawn' }, sinceDate: '2024-03-05', visitCount: 7 };
// The send's own clock is real time: facts dated far in the past still read as a block, never as the future.
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


function buildDb({ send, subscribers, deliveries }) {
  const queues = {
    newsletter_sends: [
      chain({ first: send }),
      chain({ updated: 1, returning: [{ id: send.id }] }),
      chain({ updated: 1 }),
      chain({ updated: 1 }),
      chain({ first: null }),
    ],
    newsletter_subscribers: [
      chain({ count: subscribers.length }),
      chain({ result: subscribers }),
      chain({ result: subscribers.map((s) => ({ id: s.id, customer_id: s.customer_id ?? null, email: s.email })) }),
    ],
    newsletter_send_deliveries: [
      chain({ first: null }),
      chain({}),
      chain({ result: deliveries }),
      chain({ updated: subscribers.length }),
      chain({ count: 0 }),
    ],
    customers: [chain({ result: subscribers.filter((s) => s.customer_id).map((s) => ({ id: s.customer_id, city: 'Test City', lawn_type: null })) })],
    customer_turf_profiles: [chain({ result: [] })],
    newsletter_calendar: [chain({ updated: 1 })],
  };
  db.mockImplementation((table) => {
    const queue = queues[table];
    if (!queue || !queue.length) throw new Error(`Unexpected db table: ${table} (queue exhausted)`);
    return queue.shift();
  });
}

const SUBS = [
  { id: 1, email: 'a@example.com', unsubscribe_token: 'tok-a', customer_id: 'cust-facts', first_name: 'Ann' },
  { id: 2, email: 'b@example.com', unsubscribe_token: 'tok-b', customer_id: null, first_name: null },
  { id: 3, email: 'c@example.com', unsubscribe_token: 'tok-c', customer_id: 'cust-none', first_name: null },
];
const DELIVERIES = SUBS.map((s) => ({ id: `d-${s.id}`, subscriber_id: s.id, status: 'queued', ab_variant: null }));
const sendRow = (over = {}) => ({
  id: 'send-1', status: 'draft', html_body: ISSUE.html_body, text_body: ISSUE.text_body, subject: ISSUE.subject,
  from_email: 'newsletter@wavespestcontrol.com', from_name: 'Waves', reply_to: 'contact@wavespestcontrol.com',
  segment_filter: null, subject_b: null, ...over,
});
const recipients = () => mockSendBroadcast.mock.calls[0][0].recipients;
const BASE_KEYS = ['{{greeting-name}}', '{{city}}', '{{grass-type}}'];

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadHomeFacts.mockReset();
});

describe('sendCampaign: the "Your home" tokens', () => {
  test('every reader gets both keys: the block for a customer with facts, empty for a reader with no customer or no facts', async () => {
    buildDb({ send: sendRow(), subscribers: SUBS, deliveries: DELIVERIES });
    mockLoadHomeFacts.mockResolvedValue(new Map([['cust-facts', HOME]]));

    const result = await sendCampaign('send-1');

    expect(result.accepted).toBe(3);
    // One read for the linked customers of the readers being sent, through the module's own loader.
    expect(mockLoadHomeFacts).toHaveBeenCalledTimes(1);
    expect(mockLoadHomeFacts.mock.calls[0][0]).toBe(db);
    expect(mockLoadHomeFacts.mock.calls[0][1].sort()).toEqual(['cust-facts', 'cust-none']);
    const [withFacts, noCustomer, noFacts] = recipients();
    for (const r of [withFacts, noCustomer, noFacts]) {
      expect(Object.keys(r.substitutions)).toEqual(expect.arrayContaining([HOME_TOKEN, HOME_TEXT_TOKEN]));
    }
    expect(withFacts.substitutions[HOME_TOKEN]).toBe(BLOCK.html);
    expect(withFacts.substitutions[HOME_TEXT_TOKEN]).toBe(BLOCK.text);
    expect(withFacts.substitutions[HOME_TEXT_TOKEN]).toContain('(lawn care)');
    for (const r of [noCustomer, noFacts]) {
      expect(r.substitutions[HOME_TOKEN]).toBe('');
      expect(r.substitutions[HOME_TEXT_TOKEN]).toBe('');
    }
    expect(mockWarn).not.toHaveBeenCalled();
  });

  test('when the facts cannot be read, one warning, both keys empty for everyone, and the send still goes out', async () => {
    buildDb({ send: sendRow(), subscribers: SUBS, deliveries: DELIVERIES });
    mockLoadHomeFacts.mockRejectedValue(new Error('db down'));

    const result = await sendCampaign('send-1');

    expect(result.accepted).toBe(3);
    expect(mockSendBroadcast).toHaveBeenCalledTimes(1);
    for (const r of recipients()) {
      expect(r.substitutions[HOME_TOKEN]).toBe('');
      expect(r.substitutions[HOME_TEXT_TOKEN]).toBe('');
    }
    const warnings = mockWarn.mock.calls.map((c) => c[0]).filter((m) => /Your home/.test(m));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('db down');
  });

  test('a block the send check refuses leaves that reader empty and is counted in one warning for the send', async () => {
    buildDb({ send: sendRow(), subscribers: SUBS, deliveries: DELIVERIES });
    mockLoadHomeFacts.mockResolvedValue(new Map([['cust-facts', HOME], ['cust-none', HOME]]));
    const spy = jest.spyOn(render, 'homeBlockErrors').mockReturnValue(['blocked']);
    try {
      const result = await sendCampaign('send-1');
      expect(result.accepted).toBe(3);
    } finally {
      spy.mockRestore();
    }
    for (const r of recipients()) {
      expect(r.substitutions[HOME_TOKEN]).toBe('');
      expect(r.substitutions[HOME_TEXT_TOKEN]).toBe('');
    }
    const warnings = mockWarn.mock.calls.map((c) => c[0]).filter((m) => /Your home/.test(m));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('2 reader(s)');
  });

  test('a send check that throws fails closed for that reader, never the send', async () => {
    buildDb({ send: sendRow(), subscribers: SUBS, deliveries: DELIVERIES });
    mockLoadHomeFacts.mockResolvedValue(new Map([['cust-facts', HOME]]));
    const spy = jest.spyOn(render, 'homeBlockErrors').mockImplementation(() => { throw new Error('validator broke'); });
    try {
      expect((await sendCampaign('send-1')).accepted).toBe(3);
    } finally {
      spy.mockRestore();
    }
    expect(recipients()[0].substitutions[HOME_TEXT_TOKEN]).toBe('');
  });

  test('a body without the tokens gives the substitutions it always did and reads no facts', async () => {
    buildDb({
      send: sendRow({ html_body: '<p>Body</p>', text_body: 'Body' }),
      subscribers: SUBS,
      deliveries: DELIVERIES,
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

  test('one reader\'s substitutions with a poll and the block stay under SendGrid\'s 10,000 bytes', () => {
    const { PEST_INSIDER_POLL_IDS, buildQuizSubstitutions } = require('../services/newsletter-quiz');
    const { buildFeedbackSubstitutions } = require('../services/newsletter-feedback');
    const poll = renderIssue({
      subject: 's', preview: 'p',
      lead: { headline: 'h', sentences: [{ text: 'The CDC says eggs survive 8 months.' }], postUrl: POST },
      idItem: { text: 'It raises a generation.', species: { slug: 'aedes-mosquito', name: 'Aedes Mosquito' } },
      pollQuizId: PEST_INSIDER_POLL_IDS[0],
    });
    const body = `${poll.html_body}\n${poll.text_body}`;
    const token = '00000000-0000-4000-8000-000000000000';
    const block = render.homeSubstitutions({ ...HOME, visitCount: 123456 }).substitutions;
    const subs = {
      '{{greeting-name}}': ', Alexandria-Josephine', '{{city}}': 'Lakewood Ranch', '{{grass-type}}': 'St. Augustine',
      ...buildQuizSubstitutions(body, { token }), ...buildFeedbackSubstitutions(body, { token }), ...block,
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
    const { html, text } = await renderSendPreview(sendRow({ status: 'draft' }), 'owner@example.com');
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
