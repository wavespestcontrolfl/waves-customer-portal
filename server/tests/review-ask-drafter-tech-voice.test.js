// Tech-voice review asks (GATE_REVIEW_ASK_TECH_VOICE, owner rulings
// 2026-09-30 / 10-01): every touch drafted from the visit's record in the
// technician's voice. These drafts AUTO-SEND, so each deterministic check
// that stands between a bad draft and a customer gets a case, plus the
// redraft-then-fallback contract.
const mockDispatch = jest.fn();
const mockGates = { reviewAskTechVoice: true, reviewAskPersonalized: false };
const mockGetRecentCalls = jest.fn(async () => []);
const mockTables = {};

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...a) => mockDispatch(...a) }));
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
    async select() { return rows; },
    async first() { return rows[0]; },
  };
  q.where = jest.fn((arg) => { if (typeof arg === 'function') arg(q); return q; });
  return q;
}

beforeEach(() => {
  mockDispatch.mockReset();
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
  customer: { id: 'cust-1', first_name: 'Marta' },
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
    expect(mockDispatch.mock.calls[1][1].text).toContain('REJECTED (ungrounded detail)');

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

  test('a company stored as the first name is never used as a greeting', async () => {
    mockDispatch.mockResolvedValueOnce(reply(GOOD));
    await Drafter.draftTechVoice({ ...INPUT, recipientFirstName: 'Sunset Vacation Rentals', customer: { id: 'cust-1', first_name: 'Sunset Vacation Rentals' } });
    expect(mockDispatch.mock.calls[0][1].text).toContain('Customer first name: (unknown - do not use a name)');
  });

  test('the email touch returns a paragraph with no link', async () => {
    const email = {
      body: 'Marta, it has been a week since the first treatment, and the second visit is the one for what hatches after it. Sorry again about the wait that morning when you had to get to work. A Google review would help us a lot.',
      details: [{ text: 'had to get to work', source_quote: 'I need to go to work' }],
    };
    mockDispatch.mockResolvedValueOnce(reply(email));
    expect(await Drafter.draftTechVoice({ ...INPUT, sequenceStep: 2, channel: 'email' })).toBe(email.body);
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

  test('an uncited pest, property or repair claim must still be in the record', () => {
    const body = 'I know you had to get to work, and I fixed the roof leak too. A Google review would really help: {review_url}';
    expect(verify({ body })).toBe('ungrounded_term');
    expect(verify({ body: 'I know you had to get to work. The ants were busy. Google review: {review_url}' })).toBe('ungrounded_term');
    // "Roach" is grounded by "cockroach" in the record; loose words like "spot" are not checked.
    const c = { corpus: `${corpus} German cockroaches.` };
    expect(verify({ body: 'I know you had to get to work. Roaches near the spot I flagged. Google review: {review_url}' }, c)).toBeNull();
  });

  test('an observation never becomes a claimed repair or result (pre-push audit P1)', () => {
    const c = { corpus: `${corpus} Moisture under the kitchen sink; suggested raising it with the property group.` };
    const details = [{ text: 'moisture under the kitchen sink', source_quote: 'Moisture under the kitchen sink' }];
    const fixed = "It's Adam, I fixed the moisture under the kitchen sink. A Google review would really help: {review_url}";
    expect(verify({ body: fixed, details }, c)).toBe('ungrounded_term');
    const solved = "It's Adam, the moisture under the kitchen sink is solved. A Google review would really help: {review_url}";
    expect(verify({ body: solved, details }, c)).toBe('ungrounded_term');
    const cared = "It's Adam, I took care of the moisture under the kitchen sink. A Google review would really help: {review_url}";
    expect(verify({ body: cared, details }, c)).toBe('result_claim');
    // Reporting the observation itself is fine.
    expect(verify({}, c)).toBeNull();
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
