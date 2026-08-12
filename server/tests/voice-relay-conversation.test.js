/**
 * RelayConversation lifecycle — explicit end-of-call after capture.
 *
 * After the agent captures the lead and delivers its closing line, the relay
 * must proactively end the ConversationRelay session (send the end frame) so the
 * caller isn't left in silence until they hang up. These cover the decision
 * (_maybeEndAfterTurn) and that no new turn is started once the session is ending.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));

const { RelayConversation } = require('../services/voice-agent/relay-conversation');
const db = require('../models/db');

describe('RelayConversation — explicit end after capture', () => {
  test('_maybeEndAfterTurn ends the session once, only after a lead is captured', () => {
    const endSession = jest.fn();
    const convo = new RelayConversation({ callSid: 'CA1', from: '+19415551234', send: jest.fn(), endSession });

    // No lead captured yet → do NOT end (caller is still mid-conversation).
    convo._maybeEndAfterTurn();
    expect(endSession).not.toHaveBeenCalled();
    expect(convo._ending).toBe(false);

    // Lead captured + agent finished its turn → end the session once.
    convo.leadCaptured = true;
    convo._maybeEndAfterTurn();
    expect(endSession).toHaveBeenCalledTimes(1);
    expect(endSession).toHaveBeenCalledWith(expect.objectContaining({ captured: true }));
    expect(convo._ending).toBe(true);

    // Idempotent — never send a second end frame.
    convo._maybeEndAfterTurn();
    expect(endSession).toHaveBeenCalledTimes(1);
  });

  test('no end frame when no endSession callback was provided (TwiML-Bin sandbox)', () => {
    const convo = new RelayConversation({ callSid: 'CA1', from: '+19415551234', send: jest.fn() });
    convo.leadCaptured = true;
    expect(() => convo._maybeEndAfterTurn()).not.toThrow();
    expect(convo._ending).toBe(false); // nothing to end through
  });

  test('a new caller prompt is ignored once the session is ending', () => {
    const convo = new RelayConversation({ callSid: 'CA1', from: '+19415551234', send: jest.fn(), endSession: jest.fn() });
    convo.leadCaptured = true;
    convo._maybeEndAfterTurn();
    const chainBefore = convo._chain;
    const ret = convo.handlePrompt('are you still there?');
    expect(ret).toBe(chainBefore); // early-returned the existing chain; no new turn queued
  });

  test('end() reconcile stamps ai_handled but yields to a relay-failure voicemail', async () => {
    // The /relay-complete failure path stamps call_outcome='voicemail'. end()
    // runs on every WS close and must NOT clobber that with 'ai_handled'. But the
    // handoff clears call_outcome to NULL before a SUCCESSFUL session, so the
    // guard must match NULL too (NULL <> 'voicemail' is NULL in SQL) — else
    // successful calls never finalize. Verify the guard is "NULL OR not voicemail".
    const update = jest.fn().mockResolvedValue(1);
    const guardQ = { whereNull: jest.fn().mockReturnThis(), orWhereNot: jest.fn().mockReturnThis() };
    const builder = {
      update,
      where: jest.fn((arg) => { if (typeof arg === 'function') arg(guardQ); return builder; }),
    };
    db.mockReturnValue(builder);

    const convo = new RelayConversation({ callSid: 'CA9', from: '+19415551234', send: jest.fn() });
    convo.leadCaptured = true; // skip the capture-floor lead write
    await convo.end('hangup');

    expect(db).toHaveBeenCalledWith('call_log');
    expect(builder.where).toHaveBeenCalledWith('twilio_call_sid', 'CA9');
    // the guard callback ran whereNull('call_outcome') OR orWhereNot(...,'voicemail')
    expect(guardQ.whereNull).toHaveBeenCalledWith('call_outcome');
    expect(guardQ.orWhereNot).toHaveBeenCalledWith('call_outcome', 'voicemail');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed', answered_by: 'ai_agent', call_outcome: 'ai_handled',
    }));
  });

  // ⭐ The recent-texts block is customer-AUTHORED SMS text. It rides the USER
  // role, never `system`, and is seeded exactly once, ahead of the caller's
  // first turn, as a user/assistant pair so roles still strictly alternate.
  test('recent-texts data turn is seeded into the USER role, once, before the caller turn', async () => {
    const convo = new RelayConversation({ callSid: 'CA5', from: '+19415551234', send: jest.fn() });
    convo._callerContext = {
      customer: { id: 'c-1', first_name: 'Pat' },
      tier: 'full',
      block: 'KNOWN CALLER ...',
      dataTurn: '<<<RECENT TEXTS DATA\nCustomer: the ants are back\nEND RECENT TEXTS DATA>>>',
    };
    // Drive only the seeding half of _runLoop (no Anthropic client in tests).
    await convo._runLoop('hi there').catch(() => {});

    expect(convo.messages[0]).toEqual({ role: 'user', content: convo._callerContext.dataTurn });
    expect(convo.messages[1].role).toBe('assistant');
    expect(convo.messages[2].role).toBe('user');
    // Roles alternate — the API rejects two consecutive same-role messages.
    for (let i = 1; i < convo.messages.length; i++) {
      expect(convo.messages[i].role).not.toBe(convo.messages[i - 1].role);
    }

    // Seeded ONCE, however many turns follow.
    await convo._runLoop('and another thing').catch(() => {});
    expect(convo.messages.filter((m) => m.content === convo._callerContext.dataTurn)).toHaveLength(1);
  });

  // ⭐ AN UNBOUNDED TOOL IS UNBOUNDED DEAD AIR. The stream has a 20s bound and
  // context resolution 4s; tool execution had none, and the slow ones are real
  // (get_invoice_history resolves a payer per invoice, up to 200).
  describe('tool execution is time-bounded', () => {
    let relayTools;
    beforeEach(() => {
      jest.useFakeTimers();
      relayTools = require('../services/voice-agent/relay-tools');
    });
    afterEach(() => {
      jest.useRealTimers();
      if (relayTools.executeTool.mockRestore) relayTools.executeTool.mockRestore();
    });

    async function raceWithTimers(promise) {
      await Promise.resolve();
      jest.advanceTimersByTime(30000);
      return promise;
    }

    test('a hanging READ tool degrades instead of holding the turn open', async () => {
      jest.spyOn(relayTools, 'executeTool').mockImplementation(() => new Promise(() => {}));
      const convo = new RelayConversation({ callSid: 'CA8', from: '+19415551234', send: jest.fn() });
      const out = await raceWithTimers(convo._executeToolBounded('get_invoice_history', {}, {}));
      expect(out).toMatch(/Could not look that up right now/i);
      expect(out).toMatch(/Do not guess/i);
    });

    // A timed-out WRITE is still IN FLIGHT. Telling the model "that failed"
    // would invite a retry — and a duplicate booking, lead, or ticket.
    test('a hanging WRITE tool degrades to "unknown outcome, do NOT retry"', async () => {
      jest.spyOn(relayTools, 'executeTool').mockImplementation(() => new Promise(() => {}));
      const convo = new RelayConversation({ callSid: 'CA8', from: '+19415551234', send: jest.fn() });
      for (const name of ['request_booking', 'capture_lead', 'request_reservice']) {
        const out = await raceWithTimers(convo._executeToolBounded(name, {}, {}));
        expect(out).toMatch(/do not have confirmation either way/i);
        expect(out).toMatch(/Do NOT call it again/i);
        expect(out).not.toMatch(/could not|failed/i); // never implies it didn't happen
      }
    });

    // ⭐ "Do NOT call it again" was an INSTRUCTION, not a mechanism. The timed-
    // out write is detached and still running, and nothing stopped the model
    // starting the same one again — request_reservice's dedupe is an unlocked
    // read-before-insert, so the retry files a second ticket and pages the
    // owner twice.
    test('a WRITE that timed out cannot be started again while it is still in flight', async () => {
      const finish = {}; // toolName -> resolver for that tool's detached work
      jest.spyOn(relayTools, 'executeTool')
        .mockImplementation((name) => new Promise((resolve) => { finish[name] = resolve; }));
      const convo = new RelayConversation({ callSid: 'CAw', from: '+19415551234', send: jest.fn() });

      const first = await raceWithTimers(convo._executeToolBounded('request_reservice', {}, {}));
      expect(first).toMatch(/do not have confirmation either way/i);
      expect(relayTools.executeTool).toHaveBeenCalledTimes(1);

      // The model retries anyway — refused, and NOT executed a second time.
      const second = await convo._executeToolBounded('request_reservice', {}, {});
      expect(second).toMatch(/still being processed/i);
      expect(second).toMatch(/NOT started again/);
      expect(relayTools.executeTool).toHaveBeenCalledTimes(1);

      // A DIFFERENT write is unaffected — the latch is per tool.
      await raceWithTimers(convo._executeToolBounded('capture_lead', {}, {}));
      expect(relayTools.executeTool).toHaveBeenCalledTimes(2);

      // Once the detached write settles, the latch clears.
      const detached = convo._inFlightWrites.get('request_reservice');
      finish.request_reservice('Re-service request filed for this account.');
      await detached; // the clear callback was registered first, so it has run
      expect(convo._inFlightWrites.has('request_reservice')).toBe(false);
    });

    // The turn chain does NOT cover a detached write, so end() could reach the
    // capture floor while capture_lead was still writing — and write a SECOND
    // lead for the same call.
    test('end() drains detached writes before the capture floor decides', async () => {
      const { createLeadFromExtraction } = require('../services/lead-from-extraction');
      createLeadFromExtraction.mockClear();
      let finishWork;
      jest.spyOn(relayTools, 'executeTool')
        .mockImplementation(() => new Promise((resolve) => { finishWork = resolve; }));
      // callSid null → the call_log reconcile is skipped; the capture floor is
      // the only thing left in end().
      const convo = new RelayConversation({ callSid: null, from: '+19415551234', send: jest.fn() });
      await raceWithTimers(convo._executeToolBounded('capture_lead', {}, {}));

      let ended = false;
      const closing = convo.end('hangup').then(() => { ended = true; });
      await Promise.resolve();
      await Promise.resolve();
      expect(ended).toBe(false); // still waiting on the in-flight write
      expect(createLeadFromExtraction).not.toHaveBeenCalled();

      // The write lands and sets the latch the floor reads.
      convo.leadCaptured = true;
      finishWork('Lead saved successfully.');
      await closing;
      expect(ended).toBe(true);
      expect(createLeadFromExtraction).not.toHaveBeenCalled(); // no duplicate lead
    });

    // The drain is BOUNDED — a wedged write outlives it. createLeadFromExtraction
    // is not idempotent on callSid, so running the floor anyway recreates the
    // very duplicate the drain exists to prevent.
    test('a capture_lead still in flight past the drain bound SUPPRESSES the floor', async () => {
      const { createLeadFromExtraction } = require('../services/lead-from-extraction');
      createLeadFromExtraction.mockClear();
      jest.spyOn(relayTools, 'executeTool').mockImplementation(() => new Promise(() => {})); // never settles
      const convo = new RelayConversation({ callSid: null, from: '+19415551234', send: jest.fn() });
      await raceWithTimers(convo._executeToolBounded('capture_lead', {}, {}));

      const closing = convo.end('hangup');
      await Promise.resolve();
      jest.advanceTimersByTime(30000); // blow through the drain bound
      await closing;

      expect(convo._inFlightWrites.has('capture_lead')).toBe(true);
      expect(convo.leadCaptured).toBe(false);        // the write never reported back…
      expect(createLeadFromExtraction).not.toHaveBeenCalled(); // …and the floor still did NOT race it
    });

    // ⭐ THE FLOOR OWES THE BOOKING CARD ITS LEAD ID. A caller who books and
    // then hangs up before capture_lead gets their lead from the floor — and
    // dropping the id there leaves the review card's `lead_id: null`, which
    // outbound-review-confirm treats as authoritative for voice cards (it
    // skips the single-active-lead fallback on purpose). Office confirm would
    // then leave this call's own lead open.
    test('the hangup floor attaches its lead to the booking card', async () => {
      jest.useRealTimers();
      const { createLeadFromExtraction } = require('../services/lead-from-extraction');
      createLeadFromExtraction.mockResolvedValue({ leadId: 'lead-floor-1' });
      const relayBooking = require('../services/voice-agent/relay-booking');
      const attach = jest.spyOn(relayBooking, 'attachLeadToVoiceBookingCard').mockResolvedValue(true);

      const convo = new RelayConversation({ callSid: 'CA-floor-1', from: '+19415551234', send: jest.fn() });
      convo._bookingRequested = true; // a booking landed earlier on this call
      await convo._runCaptureFloor('hangup');

      expect(createLeadFromExtraction).toHaveBeenCalled();
      expect(attach).toHaveBeenCalledWith('CA-floor-1', 'lead-floor-1');
      expect(convo._leadId).toBe('lead-floor-1');
      attach.mockRestore();
    });

    test('with no booking on the call the floor attaches nothing', async () => {
      jest.useRealTimers();
      const { createLeadFromExtraction } = require('../services/lead-from-extraction');
      createLeadFromExtraction.mockResolvedValue({ leadId: 'lead-floor-2' });
      const relayBooking = require('../services/voice-agent/relay-booking');
      const attach = jest.spyOn(relayBooking, 'attachLeadToVoiceBookingCard').mockResolvedValue(true);

      const convo = new RelayConversation({ callSid: 'CA-floor-2', from: '+19415551234', send: jest.fn() });
      await convo._runCaptureFloor('hangup');

      expect(attach).not.toHaveBeenCalled();
      attach.mockRestore();
    });

    test('a fast tool is untouched by the bound', async () => {
      jest.useRealTimers(); // no clock nudging — the work simply wins the race
      jest.spyOn(relayTools, 'executeTool').mockResolvedValue('the real answer');
      const convo = new RelayConversation({ callSid: 'CA8', from: '+19415551234', send: jest.fn() });
      await expect(convo._executeToolBounded('get_account_overview', {}, {}))
        .resolves.toBe('the real answer');
    });
  });

  // ⭐ PROMPT-CACHING ORDERING. Caching is a strict prefix match, so the system
  // prompt must be byte-identical every turn — which is exactly why the CLOCK,
  // re-rendered per turn by definition, cannot live in it.
  describe('prompt caching', () => {
    test('system blocks + tools are built once and carry a cache breakpoint', async () => {
      process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true';
      try {
        const convo = new RelayConversation({ callSid: 'CAc', from: '+19415551234', send: jest.fn() });
        await convo._runLoop('first turn').catch(() => {});
        const first = convo._systemBlocks;
        expect(Array.isArray(first)).toBe(true);
        expect(first[0].cache_control).toEqual({ type: 'ephemeral' });
        // The RENDERED clock block (the per-turn invalidator) is out; the prompt
        // RULE that tells her a clock exists stays.
        expect(first[0].text).not.toContain('<<<CLOCK DATA');
        await convo._runLoop('second turn').catch(() => {});
        expect(convo._systemBlocks).toBe(first); // same object — byte-identical prefix
      } finally {
        delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
      }
    });

    test('the clock rides the USER turn, so each turn carries its own time', async () => {
      process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true';
      try {
        const convo = new RelayConversation({ callSid: 'CAd', from: '+19415551234', send: jest.fn() });
        convo._officeHours = { startMin: 8 * 60, endMin: 17 * 60 };
        await convo._runLoop('when can you come out?').catch(() => {});
        const turn = convo.messages[convo.messages.length - 1];
        expect(turn.role).toBe('user');
        expect(Array.isArray(turn.content)).toBe(true);
        expect(turn.content[0].text).toContain('CLOCK DATA');
        expect(turn.content[1].text).toBe('when can you come out?');
      } finally {
        delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
      }
    });
  });

  // The tool ctx is rebuilt EVERY turn; the lookup budget must not be, or a
  // caller gets a fresh three lookups per turn.
  test('the lookup budget is SESSION-scoped, not per-turn', () => {
    const { LOOKUP_SESSION_BUDGET } = require('../services/voice-agent/relay-context');
    const convo = new RelayConversation({ callSid: 'CA6', from: '+19415551234', send: jest.fn() });
    const grants = [];
    for (let turn = 0; turn < LOOKUP_SESSION_BUDGET + 2; turn++) {
      grants.push(convo._buildToolCtx().consumeLookup()); // a NEW ctx each turn
    }
    expect(grants.filter(Boolean)).toHaveLength(LOOKUP_SESSION_BUDGET);
    expect(grants.slice(LOOKUP_SESSION_BUDGET)).toEqual([false, false]);
  });

  // ⭐ THE CALLED NUMBER IS THE LEAD SOURCE. capture_lead stamps ctx.to as the
  // lead's toPhone, which is what maps a tracking/GBP number to its
  // lead_source_id. The ctx omitted it, so every model-captured lead lost its
  // source — hidden by the hangup capture floor, which passes this.to directly.
  test('the tool ctx carries the DIALLED number, and capture_lead stamps it as toPhone', async () => {
    const { executeTool } = require('../services/voice-agent/relay-tools');
    const { createLeadFromExtraction } = require('../services/lead-from-extraction');
    createLeadFromExtraction.mockClear();
    const convo = new RelayConversation({
      callSid: 'CAto', from: '+19415551234', to: '+19417770000', send: jest.fn(),
    });
    expect(convo._buildToolCtx().to).toBe('+19417770000');

    await executeTool('capture_lead', { call_summary: 'ants in the kitchen' }, convo._buildToolCtx());
    expect(createLeadFromExtraction).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ phone: '+19415551234', toPhone: '+19417770000', callSid: 'CAto' }),
    );
  });

  // Contact-slot recognition must never reach the ctx as 'full'.
  test('customerTier on the tool ctx mirrors the ANI match column, failing closed', () => {
    const convo = new RelayConversation({ callSid: 'CA7', from: '+19415551234', send: jest.fn() });
    expect(convo._buildToolCtx().customerTier).toBe('redacted'); // unknown caller
    convo._callerContext = { customer: { id: 'c-1' }, tier: 'redacted' };
    expect(convo._buildToolCtx().customerTier).toBe('redacted');
    convo._callerContext = { customer: { id: 'c-1' } }; // tier missing entirely
    expect(convo._buildToolCtx().customerTier).toBe('redacted');
    convo._callerContext = { customer: { id: 'c-1' }, tier: 'full' };
    expect(convo._buildToolCtx().customerTier).toBe('full');
  });
});
