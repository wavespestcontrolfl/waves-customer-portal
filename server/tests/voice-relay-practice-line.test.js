/**
 * A PRACTICE LINE (RelayConversation option practiceLine, used by the GPT-Live
 * trial's brain, live-brain.js; sandbox only): public information plus one dry-run
 * write, and nothing that reads a customer account. It resolves no caller context
 * at all, never transfers, and never ends itself. The database is a mock that
 * throws: nothing here may touch it for an account.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn(() => { throw new Error('db must not be touched'); }));
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
// No OpenAI client can be built here, so a session pinned to that provider has no client at all.
jest.mock('../services/voice-agent/relay-openai-client', () => ({ OpenAIRelayClient: class { constructor() { throw new Error('no client in tests'); } } }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../services/voice-agent/relay-context', () => {
  const actual = jest.requireActual('../services/voice-agent/relay-context');
  return {
    ...actual,
    resolveCallerContext: jest.fn(async () => null),
    verifyRelaySession: jest.fn(async () => ({ verified: false })),
    lookupCustomersText: jest.fn(async () => 'LOOKUP RAN'),
    accountOverviewText: jest.fn(async () => 'OVERVIEW RAN'),
  };
});

const db = require('../models/db');
const relayContext = require('../services/voice-agent/relay-context');
const { executeTool, activeTools, PRACTICE_LINE_TOOLS, TOOLS, CONTEXT_TOOLS, BOOKING_TOOLS } = require('../services/voice-agent/relay-tools');
const { RelayConversation, PRACTICE_LINE_ADDENDUM } = require('../services/voice-agent/relay-conversation');

const GATE = 'GATE_VOICE_RELAY_TRANSFER';
const OLD_GATE = process.env[GATE];
const OLD_CTX = process.env.VOICE_RELAY_CONTEXT_ENABLED;
beforeEach(() => { jest.clearAllMocks(); process.env[GATE] = 'true'; process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });
afterAll(() => {
  if (OLD_GATE === undefined) delete process.env[GATE];
  else process.env[GATE] = OLD_GATE;
  if (OLD_CTX === undefined) delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
  else process.env.VOICE_RELAY_CONTEXT_ENABLED = OLD_CTX;
});

const practice = (extra = {}) => new RelayConversation({
  callSid: 'CA-practice-1', from: '+19415551234', send: jest.fn(), endSession: jest.fn(), sandbox: true, practiceLine: true, ...extra,
});

describe('practiceLine option', () => {
  test('it exists only on a sandbox session, and only for a boolean true', () => {
    expect(practice()._practiceLine).toBe(true);
    expect(practice({ practiceLine: 'true' })._practiceLine).toBe(false);
    expect(practice({ sandbox: false })._practiceLine).toBe(false); // a production session can never be one
    expect(practice({ practiceLine: false })._practiceLine).toBe(false);
  });

  test('it resolves NO caller context: no verification, no claim, no recent-text hydration', async () => {
    const convo = practice({ sessionKey: 'nonce', sessionGeneration: 5, callTokenVerified: true });
    await new Promise((r) => setImmediate(r));
    expect(relayContext.resolveCallerContext).not.toHaveBeenCalled();
    expect(relayContext.verifyRelaySession).not.toHaveBeenCalled();
    expect(convo._contextReady).toBe(null);
    expect(convo._callerContext).toBe(null);
    expect(convo._callerVerified).toBe(false);
    // an ordinary sandbox session still resolves it, as before
    const ordinary = new RelayConversation({ callSid: 'CA-sb-1', from: '+19415551234', send: jest.fn(), sandbox: true });
    expect(ordinary._contextReady).not.toBe(null);
    expect(relayContext.resolveCallerContext).toHaveBeenCalledTimes(1);
  });

  test('its tool ctx carries the flag and reports hours unknown', () => {
    const ctx = practice()._buildToolCtx();
    expect(ctx.practiceLine).toBe(true);
    expect(ctx.officeOpenNow()).toBe(null);
    expect(ctx.customerId == null).toBe(true);
  });
});

describe('the tool allowlist', () => {
  test('is exactly the public-information tools plus the dry-run capture', () => {
    expect([...PRACTICE_LINE_TOOLS]).toEqual(['get_services_catalog', 'get_pricing', 'get_availability', 'find_slots', 'capture_lead']);
  });

  test('registration: a practice line is offered those tools and no others, whatever gates are on', () => {
    const names = activeTools({ officeOpen: true, practiceLine: true }).map((t) => t.name).sort();
    expect(names).toEqual([...PRACTICE_LINE_TOOLS].sort());
    // an ordinary session still gets the full set, including the account tools and (office open) transfer
    const ordinary = activeTools({ officeOpen: true }).map((t) => t.name);
    for (const name of ['lookup_customer', 'get_account_overview', 'get_call_history', 'get_invoice_history', 'transfer_to_office']) expect(ordinary).toContain(name);
    // every tool the module defines is either allowlisted or absent from a practice line
    const all = [...TOOLS, ...CONTEXT_TOOLS, ...BOOKING_TOOLS].map((t) => t.name);
    for (const name of all.filter((n) => !PRACTICE_LINE_TOOLS.includes(n))) expect(names).not.toContain(name);
  });

  const ACCOUNT_AND_OTHER_TOOLS = [
    'lookup_customer', 'get_account_overview', 'get_service_history', 'get_service_report', 'get_open_estimates', 'get_invoice_history',
    'get_today_eta', 'get_call_history', 'get_message_history', 'request_reservice', 'request_booking', 'transfer_to_office', 'made_up_tool',
  ];
  test.each(ACCOUNT_AND_OTHER_TOOLS)('execution: %s is refused before any database call, even with a customer ref or a matched id', async (name) => {
    const markTransferRequested = jest.fn();
    const out = await executeTool(name, { customer_ref: 'C1', name: 'Pat Smith', street: '12 Palm Ave', slot_ref: 'S1' }, {
      practiceLine: true, sandbox: true, callSid: 'CA-practice-1', from: '+19415551234', callerVerified: true, customerId: 'cust-1', customerTier: 'full',
      callerAttested: true, officeOpenNow: () => true, markTransferRequested, resolveLookupRef: () => 'cust-2', rememberLookup: jest.fn(), consumeLookup: () => true,
    });
    expect(out).toMatch(/This is a practice line\. It cannot look at accounts, visits, invoices, messages or history/);
    expect(out).toMatch(/call or text the Waves office/);
    expect(db).not.toHaveBeenCalled();
    expect(relayContext.lookupCustomersText).not.toHaveBeenCalled();
    expect(relayContext.accountOverviewText).not.toHaveBeenCalled();
    expect(markTransferRequested).not.toHaveBeenCalled();
  });

  test('capture_lead: use_account_details is forced off, and the write is the practice dry run', async () => {
    const markCaptured = jest.fn();
    const out = await executeTool('capture_lead', { first_name: 'Pat', call_summary: 'Wants a quote.', use_account_details: true, estimate_requested: true }, {
      sandbox: true, practiceLine: true, callSid: 'CA-practice-1', from: '+19415551234', markCaptured, noteCallSummary: jest.fn(),
    });
    expect(out).toMatch(/PRACTICE LINE: capture_lead was checked and NOT run/);
    expect(markCaptured).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });
});

describe('failure copy and the end of the session', () => {
  test('deterministic closes promise no callback and no note for the team (no model client; tool rounds spent; turn cap)', () => {
    const convo = practice();
    for (const key of ['unavailable', 'toolRounds', 'turnCap']) {
      const text = convo._copy(key);
      expect(text).toMatch(/call or text the Waves office/);
      expect(text).not.toMatch(/call you back|team member|made a note|will follow up/i);
    }
    // an ordinary session keeps the production copy
    const ordinary = new RelayConversation({ callSid: 'CA-sb-2', from: '+19415551234', send: jest.fn(), sandbox: true });
    expect(ordinary._copy('unavailable')).toMatch(/team member will call you back/);
  });

  test('a turn with no model client speaks the practice copy through the real conversation', async () => {
    const send = jest.fn();
    const convo = practice({ send });
    convo._provider = 'openai'; // its client could not be built (mocked above)
    await convo.handlePrompt('hello there');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("Sorry, I can't answer that right now. You can call or text the Waves office.");
  });

  test('a captured lead never ends a practice line, and an ordinary sandbox session still ends (unchanged)', () => {
    const convo = practice();
    convo.leadCaptured = true;
    convo._maybeEndAfterTurn();
    expect(convo._endSession).not.toHaveBeenCalled();
    expect(convo._ending).toBe(false);
    const ordinary = new RelayConversation({ callSid: 'CA-sb-9', from: '+19415551234', send: jest.fn(), endSession: jest.fn(), sandbox: true });
    ordinary.leadCaptured = true;
    ordinary._maybeEndAfterTurn();
    expect(ordinary._endSession).toHaveBeenCalledTimes(1);
  });

  test('the provider-failure handoff never runs on a practice line (no transfer, no callback filed, no end frame)', async () => {
    const convo = practice();
    await new Promise((r) => setImmediate(r));
    db.mockClear();
    convo._modelFailures = 5;
    convo._toolFailures = 5;
    await expect(convo._maybeHandoffForFailure(convo._buildToolCtx())).resolves.toBe(false);
    expect(convo._endSession).not.toHaveBeenCalled();
    expect(db.mock.calls.map((c) => c[0])).toEqual([]);
  });

  test('the practice addendum names what it can and cannot do, and forbids promising a callback', () => {
    expect(PRACTICE_LINE_ADDENDUM).toMatch(/quote prices, describe services, find open times and take\s+a new-customer request/);
    expect(PRACTICE_LINE_ADDENDUM).toMatch(/cannot see accounts, visits, invoices, estimates, messages or call\s+history/);
    expect(PRACTICE_LINE_ADDENDUM).toMatch(/Do NOT promise a callback/);
    expect(PRACTICE_LINE_ADDENDUM.length).toBeLessThan(900);
  });
});
