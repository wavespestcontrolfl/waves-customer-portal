/**
 * Sandy slice 1, PR D — live-verification tests for the 5 new scenario
 * families added to server/fixtures/voice-relay-eval/scenarios.json
 * (mid-thought-pause, backchannel-vs-explicit-correction,
 * interruption-inside-amount-or-date, delayed-tool-response-changed-
 * instructions, mid-stream-disconnect-recovery).
 *
 * These new scenarios load through the REAL harness (services/eval/
 * voice-relay-replay's runScenario, the actual RelayConversation loop) with
 * a scripted (never live) model, exactly the way the existing "voice relay
 * eval — the harness" describe block in voice-relay-eval.test.js drives
 * scenarios. Each test here takes the ACTUAL fixture scenario (its real
 * caller, fixtures.toolResponses, and one of its real `expect` entries,
 * unmodified) and scripts a model reply that VIOLATES that one expectation,
 * confirming the harness actually reports the check as failed — proving the
 * check is not a deterministic expectation that can never fail.
 *
 * No live model or phone calls are made anywhere in this file.
 */

jest.mock('../services/ops-digest', () => ({ deliverOpsDigest: jest.fn(async ({ sendEmail }) => sendEmail()) }));
jest.mock('../services/ops-digest-fall-off', () => ({ retireIfClean: jest.fn(async () => 1) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => {
  const fn = jest.fn(() => { throw new Error('db called'); });
  fn.raw = jest.fn(() => { throw new Error('db.raw called'); });
  fn.transaction = jest.fn(() => { throw new Error('db.transaction called'); });
  fn.destroy = jest.fn();
  fn.fn = { now: () => 'now()' };
  return fn;
});
jest.mock('../services/lead-from-extraction', () => ({
  createLeadFromExtraction: jest.fn(async () => { throw new Error('capture floor called'); }),
  stampCustomerPreferredLanguage: jest.fn(async () => false),
}));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../services/voice-profile-distiller', () => ({ MAX_PROFILE_CHARS: 4000, getApprovedVoiceProfile: jest.fn(async () => null) }));
jest.mock('../services/twilio-failure-alerts', () => ({ maskSid: (s) => String(s || 'none') }));

const path = require('path');

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'voice-relay-eval', 'scenarios.json');

// The SDK double: a Messages CLASS so the harness can patch the shared
// prototype the way it does against the real SDK (same pattern as
// voice-relay-eval.test.js's "voice relay eval — the harness" block).
let script;
function mockSdk() {
  jest.doMock('@anthropic-ai/sdk', () => {
    class Messages {
      stream() {
        const next = script.shift();
        if (next && next.throwSync) throw next.throwSync;
        return {
          on() {},
          finalMessage: async () => {
            if (!next) throw new Error('script exhausted');
            if (next instanceof Error) throw next;
            return next;
          },
        };
      }
    }
    return function AnthropicMock() { return { messages: new Messages() }; };
  });
}

const toolUse = (name, input, id = 't1') => ({ content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' });
const say = (text) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });

function loadScenario(id) {
  // Fresh require each time (jest.resetModules() in beforeEach) so the real,
  // unmodified fixture scenario is used every test.
  const replay = require('../services/eval/voice-relay-replay');
  const scenario = replay.loadFixture(FIXTURE_PATH).scenarios.find((s) => s.id === id);
  if (!scenario) throw new Error(`fixture scenario not found: ${id}`);
  return { replay, scenario };
}

beforeEach(() => { jest.resetModules(); script = []; });
afterEach(() => { delete process.env.VOICE_RELAY_CONTEXT_ENABLED; });

describe('mid-thought-pause — tools_called_include can fail', () => {
  test('capture_lead never called ⇒ the real critical check fails, not just errors out', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('mid-thought-pause');
    const realCheck = scenario.expect.find((e) => e.check === 'tools_called_include');
    expect(realCheck).toBeTruthy();
    expect(realCheck.severity).toBe('critical');

    // Model never calls capture_lead on any of the 3 turns — just acks.
    script.push(say('Take your time.'), say('Got it, thanks for that.'), say('You too, bye now.'));
    const result = await replay.runScenario({ ...scenario, expect: [realCheck] });

    expect(result.error).toBeUndefined();
    const check = result.checks.find((c) => c.check === 'tools_called_include');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/capture_lead/);
    expect(result.status).toBe('fail');
  });
});

describe('backchannel-vs-explicit-correction — capture_lead_input_includes can fail on WRONG data, not just a missing call', () => {
  test('capture_lead is called validly, but with the pre-correction address ⇒ the real major check fails', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('backchannel-vs-explicit-correction');
    const realCheck = scenario.expect.find((e) => e.check === 'capture_lead_input_includes');
    expect(realCheck).toBeTruthy();
    expect(realCheck.value).toEqual({ address_line1: '88B Palm Harbor' });

    // Turn 1: ack, no tool. Turn 2 (backchannel "Mm-hmm"): ack, no tool.
    // Turn 3 (the barge-in correction to 88B): ack, no tool.
    // Turn 4 (email): capture_lead called VALIDLY (call_summary present, so
    // it is not `invalid` and counts) but with the STALE, uncorrected
    // address — this is the bug the check exists to catch.
    script.push(
      say('Sure, go ahead.'),
      say('Mm-hmm, go on.'),
      say('Got it, noted.'),
      toolUse('capture_lead', {
        call_summary: 'Wasp nest under the eaves',
        first_name: 'Carlos',
        last_name: 'Nunez',
        address_line1: '88 Palm Harbor Drive',
        city: 'Venice',
        email: 'carlos.nunez@example.com',
      }),
      say('Thanks, a Waves team member will follow up.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [realCheck] });

    expect(result.error).toBeUndefined();
    const captured = result.toolCalls.find((t) => t.name === 'capture_lead');
    expect(captured).toBeTruthy();
    expect(captured.ok).toBe(true);
    expect(captured.invalid).not.toBe(true);
    const check = result.checks.find((c) => c.check === 'capture_lead_input_includes');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/address_line1/);
    // This check is `severity: major` with no `adjudicated: true` in the
    // real fixture, so a lone miss here is non-blocking for the aggregate
    // scenario status (see scenarioStatus/`blocking` in voice-relay-replay.js)
    // — the check itself still failed and is visible in result.checks above.
    expect(result.status).toBe('pass');
  });
});

describe('interruption-inside-amount-or-date — spoken_never_matches can fail on the interrupted amount resurfacing', () => {
  test('the pre-interruption pest-control price is spoken again after the correction ⇒ the real critical check fails', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('interruption-inside-amount-or-date');
    const realCheck = scenario.expect.find((e) => e.check === 'spoken_never_matches');
    expect(realCheck).toBeTruthy();
    expect(realCheck.severity).toBe('critical');
    expect(realCheck.value.fromTurn).toBe(2);

    // Turn 1: ask pest-control pricing — model reads the real fixture price
    // ($129 quarterly, from fixtures.toolResponses.get_pricing) and speaks
    // it. That is fine on turn 1 (before the fromTurn:2 boundary).
    script.push(
      toolUse('get_pricing', { service: 'pest_control', home_sqft: 2000 }),
      say('Quarterly pest control is $129 per application.'),
      // Turn 2 (the barge-in correcting to lawn care): the bug — Sandy
      // re-speaks the OLD, interrupted pest-control amount instead of only
      // the corrected service's own price.
      say('Sure — to confirm, quarterly pest control was $129, and for lawn care let me check.'),
      say('All set, thanks.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [realCheck] });

    expect(result.error).toBeUndefined();
    const check = result.checks.find((c) => c.check === 'spoken_never_matches');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/129/);
    expect(result.status).toBe('fail');
  });
});

describe('delayed-tool-response-changed-instructions — tools_never_called and tools_performed_include can both fail on a stale booking', () => {
  test('request_booking is placed on the abandoned instruction, and request_reservice is never performed ⇒ both real critical checks fail', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('delayed-tool-response-changed-instructions');
    const neverCalled = scenario.expect.find((e) => e.check === 'tools_never_called');
    const performedInclude = scenario.expect.find((e) => e.check === 'tools_performed_include');
    expect(neverCalled).toBeTruthy();
    expect(neverCalled.value).toEqual(['request_booking']);
    expect(performedInclude).toBeTruthy();
    expect(performedInclude.value).toEqual(['request_reservice']);

    // Turn 1: ask to book the quarterly visit — model finds a slot.
    script.push(
      toolUse('find_slots', { city: 'Bradenton', when: 'next week' }),
      say('I found Tuesday at 1 PM — want me to request that?'),
      // Turn 2 (the caller changes their mind — cancel the booking, file a
      // re-service instead): the bug — Sandy ignores the new instruction and
      // places the booking on the abandoned slot anyway, never filing the
      // re-service the caller actually asked for.
      toolUse('request_booking', { slot_ref: 'S1' }, 't2'),
      say("All set — that's booked for Tuesday at 1 PM."),
      say('You are welcome, thanks for calling.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [neverCalled, performedInclude] });

    expect(result.error).toBeUndefined();
    expect(result.toolCalls.some((t) => t.name === 'request_booking')).toBe(true);
    expect(result.toolCalls.some((t) => t.name === 'request_reservice')).toBe(false);
    const neverCalledCheck = result.checks.find((c) => c.check === 'tools_never_called');
    const performedCheck = result.checks.find((c) => c.check === 'tools_performed_include');
    expect(neverCalledCheck.status).toBe('fail');
    expect(neverCalledCheck.detail).toMatch(/request_booking/);
    expect(performedCheck.status).toBe('fail');
    expect(performedCheck.detail).toMatch(/request_reservice/);
    expect(result.status).toBe('fail');
  });
});

describe('mid-stream-disconnect-recovery — tools_never_called and spoken_never_matches can both fail after a reconnect', () => {
  test('a re-placed booking attempt and a false "confirmed" claim after reconnect ⇒ both real critical checks fail', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('mid-stream-disconnect-recovery');
    const neverCalled = scenario.expect.find((e) => e.check === 'tools_never_called');
    const neverSpoken = scenario.expect.find((e) => e.check === 'spoken_never_matches');
    expect(neverCalled).toBeTruthy();
    expect(neverCalled.value).toEqual(['request_booking', 'find_slots', 'get_availability']);
    expect(neverSpoken).toBeTruthy();
    expect(neverSpoken.severity).toBe('critical');

    // The scenario seeds a resumed call (fixtures.resume) where the caller's
    // pending booking request was already placed, mid-reply, before the
    // socket dropped. On reconnect the caller asks whether it went through.
    // The bug — instead of reassuring without re-placing or over-claiming,
    // Sandy re-runs the slot search AND falsely claims it is "confirmed".
    script.push(
      toolUse('find_slots', { city: 'Bradenton', when: 'next week' }),
      say("Yes, that's confirmed — you're all set."),
      say("You're welcome, take care."),
    );
    const result = await replay.runScenario({ ...scenario, expect: [neverCalled, neverSpoken] });

    expect(result.error).toBeUndefined();
    expect(result.toolCalls.some((t) => t.name === 'find_slots')).toBe(true);
    const neverCalledCheck = result.checks.find((c) => c.check === 'tools_never_called');
    const neverSpokenCheck = result.checks.find((c) => c.check === 'spoken_never_matches');
    expect(neverCalledCheck.status).toBe('fail');
    expect(neverCalledCheck.detail).toMatch(/find_slots/);
    expect(neverSpokenCheck.status).toBe('fail');
    expect(neverSpokenCheck.detail).toMatch(/confirmed/);
    expect(result.status).toBe('fail');
  });
});

describe('mid-stream-disconnect-recovery — spoken_never_matches on "confirmed" must be negation-aware', () => {
  // The check exists to catch Sandy CLAIMING confirmation ("that's
  // confirmed") — see the sibling describe block above. It must NOT also
  // fire on a correct reply that explicitly DENIES confirmation ("it is not
  // confirmed yet"), which is the reassurance this scenario actually wants.
  test('an explicit denial of confirmation passes the check', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('mid-stream-disconnect-recovery');
    const neverSpoken = scenario.expect.find((e) => e.check === 'spoken_never_matches');
    expect(neverSpoken).toBeTruthy();
    expect(neverSpoken.severity).toBe('critical');

    script.push(
      say('Your request is pending office review right now; nothing is confirmed yet.'),
      say('You are welcome, take care.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [neverSpoken] });

    expect(result.error).toBeUndefined();
    const check = result.checks.find((c) => c.check === 'spoken_never_matches');
    expect(check.status).toBe('pass');
    expect(result.status).toBe('pass');
  });

  test('a real, unnegated confirmation claim still fails the check', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('mid-stream-disconnect-recovery');
    const neverSpoken = scenario.expect.find((e) => e.check === 'spoken_never_matches');
    expect(neverSpoken).toBeTruthy();

    script.push(
      say("Yes, that's confirmed — you're all set."),
      say('You are welcome, take care.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [neverSpoken] });

    expect(result.error).toBeUndefined();
    const check = result.checks.find((c) => c.check === 'spoken_never_matches');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/confirmed/);
    expect(result.status).toBe('fail');
  });
});
