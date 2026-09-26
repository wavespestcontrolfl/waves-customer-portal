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

describe('mid-thought-pause — a premature turn-1 capture_lead fails, even with a correct later capture', () => {
  test('capture_lead guessed on the unfinished turn-1 fragment, then a correct capture on turn 2 ⇒ both real critical checks fail', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('mid-thought-pause');
    const atMost = scenario.expect.find((e) => e.check === 'tools_called_at_most');
    const notBefore = scenario.expect.find((e) => e.check === 'tool_not_called_before_turn');
    expect(atMost).toBeTruthy();
    expect(atMost.value).toEqual({ capture_lead: 1 });
    expect(atMost.severity).toBe('critical');
    expect(notBefore).toBeTruthy();
    expect(notBefore.value).toEqual({ tool: 'capture_lead', turn: 2 });
    expect(notBefore.severity).toBe('critical');

    // Turn 1 is an unfinished fragment with no usable info (fixture turns[0])
    // — the bug: the model guesses at a capture anyway (toolUse, then a `say`
    // to close out turn 1's model rounds). Turn 2 then supplies the real
    // details and the model captures again, correctly this time (toolUse +
    // say closes turn 2). Turn 3 is a plain ack.
    script.push(
      toolUse('capture_lead', { call_summary: 'Caller paused mid-thought' }),
      say('Take your time.'),
      toolUse('capture_lead', {
        call_summary: 'Wasp problem out back',
        first_name: 'Priya',
        last_name: 'Fenn',
        address_line1: '210 Oak Terrace',
        city: 'Nokomis',
        email: 'priya.fenn@example.com',
      }, 't2'),
      say('Thanks, a Waves team member will follow up.'),
      say('You are welcome, take care.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [atMost, notBefore] });

    expect(result.error).toBeUndefined();
    expect(result.toolCalls.filter((t) => t.name === 'capture_lead')).toHaveLength(2);
    const atMostCheck = result.checks.find((c) => c.check === 'tools_called_at_most');
    const notBeforeCheck = result.checks.find((c) => c.check === 'tool_not_called_before_turn');
    expect(atMostCheck.status).toBe('fail');
    expect(atMostCheck.detail).toMatch(/capture_lead called 2× \(max 1\)/);
    expect(notBeforeCheck.status).toBe('fail');
    expect(notBeforeCheck.detail).toMatch(/capture_lead called on caller turn 1, before turn 2/);
    expect(result.status).toBe('fail');
  });

  test('a SOLE premature turn-1 capture (never retried on turn 2) still fails tool_not_called_before_turn even though it never exceeds the max-1 cap', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('mid-thought-pause');
    const notBefore = scenario.expect.find((e) => e.check === 'tool_not_called_before_turn');
    expect(notBefore).toBeTruthy();

    // Exactly ONE capture_lead call total, but placed on turn 1's unfinished
    // fragment — tools_called_at_most (max 1) alone would pass this; the
    // turn-scoped prohibition is what actually catches it. toolUse keeps
    // turn 1's model rounds going, so a `say` is needed to close it out.
    script.push(
      toolUse('capture_lead', { call_summary: 'Caller paused mid-thought' }),
      say('Got it, thanks for that.'),
      say('Noted.'),
      say('You too, bye now.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [notBefore] });

    expect(result.error).toBeUndefined();
    expect(result.toolCalls.filter((t) => t.name === 'capture_lead')).toHaveLength(1);
    const check = result.checks.find((c) => c.check === 'tool_not_called_before_turn');
    expect(check.status).toBe('fail');
    expect(result.status).toBe('fail');
  });

  test('capture_lead called only once, after turn 2, passes both real checks', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('mid-thought-pause');
    const atMost = scenario.expect.find((e) => e.check === 'tools_called_at_most');
    const notBefore = scenario.expect.find((e) => e.check === 'tool_not_called_before_turn');

    script.push(
      say('Take your time.'),
      toolUse('capture_lead', {
        call_summary: 'Wasp problem out back',
        first_name: 'Priya',
        last_name: 'Fenn',
        address_line1: '210 Oak Terrace',
        city: 'Nokomis',
        email: 'priya.fenn@example.com',
      }),
      say('Thanks, a Waves team member will follow up.'),
      say('You are welcome, take care.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [atMost, notBefore] });

    expect(result.error).toBeUndefined();
    expect(result.checks.find((c) => c.check === 'tools_called_at_most').status).toBe('pass');
    expect(result.checks.find((c) => c.check === 'tool_not_called_before_turn').status).toBe('pass');
    expect(result.status).toBe('pass');
  });
});

describe('mid-thought-pause — capture_lead_input_includes can fail on WRONG data, not just a missing call', () => {
  test('capture_lead is called validly, but with the wrong street ⇒ the real critical check fails (bumped from major)', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('mid-thought-pause');
    const realCheck = scenario.expect.find((e) => e.check === 'capture_lead_input_includes');
    expect(realCheck).toBeTruthy();
    expect(realCheck.value).toEqual({ first_name: 'Priya', last_name: 'Fenn', address_line1: 'Oak Terrace' });
    // Bumped critical: a captured lead with wrong data reaching the office is
    // exactly the miss the CLASS sweep closed — this check must now block.
    expect(realCheck.severity).toBe('critical');

    // Turn 1: wait through the pause, no tool. Turn 2: the model captures the
    // real fixture's name and email but the WRONG street — the bug the check
    // exists to catch even though the call itself succeeds. Turn 3: ack.
    script.push(
      say('Take your time.'),
      toolUse('capture_lead', {
        call_summary: 'Wasp problem out back',
        first_name: 'Priya',
        last_name: 'Fenn',
        address_line1: '210 Main Street',
        city: 'Nokomis',
        email: 'priya.fenn@example.com',
      }),
      say('Thanks, a Waves team member will follow up.'),
      say('You are welcome, take care.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [realCheck] });

    expect(result.error).toBeUndefined();
    const captured = result.toolCalls.find((t) => t.name === 'capture_lead');
    expect(captured).toBeTruthy();
    expect(captured.ok).toBe(true);
    const check = result.checks.find((c) => c.check === 'capture_lead_input_includes');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/address_line1/);
    expect(result.status).toBe('fail');
  });

  test('capture_lead called with the correct name and street passes the check', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('mid-thought-pause');
    const realCheck = scenario.expect.find((e) => e.check === 'capture_lead_input_includes');
    expect(realCheck).toBeTruthy();

    script.push(
      say('Take your time.'),
      toolUse('capture_lead', {
        call_summary: 'Wasp problem out back',
        first_name: 'Priya',
        last_name: 'Fenn',
        address_line1: '210 Oak Terrace',
        city: 'Nokomis',
        email: 'priya.fenn@example.com',
      }),
      say('Thanks, a Waves team member will follow up.'),
      say('You are welcome, take care.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [realCheck] });

    expect(result.error).toBeUndefined();
    const check = result.checks.find((c) => c.check === 'capture_lead_input_includes');
    expect(check.status).toBe('pass');
    expect(result.status).toBe('pass');
  });
});

describe('backchannel-vs-explicit-correction — capture_lead_input_includes can fail on WRONG data, not just a missing call', () => {
  test('capture_lead is called validly, but with the pre-correction address ⇒ the real critical check fails, and blocks the scenario', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('backchannel-vs-explicit-correction');
    const realCheck = scenario.expect.find((e) => e.check === 'capture_lead_input_includes');
    expect(realCheck).toBeTruthy();
    expect(realCheck.value).toEqual({ address_line1: '88B Palm Harbor' });
    expect(realCheck.severity).toBe('critical');

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
    // This check is `severity: critical` in the real fixture (bumped from
    // `major` — a stale, uncorrected address reaching the office is exactly
    // the kind of miss that must block the run, not just lower its quality
    // score), so this lone miss is now BLOCKING for the aggregate scenario
    // status (see scenarioStatus/`blocking` in voice-relay-replay.js).
    expect(result.status).toBe('fail');
  });
});

describe('backchannel-vs-explicit-correction — spoken_never_matches (onTurn: 2) can fail on treating the backchannel as a restart cue', () => {
  test('Sandy asks the caller to repeat/restart in response to a bare "Mm-hmm" ⇒ the real critical check fails, even though she recovers by turn 4', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('backchannel-vs-explicit-correction');
    const onTurnChecks = scenario.expect.filter((e) => e.check === 'spoken_never_matches' && e.value && e.value.onTurn === 2);
    expect(onTurnChecks).toHaveLength(1);
    const realCheck = onTurnChecks[0];
    expect(realCheck.severity).toBe('critical');

    // Turn 1: ack, no tool. Turn 2 (the bare backchannel "Mm-hmm"): the bug —
    // Sandy treats it as a cue to restart the intake, instead of continuing
    // through the backchannel unchanged. Turn 3 (the real fixture's own
    // barge-in, unmodified) cuts off whatever Sandy is still saying at the
    // halfway word mark — the harness grades only what was actually HEARD,
    // never the full planned text — so the restart cue is padded with
    // trailing filler to land inside that first half. Turn 3's correction
    // and turn 4 (email + capture) both go fine afterward — she recovers
    // with the right, corrected address, but the turn-2 restart cue already
    // broke this check (see the Codex finding this test exists to pin: a
    // model that restarts on turn 2 then recovers must still fail).
    script.push(
      say('Sure, go ahead.'),
      say('Start over, one moment, sorry about that.'),
      say('Got it, noted.'),
      toolUse('capture_lead', {
        call_summary: 'Wasp nest under the eaves',
        first_name: 'Carlos',
        last_name: 'Nunez',
        address_line1: '88B Palm Harbor Drive',
        city: 'Venice',
        email: 'carlos.nunez@example.com',
      }),
      say('Thanks, a Waves team member will follow up.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [realCheck] });

    expect(result.error).toBeUndefined();
    const check = result.checks.find((c) => c.check === 'spoken_never_matches');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/start over/i);
    expect(check.detail).toMatch(/on caller turn 2/);
    expect(result.status).toBe('fail');
  });

  test('a plain continuation through the backchannel, with the barge-in correction honored later, passes the check', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('backchannel-vs-explicit-correction');
    const onTurnChecks = scenario.expect.filter((e) => e.check === 'spoken_never_matches' && e.value && e.value.onTurn === 2);
    const realCheck = onTurnChecks[0];
    expect(realCheck).toBeTruthy();

    script.push(
      say('Sure, go ahead.'),
      say('Mm-hmm, go on.'),
      say('Got it, noted.'),
      toolUse('capture_lead', {
        call_summary: 'Wasp nest under the eaves',
        first_name: 'Carlos',
        last_name: 'Nunez',
        address_line1: '88B Palm Harbor Drive',
        city: 'Venice',
        email: 'carlos.nunez@example.com',
      }),
      say('Thanks, a Waves team member will follow up.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [realCheck] });

    expect(result.error).toBeUndefined();
    const check = result.checks.find((c) => c.check === 'spoken_never_matches');
    expect(check.status).toBe('pass');
    expect(result.status).toBe('pass');
  });

  test('re-asking a field the caller already gave (their name) on turn 2 also fails the check', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('backchannel-vs-explicit-correction');
    const onTurnChecks = scenario.expect.filter((e) => e.check === 'spoken_never_matches' && e.value && e.value.onTurn === 2);
    const realCheck = onTurnChecks[0];
    expect(realCheck).toBeTruthy();

    // Same halfway-cutoff mechanic as the sibling test above: the re-ask
    // phrase is padded with trailing filler so it lands inside what the
    // barge-in actually leaves "heard".
    script.push(
      say('Sure, go ahead.'),
      say("What's your name, one moment please."),
      say('Got it, noted.'),
      toolUse('capture_lead', {
        call_summary: 'Wasp nest under the eaves',
        first_name: 'Carlos',
        last_name: 'Nunez',
        address_line1: '88B Palm Harbor Drive',
        city: 'Venice',
        email: 'carlos.nunez@example.com',
      }),
      say('Thanks, a Waves team member will follow up.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [realCheck] });

    expect(result.error).toBeUndefined();
    const check = result.checks.find((c) => c.check === 'spoken_never_matches');
    expect(check.status).toBe('fail');
    expect(result.status).toBe('fail');
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

describe('interruption-inside-amount-or-date — tool_input_includes can fail when the corrected lookup never happens', () => {
  test('the model never calls get_pricing for lawn_care after the correction ⇒ the real critical check fails', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('interruption-inside-amount-or-date');
    const realCheck = scenario.expect.find((e) => e.check === 'tool_input_includes');
    expect(realCheck).toBeTruthy();
    expect(realCheck.severity).toBe('critical');
    expect(realCheck.value).toEqual({ tool: 'get_pricing', input: { service: 'lawn_care' }, fromTurn: 2 });

    // Turn 1: ask pest-control pricing — get_pricing(pest_control) runs fine.
    // Turn 2 (the barge-in correcting to lawn care): the bug — Sandy never
    // re-quotes with get_pricing(lawn_care); she just acks the correction
    // and moves on without the corrected lookup the caller actually needs.
    script.push(
      toolUse('get_pricing', { service: 'pest_control', home_sqft: 2000 }),
      say('Quarterly pest control is $129 per application.'),
      say('Got it, noted — anything else?'),
      say('All set, thanks.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [realCheck] });

    expect(result.error).toBeUndefined();
    expect(result.toolCalls.some((t) => t.name === 'get_pricing' && t.input.service === 'lawn_care')).toBe(false);
    const check = result.checks.find((c) => c.check === 'tool_input_includes');
    expect(check.status).toBe('fail');
    expect(result.status).toBe('fail');
  });

  test('the model DOES call get_pricing(lawn_care) after the correction ⇒ the real critical check passes', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('interruption-inside-amount-or-date');
    const realCheck = scenario.expect.find((e) => e.check === 'tool_input_includes');
    expect(realCheck).toBeTruthy();

    script.push(
      toolUse('get_pricing', { service: 'pest_control', home_sqft: 2000 }),
      say('Quarterly pest control is $129 per application.'),
      toolUse('get_pricing', { service: 'lawn_care', lawn_sqft: 5000 }, 't2'),
      say('For lawn care: enhanced $119 per application, premium $99 per application.'),
      say('All set, thanks.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [realCheck] });

    expect(result.error).toBeUndefined();
    const check = result.checks.find((c) => c.check === 'tool_input_includes');
    expect(check.status).toBe('pass');
    expect(result.status).toBe('pass');
  });
});

describe('interruption-inside-amount-or-date — the corrected lawn price must be spoken in the right unit (per application, never per month)', () => {
  test('speaking the corrected lawn price as "per month" ⇒ the real critical check fails', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('interruption-inside-amount-or-date');
    const realCheck = scenario.expect.find((e) => e.check === 'spoken_never_matches' && (e.value.patterns || []).includes('\\bper month\\b'));
    expect(realCheck).toBeTruthy();
    expect(realCheck.severity).toBe('critical');
    expect(realCheck.value.fromTurn).toBe(2);

    script.push(
      toolUse('get_pricing', { service: 'pest_control', home_sqft: 2000 }),
      say('Quarterly pest control is $129 per application.'),
      // Turn 2 (the correction to lawn care): the bug — production lawn
      // pricing is billed per application, and Sandy must never speak it as
      // a per-month figure.
      toolUse('get_pricing', { service: 'lawn_care', lawn_sqft: 5000 }, 't2'),
      say('For lawn care: enhanced $119 per month, premium $99 per month.'),
      say('All set, thanks.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [realCheck] });

    expect(result.error).toBeUndefined();
    const check = result.checks.find((c) => c.check === 'spoken_never_matches');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/per month/i);
    expect(result.status).toBe('fail');
  });

  test('speaking the corrected lawn price as "per application" passes the check', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('interruption-inside-amount-or-date');
    const realCheck = scenario.expect.find((e) => e.check === 'spoken_never_matches' && (e.value.patterns || []).includes('\\bper month\\b'));
    expect(realCheck).toBeTruthy();

    script.push(
      toolUse('get_pricing', { service: 'pest_control', home_sqft: 2000 }),
      say('Quarterly pest control is $129 per application.'),
      toolUse('get_pricing', { service: 'lawn_care', lawn_sqft: 5000 }, 't2'),
      say('For lawn care: enhanced $119 per application, premium $99 per application.'),
      say('All set, thanks.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [realCheck] });

    expect(result.error).toBeUndefined();
    const check = result.checks.find((c) => c.check === 'spoken_never_matches');
    expect(check.status).toBe('pass');
    expect(result.status).toBe('pass');
  });
});

describe('interruption-inside-amount-or-date — the corrected lawn price figure must actually be spoken', () => {
  test('the corrected lawn price is never spoken (Sandy only acks the correction) ⇒ the real critical check fails', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('interruption-inside-amount-or-date');
    const realCheck = scenario.expect.find((e) => e.check === 'spoken_matches_any');
    expect(realCheck).toBeTruthy();
    expect(realCheck.severity).toBe('critical');
    expect(realCheck.value.fromTurn).toBe(2);

    script.push(
      toolUse('get_pricing', { service: 'pest_control', home_sqft: 2000 }),
      say('Quarterly pest control is $129 per application.'),
      toolUse('get_pricing', { service: 'lawn_care', lawn_sqft: 5000 }, 't2'),
      say('Got it, noted — anything else?'),
      say('All set, thanks.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [realCheck] });

    expect(result.error).toBeUndefined();
    const check = result.checks.find((c) => c.check === 'spoken_matches_any');
    expect(check.status).toBe('fail');
    expect(result.status).toBe('fail');
  });

  test('speaking one of the corrected lawn figures ($119 or $99) passes the check', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('interruption-inside-amount-or-date');
    const realCheck = scenario.expect.find((e) => e.check === 'spoken_matches_any');
    expect(realCheck).toBeTruthy();

    script.push(
      toolUse('get_pricing', { service: 'pest_control', home_sqft: 2000 }),
      say('Quarterly pest control is $129 per application.'),
      toolUse('get_pricing', { service: 'lawn_care', lawn_sqft: 5000 }, 't2'),
      say('For lawn care: enhanced $119 per application, premium $99 per application.'),
      say('All set, thanks.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [realCheck] });

    expect(result.error).toBeUndefined();
    const check = result.checks.find((c) => c.check === 'spoken_matches_any');
    expect(check.status).toBe('pass');
    expect(result.status).toBe('pass');
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

describe('mid-stream-disconnect-recovery — spoken_matches_any reassurance can fail when Sandy never reassures (bumped from major)', () => {
  test('a reply that never confirms the pending status is on file ⇒ the real critical check fails', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('mid-stream-disconnect-recovery');
    const realCheck = scenario.expect.find((e) => e.check === 'spoken_matches_any');
    expect(realCheck).toBeTruthy();
    // Bumped critical: the whole point of recovery is the reassurance — a
    // resumed call that never says the request is pending/being reviewed is
    // exactly the miss the CLASS sweep closed, and it must now block.
    expect(realCheck.severity).toBe('critical');

    script.push(
      say('Okay, sounds good. Have a nice day.'),
      say('You are welcome, take care.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [realCheck] });

    expect(result.error).toBeUndefined();
    const check = result.checks.find((c) => c.check === 'spoken_matches_any');
    expect(check.status).toBe('fail');
    expect(result.status).toBe('fail');
  });

  test('reassuring that the request is pending office review passes the check', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('mid-stream-disconnect-recovery');
    const realCheck = scenario.expect.find((e) => e.check === 'spoken_matches_any');
    expect(realCheck).toBeTruthy();

    script.push(
      say('Your request is pending office review right now; nothing is confirmed yet.'),
      say('You are welcome, take care.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [realCheck] });

    expect(result.error).toBeUndefined();
    const check = result.checks.find((c) => c.check === 'spoken_matches_any');
    expect(check.status).toBe('pass');
    expect(result.status).toBe('pass');
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

describe('mid-stream-disconnect-recovery — commitment_requires_receipt no longer false-fails the correct recovery reply', () => {
  // The bug this fix closes: fixtures.resume seeds the RESUMED SEGMENT as
  // text only — no request_booking ever actually ran through this replay,
  // so before the fix, the mandatory always-on commitment_requires_receipt
  // check found no receipt to back "a Waves team member will confirm" and
  // false-failed a perfectly correct reply. fixtures.resume.priorReceipts
  // seeds the pre-drop receipt the segmentsText's own prose already claims.
  test('the correct "pending, a team member will confirm" recovery reply passes commitment_requires_receipt', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('mid-stream-disconnect-recovery');
    expect(scenario.fixtures.resume.priorReceipts).toEqual(['request_booking']);
    const receiptCheck = { check: 'commitment_requires_receipt', value: true, severity: 'critical', adjudicated: true };

    script.push(
      say('Your request is pending office review; a Waves team member will follow up to confirm the final time.'),
      say('You are welcome, take care.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [receiptCheck] });

    expect(result.error).toBeUndefined();
    const check = result.checks.find((c) => c.check === 'commitment_requires_receipt');
    expect(check.status).toBe('pass');
    expect(result.status).toBe('pass');
  });

  test('a false "confirmed" claim with no real receipt still fails every OTHER check even though the seeded receipt backs the promise itself', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('mid-stream-disconnect-recovery');
    const neverSpoken = scenario.expect.find((e) => e.check === 'spoken_never_matches');
    const receiptCheck = { check: 'commitment_requires_receipt', value: true, severity: 'critical', adjudicated: true };

    script.push(
      say("Yes, that's confirmed — a team member will follow up too."),
      say('You are welcome, take care.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [neverSpoken, receiptCheck] });

    expect(result.error).toBeUndefined();
    // The seeded receipt backs the (still-present) follow-up promise, so
    // commitment_requires_receipt itself passes — but the false completion
    // claim is caught by spoken_never_matches regardless, and the scenario
    // still fails overall.
    expect(result.checks.find((c) => c.check === 'commitment_requires_receipt').status).toBe('pass');
    expect(result.checks.find((c) => c.check === 'spoken_never_matches').status).toBe('fail');
    expect(result.status).toBe('fail');
  });
});

describe('mid-stream-disconnect-recovery — the false-completion prohibition now also covers "scheduled" and similar completion claims', () => {
  test('a false "scheduled for <day>" claim after reconnect fails the check', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('mid-stream-disconnect-recovery');
    const neverSpoken = scenario.expect.find((e) => e.check === 'spoken_never_matches');
    expect(neverSpoken).toBeTruthy();
    expect(neverSpoken.value[0]).toMatch(/scheduled/);

    script.push(
      say("Yes, that's scheduled for Tuesday at 1 PM."),
      say("You're welcome, take care."),
    );
    const result = await replay.runScenario({ ...scenario, expect: [neverSpoken] });

    expect(result.error).toBeUndefined();
    const check = result.checks.find((c) => c.check === 'spoken_never_matches');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/scheduled/);
    expect(result.status).toBe('fail');
  });

  // Negation-aware, the same way "confirmed" already is (see the sibling
  // describe block above) — "not scheduled yet" is exactly the correct
  // recovery reassurance this scenario wants, and must never fail on it.
  test('"not scheduled yet" — a correct, negated reply — passes the check', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('mid-stream-disconnect-recovery');
    const neverSpoken = scenario.expect.find((e) => e.check === 'spoken_never_matches');
    expect(neverSpoken).toBeTruthy();

    script.push(
      say("It's pending office review — not scheduled yet. A team member will confirm."),
      say("You're welcome, take care."),
    );
    const result = await replay.runScenario({ ...scenario, expect: [neverSpoken] });

    expect(result.error).toBeUndefined();
    const check = result.checks.find((c) => c.check === 'spoken_never_matches');
    expect(check.status).toBe('pass');
    expect(result.status).toBe('pass');
  });
});

describe('interruption-inside-amount-or-date — "per application" wording is itself required, not just the bare price figure', () => {
  test('speaking the corrected price with NO "per application" wording ⇒ the real critical check fails', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('interruption-inside-amount-or-date');
    const realCheck = scenario.expect.find((e) => e.check === 'spoken_matches_any');
    expect(realCheck).toBeTruthy();
    expect(realCheck.severity).toBe('critical');

    script.push(
      toolUse('get_pricing', { service: 'pest_control', home_sqft: 2000 }),
      say('Quarterly pest control is $129 per application.'),
      toolUse('get_pricing', { service: 'lawn_care', lawn_sqft: 5000 }, 't2'),
      // The bug this fix closes: the bare price figure alone, with no unit
      // wording at all — easily heard as a flat one-time fee.
      say('For lawn care: enhanced is $119, premium is $99.'),
      say('All set, thanks.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [realCheck] });

    expect(result.error).toBeUndefined();
    const check = result.checks.find((c) => c.check === 'spoken_matches_any');
    expect(check.status).toBe('fail');
    expect(result.status).toBe('fail');
  });

  test('speaking the corrected price WITH "per application" wording passes the check', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('interruption-inside-amount-or-date');
    const realCheck = scenario.expect.find((e) => e.check === 'spoken_matches_any');
    expect(realCheck).toBeTruthy();

    script.push(
      toolUse('get_pricing', { service: 'pest_control', home_sqft: 2000 }),
      say('Quarterly pest control is $129 per application.'),
      toolUse('get_pricing', { service: 'lawn_care', lawn_sqft: 5000 }, 't2'),
      say('For lawn care: enhanced $119 per application, premium $99 per application.'),
      say('All set, thanks.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [realCheck] });

    expect(result.error).toBeUndefined();
    const check = result.checks.find((c) => c.check === 'spoken_matches_any');
    expect(check.status).toBe('pass');
    expect(result.status).toBe('pass');
  });
});

describe('interruption-inside-amount-or-date — the monthly-wording prohibition now covers equivalent phrasings, not just literal "per month"', () => {
  test('"a month" wording fails the check', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('interruption-inside-amount-or-date');
    const realCheck = scenario.expect.find((e) => e.check === 'spoken_never_matches' && (e.value.patterns || []).includes('\\ba month\\b'));
    expect(realCheck).toBeTruthy();
    expect(realCheck.severity).toBe('critical');

    script.push(
      toolUse('get_pricing', { service: 'pest_control', home_sqft: 2000 }),
      say('Quarterly pest control is $129 per application.'),
      toolUse('get_pricing', { service: 'lawn_care', lawn_sqft: 5000 }, 't2'),
      say('For lawn care: enhanced is $119 a month, premium is $99 a month.'),
      say('All set, thanks.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [realCheck] });

    expect(result.error).toBeUndefined();
    const check = result.checks.find((c) => c.check === 'spoken_never_matches');
    expect(check.status).toBe('fail');
    expect(result.status).toBe('fail');
  });

  test('"/mo" shorthand fails the check', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('interruption-inside-amount-or-date');
    const realCheck = scenario.expect.find((e) => e.check === 'spoken_never_matches' && (e.value.patterns || []).includes('/mo\\b'));
    expect(realCheck).toBeTruthy();

    script.push(
      toolUse('get_pricing', { service: 'pest_control', home_sqft: 2000 }),
      say('Quarterly pest control is $129 per application.'),
      toolUse('get_pricing', { service: 'lawn_care', lawn_sqft: 5000 }, 't2'),
      say('For lawn care: enhanced is $119/mo, premium is $99/mo.'),
      say('All set, thanks.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [realCheck] });

    expect(result.error).toBeUndefined();
    const check = result.checks.find((c) => c.check === 'spoken_never_matches');
    expect(check.status).toBe('fail');
    expect(result.status).toBe('fail');
  });

  test('"per application" wording (never a monthly form) still passes the check', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('interruption-inside-amount-or-date');
    const realCheck = scenario.expect.find((e) => e.check === 'spoken_never_matches' && (e.value.patterns || []).includes('\\ba month\\b'));
    expect(realCheck).toBeTruthy();

    script.push(
      toolUse('get_pricing', { service: 'pest_control', home_sqft: 2000 }),
      say('Quarterly pest control is $129 per application.'),
      toolUse('get_pricing', { service: 'lawn_care', lawn_sqft: 5000 }, 't2'),
      say('For lawn care: enhanced $119 per application, premium $99 per application.'),
      say('All set, thanks.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [realCheck] });

    expect(result.error).toBeUndefined();
    const check = result.checks.find((c) => c.check === 'spoken_never_matches');
    expect(check.status).toBe('pass');
    expect(result.status).toBe('pass');
  });
});

describe('delayed-tool-response-changed-instructions — tool_input_includes catches the wrong service lane on request_reservice', () => {
  test('request_reservice filed with lane: lawn (the wrong service) ⇒ the real critical check fails', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('delayed-tool-response-changed-instructions');
    const realCheck = scenario.expect.find((e) => e.check === 'tool_input_includes');
    expect(realCheck).toBeTruthy();
    expect(realCheck.value).toEqual({ tool: 'request_reservice', input: { lane: 'pest', issue: 'ant' } });
    expect(realCheck.severity).toBe('critical');

    script.push(
      toolUse('find_slots', { city: 'Bradenton', when: 'next week' }),
      say('I found Tuesday at 1 PM — want me to request that?'),
      // The bug this check exists to catch: the fixture's request_reservice
      // answer is unconditioned (it accepts any lane), so a wrong-lane call
      // still succeeds live — only this check catches the input itself.
      toolUse('request_reservice', { lane: 'lawn', issue: 'ants back in the yard' }, 't2'),
      say('Filed — a Waves team member will follow up.'),
      say('You are welcome, thanks for calling.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [realCheck] });

    expect(result.error).toBeUndefined();
    const call = result.toolCalls.find((t) => t.name === 'request_reservice');
    expect(call).toBeTruthy();
    expect(call.ok).toBe(true);
    const check = result.checks.find((c) => c.check === 'tool_input_includes');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/lane/);
    expect(result.status).toBe('fail');
  });

  test('request_reservice filed with lane: pest and an ant issue passes the check', async () => {
    mockSdk();
    const { replay, scenario } = loadScenario('delayed-tool-response-changed-instructions');
    const realCheck = scenario.expect.find((e) => e.check === 'tool_input_includes');
    expect(realCheck).toBeTruthy();

    script.push(
      toolUse('find_slots', { city: 'Bradenton', when: 'next week' }),
      say('I found Tuesday at 1 PM — want me to request that?'),
      toolUse('request_reservice', { lane: 'pest', issue: 'ants back in the kitchen' }, 't2'),
      say('Filed — a Waves team member will follow up.'),
      say('You are welcome, thanks for calling.'),
    );
    const result = await replay.runScenario({ ...scenario, expect: [realCheck] });

    expect(result.error).toBeUndefined();
    const check = result.checks.find((c) => c.check === 'tool_input_includes');
    expect(check.status).toBe('pass');
    expect(result.status).toBe('pass');
  });
});
