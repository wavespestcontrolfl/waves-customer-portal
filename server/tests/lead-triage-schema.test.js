// An off-schema Claude-fallback triage (e.g. urgency "critical") used to be
// mapped onto the lead anyway while only the ledger row said it failed; it is
// now the same null the callers already handle for any AI failure.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatch: jest.fn(async () => ({ ok: false, reason: 'openai_timeout' })), rejectCall: jest.fn() }));

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));

// Keep the real ledgerCall (GATE_LLM_CALL_LEDGER is unset in tests, so it's
// already a real no-DB no-op) but spy on ledgerCallRejected.
jest.mock('../services/llm-dispatch-metrics', () => {
  const actual = jest.requireActual('../services/llm-dispatch-metrics');
  return { ...actual, ledgerCallRejected: jest.fn() };
});

const { aiTriageLead } = require('../services/lead-triage');
const { dispatch, rejectCall } = require('../services/llm/call');
const { ledgerCallRejected } = require('../services/llm-dispatch-metrics');

const LEAD = { name: 'Pat Doe', phone: '+19415550100', message: 'Ants in the kitchen', address: 'Sarasota', pageUrl: '/', formName: 'contact' };
const VALID = { serviceInterest: 'General Pest Control', urgency: 'high', extractedData: { pestType: 'ants', location: 'Sarasota', propertyType: 'residential' }, suggestedReply: 'Thanks — we can help with the ants.' };
const reply = (obj) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] });

describe('aiTriageLead — Claude fallback schema', () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'test-key'; mockCreate.mockReset(); ledgerCallRejected.mockClear(); });
  afterAll(() => { if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey; });

  test('an on-schema answer is mapped and not flagged', async () => {
    mockCreate.mockResolvedValue(reply(VALID));
    expect(await aiTriageLead(LEAD)).toMatchObject({ urgency: 'high', serviceInterest: 'General Pest Control' });
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });

  test.each([
    ['an off-enum urgency', { ...VALID, urgency: 'critical' }],
    ['a missing extractedData', { ...VALID, extractedData: undefined }],
    ['an object serviceInterest', { ...VALID, serviceInterest: { name: 'x' } }],
    // Codex r16 on #4884: mapTriage turns blanks into null — no classification, no reply.
    ['a blank serviceInterest', { ...VALID, serviceInterest: '   ' }],
    ['a blank suggestedReply', { ...VALID, suggestedReply: '' }],
  ])('%s returns null (nothing written to the lead) and fails the row', async (_label, answer) => {
    mockCreate.mockResolvedValue(reply(answer));
    expect(await aiTriageLead(LEAD)).toBeNull();
    expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
  });
});

describe('aiTriageLead — structured-output primary', () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'test-key'; mockCreate.mockReset(); ledgerCallRejected.mockClear(); rejectCall.mockClear(); });
  afterAll(() => { if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey; });

  test('a usable primary answer is mapped without touching the fallback', async () => {
    dispatch.mockResolvedValueOnce({ ok: true, json: VALID });
    expect(await aiTriageLead(LEAD)).toMatchObject({ urgency: 'high' });
    expect(rejectCall).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('a blank primary answer fails its row and the Claude fallback answers', async () => {
    dispatch.mockResolvedValueOnce({ ok: true, json: { ...VALID, suggestedReply: ' ' } });
    mockCreate.mockResolvedValue(reply(VALID));
    expect(await aiTriageLead(LEAD)).toMatchObject({ suggestedReply: VALID.suggestedReply });
    expect(rejectCall).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

// Codex r20 on #4884: serviceInterest is written to leads.service_interest varchar(255).
test('a serviceInterest longer than 255 chars is not usable (fallback)', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  mockCreate.mockResolvedValue(reply({ ...VALID, serviceInterest: 'x'.repeat(256) }));
  expect(await aiTriageLead(LEAD)).toBeNull();
  expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
});

// Owner ruling 2026-09-26: customer texts are never signed. The prompt says so
// and the suggestion is stripped anyway, since models add sign-offs on their own.
describe('aiTriageLead — suggested replies are never signed', () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'test-key'; mockCreate.mockReset(); ledgerCallRejected.mockClear(); dispatch.mockReset(); dispatch.mockResolvedValue({ ok: false, reason: 'openai_timeout' }); });
  afterAll(() => { if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey; });

  test.each([
    'Thanks — we can help with the ants. — Adam, Waves Pest Control',
    'Thanks — we can help with the ants.\n\nAdam, Waves Pest Control',
    'Thanks — we can help with the ants. — Adam',
  ])('a signed fallback suggestion is stripped: %j', async (suggestedReply) => {
    mockCreate.mockResolvedValue(reply({ ...VALID, suggestedReply }));
    expect((await aiTriageLead(LEAD)).suggestedReply).toBe('Thanks — we can help with the ants.');
  });

  test('a signed primary suggestion is stripped too', async () => {
    dispatch.mockResolvedValueOnce({ ok: true, json: { ...VALID, suggestedReply: 'We can help. — Adam, Waves Pest Control' } });
    expect((await aiTriageLead(LEAD)).suggestedReply).toBe('We can help.');
  });

  test('a reply that just thanks a customer named Adam by name is kept', async () => {
    mockCreate.mockResolvedValue(reply({ ...VALID, suggestedReply: 'Thanks, Adam!' }));
    expect((await aiTriageLead({ ...LEAD, name: 'Adam Smith' })).suggestedReply).toBe('Thanks, Adam!');
  });

  test('the prompt asks for no signature', async () => {
    mockCreate.mockResolvedValue(reply(VALID));
    await aiTriageLead(LEAD);
    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toMatch(/NEVER sign/);
    expect(prompt).not.toMatch(/signed "Adam/);
  });
});

// Codex r1 on #4975: a suggestion that is ONLY a signature must not pass the
// non-blank check and then be stripped to nothing after acceptance.
describe('aiTriageLead — a signature-only suggestion is a failed answer', () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'test-key'; mockCreate.mockReset(); ledgerCallRejected.mockClear(); rejectCall.mockClear(); dispatch.mockReset(); });
  afterAll(() => { if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey; });

  test('a signature-only primary suggestion fails its row and the Claude fallback answers', async () => {
    dispatch.mockResolvedValueOnce({ ok: true, json: { ...VALID, suggestedReply: '— Adam' } });
    mockCreate.mockResolvedValue(reply(VALID));
    expect((await aiTriageLead(LEAD)).suggestedReply).toBe(VALID.suggestedReply);
    expect(rejectCall).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
  });

  test('a signature-only fallback suggestion returns null and fails the row', async () => {
    dispatch.mockResolvedValue({ ok: false, reason: 'openai_timeout' });
    mockCreate.mockResolvedValue(reply({ ...VALID, suggestedReply: '— Adam, Waves Pest Control' }));
    expect(await aiTriageLead(LEAD)).toBeNull();
    expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
  });
});

// Codex r2 on #4975: the shared stripper knows only the Waves signers, so a
// sign-off by any other name is stripped too — in signature context only.
describe('aiTriageLead — a sign-off by any name is removed', () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'test-key'; mockCreate.mockReset(); ledgerCallRejected.mockClear(); rejectCall.mockClear(); dispatch.mockReset(); dispatch.mockResolvedValue({ ok: false, reason: 'openai_timeout' }); });
  afterAll(() => { if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey; });

  test.each([
    ['We can help. — Sarah', 'We can help.'],
    ['We can help!\n— Sarah', 'We can help!'],
    ['We can help.\n\n— Sarah Jones, Waves Team', 'We can help.'],
    // Review on #4975: lowercase and non-ASCII signer names.
    ['We can help. — sarah', 'We can help.'],
    // Codex r3 on #4975: a question with the signer on its own dash line.
    ['Would you like to schedule?\n— Sarah', 'Would you like to schedule?'],
    ['We can help. — Élodie', 'We can help.'],
  ])('%j is stripped to %j and the triage kept', async (suggestedReply, expected) => {
    mockCreate.mockResolvedValue(reply({ ...VALID, suggestedReply }));
    const out = await aiTriageLead(LEAD);
    expect(out).toMatchObject({ suggestedReply: expected, urgency: VALID.urgency });
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });

  test('a reply that is only a sign-off is blank: the primary fails its row and the fallback answers', async () => {
    dispatch.mockResolvedValueOnce({ ok: true, json: { ...VALID, suggestedReply: '— Sarah' } });
    mockCreate.mockResolvedValue(reply(VALID));
    expect((await aiTriageLead(LEAD)).suggestedReply).toBe(VALID.suggestedReply);
    expect(rejectCall).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
  });

  // Pre-push audit on #4975: ordinary text that looked name-shaped.
  test.each([
    'Which pests are you seeing?\nAnts, roaches, or something else?',
    'We serve your area — Sarasota.',
    'Totally — Tuesday works.',
    'We can help — call us at (941) 318-7612.',
    'See you Tuesday — Mike will be your tech.',
    'Hi! — Mike from Waves will call you.',
    'Thanks, Sarah!',
    'We can help with:\nLawn Care',
    'Your technician will be\nAdam',
    'Who will be coming?\nAdam',
    'Which service would help?\nLawn Care',
    'Which service? — Lawn Care',
    'We can help.\n\nSarah',
    // Review on #4975: a name given as the answer, not a sign-off.
    'Your technician is — Sarah',
    'Your technician is:\nSarah',
    'Totally. — Tuesday works.',
  ])('ordinary text is kept as written: %j', async (suggestedReply) => {
    mockCreate.mockResolvedValue(reply({ ...VALID, suggestedReply }));
    expect((await aiTriageLead(LEAD)).suggestedReply).toBe(suggestedReply);
  });
});
