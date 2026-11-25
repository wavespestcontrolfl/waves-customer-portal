/**
 * A PRACTICE LINE (RelayConversation option practiceLine, used by the GPT-Live
 * trial's brain, live-brain.js; sandbox only): no transfer and no handoff packet
 * ever, dry-run writes that say so, and a conversation that never ends itself.
 * The database is a mock that throws: nothing here may touch it.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn(() => { throw new Error('db must not be touched'); }));
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../services/reservice-scheduler', () => ({
  openReserviceCallbacks: jest.fn(async () => ({})),
  reserviceLanesForCustomer: jest.fn(async () => []),
  openCallbackExistsForLane: jest.fn(async () => false),
  RESERVICE_LANES: {},
}));

const db = require('../models/db');
const { executeTool, activeTools } = require('../services/voice-agent/relay-tools');
const { RelayConversation } = require('../services/voice-agent/relay-conversation');

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
const tablesTouched = () => db.mock.calls.map((c) => c[0]);

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

  test('its tool ctx reports hours unknown and carries the flag, so no transfer tool or rule is built', () => {
    const ctx = practice()._buildToolCtx();
    expect(ctx.practiceLine).toBe(true);
    expect(ctx.officeOpenNow()).toBe(null);
    // even with the transfer gate on, an unknown office state registers no transfer tool
    expect(activeTools({ officeOpen: ctx.officeOpenNow() }).map((t) => t.name)).not.toContain('transfer_to_office');
    expect(activeTools({ officeOpen: true }).map((t) => t.name)).toContain('transfer_to_office'); // the gate is on: an ordinary open office would get it
  });
});

describe('transfer is refused before any packet exists', () => {
  test('transfer_to_office on a practice line writes nothing and marks no transfer, whatever the office state says', async () => {
    const markTransferRequested = jest.fn();
    const handoffFacts = jest.fn(() => ({ name: 'Pat' }));
    const out = await executeTool('transfer_to_office', { intent: 'person', summary: 'wants a person' }, {
      practiceLine: true, sandbox: true, callSid: 'CA-practice-1', officeOpenNow: () => true, markTransferRequested, handoffFacts, transferRequested: () => false,
    });
    expect(out).toMatch(/practice line and cannot transfer/);
    expect(markTransferRequested).not.toHaveBeenCalled();
    expect(handoffFacts).not.toHaveBeenCalled(); // no packet is built, so no relay_handoff metadata can be written
    expect(db).not.toHaveBeenCalled();
  });

  test('the provider-failure handoff never runs on a practice line (no transfer, no callback filed, no end frame)', async () => {
    const convo = practice();
    await new Promise((r) => setImmediate(r)); // the constructor's own reads (caller check, office hours) settle first
    db.mockClear();
    convo._modelFailures = 5;
    convo._toolFailures = 5;
    await expect(convo._maybeHandoffForFailure(convo._buildToolCtx())).resolves.toBe(false);
    expect(convo._endSession).not.toHaveBeenCalled();
    expect(convo._handoffForFailure).toBe(false);
    expect(tablesTouched()).toEqual([]); // no handoff packet, no outcome stamp, no callback row
  });
});

describe('dry-run writes say so, and the conversation stays open', () => {
  test.each([
    ['capture_lead', { first_name: 'Pat', call_summary: 'Wants a quote.' }, { from: '+19415551234' }],
    ['request_reservice', { lane: 'pest', issue: 'ants are back in the kitchen' }, { from: '+19415551234', customerId: 'c-1', customerTier: 'full' }],
  ])('%s gets the explicit practice wording and does not mark the call captured', async (name, input, extra) => {
    const markCaptured = jest.fn();
    const noteCallSummary = jest.fn();
    db.mockImplementation(() => {
      const chain = {};
      for (const m of ['where', 'whereIn', 'whereNull', 'orderBy', 'select']) chain[m] = jest.fn(() => chain);
      chain.first = jest.fn(async () => undefined);
      return chain;
    });
    const out = await executeTool(name, input, { sandbox: true, practiceLine: true, callSid: 'CA-practice-1', markCaptured, noteCallSummary, ...extra });
    expect(out).toMatch(new RegExp(`PRACTICE LINE: ${name} was checked and NOT run, so nothing was booked, saved or filed`));
    expect(out).toMatch(/This is a practice line, so nothing was booked or saved\. On a real call, /);
    expect(out).toMatch(/Do NOT say it was done, and do NOT promise a callback/);
    expect(out).not.toMatch(/succeeded|Carry on exactly/);
    expect(markCaptured).not.toHaveBeenCalled();
    expect(noteCallSummary).not.toHaveBeenCalled();
    db.mockImplementation(() => { throw new Error('db must not be touched'); });
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

  test('the practice addendum is a short block that forbids promising a callback', () => {
    const { PRACTICE_LINE_ADDENDUM } = require('../services/voice-agent/relay-conversation');
    expect(PRACTICE_LINE_ADDENDUM).toMatch(/cannot transfer the call/);
    expect(PRACTICE_LINE_ADDENDUM).toMatch(/Do NOT promise a callback/);
    expect(PRACTICE_LINE_ADDENDUM.length).toBeLessThan(700);
  });
});
