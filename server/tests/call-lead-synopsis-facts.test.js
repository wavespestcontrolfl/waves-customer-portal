// Lead notes ("lead synopsis") get the system's record facts, and a CURRENT
// customer never reaches the model (production audit 2026-11-09: a customer
// written up as a new lead, a "verify the name" note on a complete record, an
// email spelling nobody said). No real provider: the SDK is mocked.
// Synthetic data only.

const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockAnthropicCreate } })));
jest.mock('../services/llm-dispatch-metrics', () => ({
  recordCall: jest.fn(() => null),
  failCall: jest.fn(),
  recordDispatch: jest.fn(),
  recordedPolicyLabel: jest.fn(() => null),
  ledgerCall: jest.fn((_provider, _model, fn) => fn()),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const db = require('../models/db');
const fs = require('fs');
const path = require('path');
const { _test } = require('../services/call-recording-processor');

const {
  generateLeadSynopsis, resolveLeadSynopsis, leadSynopsisFactsBlock, buildLeadSynopsisFacts,
  LEAD_SYNOPSIS_GATE_SENTENCE, LEAD_SYNOPSIS_GATE_REFUSAL_RE, summarizeKnownCaller, leadSynopsisCallerState,
} = _test;

const TRANSCRIPT = 'Agent: Waves, how can I help?\nCaller: I have ants in the kitchen.';
const modelOk = (text) => ({ id: 'msg_1', model: 'claude-test', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } });
const promptSent = () => mockAnthropicCreate.mock.calls[0][0].messages[0].content;

beforeEach(() => {
  mockAnthropicCreate.mockReset();
  mockAnthropicCreate.mockResolvedValue(modelOk('## Lead notes'));
  process.env.ANTHROPIC_API_KEY = 'test-anthropic';
});

describe('leadSynopsisFactsBlock', () => {
  const full = {
    callerOnFile: true,
    visit: { booked: true, when: 'Tue Nov 10, 9 AM', service: 'General Pest Control' },
    quotePromised: false,
    name: 'complete',
    email: 'held',
  };

  test('each fact renders its own line', () => {
    const block = leadSynopsisFactsBlock(full);
    expect(block).toContain('- Caller on file before this call: yes (a prospect or past account)');
    expect(block).toContain('- A visit was booked on this call: Tue Nov 10, 9 AM, General Pest Control');
    expect(block).toContain('- A quote was promised on this call: no');
    expect(block).toContain("- The customer's name on the record: complete");
    expect(block).toContain('- An email is on the record: held for review');
  });

  test('the other states render', () => {
    const block = leadSynopsisFactsBlock({ callerOnFile: false, visit: { booked: false }, quotePromised: true, name: 'none', email: 'no' });
    expect(block).toContain('Caller on file before this call: no');
    expect(block).toContain('A visit was booked on this call: none');
    expect(block).toContain('A quote was promised on this call: yes');
    expect(block).toContain("name on the record: none");
    expect(leadSynopsisFactsBlock({ name: 'first' })).toContain("name on the record: first name only");
    expect(leadSynopsisFactsBlock({ name: 'last' })).toContain("name on the record: last name only");
    expect(block).toContain('An email is on the record: no');
    expect(leadSynopsisFactsBlock({ email: 'yes' })).toContain('An email is on the record: yes');
  });

  test('a booked visit with no day or time still says so', () => {
    expect(leadSynopsisFactsBlock({ visit: { booked: true } })).toContain('A visit was booked on this call: yes (day and time not available here)');
  });

  test('unknown facts are left out', () => {
    const block = leadSynopsisFactsBlock({ name: 'complete' });
    expect(block).toContain("name on the record: complete");
    expect(block).not.toMatch(/Caller on file|A visit|A quote|An email/);
    expect(leadSynopsisFactsBlock({ visit: {} })).toBe('');
  });

  test('an empty or invalid input renders no block', () => {
    expect(leadSynopsisFactsBlock({})).toBe('');
    expect(leadSynopsisFactsBlock()).toBe('');
    expect(leadSynopsisFactsBlock(null)).toBe('');
    expect(leadSynopsisFactsBlock('text')).toBe('');
  });

  test('the block carries the instruction lines, and ends with a blank line', () => {
    const block = leadSynopsisFactsBlock(full);
    expect(block).toContain('These record facts come from our system and outrank the transcript.');
    expect(block).toContain('Do not tell the office to capture, confirm or verify a detail the record facts show as complete or on the record.');
    expect(block).toContain('Do not describe how a name or an email is spelled.');
    expect(block).toContain('the office follow-up (Step 3C) is about that visit, not about booking one.');
    expect(block.endsWith('\n\n')).toBe(true);
  });

  test('hostile input never puts an email, phone or street in the block', () => {
    const block = leadSynopsisFactsBlock({
      callerOnFile: true,
      full_name: 'Pat Example', email_address: 'pat-example@example.test', phone: '+19415550123', address: '12 Example Way, Bradenton',
      name: 'Pat Example',
      nameOnRecord: true,
      email: 'pat-example@example.test',
      visit: { booked: true, when: 'pat-example@example.test', service: '12 Example Way', name: 'Pat', phone: '941-555-0123' },
      quotePromised: '941-555-0123',
    });
    expect(block).not.toMatch(/@/);
    expect(block).not.toMatch(/\d[\d\s().-]{5,}\d/);
    expect(block).not.toMatch(/Example Way|Pat|Bradenton/);
    expect(block).toContain('A visit was booked on this call: yes (day and time not available here)');
    // The unexpected fields did not produce lines of their own.
    expect(block).not.toMatch(/name on the record|An email is on the record|A quote/);
  });

  test('hostile phone and street text inside the allowed visit fields is dropped', () => {
    const block = leadSynopsisFactsBlock({ visit: { booked: true, when: 'Call 941 555 0123', service: '1200 Palm Avenue' } });
    expect(block).not.toMatch(/941|Palm/);
  });
});

describe('buildLeadSynopsisFacts', () => {
  const customer = (stage) => summarizeKnownCaller({ id: 'c1', first_name: 'Pat', last_name: 'Example', pipeline_stage: stage, created_at: new Date() });

  test('on file / not on file / lookup failed', () => {
    expect(buildLeadSynopsisFacts({ knownCaller: customer('new_lead') }).callerOnFile).toBe(true);
    expect(buildLeadSynopsisFacts({ knownCaller: null }).callerOnFile).toBe(false);
    expect(buildLeadSynopsisFacts({ knownCaller: null, lookupFailed: true })).not.toHaveProperty('callerOnFile');
    expect(buildLeadSynopsisFacts({})).not.toHaveProperty('callerOnFile');
    expect(buildLeadSynopsisFacts({ callerOnFile: false, knownCaller: customer('new_lead') }).callerOnFile).toBe(false);
  });

  test('a booked visit carries the day and window and the service', () => {
    const facts = buildLeadSynopsisFacts({
      knownCaller: null,
      appointmentResult: { smsSent: true, scheduledServiceId: 'v1', service: 'General Pest Control', scheduledDate: '2026-11-10', windowStart: '09:00' },
    });
    expect(facts.visit).toEqual({ booked: true, when: 'Tue Nov 10, 9 AM', service: 'General Pest Control' });
    expect(leadSynopsisFactsBlock(facts)).toContain('A visit was booked on this call: Tue Nov 10, 9 AM, General Pest Control');
  });

  test('a booked visit whose result lacks a day still counts as booked', () => {
    const facts = buildLeadSynopsisFacts({ appointmentResult: { smsSkippedReason: 'duplicate', scheduledServiceId: 'v1' } });
    expect(facts.visit).toEqual({ booked: true, when: null, service: null });
  });

  test('no visit: a held or missing result is none; an unknown result leaves the line out', () => {
    expect(buildLeadSynopsisFacts({ appointmentResult: null }).visit).toEqual({ booked: false });
    expect(buildLeadSynopsisFacts({ appointmentResult: { skippedReason: 'missing_required_customer_fields', scheduleCreated: false } }).visit).toEqual({ booked: false });
    expect(buildLeadSynopsisFacts({})).not.toHaveProperty('visit');
  });

  test('quote promised, name and email state', () => {
    expect(buildLeadSynopsisFacts({ quotePromised: true }).quotePromised).toBe(true);
    expect(buildLeadSynopsisFacts({ quotePromised: false }).quotePromised).toBe(false);
    expect(buildLeadSynopsisFacts({})).not.toHaveProperty('quotePromised');
    expect(buildLeadSynopsisFacts({ nameState: 'complete', emailOnRecord: true })).toMatchObject({ name: 'complete', email: 'yes' });
    expect(buildLeadSynopsisFacts({ nameState: 'first', emailOnRecord: false })).toMatchObject({ name: 'first', email: 'no' });
    expect(buildLeadSynopsisFacts({ nameState: 'last' })).toMatchObject({ name: 'last' });
    expect(buildLeadSynopsisFacts({ nameState: 'none' })).toMatchObject({ name: 'none' });
    expect(buildLeadSynopsisFacts({ nameState: 'Pat Example' })).not.toHaveProperty('name');
    expect(buildLeadSynopsisFacts({})).not.toHaveProperty('name');
    expect(buildLeadSynopsisFacts({})).not.toHaveProperty('email');
  });

  test('an email held for review wins over the record state', () => {
    expect(buildLeadSynopsisFacts({ emailOnRecord: false, emailHeld: true }).email).toBe('held');
    expect(buildLeadSynopsisFacts({ emailOnRecord: true, emailHeld: true }).email).toBe('held');
  });

  test('the facts hold states only, never a name, email, phone or address', () => {
    const facts = buildLeadSynopsisFacts({
      knownCaller: customer('new_lead'), appointmentResult: { scheduledServiceId: 'v1', service: 'General Pest Control', scheduledDate: '2026-11-10', windowStart: '09:00' },
      quotePromised: true, nameState: 'complete', emailOnRecord: true,
    });
    expect(JSON.stringify(facts)).not.toMatch(/Pat|Example|@/);
  });
});

describe('the gate sentence', () => {
  test('is one constant: the prompt, the skip and the refusal test agree', async () => {
    await generateLeadSynopsis(TRANSCRIPT, {});
    expect(promptSent()).toContain(`respond with only: "${LEAD_SYNOPSIS_GATE_SENTENCE}" and stop.`);
    expect(LEAD_SYNOPSIS_GATE_SENTENCE).toBe('Not a new lead — no analysis needed.');
    expect(LEAD_SYNOPSIS_GATE_REFUSAL_RE.test(LEAD_SYNOPSIS_GATE_SENTENCE)).toBe(true);
    expect(LEAD_SYNOPSIS_GATE_REFUSAL_RE.test(`**${LEAD_SYNOPSIS_GATE_SENTENCE}**`)).toBe(true);
    expect(LEAD_SYNOPSIS_GATE_REFUSAL_RE.test('## Lead notes')).toBe(false);
  });

  test('the call site tests the refusal with the shared regex', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    expect(src).toContain('const synopsisIsGateRefusal = LEAD_SYNOPSIS_GATE_REFUSAL_RE.test(synopsis);');
  });
});

describe('resolveLeadSynopsis', () => {
  test('a current customer never reaches the provider and yields exactly the gate sentence', async () => {
    const known = summarizeKnownCaller({ id: 'c1', first_name: 'Pat', last_name: 'Example', pipeline_stage: 'active_customer', created_at: new Date() });
    expect(known.isExistingCustomer).toBe(true);
    const out = await resolveLeadSynopsis(TRANSCRIPT, { currentCustomer: known.isExistingCustomer === true, facts: { callerOnFile: true } });
    expect(out).toBe(LEAD_SYNOPSIS_GATE_SENTENCE);
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
    expect(LEAD_SYNOPSIS_GATE_REFUSAL_RE.test(out)).toBe(true);
  });

  test('a prospect on file reaches the provider with the facts block in the prompt', async () => {
    const known = summarizeKnownCaller({ id: 'c2', first_name: 'Sam', last_name: 'Sample', pipeline_stage: 'new_lead', created_at: new Date() });
    expect(known.isExistingCustomer).toBe(false);
    const facts = buildLeadSynopsisFacts({ knownCaller: known, appointmentResult: null, quotePromised: true, nameState: 'complete', emailOnRecord: false });
    const out = await resolveLeadSynopsis(TRANSCRIPT, { currentCustomer: known.isExistingCustomer === true, facts });
    expect(out).toBe('## Lead notes');
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    const prompt = promptSent();
    expect(prompt).toContain('Record facts (from our system):');
    expect(prompt).toContain('- Caller on file before this call: yes (a prospect or past account)');
    expect(prompt).toContain('- A visit was booked on this call: none');
    expect(prompt).toContain('- A quote was promised on this call: yes');
    // Placed after the transcript and before Step 0.
    expect(prompt.indexOf(TRANSCRIPT)).toBeLessThan(prompt.indexOf('Record facts'));
    expect(prompt.indexOf('Record facts')).toBeLessThan(prompt.indexOf('Step 0'));
  });

  test('a caller not on file reaches the provider with the facts block', async () => {
    const facts = buildLeadSynopsisFacts({ knownCaller: null, appointmentResult: { scheduledServiceId: 'v1', service: 'General Pest Control', scheduledDate: '2026-11-10', windowStart: '09:00' }, nameState: 'complete', emailOnRecord: true });
    await resolveLeadSynopsis(TRANSCRIPT, { currentCustomer: false, facts });
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    const prompt = promptSent();
    expect(prompt).toContain('- Caller on file before this call: no');
    expect(prompt).toContain('- A visit was booked on this call: Tue Nov 10, 9 AM, General Pest Control');
    expect(prompt).toContain('- An email is on the record: yes');
  });

  test('with no facts the prompt has no block and keeps the old shape', async () => {
    await generateLeadSynopsis(TRANSCRIPT);
    const prompt = promptSent();
    expect(prompt).not.toContain('Record facts');
    expect(prompt).toContain(`${TRANSCRIPT}\n\nStep 0 — Qualify the Lead (Gate Check):`);
  });

  test('the model, lane, timeout and retry settings are unchanged', async () => {
    const { ledgerCall } = require('../services/llm-dispatch-metrics');
    const MODELS = require('../config/models');
    await generateLeadSynopsis(TRANSCRIPT, {});
    expect(ledgerCall).toHaveBeenCalledWith('anthropic', MODELS.ROUTINE, expect.any(Function), { laneId: 'lead_synopsis' });
    expect(mockAnthropicCreate.mock.calls[0][0].model).toBe(MODELS.ROUTINE);
    expect(mockAnthropicCreate.mock.calls[0][1]).toMatchObject({ maxRetries: 0 });
  });

  test('a refusal still yields no synopsis', async () => {
    mockAnthropicCreate.mockResolvedValue({ ...modelOk('I cannot help'), stop_reason: 'refusal' });
    expect(await resolveLeadSynopsis(TRANSCRIPT, { currentCustomer: false, facts: {} })).toBeNull();
  });
});

describe('leadSynopsisCallerState (the skip follows the resolved caller)', () => {
  const known = (id, stage) => summarizeKnownCaller({ id, first_name: 'Pat', last_name: 'Example', pipeline_stage: stage, created_at: new Date() });

  test('same customer and a current customer: skip, on file', () => {
    expect(leadSynopsisCallerState({ knownCaller: known('c1', 'active_customer'), customerId: 'c1' })).toEqual({ currentCustomer: true, callerOnFile: true });
    // ids compare as text (uuid string vs. a driver's value)
    expect(leadSynopsisCallerState({ knownCaller: known(7, 'active_customer'), customerId: '7' }).currentCustomer).toBe(true);
  });

  test('a different resolved customer (shared household number): no skip, no on-file fact', () => {
    expect(leadSynopsisCallerState({ knownCaller: known('c1', 'active_customer'), customerId: 'c2' })).toEqual({ currentCustomer: false, callerOnFile: undefined });
  });

  test('no resolved customer: no skip, no on-file fact', () => {
    expect(leadSynopsisCallerState({ knownCaller: known('c1', 'active_customer'), customerId: null })).toEqual({ currentCustomer: false, callerOnFile: undefined });
    expect(leadSynopsisCallerState({ knownCaller: known('c1', 'active_customer') }).currentCustomer).toBe(false);
  });

  test('same customer but not a current customer (a prospect): no skip, on file yes', () => {
    expect(leadSynopsisCallerState({ knownCaller: known('c2', 'new_lead'), customerId: 'c2' })).toEqual({ currentCustomer: false, callerOnFile: true });
  });

  test('no pre-lookup match: not on file, no skip (a customer made during this pass is not pre-existing)', () => {
    expect(leadSynopsisCallerState({ knownCaller: null, customerId: 'c9' })).toEqual({ currentCustomer: false, callerOnFile: false });
  });

  test('lookup failed or unknown: unknown, no skip', () => {
    expect(leadSynopsisCallerState({ knownCaller: null, customerId: 'c1', lookupFailed: true })).toEqual({ currentCustomer: false, callerOnFile: undefined });
    expect(leadSynopsisCallerState({ knownCaller: known('c1', 'active_customer'), customerId: 'c1', lookupFailed: true }).currentCustomer).toBe(false);
    expect(leadSynopsisCallerState({})).toEqual({ currentCustomer: false, callerOnFile: undefined });
  });

  test('a shared-number prospect resolved by the pass still gets the model', async () => {
    const state = leadSynopsisCallerState({ knownCaller: known('c1', 'active_customer'), customerId: 'c2' });
    await resolveLeadSynopsis(TRANSCRIPT, { currentCustomer: state.currentCustomer, facts: buildLeadSynopsisFacts({ callerOnFile: state.callerOnFile }) });
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    expect(promptSent()).not.toContain('Caller on file before this call');
  });
});

describe('readLeadSynopsisRecordState (name is complete, partial or none)', () => {
  const rowIs = (row) => db.mockImplementation(() => ({ where: () => ({ whereNull: () => ({ first: async () => row }) }) }));
  const read = () => _test.readLeadSynopsisRecordState('c1');

  test.each([
    [{ first_name: 'Pat', last_name: 'Example', email: 'pat-example@example.test' }, { nameState: 'complete', emailOnRecord: true }],
    [{ first_name: 'Pat', last_name: '', email: null }, { nameState: 'first', emailOnRecord: false }],
    [{ first_name: null, last_name: 'Example', email: '' }, { nameState: 'last', emailOnRecord: false }],
    [{ first_name: '', last_name: ' ', email: '  ' }, { nameState: 'none', emailOnRecord: false }],
    // intake placeholders are not real name parts
    [{ first_name: 'Pat', last_name: 'Unknown', email: 'a@example.test' }, { nameState: 'first', emailOnRecord: true }],
    [{ first_name: 'Unknown', last_name: 'Caller', email: null }, { nameState: 'none', emailOnRecord: false }],
  ])('%j', async (row, expected) => {
    rowIs(row);
    expect(await read()).toEqual(expected);
  });

  test('no id, no row or a failed read leaves both facts out', async () => {
    expect(await _test.readLeadSynopsisRecordState(null)).toEqual({});
    rowIs(undefined);
    expect(await read()).toEqual({});
    db.mockImplementation(() => { throw new Error('db down'); });
    expect(await read()).toEqual({});
  });

  test('the state never carries the name or the email itself', async () => {
    rowIs({ first_name: 'Pat', last_name: 'Example', email: 'pat-example@example.test' });
    expect(JSON.stringify(await read())).not.toMatch(/Pat|Example|@/);
  });
});

describe('call sites (source pins)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');

  test('the main pass passes its known-caller signal and the facts', () => {
    expect(src).toContain('leadSynopsisCallerState({ knownCaller, customerId, lookupFailed: knownCallerLookupFailed })');
    expect(src).toContain('currentCustomer: synopsisCaller.currentCustomer,');
    const site = src.slice(src.indexOf('synopsis = await resolveLeadSynopsis(transcription, {'));
    const call = site.slice(0, site.indexOf('if (synopsis) {'));
    expect(call).toContain('buildLeadSynopsisFacts({');
    expect(call).toContain('callerOnFile: synopsisCaller.callerOnFile');
    expect(call).toContain('appointmentResult');
    expect(call).toContain('quotePromised: callQuotePromised');
    expect(call).toContain('emailHeld: emailReviewHeldThisRun');
    expect(src).not.toContain('synopsis = await generateLeadSynopsis(transcription);');
  });

  test('the manual regenerate path always runs the model and reads only its own customer row', () => {
    const start = src.indexOf('async generateSynopsis(callSid) {');
    const body = src.slice(start, src.indexOf('return { success: true, synopsis };', start)).replace(/^\s*\/\/.*$/gm, '');
    expect(body).toContain('generateLeadSynopsis(');
    expect(body).toContain('buildLeadSynopsisFacts(await readLeadSynopsisRecordState(call.customer_id))');
    expect(body).not.toContain('resolveLeadSynopsis(');
    expect(body).not.toContain('known_caller');
    expect(body).not.toContain('current_customer');
  });
});

describe('generateSynopsis (manual regenerate)', () => {
  const { CallRecordingProcessor } = (() => ({ CallRecordingProcessor: require('../services/call-recording-processor') }))();
  const stubDb = ({ stamp, customerRow }) => {
    const updates = [];
    db.mockImplementation((table) => {
      if (table === 'call_log') {
        return {
          where: () => ({
            first: async () => ({ id: 'cl1', customer_id: 'c1', transcription: TRANSCRIPT, ai_extraction: JSON.stringify({ known_caller: stamp }) }),
            update: (patch) => { updates.push(patch); return Promise.resolve(1); },
          }),
        };
      }
      return { where: () => ({ whereNull: () => ({ first: async () => customerRow }) }) };
    });
    return updates;
  };

  test.each(['current_customer', 'other_account', 'not_on_file', 'lookup_failed', undefined])('a stored stamp of %s never skips the model or states the on-file fact', async (stamp) => {
    const updates = stubDb({ stamp, customerRow: { first_name: 'Pat', last_name: '', email: 'pat-example@example.test' } });
    const out = await CallRecordingProcessor.generateSynopsis('CA_x');
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ success: true, synopsis: '## Lead notes' });
    expect(updates).toEqual([{ lead_synopsis: '## Lead notes' }]);
    const prompt = promptSent();
    expect(prompt).not.toContain('Caller on file');
    expect(prompt).toContain("- The customer's name on the record: first name only");
    expect(prompt).toContain('- An email is on the record: yes');
    expect(prompt).not.toMatch(/Pat|@/);
    // No pass state here: no visit or quote line either.
    expect(prompt).not.toMatch(/A visit was booked|A quote was promised/);
  });

  test('a customer row that cannot be read leaves the facts block out', async () => {
    stubDb({ stamp: 'current_customer', customerRow: undefined });
    await CallRecordingProcessor.generateSynopsis('CA_x');
    expect(promptSent()).not.toContain('Record facts');
  });
});
