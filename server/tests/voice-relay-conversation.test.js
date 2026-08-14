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
  // ⭐ THE GREETING *IS* THE FL §934.03 DISCLOSURE. A keyword-only check
  // accepted the exact opposite of what it guards, so an env-var edit could
  // have deleted both required statements.
  describe('VOICE_RELAY_GREETING override validation', () => {
    const { buildRelayTwiML } = require('../services/voice-agent/relay-protocol');
    afterEach(() => { delete process.env.VOICE_RELAY_GREETING; });

    test('a NEGATED disclosure never passes verbatim — the canonical line is appended', () => {
      process.env.VOICE_RELAY_GREETING = 'Hi! This call is not recorded and you are speaking with a human assistant.';
      const xml = buildRelayTwiML({ wsUrl: 'wss://portal.example.com/ws/voice-agent' });
      expect(xml).toMatch(/this call may be recorded/i);
      expect(xml).toMatch(/automated assistant/i);
    });

    test('an affirmative override that states BOTH is left exactly as written', () => {
      const good = 'Thanks for calling Waves! This call may be recorded and you are speaking with our automated assistant.';
      process.env.VOICE_RELAY_GREETING = good;
      const xml = buildRelayTwiML({ wsUrl: 'wss://portal.example.com/ws/voice-agent' });
      expect(xml).toContain(good);
      expect(xml).not.toMatch(/Just so you know/);
    });

    test('a greeting missing the automated-assistant half gets it appended', () => {
      process.env.VOICE_RELAY_GREETING = 'Thanks for calling Waves! This call may be recorded.';
      const xml = buildRelayTwiML({ wsUrl: 'wss://portal.example.com/ws/voice-agent' });
      expect(xml).toMatch(/Just so you know/);
      expect(xml).toMatch(/automated assistant/i);
    });
  });

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

  // ⭐ THE LATEST OFFER'S CONTEXT WINS. The slot ref is stable per
  // (date, start), but a re-offer from a narrower search must refresh the
  // stored context — request_booking re-validates with it, and a stale broad
  // 'any' search can crowd the chosen afternoon slot past the per-day cap and
  // report a still-open time as gone.
  test('re-offering the same slot refreshes the stored search context under the SAME ref', () => {
    const convo = new RelayConversation({ callSid: 'CA-slot', from: '+19415551234', send: jest.fn() });
    const ctx = convo._buildToolCtx();
    const slot = { date: '2026-08-20', start_time: '14:00' };
    const ref1 = ctx.rememberSlot(slot, { lat: 27.4, lng: -82.5, timeOfDay: 'any', expandOpenDays: true });
    expect(ctx.resolveSlotRef(ref1)).toMatchObject({ timeOfDay: 'any', expandOpenDays: true });
    const ref2 = ctx.rememberSlot(slot, { lat: 27.4, lng: -82.5, timeOfDay: 'afternoon', expandOpenDays: false });
    expect(ref2).toBe(ref1); // stable ref, no registry growth
    expect(ctx.resolveSlotRef(ref1)).toMatchObject({ timeOfDay: 'afternoon', expandOpenDays: false });
  });

  // ⭐ EXHAUSTION IS NOT SILENCE. A model that spends every round on tool
  // calls never emits text — without a fallback the caller sits in dead air
  // on an open line after MAX_TOOL_ROUNDS.
  test('tool-round exhaustion speaks a fallback instead of leaving the caller in silence', async () => {
    let IsolatedConvo;
    jest.isolateModules(() => {
      jest.doMock('@anthropic-ai/sdk', () => function AnthropicMock() {
        return {
          messages: {
            stream: () => ({
              finalMessage: async () => ({
                content: [{ type: 'tool_use', id: 't1', name: 'get_availability', input: {} }],
                stop_reason: 'tool_use',
              }),
            }),
          },
        };
      });
      jest.doMock('../services/voice-agent/relay-tools', () => ({
        TOOLS: [],
        CONTEXT_TOOLS: [],
        activeTools: () => [],
        executeTool: jest.fn(async () => 'ok'),
      }));
      IsolatedConvo = require('../services/voice-agent/relay-conversation').RelayConversation;
    });
    const send = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-exhaust', from: '+19415551234', send });
    await convo._runLoop('book me something').catch(() => {});
    const spoken = send.mock.calls.map(([t]) => String(t)).join(' ');
    expect(spoken).toMatch(/anything else I can help/i);
  });

  // ⭐ NO SPEECH BEFORE A WRITE'S RESULT IS KNOWN. A mixed text-plus-tool turn
  // around a write tool would speak "that's submitted!" BEFORE the write ran —
  // a false success when the tool then rejects a stale slot or fails. The
  // pre-write text is suppressed; the model speaks after seeing the result.
  test('text on a write-tool turn is suppressed; the post-result text is what the caller hears', async () => {
    let IsolatedConvo;
    jest.isolateModules(() => {
      let call = 0;
      jest.doMock('@anthropic-ai/sdk', () => function AnthropicMock() {
        return {
          messages: {
            stream: () => ({
              finalMessage: async () => {
                call += 1;
                if (call === 1) {
                  return {
                    content: [
                      { type: 'text', text: 'Great — your booking is submitted!' },
                      { type: 'tool_use', id: 't1', name: 'request_booking', input: {} },
                    ],
                    stop_reason: 'tool_use',
                  };
                }
                return {
                  content: [{ type: 'text', text: 'That time was just taken — want another option?' }],
                  stop_reason: 'end_turn',
                };
              },
            }),
          },
        };
      });
      jest.doMock('../services/voice-agent/relay-tools', () => ({
        TOOLS: [],
        CONTEXT_TOOLS: [],
        activeTools: () => [],
        executeTool: jest.fn(async () => 'slot_gone'),
      }));
      IsolatedConvo = require('../services/voice-agent/relay-conversation').RelayConversation;
    });
    const send = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-write-text', from: '+19415551234', send });
    await convo._runLoop('book it').catch(() => {});
    const spoken = send.mock.calls.map(([t]) => String(t)).join(' ');
    expect(spoken).not.toMatch(/booking is submitted/i);
    expect(spoken).toMatch(/just taken/i);
    // ⭐ THE HISTORY AGREES WITH THE AIR: the suppressed turn is stored
    // tool-use-only, so the follow-up round knows nothing was spoken yet and
    // must state the outcome itself (a full stored message let the model
    // believe the caller had already heard the pre-write text).
    const storedAssistant = convo.messages.find((m) => m.role === 'assistant');
    expect(storedAssistant.content.every((b) => b.type !== 'text')).toBe(true);
  });

  // ⭐ A LATE-HYDRATED KNOWN CALLER BLOCK STILL REACHES THE MODEL. The system
  // prompt is frozen per call (cache-prefix stability) — a context settling
  // after the freeze rides the next user turn as an ACCOUNT CONTEXT pair.
  test('a context hydrated after the prompt froze rides the next turn as an ACCOUNT CONTEXT data turn', async () => {
    let IsolatedConvo;
    jest.isolateModules(() => {
      jest.doMock('@anthropic-ai/sdk', () => function AnthropicMock() {
        return {
          messages: {
            stream: () => ({
              finalMessage: async () => ({ content: [{ type: 'text', text: 'Hi there!' }], stop_reason: 'end_turn' }),
            }),
          },
        };
      });
      jest.doMock('../services/voice-agent/relay-tools', () => ({
        TOOLS: [], CONTEXT_TOOLS: [], activeTools: () => [], executeTool: jest.fn(async () => 'ok'),
      }));
      IsolatedConvo = require('../services/voice-agent/relay-conversation').RelayConversation;
    });
    const convo = new IsolatedConvo({ callSid: 'CA-late-block', from: '+19415551234', send: jest.fn() });
    convo._lateContextBlockPending = true; // what onLateContext sets when blocks were frozen
    convo._callerContext = { block: 'KNOWN CALLER: Pat Smith, full tier.', customer: { id: 'c-9' }, tier: 'full' };
    await convo._runLoop('hi').catch(() => {});
    const userTurns = convo.messages.filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content));
    expect(userTurns.some((t) => t.includes('ACCOUNT CONTEXT (hydrated after the call started'))).toBe(true);
    expect(convo._lateContextBlockPending).toBe(false); // one-time seed
  });

  test('text on a READ-tool turn is still spoken (filler is fine when nothing can be falsely promised)', async () => {
    let IsolatedConvo;
    jest.isolateModules(() => {
      let call = 0;
      jest.doMock('@anthropic-ai/sdk', () => function AnthropicMock() {
        return {
          messages: {
            stream: () => ({
              finalMessage: async () => {
                call += 1;
                if (call === 1) {
                  return {
                    content: [
                      { type: 'text', text: 'One moment while I check the schedule.' },
                      { type: 'tool_use', id: 't1', name: 'get_availability', input: {} },
                    ],
                    stop_reason: 'tool_use',
                  };
                }
                return { content: [{ type: 'text', text: 'I have Tuesday open.' }], stop_reason: 'end_turn' };
              },
            }),
          },
        };
      });
      jest.doMock('../services/voice-agent/relay-tools', () => ({
        TOOLS: [],
        CONTEXT_TOOLS: [],
        activeTools: () => [],
        executeTool: jest.fn(async () => 'slots'),
      }));
      IsolatedConvo = require('../services/voice-agent/relay-conversation').RelayConversation;
    });
    const send = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-read-text', from: '+19415551234', send });
    await convo._runLoop('when can you come?').catch(() => {});
    const spoken = send.mock.calls.map(([t]) => String(t)).join(' ');
    expect(spoken).toMatch(/one moment while I check/i);
    expect(spoken).toMatch(/Tuesday open/i);
  });

  // ⭐ A SUPERSEDED SESSION LOSES ITS TOOLS. After a fresh-token reconnect
  // takes over the CallSid claim, the OLD socket must not keep account
  // context or write access — every tool call re-proves nonce ownership.
  test('a session whose claim was taken over refuses tools and ends', async () => {
    const builder = {};
    builder.where = jest.fn(() => builder);
    builder.first = jest.fn(async () => ({ metadata: { relay_session_claim_owner: 'nonce-NEW' } }));
    db.mockImplementation(() => builder);
    const endSession = jest.fn();
    const convo = new RelayConversation({
      callSid: 'CA-superseded', sessionKey: 'nonce-OLD', from: '+19415551234', send: jest.fn(), endSession,
    });
    const out = await convo._executeToolBounded('get_availability', {}, {});
    expect(out).toMatch(/superseded by a reconnect/i);
    expect(endSession).toHaveBeenCalledWith(expect.objectContaining({ reason: 'superseded' }));
  });

  // Tri-state: a CLAIMED (verified) session fails CLOSED on an unprovable
  // ownership read; an unclaimed (sandbox — no call_log row) session keeps
  // working.
  test('a VERIFIED session with an unprovable ownership read is refused (fail closed)', async () => {
    const builder = {};
    builder.where = jest.fn(() => builder);
    builder.first = jest.fn(async () => { throw new Error('pool exhausted'); });
    db.mockImplementation(() => builder);
    const endSession = jest.fn();
    const convo = new RelayConversation({
      callSid: 'CA-unprovable', sessionKey: 'nonce-MINE', from: '+19415551234', send: jest.fn(), endSession,
    });
    convo._callerVerified = true; // verification implies the claim was won
    const out = await convo._executeToolBounded('get_availability', {}, {});
    expect(out).toMatch(/superseded by a reconnect/i);
    expect(endSession).toHaveBeenCalled();
  });

  test('an UNVERIFIED session with NO call_log row (the sandbox path) keeps its tools', async () => {
    const builder = {};
    builder.where = jest.fn(() => builder);
    builder.first = jest.fn(async () => null); // no row at all
    db.mockImplementation(() => builder);
    const convo = new RelayConversation({
      callSid: 'CA-sandbox', sessionKey: 'nonce-SANDBOX', from: '+19415551234', send: jest.fn(), endSession: jest.fn(),
    });
    const out = await convo._executeToolBounded('definitely_not_a_tool', {}, {});
    expect(out).not.toMatch(/superseded/i);
  });

  test('a session that still OWNS the claim executes tools normally', async () => {
    const builder = {};
    builder.where = jest.fn(() => builder);
    builder.first = jest.fn(async () => ({ metadata: { relay_session_claim_owner: 'nonce-MINE' } }));
    db.mockImplementation(() => builder);
    const convo = new RelayConversation({
      callSid: 'CA-owned', sessionKey: 'nonce-MINE', from: '+19415551234', send: jest.fn(), endSession: jest.fn(),
    });
    const out = await convo._executeToolBounded('definitely_not_a_tool', {}, {});
    expect(out).not.toMatch(/superseded/i); // fence passed; normal tool handling follows
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

  // ⭐ A LIVE GETTER, NOT A SNAPSHOT. Verification (and the context upgrade it
  // brings) has its own bounded race and can publish AFTER the turn's ctx was
  // built — a first-turn "stop texting me" must not read a stale false.
  test('late-landing verification is visible to the ALREADY-BUILT tool ctx', () => {
    const convo = new RelayConversation({ callSid: 'CA-late', from: '+19415551234', send: jest.fn() });
    const ctx = convo._buildToolCtx();
    expect(ctx.callerVerified).toBe(false);
    expect(ctx.customerTier).toBe('redacted');
    expect(ctx.customerId).toBe(null);
    // The late publish (relay-context's verification race settling).
    convo._callerVerified = true;
    convo._callerContext = { customer: { id: 'c-9' }, tier: 'full', attested: true };
    expect(ctx.callerVerified).toBe(true);
    expect(ctx.customerTier).toBe('full');
    expect(ctx.customerId).toBe('c-9');
    expect(ctx.callerAttested).toBe(true);
  });
});
