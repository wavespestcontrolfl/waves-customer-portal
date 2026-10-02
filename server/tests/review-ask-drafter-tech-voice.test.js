// Tech-voice review asks (GATE_REVIEW_ASK_TECH_VOICE, owner rulings
// 2026-09-30 / 10-01): every touch drafted from the visit's record in the
// technician's voice. These drafts AUTO-SEND, so each deterministic check
// that stands between a bad draft and a customer gets a case, plus the
// redraft-then-fallback contract.
const mockDispatch = jest.fn();
const mockFactCheck = jest.fn();
const mockGates = { reviewAskTechVoice: true, reviewAskPersonalized: false };
const mockGetRecentCalls = jest.fn(async () => []);
const mockTables = {};

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The writer and the fact check share the dispatcher; route by lane.
const mockRejectCall = jest.fn();
jest.mock('../services/llm/call', () => ({
  dispatchWithFallback: (...a) => (a[1]?.laneId === 'review_ask_fact_check' ? mockFactCheck(...a) : mockDispatch(...a)),
  rejectCall: (...a) => mockRejectCall(...a),
}));
jest.mock('../config/feature-gates', () => ({ isEnabled: (g) => !!mockGates[g], gates: mockGates }));
jest.mock('../services/messaging/review-ask-reservation', () => ({ excludeUnresolvedSendReservations: (q) => q }));
jest.mock('../services/context-aggregator', () => {
  const mod = { getRecentCalls: (...a) => mockGetRecentCalls(...a) };
  mod.redactAccessCodes = (s) => s;
  return mod;
});

const db = require('../models/db');
const Drafter = require('../services/review-ask-drafter');

const REPORT = {
  customerRecap: 'German cockroaches in the kitchen, first of two treatments.',
  observations: 'Moisture under the kitchen sink that may lead to mildew; suggested raising it with the property group.',
  inventoryDeductions: [{ product: 'Secret product' }],
};
const SMS = [
  { direction: 'inbound', message_body: "Are you coming? I can't wait too long, I need to go to work", created_at: new Date() },
];

function builder(table) {
  const rows = mockTables[table] || [];
  const q = {
    where() { return q; },
    whereRaw() { return q; },
    whereNotNull() { return q; },
    orWhereNotNull() { return q; },
    orderBy() { return q; },
    limit() { return q; },
    modify(fn) { fn(q); return q; },
    async select() { return rows; },
    async first() { return rows[0]; },
  };
  q.where = jest.fn((arg) => { if (typeof arg === 'function') arg(q); return q; });
  return q;
}

beforeEach(() => {
  mockDispatch.mockReset();
  mockRejectCall.mockReset();
  mockFactCheck.mockReset().mockImplementation(async (_p, req) => approveAll(req));
  mockGetRecentCalls.mockReset().mockResolvedValue([]);
  mockGates.reviewAskTechVoice = true;
  Object.keys(mockTables).forEach((k) => delete mockTables[k]);
  mockTables.service_records = [{ structured_notes: JSON.stringify(REPORT) }];
  mockTables.sms_log = SMS;
  mockTables.emails = [];
  mockTables.review_requests = [];
  db.mockImplementation(builder);
});

const INPUT = {
  customer: { id: 'cust-1', first_name: 'Marta', email: 'marta@example.com' },
  recipientFirstName: 'Marta',
  serviceType: 'Cockroach Treatment Service',
  techName: 'Adam Benetti',
  sequenceStep: 0,
  serviceDate: new Date(),
  serviceRecordId: 'rec-1',
  sequenceId: 'seq-1',
  channel: 'sms',
};
const GOOD = {
  body: "It's Adam, thanks for waiting on me this morning when you had to get to work. I flagged moisture under the kitchen sink for your property group. A Google review would really help: {review_url}",
  details: [
    { text: 'had to get to work', source_quote: 'I need to go to work' },
    { text: 'moisture under the kitchen sink', source_quote: 'Moisture under the kitchen sink' },
  ],
};
const reply = (draft) => ({ ok: true, text: JSON.stringify(draft) });
// What the fact check was given: the record and the sentences it judged.
const factInput = (req) => JSON.parse(req.text.slice(req.text.indexOf('{"record"')));
// Default checker: every sentence backed by a line that IS in the record.
const approveAll = (req) => ({
  ok: true,
  json: {
    sentences: factInput(req).sentences.map((sentence) => (/google review/i.test(sentence) && !/work|sink/i.test(sentence)
      ? { sentence, ask_only: true, off_limits: false, supported: false, quotes: [] }
      : { sentence, ask_only: false, off_limits: false, supported: true, quotes: [/sink/i.test(sentence) ? 'Moisture under the kitchen sink' : "Are you coming? I can't wait too long, I need to go to work"] })),
  },
});

describe('draftTechVoice', () => {
  test('gate off: no model call, null (the fixed template sends)', async () => {
    mockGates.reviewAskTechVoice = false;
    expect(await Drafter.draftTechVoice(INPUT)).toBeNull();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('a grounded draft is accepted; the report, texts and series history reach the model, products never do', async () => {
    mockTables.review_requests = [{ sequence_step: 0, channel: 'sms', custom_body: 'Earlier touch about the sink', template_key: 'day0_ask_tech_voice' }];
    mockDispatch.mockResolvedValueOnce(reply(GOOD));
    expect(await Drafter.draftTechVoice({ ...INPUT, sequenceStep: 1 })).toBe(GOOD.body);
    const call = mockDispatch.mock.calls[0][1];
    expect(call.jsonMode).toBe(true);
    expect(call.laneId).toBe('review_ask');
    expect(call.text).toContain('Moisture under the kitchen sink');
    expect(call.text).toContain('I need to go to work');
    expect(call.text).toContain('Earlier touch about the sink');
    expect(call.text).not.toContain('Secret product');
    // Rules ride the system channel, never the data.
    expect(call.system).toContain('Google review');
    expect(call.text).not.toContain('RULES');
  });

  test('a rejected draft gets ONE redraft with the reason; a second rejection falls back to the template', async () => {
    const ungrounded = { ...GOOD, details: [{ text: 'had to get to work', source_quote: 'words nobody said' }] };
    mockDispatch.mockResolvedValueOnce(reply(ungrounded)).mockResolvedValueOnce(reply(GOOD));
    expect(await Drafter.draftTechVoice(INPUT)).toBe(GOOD.body);
    expect(mockDispatch.mock.calls[1][1].system).toContain('REJECTED (ungrounded detail)');

    mockDispatch.mockReset().mockResolvedValue(reply(ungrounded));
    expect(await Drafter.draftTechVoice(INPUT)).toBeNull();
    expect(mockDispatch).toHaveBeenCalledTimes(2);
  });

  test('provider outage or unparseable output falls back to the template', async () => {
    mockDispatch.mockResolvedValueOnce({ ok: false });
    expect(await Drafter.draftTechVoice(INPUT)).toBeNull();
    mockDispatch.mockReset().mockResolvedValue({ ok: true, text: 'not json at all' });
    expect(await Drafter.draftTechVoice(INPUT)).toBeNull();
  });

  test('terminal pass 2: the company check reads the full contact name, not the first word a caller cut it to', async () => {
    mockDispatch.mockResolvedValueOnce(reply(GOOD));
    await Drafter.draftTechVoice({ ...INPUT, recipientFirstName: 'Sunset', recipientName: 'Sunset Vacation Rentals' });
    expect(mockDispatch.mock.calls[0][1].text).toContain('Customer first name: (unknown - do not use a name)');
  });

  test('terminal pass 4: a company split across first/last name is caught even when the contact name is cut to its first word', async () => {
    mockDispatch.mockResolvedValueOnce(reply(GOOD));
    await Drafter.draftTechVoice({ ...INPUT, recipientFirstName: 'Sunset', recipientName: 'Sunset', customer: { id: 'cust-1', first_name: 'Sunset', last_name: 'Vacation Rentals' } });
    expect(mockDispatch.mock.calls[0][1].text).toContain('Customer first name: (unknown - do not use a name)');
  });

  test('a company stored as the first name is never used as a greeting', async () => {
    mockDispatch.mockResolvedValueOnce(reply(GOOD));
    await Drafter.draftTechVoice({ ...INPUT, recipientFirstName: 'Sunset Vacation Rentals', customer: { id: 'cust-1', first_name: 'Sunset Vacation Rentals' } });
    expect(mockDispatch.mock.calls[0][1].text).toContain('Customer first name: (unknown - do not use a name)');
  });

  test('the email touch returns a paragraph with no link', async () => {
    const email = {
      body: 'Marta, it has been a week since the first treatment, and the moisture under the kitchen sink is still worth raising with your property group. Sorry again about the wait that morning when you had to get to work. A Google review would help us a lot.',
      details: [
        { text: 'had to get to work', source_quote: 'I need to go to work' },
        { text: 'moisture under the kitchen sink', source_quote: 'Moisture under the kitchen sink' },
      ],
    };
    mockDispatch.mockResolvedValueOnce(reply(email));
    // A quote per claim: the treatment (report recap) and the sink (observations).
    mockFactCheck.mockImplementation(async (_p, req) => ({
      ok: true,
      json: { sentences: factInput(req).sentences.map((sentence) => (/sink/i.test(sentence)
        ? { sentence, ask_only: false, greeting_only: false, off_limits: false, supported: true, quotes: ['first of two treatments', 'Moisture under the kitchen sink'] }
        : /work/i.test(sentence)
          ? { sentence, ask_only: false, greeting_only: false, off_limits: false, supported: true, quotes: ["I can't wait too long, I need to go to work"] }
          : { sentence, ask_only: true, greeting_only: false, off_limits: false, supported: false, quotes: [] })) },
    }));
    expect(await Drafter.draftTechVoice({ ...INPUT, sequenceStep: 2, channel: 'email' })).toBe(email.body);
  });
});

describe('fact check — every sentence backed by the record (owner ruling 2026-10-01)', () => {
  const judge = (verdicts) => mockFactCheck.mockImplementation(async (_p, req) => ({
    ok: true,
    json: { sentences: factInput(req).sentences.map((sentence, i) => ({ sentence, off_limits: false, ...verdicts[i] })) },
  }));

  test('runs on the fast verifier lane, sees the record but not what Waves already sent', async () => {
    mockTables.review_requests = [{ sequence_step: 0, channel: 'sms', custom_body: 'Earlier touch about the sink', template_key: 'day0_ask_tech_voice' }];
    mockTables.sms_log = [...SMS, { direction: 'outbound', message_body: 'Thanks again for having me out. A Google review would help: x', created_at: new Date() }];
    mockDispatch.mockResolvedValueOnce(reply(GOOD));
    expect(await Drafter.draftTechVoice({ ...INPUT, sequenceStep: 1 })).toBe(GOOD.body);
    const req = mockFactCheck.mock.calls[0][1];
    expect(req.jsonSchema).toBeDefined();
    const { record, sentences } = factInput(req);
    expect(record).toContain('I need to go to work');
    expect(record).not.toContain('Earlier touch about the sink');
    // Nothing Waves texted either: an earlier review ask in sms_log cannot back a claim.
    expect(record).not.toContain('Thanks again for having me out');
    expect(sentences).toHaveLength(3);
  });

  test('an invented personal detail is refused: redraft once, then the template', async () => {
    const baby = { body: "It's Adam, I know you had to get to work. So happy about your new baby! A Google review would really help: {review_url}", details: GOOD.details.slice(0, 1) };
    mockDispatch.mockResolvedValue(reply(baby));
    judge([{ ask_only: false, supported: true, quotes: ['I need to go to work'] }, { ask_only: false, supported: false, quotes: [] }, { ask_only: true, supported: false, quotes: [] }]);
    expect(await Drafter.draftTechVoice(INPUT)).toBeNull();
    expect(mockDispatch).toHaveBeenCalledTimes(2);
    expect(mockDispatch.mock.calls[1][1].system).toContain('REJECTED (unsupported sentence)');
  });

  test('the checker cannot vouch with a quote that is not in the record', async () => {
    mockDispatch.mockResolvedValue(reply(GOOD));
    judge([{ ask_only: false, supported: true, quotes: ['she just had a baby'] }, { ask_only: false, supported: true, quotes: ['Moisture under the kitchen sink'] }, { ask_only: true, supported: false, quotes: [] }]);
    expect(await Drafter.draftTechVoice(INPUT)).toBeNull();
  });

  test('a sentence with content can never pass as a bare review request', async () => {
    const sneaky = { ...GOOD, body: "It's Adam, I know you had to get to work. Congrats on the baby, a Google review would really help: {review_url}", details: GOOD.details.slice(0, 1) };
    mockDispatch.mockResolvedValue(reply(sneaky));
    judge([{ ask_only: false, supported: true, quotes: ['I need to go to work'] }, { ask_only: true, supported: false, quotes: [] }]);
    expect(await Drafter.draftTechVoice(INPUT)).toBeNull();
    const { isAskOnlySentence } = Drafter.__private;
    expect(isAskOnlySentence('Marta, a Google review would really help: {review_url}', new Set(['marta']))).toBe(true);
    expect(isAskOnlySentence('A Google review would help us a lot.', new Set())).toBe(true);
    expect(isAskOnlySentence('Congrats on the baby, a Google review would help: {review_url}', new Set())).toBe(false);
    // Terminal pass 3: ordinary request wording is still a bare request.
    expect(isAskOnlySentence('Could you leave a Google review? {review_url}', new Set())).toBe(true);
    expect(isAskOnlySentence('Can you please share a Google review? {review_url}', new Set())).toBe(true);
  });

  test('every verdict must judge the sentence actually being sent', async () => {
    mockDispatch.mockResolvedValue(reply(GOOD));
    mockFactCheck.mockImplementation(async (_p, req) => ({
      ok: true,
      json: { sentences: factInput(req).sentences.map((sentence, i) => (i === 1
        ? { sentence: 'I need to go to work.', ask_only: false, off_limits: false, supported: true, quotes: ['I need to go to work'] }
        : approveAll(req).json.sentences[i])) },
    }));
    expect(await Drafter.draftTechVoice(INPUT)).toBeNull();
  });

  test('Codex r2: a record-backed but off-limits sentence (household, health, product) is refused by the checker verdict', async () => {
    mockDispatch.mockResolvedValue(reply(GOOD));
    judge([{ ask_only: false, off_limits: true, supported: true, quotes: ['I need to go to work'] }, { ask_only: false, supported: true, quotes: ['Moisture under the kitchen sink'] }, { ask_only: true, supported: false, quotes: [] }]);
    expect(await Drafter.draftTechVoice(INPUT)).toBeNull();
    expect(mockDispatch.mock.calls[1][1].system).toContain('REJECTED (off limits topic)');
    // A missing off_limits verdict counts as off limits (fail closed).
    mockDispatch.mockReset().mockResolvedValue(reply(GOOD));
    mockFactCheck.mockReset().mockImplementation(async (_p, req) => ({ ok: true, json: { sentences: approveAll(req).json.sentences.map(({ off_limits: _o, ...rest }) => rest) } }));
    expect(await Drafter.draftTechVoice(INPUT)).toBeNull();
  });

  test('Codex r3: one time budget covers write, check and redraft; each call gets only what is left', async () => {
    let now = 1_000_000;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const ungrounded = { ...GOOD, details: [{ text: 'had to get to work', source_quote: 'words nobody said' }] };
      // The first write takes 57 s and is rejected: no time is left for a redraft.
      mockDispatch.mockImplementation(async () => { now += 57_000; return reply(ungrounded); });
      expect(await Drafter.draftTechVoice(INPUT)).toBeNull();
      expect(mockDispatch).toHaveBeenCalledTimes(1);
      const [, req, opts] = mockDispatch.mock.calls[0];
      expect(req.timeoutMs).toBeLessThanOrEqual(60_000);
      expect(opts).toMatchObject({ hardDeadline: true });
    } finally {
      spy.mockRestore();
    }
  });

  test('Codex r1: the checker rules ride the system channel; the user message is data only', async () => {
    mockDispatch.mockResolvedValueOnce(reply(GOOD));
    await Drafter.draftTechVoice(INPUT);
    const req = mockFactCheck.mock.calls[0][1];
    expect(req.system).toContain('ask_only');
    expect(req.text).not.toContain('ask_only');
    expect(req.text.startsWith('FACT CHECK DATA')).toBe(true);
  });

  test('terminal pass 5: a bare thanks needs no quote, but a thanks with a claim still does', async () => {
    const thanks = { ...GOOD, body: "It's Adam, I know you had to get to work. Thanks again. A Google review would really help: {review_url}", details: GOOD.details.slice(0, 1) };
    mockDispatch.mockResolvedValue(reply(thanks));
    judge([{ ask_only: false, supported: true, quotes: ['I need to go to work'] }, { ask_only: false, greeting_only: true, supported: true, quotes: [] }, { ask_only: true, supported: false, quotes: [] }]);
    expect(await Drafter.draftTechVoice(INPUT)).toBe(thanks.body);
    const { isGreetingOnlySentence } = Drafter.__private;
    expect(isGreetingOnlySentence('Thanks again.', new Set())).toBe(true);
    expect(isGreetingOnlySentence("It's Adam.", new Set(['adam']))).toBe(true);
    expect(isGreetingOnlySentence('Thanks for the new deck.', new Set())).toBe(false);
    // Terminal pass 6: first-person requests are bare requests too.
    const { isAskOnlySentence } = Drafter.__private;
    expect(isAskOnlySentence('Would you leave me a Google review? {review_url}', new Set())).toBe(true);
    expect(isAskOnlySentence('A Google review would mean a lot to me.', new Set())).toBe(true);
  });

  test('terminal pass 5: every record line carries its date, and today is stated', async () => {
    mockDispatch.mockResolvedValueOnce(reply(GOOD));
    mockTables.sms_log = [{ direction: 'inbound', message_body: 'I saw ants today', created_at: new Date('2026-09-10T15:00:00Z') }];
    // A fixed visit date: the message must sit inside the visit window whatever day the suite runs.
    await Drafter.draftTechVoice({ ...INPUT, serviceDate: '2026-09-15' });
    const text = mockDispatch.mock.calls[0][1].text;
    expect(text).toContain('[customer, 2026-09-10] I saw ants today');
    expect(text).toMatch(/Today: \d{4}-\d{2}-\d{2}/);
  });

  test('terminal pass 6: a hyphenated name passes the greeting check end to end', async () => {
    const hi = { ...GOOD, body: "Hi Mary-Jane. I know you had to get to work. A Google review would really help: {review_url}", details: GOOD.details.slice(0, 1) };
    mockDispatch.mockResolvedValue(reply(hi));
    judge([{ ask_only: false, greeting_only: true, supported: true, quotes: [] }, { ask_only: false, supported: true, quotes: ['I need to go to work'] }, { ask_only: true, supported: false, quotes: [] }]);
    expect(await Drafter.draftTechVoice({ ...INPUT, recipientFirstName: 'Mary-Jane', customer: { id: 'cust-1', first_name: 'Mary-Jane' } })).toBe(hi.body);
  });

  test('GitHub r1: the fact check starts on the provider the writer did not use', async () => {
    mockDispatch.mockResolvedValueOnce({ ...reply(GOOD), provider: 'anthropic' });
    await Drafter.draftTechVoice(INPUT);
    expect(mockFactCheck.mock.calls[0][0].primary.provider).toBe('openai');
    mockFactCheck.mockClear();
    mockDispatch.mockResolvedValueOnce({ ...reply(GOOD), provider: 'openai' });
    await Drafter.draftTechVoice(INPUT);
    const policy = mockFactCheck.mock.calls[0][0];
    expect(policy.primary.provider).toBe('anthropic');
    expect(policy.fallback.provider).toBe('openai');
  });

  test('GitHub r1: a refused draft is marked failed on the call ledger; an unavailable checker is not', async () => {
    const ungrounded = { ...GOOD, details: [{ text: 'had to get to work', source_quote: 'words nobody said' }] };
    mockDispatch.mockResolvedValue(reply(ungrounded));
    await Drafter.draftTechVoice(INPUT);
    expect(mockRejectCall.mock.calls[0][1]).toBe('ungrounded_detail');
    mockRejectCall.mockClear();
    mockDispatch.mockReset().mockResolvedValue(reply(GOOD));
    mockFactCheck.mockReset().mockResolvedValue({ ok: false });
    await Drafter.draftTechVoice(INPUT);
    expect(mockRejectCall).not.toHaveBeenCalled();
  });

  test('GitHub r3: the ledger row marked failed is the adapter result the validate hook saw, not the dispatcher copy', async () => {
    const ungrounded = { ...GOOD, details: [{ text: 'had to get to work', source_quote: 'words nobody said' }] };
    const adapterResults = [];
    // Like dispatchWithFallback: hand the adapter's own object to validate, return a spread copy.
    mockDispatch.mockImplementation(async (_policy, _payload, opts) => {
      const adapter = { ...reply(ungrounded), provider: 'anthropic' };
      adapterResults.push(adapter);
      expect(opts.validate(adapter)).toBeNull();
      return { ...adapter };
    });
    await Drafter.draftTechVoice(INPUT);
    expect(mockRejectCall).toHaveBeenCalledTimes(2);
    expect(mockRejectCall.mock.calls[0][0]).toBe(adapterResults[0]);
    expect(mockRejectCall.mock.calls[1][0]).toBe(adapterResults[1]);
  });

  test('GitHub r3: a review request that coaches the sentiment is refused', () => {
    const rec = 'I need to go to work.';
    const verify = ({ body }) => Drafter.verifyTechVoiceDraft(
      { body, details: [{ text: 'had to get to work', source_quote: 'I need to go to work' }] },
      { channel: 'sms', firstName: 'Marta', techName: 'Adam Benetti', termite: false, corpus: rec, ownWords: rec },
    );
    expect(verify({ body: 'I know you had to get to work. Please give me a great Google review: {review_url}' })).toBe('coached_review');
    expect(verify({ body: 'I know you had to get to work. A glowing Google review would help: {review_url}' })).toBe('coached_review');
    expect(Drafter.__private.isAskOnlySentence('Please give me a great Google review: {review_url}', new Set())).toBe(false);
    // "It would be great" is not an adjective on the review.
    expect(verify({ body: 'I know you had to get to work. A Google review would be great: {review_url}' })).toBeNull();
  });

  test('GitHub r3: a self-introduction counts as a greeting only when it names the technician', () => {
    const { isGreetingOnlySentence } = Drafter.__private;
    expect(isGreetingOnlySentence("I'm here.", new Set(['adam']))).toBe(false);
    expect(isGreetingOnlySentence('This is Adam here.', new Set(['adam']))).toBe(true);
    expect(isGreetingOnlySentence('Hi Marta!', new Set(['marta']))).toBe(true);
    // GitHub r4: the customer's name greets, it never introduces.
    expect(isGreetingOnlySentence("It's Marta.", new Set(['marta', 'adam']), new Set(['adam']))).toBe(false);
    expect(isGreetingOnlySentence("It's Adam.", new Set(['marta', 'adam']), new Set(['adam']))).toBe(true);
  });

  test("GitHub r1: the writer's answer is read from the dispatcher's tolerant parse", async () => {
    mockDispatch.mockResolvedValueOnce({ ok: true, text: 'Here you go:\n```json\n{"body": "x",}\n```', json: { ...GOOD } });
    expect(await Drafter.draftTechVoice(INPUT)).toBe(GOOD.body);
  });

  test('GitHub r1: an email that did not authenticate as its own domain is not the customer\'s words', async () => {
    mockTables.emails = [
      { id: 'e1', subject: null, from_address: 'marta@example.com', authentication_results: 'mx.google.com; dkim=pass header.i=@example.com; spf=pass smtp.mailfrom=example.com', body_text: 'Authentic note about the garage door.', received_at: new Date() },
      { id: 'e2', subject: null, from_address: 'marta@example.com', authentication_results: 'mx.google.com; dkim=fail; spf=fail', body_text: 'Spoofed: congrats on the new baby.', received_at: new Date() },
    ];
    mockDispatch.mockResolvedValueOnce(reply(GOOD));
    await Drafter.draftTechVoice(INPUT);
    const text = mockDispatch.mock.calls[0][1].text;
    expect(text).toContain('Authentic note about the garage door.');
    expect(text).not.toContain('Spoofed');
  });

  test('GitHub r5: the redraft reason rides the system channel, never the data block', async () => {
    const ungrounded = { ...GOOD, details: [{ text: 'had to get to work', source_quote: 'words nobody said' }] };
    mockDispatch.mockResolvedValueOnce(reply(ungrounded)).mockResolvedValueOnce(reply(GOOD));
    await Drafter.draftTechVoice(INPUT);
    expect(mockDispatch.mock.calls[1][1].system).toContain('REJECTED (ungrounded detail)');
    expect(mockDispatch.mock.calls[1][1].text).not.toContain('REJECTED');
  });

  test('GitHub r5: history is scoped to the visit (a month before through the visit day)', async () => {
    mockTables.sms_log = [
      { direction: 'inbound', message_body: 'Ants by the back door again', created_at: new Date('2026-09-20T15:00:00Z') },
      { direction: 'inbound', message_body: 'Can you quote rodent work next month', created_at: new Date('2026-09-29T15:00:00Z') },
      { direction: 'inbound', message_body: 'Old roof rat question', created_at: new Date('2026-07-01T15:00:00Z') },
    ];
    mockDispatch.mockResolvedValueOnce(reply(GOOD));
    await Drafter.draftTechVoice({ ...INPUT, serviceDate: '2026-09-25' });
    const text = mockDispatch.mock.calls[0][1].text;
    expect(text).toContain('Ants by the back door again');
    expect(text).not.toContain('rodent work');
    expect(text).not.toContain('roof rat');
  });

  test('GitHub r5: a detail cited only from the record header (a name) is not a visit detail', () => {
    const rec = 'Customer first name: Marta\nTechnician (you): Adam';
    const v = Drafter.verifyTechVoiceDraft(
      { body: "Hi Marta! It's Adam. A Google review would really help: {review_url}", details: [{ text: 'Marta', source_quote: 'Customer first name: Marta' }] },
      { channel: 'sms', firstName: 'Marta', techName: 'Adam', termite: false, corpus: rec, ownWords: 'German cockroaches in the kitchen.' },
    );
    expect(v).toBe('ungrounded_detail');
  });

  test('#5524 r1 P1: a checker quote must share a content word with its sentence', async () => {
    const baby = { body: "It's Adam, I know you had to get to work. So happy about your new baby! A Google review would really help: {review_url}", details: GOOD.details.slice(0, 1) };
    mockDispatch.mockResolvedValue(reply(baby));
    // The checker wrongly vouches for the invented sentence with a real but unrelated line.
    judge([{ ask_only: false, supported: true, quotes: ['I need to go to work'] }, { ask_only: false, supported: true, quotes: ['I need to go to work'] }, { ask_only: true, supported: false, quotes: [] }]);
    expect(await Drafter.draftTechVoice(INPUT)).toBeNull();
    expect(mockDispatch.mock.calls[1][1].system).toContain('REJECTED (unsupported sentence)');
  });

  test('#5524 r1: the visit bound is applied in the query, before the row limit', async () => {
    const whereCalls = [];
    db.mockImplementation((table) => {
      const q = builder(table);
      const orig = q.where;
      q.where = jest.fn((...args) => { whereCalls.push([table, ...args]); return orig(...args); });
      return q;
    });
    mockDispatch.mockResolvedValueOnce(reply(GOOD));
    await Drafter.draftTechVoice({ ...INPUT, serviceDate: '2026-09-15' });
    const bound = whereCalls.find(([t, col, op]) => t === 'sms_log' && col === 'created_at' && op === '<');
    expect(bound).toBeDefined();
    expect(bound[3].toISOString()).toBe('2026-09-16T04:00:00.000Z'); // midnight ET starting the next day
    expect(mockGetRecentCalls.mock.calls[0][1].before.toISOString()).toBe('2026-09-16T04:00:00.000Z');
  });

  test('#5524 r1: a satisfaction condition split from the review sentence is refused', () => {
    const rec = 'I need to go to work.';
    const v = Drafter.verifyTechVoiceDraft(
      { body: 'I know you had to get to work. If you were happy with the visit. Would you leave a Google review? {review_url}', details: [{ text: 'had to get to work', source_quote: 'I need to go to work' }] },
      { channel: 'sms', firstName: 'Marta', techName: 'Adam', termite: false, corpus: rec, ownWords: rec },
    );
    expect(v).toBe('satisfaction_condition');
    expect(Drafter.verifyDraftBody('Aaron, if you were happy with the visit. Would you leave a Google review? {review_url}', { firstName: 'Aaron' })).toBe('satisfaction_condition');
  });

  test('#5524 r2 P1: an email attached by display name from another address is not the customer\'s words', async () => {
    const auth = (d) => `mx.google.com; dkim=pass header.i=@${d}`;
    mockTables.emails = [
      { id: 'e1', subject: null, from_address: 'Marta@Example.com', authentication_results: auth('example.com'), body_text: 'Her own note about the lanai.', received_at: new Date() },
      { id: 'e2', subject: null, from_address: 'someone@other.org', authentication_results: auth('other.org'), body_text: 'A stranger mentions a new baby.', received_at: new Date() },
    ];
    mockDispatch.mockResolvedValueOnce(reply(GOOD));
    await Drafter.draftTechVoice(INPUT);
    const text = mockDispatch.mock.calls[0][1].text;
    expect(text).toContain('Her own note about the lanai.');
    expect(text).not.toContain('new baby');
  });

  test('#5524 r2 P1: shared stop words (stemmed) never count as quote overlap', () => {
    const { quoteSharesContent, detailSupportedByQuote } = Drafter.__private;
    expect(quoteSharesContent('There was a new baby at the house.', 'There were ants in the kitchen', new Set())).toBe(false);
    expect(detailSupportedByQuote('there was a new baby', 'There were ants in the kitchen')).toBe(false);
    expect(quoteSharesContent('Ants were busy in the kitchen.', 'There were ants in the kitchen', new Set())).toBe(true);
  });

  test('#5524 r3 P1: every clause needs its own backing; a quote for the ants does not cover "your new baby"', async () => {
    const both = { body: "It's Adam, I know you had to get to work. You mentioned the moisture under the sink and your new baby. A Google review would really help: {review_url}", details: GOOD.details };
    mockDispatch.mockResolvedValue(reply(both));
    judge([{ ask_only: false, supported: true, quotes: ['I need to go to work'] }, { ask_only: false, supported: true, quotes: ['Moisture under the kitchen sink'] }, { ask_only: true, supported: false, quotes: [] }]);
    expect(await Drafter.draftTechVoice(INPUT)).toBeNull();
    // A quote per claim, each really in the record, passes.
    const { sentenceClauses } = Drafter.__private;
    expect(sentenceClauses('You mentioned the moisture under the sink and your new baby.')).toHaveLength(2);
    expect(sentenceClauses("It's Adam, thanks again.", new Set(['adam']))).toHaveLength(0);
  });

  test('#5524 r3: "Adam is here." is not an introduction; "It\'s Adam." is', () => {
    const { isGreetingOnlySentence } = Drafter.__private;
    const names = new Set(['marta', 'adam']);
    const tech = new Set(['adam']);
    expect(isGreetingOnlySentence('Adam is here.', names, tech)).toBe(false);
    expect(isGreetingOnlySentence("Hi, it's Adam.", names, tech)).toBe(true);
    expect(isGreetingOnlySentence('This is Adam here.', names, tech)).toBe(true);
  });

  test('#5524 r3: a thanks for a review already left is not a request', () => {
    const { isAskOnlySentence } = Drafter.__private;
    expect(isAskOnlySentence('Thanks for your Google review. {review_url}', new Set())).toBe(false);
    expect(isAskOnlySentence('Thanks, a Google review would help: {review_url}', new Set())).toBe(true);
  });

  test('#5524 r4 P1: a quote must cover the facts inside a clause, not just one word', () => {
    const { quoteSharesContent } = Drafter.__private;
    expect(quoteSharesContent("I saw ants in your new baby's nursery", 'ants outside the kitchen', new Set())).toBe(false);
    // Honest paraphrase of a report line still passes.
    expect(quoteSharesContent('I flagged moisture under the kitchen sink for your property group',
      'Moisture under the kitchen sink that may lead to mildew; suggested raising it with the property group', new Set())).toBe(true);
    // A pest / property word missing from the quotes always fails.
    expect(quoteSharesContent('moisture under the kitchen sink and the attic', 'Moisture under the kitchen sink', new Set())).toBe(false);
  });

  test('#5524 r4 P1: from calls, only the caller\'s labeled turns count as the customer\'s words', () => {
    const { callerTurns } = Drafter.__private;
    expect(callerTurns('Agent: we just had a new baby at the office\nCaller: the ants are back by the lanai')).toBe('the ants are back by the lanai');
    expect(callerTurns('no labels at all here')).toBe('');
  });

  test('a bare link after a question stays with its sentence', () => {
    const { techVoiceSentences } = Drafter.__private;
    expect(techVoiceSentences("It's Adam. Would you leave a Google review? {review_url}")).toEqual(["It's Adam.", 'Would you leave a Google review? {review_url}']);
  });

  test('Codex r4: a fixed-copy email already sent shows as a prior touch (its generic intro)', async () => {
    mockTables.review_requests = [{ sequence_step: 1, channel: 'email', custom_body: null, template_key: 'review_request_email' }];
    mockDispatch.mockResolvedValueOnce(reply(GOOD));
    await Drafter.draftTechVoice({ ...INPUT, sequenceStep: 2 });
    expect(mockDispatch.mock.calls[0][1].text).toContain('word of mouth is how neighbors find us');
  });

  test('Codex r1: the customer email evidence drops quoted Waves history', async () => {
    mockTables.emails = [{ id: 'e1', subject: null, from_address: 'marta@example.com', authentication_results: 'mx.google.com; dkim=pass header.i=@example.com', body_text: 'Sounds good, see you Sunday.\n\nOn Tue, Sep 29, 2026 at 9:00 AM Waves <contact@wavespestcontrol.com> wrote:\n> We sealed every gap in the garage.', received_at: new Date() }];
    mockDispatch.mockResolvedValueOnce(reply(GOOD));
    await Drafter.draftTechVoice(INPUT);
    expect(mockDispatch.mock.calls[0][1].text).toContain('Sounds good, see you Sunday.');
    expect(mockDispatch.mock.calls[0][1].text).not.toContain('sealed every gap');
  });

  test('Fable P2: a Day-0 email is prompted as the same day, never "a week after"', async () => {
    const email = { body: 'Marta, thanks for waiting this morning when you had to get to work. A Google review would help us a lot.', details: GOOD.details.slice(0, 1) };
    mockDispatch.mockResolvedValueOnce(reply(email));
    await Drafter.draftTechVoice({ ...INPUT, sequenceStep: 0, channel: 'email' });
    expect(mockDispatch.mock.calls[0][1].system).toContain('sent the same day as the visit');
    expect(mockDispatch.mock.calls[0][1].system).not.toContain('a week');
  });

  test('a wrong-length answer or an unavailable checker never sends the draft', async () => {
    mockDispatch.mockResolvedValue(reply(GOOD));
    judge([{ ask_only: false, supported: true, quotes: ['I need to go to work'] }]);
    mockFactCheck.mockImplementation(async () => ({ ok: true, json: { sentences: [{ sentence: 'x', ask_only: false, supported: true, quotes: ['I need to go to work'] }] } }));
    expect(await Drafter.draftTechVoice(INPUT)).toBeNull();
    mockDispatch.mockReset().mockResolvedValue(reply(GOOD));
    mockFactCheck.mockReset().mockResolvedValue({ ok: false });
    expect(await Drafter.draftTechVoice(INPUT)).toBeNull();
    // Unavailable is final: no redraft spent on it.
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });
});

describe('verifyTechVoiceDraft — the auto-send safety net', () => {
  const corpus = 'Moisture under the kitchen sink. I need to go to work. Sunday visit.';
  const ctx = { channel: 'sms', firstName: 'Marta', techName: 'Adam Benetti', termite: false, corpus, ownWords: corpus };
  const WORK = [{ text: 'had to get to work', source_quote: 'I need to go to work' }];
  const verify = (over, c = {}) => Drafter.verifyTechVoiceDraft(
    { ...GOOD, ...(over.body ? { details: WORK } : {}), ...over }, { ...ctx, ...c });

  test('a clean grounded draft passes', () => {
    expect(verify({})).toBeNull();
  });

  test('every detail must cite words that are in the record, and appear in the body', () => {
    expect(verify({ details: [] })).toBe('no_details');
    expect(verify({ details: [{ text: 'had to get to work', source_quote: 'you said the ants are gone' }] })).toBe('ungrounded_detail');
    expect(verify({ details: [{ text: 'your new deck', source_quote: 'I need to go to work' }] })).toBe('detail_not_in_body');
  });

  test('a cited line must back its own detail (pre-push audit P1: unrelated citation)', () => {
    const body = "It's Adam, I fixed the roof leak. A Google review would really help: {review_url}";
    expect(verify({ body, details: [{ text: 'fixed the roof leak', source_quote: 'I need to go to work' }] })).toBe('detail_not_supported');
    // A paraphrase that shares the key word still passes.
    expect(verify({})).toBeNull();
  });

  test('an uncited pest, property or problem must still be in the record', () => {
    const body = 'I know you had to get to work, and I looked at the roof leak too. A Google review would really help: {review_url}';
    expect(verify({ body })).toBe('ungrounded_term');
    expect(verify({ body: 'I know you had to get to work. The ants were busy. Google review: {review_url}' })).toBe('ungrounded_term');
    // "Roach" is grounded by "cockroach" in the record; loose words like "spot" are not checked.
    const c = { corpus: `${corpus} German cockroaches.`, ownWords: `${corpus} German cockroaches.` };
    expect(verify({ body: 'I know you had to get to work. Roaches near the spot I flagged. Google review: {review_url}' }, c)).toBeNull();
  });

  test('an observation never becomes a claimed repair or result (pre-push audit P1)', () => {
    const c = { corpus: `${corpus} Moisture under the kitchen sink; suggested raising it with the property group.` };
    const details = [{ text: 'moisture under the kitchen sink', source_quote: 'Moisture under the kitchen sink' }];
    const fixed = "It's Adam, I fixed the moisture under the kitchen sink. A Google review would really help: {review_url}";
    expect(verify({ body: fixed, details }, c)).toBe('result_claim');
    const solved = "It's Adam, the moisture under the kitchen sink is solved. A Google review would really help: {review_url}";
    expect(verify({ body: solved, details }, c)).toBe('result_claim');
    // A request in the record ("please fix") never grounds a claimed repair (audit round 3).
    const asked = { corpus: `${corpus} Please fix the moisture under the kitchen sink.` };
    expect(verify({ body: fixed, details }, asked)).toBe('result_claim');
    const gone = "It's Adam, the moisture under the kitchen sink is not gone yet. A Google review would really help: {review_url}";
    expect(verify({ body: gone, details }, c)).toBe('result_claim');
    const cared = "It's Adam, I took care of the moisture under the kitchen sink. A Google review would really help: {review_url}";
    expect(verify({ body: cared, details }, c)).toBe('result_claim');
    // Reporting the observation itself is fine.
    expect(verify({}, c)).toBeNull();
  });

  test('no promises or future visits: nothing in the record verifies them (pre-push audit P1)', () => {
    expect(verify({ body: 'I know you had to get to work. I will be back tomorrow for the next treatment. Google review: {review_url}' })).toBe('commitment');
    expect(verify({ body: "I know you had to get to work. I'll keep an eye on it. Google review: {review_url}" })).toBe('commitment');
    expect(verify({ body: 'I know you had to get to work. Your second visit is set. Google review: {review_url}' })).toBe('commitment');
  });

  test('Codex r1: health and money stay out even when the record holds them', () => {
    const c = { corpus: `${corpus} Back from surgery last week. Rent is due.`, ownWords: `${corpus} Back from surgery last week. Rent is due.` };
    expect(verify({ body: 'I know you had to get to work so soon after surgery. Google review: {review_url}' }, c)).toBe('sensitive_topic');
    expect(verify({ body: 'I know you had to get to work with rent due. Google review: {review_url}' }, c)).toBe('sensitive_topic');
  });

  test('Codex r2: the deterministic floor also covers common conditions, products and household members', () => {
    for (const phrase of ['your asthma', 'the dialysis', 'the Talstar you asked about', 'your son let me in', 'the tenant was home']) {
      expect(verify({ body: `I know you had to get to work, and ${phrase}. Google review: {review_url}` })).toBe('sensitive_topic');
    }
  });

  test('terminal pass 1: a question opener is not a name, and a customer named Bill is not a money topic', () => {
    expect(verify({ body: 'I know you had to get to work. Would you leave a Google review? {review_url}' })).toBeNull();
    expect(verify({ body: 'Bill, I know you had to get to work. Google review: {review_url}' }, { firstName: 'Bill' })).toBeNull();
    // An actual bill is still a money topic.
    expect(verify({ body: 'Bill, I know you had to get to work and the bill is due. Google review: {review_url}' }, { firstName: 'Bill' })).toBe('sensitive_topic');
  });

  test('terminal pass 4: "Please" opening the review request is not a name', () => {
    expect(verify({ body: 'I know you had to get to work. Please leave a Google review: {review_url}' })).toBeNull();
  });

  test('Codex r2: an email intro must name a Google review too', () => {
    const e = { channel: 'email' };
    expect(verify({ body: 'Marta, I know you had to get to work. A review would help us a lot.' }, e)).toBe('missing_google_review');
  });

  test('Codex r1: outcome wording is a result claim even when the report says it', () => {
    for (const phrase of ['activity is reduced', 'the lawn looks better', 'things are settling down', 'it is working', 'no more ants']) {
      expect(verify({ body: `I know you had to get to work, and ${phrase}. Google review: {review_url}` })).toBe('result_claim');
    }
  });

  test('Codex r1: an invented name at the start of a sentence is still caught', () => {
    expect(verify({ body: 'I know you had to get to work. Nutmeg was great to meet. Google review: {review_url}' })).toBe('unknown_proper_noun');
    // An ordinary opener is fine.
    expect(verify({ body: 'I know you had to get to work. Thanks again. Google review: {review_url}' })).toBeNull();
  });

  test('stems: plural, -ing/-ed and short words', () => {
    const { ungroundedTerm, detailSupportedByQuote } = Drafter.__private;
    expect(ungroundedTerm('the lanai and pool cages', 'lanai and pool cage')).toBeNull();
    expect(ungroundedTerm('we wed', '')).toBeNull();
    expect(ungroundedTerm('checked the attic', 'garage')).toBe('attic');
    expect(detailSupportedByQuote('thanks for waiting this morning', "can't wait too long this morning")).toBe(true);
    expect(detailSupportedByQuote('your new puppies', 'I need to go to work')).toBe(false);
  });

  test('a capitalized name the customer never used is rejected (street / car / rental misreads)', () => {
    const body = "It's Adam. How is Nutmeg doing since I had to get to work? A Google review would really help: {review_url}";
    expect(verify({ body })).toBe('unknown_proper_noun');
    // A weekday, Google and the tech's own name are fine.
    const ok = "It's Adam, thanks for Sunday. I know you had to get to work. A Google review would really help: {review_url}";
    expect(verify({ body: ok })).toBeNull();
  });

  test('neutral: no satisfaction condition, no steering away from reviewing', () => {
    expect(verify({ body: 'If we earned it, a Google review would help: {review_url} I know you had to get to work.' })).toBe('satisfaction_condition');
    expect(verify({ body: 'If you were happy with it, a Google review means a lot: {review_url} You had to get to work.' })).toBe('satisfaction_condition');
    expect(verify({ body: 'Text me instead of posting if something is wrong. Google review: {review_url} You had to get to work.' })).toBe('steers_from_review');
  });

  test('#5511 GitHub r2: a reply-instead-of-review route split across sentences is refused', () => {
    expect(verify({ body: 'I know you had to get to work. If anything still looks off, just reply. Otherwise a Google review helps: {review_url}' })).toBe('steers_from_review');
  });

  test('office / AI phrasing is rejected', () => {
    expect(verify({ body: 'I know you had to get to work. Google review: {review_url} Questions? Just reply.' })).toBe('office_phrase');
    expect(verify({ body: "I know you had to get to work. Google review: {review_url} Reply if anything's off." })).toBe('office_phrase');
  });

  test('termites only on a termite visit', () => {
    const body = 'I know you had to get to work, and termites were not a concern. Google review: {review_url}';
    expect(verify({ body })).toBe('termite_off_service');
    expect(verify({ body }, { termite: true })).toBeNull();
  });

  test('SMS must name a Google review, carry the link once, and fit two segments', () => {
    expect(verify({ body: 'I know you had to get to work. A review would help: {review_url}' })).toBe('missing_google_review');
    expect(verify({ body: 'I know you had to get to work. A Google review would help.' })).toBe('missing_link');
    expect(verify({ body: `I know you had to get to work. ${'Really. '.repeat(40)}Google review: {review_url}` })).toBe('too_many_segments');
  });

  test('every existing compliance rule still applies', () => {
    expect(verify({ body: 'I know you had to get to work. Keep the dog off it until dry. Google review: {review_url}' })).toBe('banned_phrase');
    expect(verify({ body: 'I know you had to get to work. Google review for a free treatment: {review_url}' })).toBe('banned_phrase');
    expect(verify({ body: 'I know you had to get to work. Google review: {review_url} or g.page/r/abc' })).toBe('raw_url');
  });

  test('email: no link or placeholder, length cap', () => {
    const e = { channel: 'email' };
    expect(verify({ body: 'Marta, I know you had to get to work. A Google review would help us a lot.' }, e)).toBeNull();
    expect(verify({ body: 'Marta, I know you had to get to work. Review: {review_url}' }, e)).toBe('stray_placeholder');
    expect(verify({ body: `Marta, I know you had to get to work. ${'More words. '.repeat(60)}` }, e)).toBe('too_long');
  });
});
