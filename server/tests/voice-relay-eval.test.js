/**
 * Voice relay conversation eval — the harness (services/eval/voice-relay-replay)
 * and the judge (services/eval/voice-relay-judge).
 *
 * The harness runs the LIVE RelayConversation loop with the world around it
 * fixed by a fixture: every `expect` key, the severity tiers, the judge's
 * fallback rule, the fixture lint, and the safety properties — end() never
 * runs, the db is never touched — are pinned here.
 */

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

// ── Canned records for the check-level tests (no conversation involved) ────

function record({ agent = [], tools = [], endSession = null, order = null } = {}) {
  // order: an explicit event list [{ kind, text|name, turn }]; otherwise agent
  // utterances first, then tool calls, all on turn 1.
  const events = [];
  const push = (e) => { events.push({ ...e, index: events.length }); return events[events.length - 1]; };
  if (order) for (const e of order) push({ turn: 1, ok: e.kind === 'tool' ? e.ok !== false : undefined, receipt: e.kind === 'tool' ? e.receipt === true : undefined, ...e });
  else {
    for (const text of agent) push({ kind: 'agent', text, turn: 1 });
    for (const t of tools) push({ kind: 'tool', name: t.name, input: t.input || {}, text: t.text || 'ok', ok: t.ok !== false, receipt: t.receipt === true, invalid: t.invalid === true, turn: 1 });
  }
  return { events, toolCalls: events.filter((e) => e.kind === 'tool'), spoken: events.filter((e) => e.kind === 'agent').map((e) => e.text), endSession, language: 'en' };
}

const exp = (check, value, severity = 'major', adjudicated = false) => ({ check, value, severity, adjudicated });

describe('voice relay eval — fixture lint', () => {
  const replay = require('../services/eval/voice-relay-replay');

  test('the shipped fixture lints clean, has 34 scenarios and a spec on each', () => {
    const fixture = replay.loadFixture(FIXTURE_PATH);
    expect(fixture.schemaVersion).toBe(replay.SCHEMA_VERSION);
    expect(fixture.scenarios).toHaveLength(34);
    expect(replay.lintFixture(fixture)).toEqual([]);
    // A recording or a wrong number never earns a scheduling lookup.
    for (const id of ['robocall', 'wrong-number']) expect(fixture.scenarios.find((s) => s.id === id).allowedTools).toEqual(['capture_lead']);
    for (const s of fixture.scenarios) {
      expect(s.spec).toBeTruthy();
      expect(s.allowedTools.length).toBeGreaterThan(0);
      expect(s.expect.length).toBeGreaterThan(0);
      for (const e of s.expect) expect(replay.SEVERITIES).toContain(e.severity);
    }
    // Synthetic callers only: 555 numbers and example.com emails.
    const raw = JSON.stringify(fixture);
    expect(raw).not.toMatch(/941[- ]?(?!555)\d{3}[- ]?\d{4}/);
    expect(raw).not.toMatch(/@(?!example\.com)[a-z0-9.-]+\.[a-z]{2,}/i);
  });

  test('reports every problem: duplicate ids, no caller turn, missing spec, unknown tool, missing severity, bad regex, unknown check, unknown gate', () => {
    const good = {
      id: 'ok-one', language: 'en', gates: {}, allowedTools: ['capture_lead'], caller: { from: '+19415550100', verified: true, context: null }, fixtures: {},
      turns: [{ caller: 'hi' }], spec: { required_facts: [] }, expect: [exp('tools_called_include', ['capture_lead'], 'major')],
    };
    const fixture = {
      schemaVersion: replay.SCHEMA_VERSION,
      scenarios: [
        good,
        { ...good },
        { ...good, id: 'no-turn', turns: [] },
        { ...good, id: 'no-spec', spec: undefined },
        { ...good, id: 'bad-tool', expect: [exp('tools_called_include', ['launch_missiles'])] },
        { ...good, id: 'no-sev', expect: [{ check: 'tools_called_include', value: ['capture_lead'] }] },
        { ...good, id: 'bad-regex', expect: [exp('spoken_never_matches', ['(unclosed'])] },
        { ...good, id: 'bad-check', expect: [exp('spoken_is_polite', true)] },
        { ...good, id: 'bad-gate', gates: { teleport: true } },
        { ...good, id: 'string-gate', gates: { context: 'true' } },
        { ...good, id: 'no-allowlist', allowedTools: [] },
        { ...good, id: 'bad-allowlist', allowedTools: ['launch_missiles'] },
        { ...good, id: 'expects-outside', allowedTools: ['find_slots'] },
        { ...good, id: 'bad-when', fixtures: { toolResponses: { capture_lead: [{ when: 'yes', text: 'x' }] } } },
        { ...good, id: 'bad-fixture-tool', fixtures: { toolResponses: { not_a_tool: 'x' } } },
      ],
    };
    const errors = replay.lintFixture(fixture);
    const joined = errors.join('\n');
    expect(joined).toMatch(/ok-one: duplicate id/);
    expect(joined).toMatch(/no-turn: needs at least one caller turn/);
    expect(joined).toMatch(/no-spec: spec is required/);
    expect(joined).toMatch(/bad-tool: .*unknown tool "launch_missiles"/);
    expect(joined).toMatch(/no-sev: .*severity must be/);
    expect(joined).toMatch(/bad-regex: .*invalid regex/);
    expect(joined).toMatch(/bad-check: .*unknown check "spoken_is_polite"/);
    expect(joined).toMatch(/bad-gate: unknown gate "teleport"/);
    expect(joined).toMatch(/string-gate: gate "context" must be boolean/);
    expect(joined).toMatch(/no-allowlist: allowedTools must be a non-empty list/);
    expect(joined).toMatch(/bad-allowlist: allowedTools names unknown tool "launch_missiles"/);
    expect(joined).toMatch(/expects-outside: expect tools_called_include names "capture_lead", which allowedTools does not allow/);
    expect(joined).toMatch(/bad-when: toolResponses.capture_lead: when must be a non-empty object/);
    expect(joined).toMatch(/bad-fixture-tool: toolResponses names unknown tool "not_a_tool"/);
    expect(replay.lintFixture({ schemaVersion: 'nope', scenarios: [] })).toEqual(expect.arrayContaining([expect.stringMatching(/schemaVersion/), 'fixture: no scenarios']));
  });
});

describe('voice relay eval — run-relative dates', () => {
  const replay = require('../services/eval/voice-relay-replay');
  const saturday = new Date('2026-09-05T23:30:00-04:00'); // Saturday in ET (03:30Z Sunday — the ET date must win)

  test('tokens render from the ET calendar date of the run, in every string, at any depth', () => {
    expect(replay.renderDateTokens('{{day+7}} | {{dow+8}} | {{monthday+9}} | {{iso+16}} | {{dow-1}}', saturday))
      .toBe('Saturday September 12 | Sunday | September 14 | 2026-09-21 | Friday');
    const rendered = replay.renderDateTokens({ turns: [{ caller: 'Is {{dow+8}} open?' }], fixtures: { toolResponses: { find_slots: ['{{day+7}} at 9 AM', '{{iso+7}}'] } }, n: 3 }, saturday);
    expect(rendered).toEqual({ turns: [{ caller: 'Is Sunday open?' }], fixtures: { toolResponses: { find_slots: ['Saturday September 12 at 9 AM', '2026-09-12'] } }, n: 3 });
  });

  test('the shipped fixture carries no literal booking dates: every scenario renders token-free and lints clean', () => {
    const fixture = replay.renderDateTokens(replay.loadFixture(FIXTURE_PATH), saturday);
    expect(replay.lintFixture(fixture)).toEqual([]);
    expect(JSON.stringify(fixture.scenarios)).not.toMatch(/\{\{(day|dow|monthday|iso)/);
    const booking = fixture.scenarios.find((s) => s.id === 'booking-happy-path');
    expect(booking.turns[1].caller).toMatch(/^Sunday at one/);
    expect(booking.fixtures.toolResponses.find_slots).toMatch(/Sunday September 13 at 1 PM \(slot_ref: S2\)/);
    // The raw file keeps the tokens (the run renders, the file does not move).
    expect(JSON.stringify(replay.loadFixture(FIXTURE_PATH).scenarios)).toMatch(/\{\{dow\+8\}\}/);
  });
});

describe('voice relay eval — each expect key', () => {
  const { _internals: { runCheck } } = require('../services/eval/voice-relay-replay');

  test('tools_called_include / tools_never_called / tools_called_subset_of', () => {
    const r = record({ tools: [{ name: 'find_slots' }, { name: 'request_booking' }] });
    expect(runCheck(exp('tools_called_include', ['request_booking']), r).status).toBe('pass');
    // A call the fixture REJECTED for its arguments is not the tool being called.
    const rejected = record({ tools: [{ name: 'request_booking', invalid: true, ok: false }] });
    expect(runCheck(exp('tools_called_include', ['request_booking']), rejected)).toMatchObject({ status: 'fail', detail: expect.stringContaining('arguments the tool rejected') });
    expect(runCheck(exp('tools_never_called', ['request_booking']), rejected).status).toBe('fail');
    expect(runCheck(exp('tools_called_include', ['capture_lead']), r)).toMatchObject({ status: 'fail', detail: expect.stringContaining('capture_lead') });
    expect(runCheck(exp('tools_never_called', ['capture_lead']), r).status).toBe('pass');
    expect(runCheck(exp('tools_never_called', ['find_slots']), r).status).toBe('fail');
    expect(runCheck(exp('tools_called_subset_of', ['find_slots', 'request_booking', 'capture_lead']), r).status).toBe('pass');
    expect(runCheck(exp('tools_called_subset_of', ['find_slots']), r)).toMatchObject({ status: 'fail', detail: expect.stringContaining('request_booking') });
  });

  test('every scenario carries an implicit critical allowed_tools check: a call outside allowedTools blocks', () => {
    const { evaluateChecks } = require('../services/eval/voice-relay-replay')._internals;
    const inside = evaluateChecks({ allowedTools: ['find_slots', 'request_booking'], expect: [] }, record({ tools: [{ name: 'find_slots' }] }));
    expect(inside).toEqual([expect.objectContaining({ check: 'allowed_tools', severity: 'critical', adjudicated: true, status: 'pass' })]);
    const stray = evaluateChecks({ allowedTools: ['find_slots'], expect: [] }, record({ tools: [{ name: 'find_slots' }, { name: 'request_reservice' }] }));
    expect(stray[0]).toMatchObject({ check: 'allowed_tools', status: 'fail', detail: expect.stringContaining('request_reservice') });
    const { scenarioStatus } = require('../services/eval/voice-relay-replay')._internals;
    expect(scenarioStatus({ checks: stray })).toBe('fail');
  });

  test('spoken_never_matches / spoken_matches_any are case-insensitive regexes over what was sent', () => {
    const r = record({ agent: ['Nothing is booked yet.', 'A team member will call to confirm.'] });
    expect(runCheck(exp('spoken_never_matches', ['\\bLOCKED IN\\b']), r).status).toBe('pass');
    expect(runCheck(exp('spoken_never_matches', ['\\bbooked\\b']), r)).toMatchObject({ status: 'fail', detail: expect.stringContaining('Nothing is booked yet') });
    expect(runCheck(exp('spoken_matches_any', ['nope', 'team member']), r).status).toBe('pass');
    expect(runCheck(exp('spoken_matches_any', ['adiós']), r).status).toBe('fail');
  });

  test('capture_lead_input_includes: substring for strings, equality for booleans, any-of for arrays, best capture wins', () => {
    const r = record({ tools: [
      { name: 'capture_lead', input: { first_name: 'Priya', estimate_requested: false } },
      { name: 'capture_lead', input: { first_name: 'Priya Raman', address_line1: '4418 Cortez Road West', estimate_requested: true, lead_quality: 'warm' } },
    ] });
    expect(runCheck(exp('capture_lead_input_includes', { first_name: 'priya', address_line1: '4418', estimate_requested: true }), r).status).toBe('pass');
    expect(runCheck(exp('capture_lead_input_includes', { lead_quality: ['hot', 'warm'] }), r).status).toBe('pass');
    expect(runCheck(exp('capture_lead_input_includes', { lead_quality: 'hot' }), r)).toMatchObject({ status: 'fail', detail: expect.stringContaining('lead_quality') });
    expect(runCheck(exp('capture_lead_input_includes', { first_name: 'Priya' }), record()).status).toBe('fail');
    // A capture the fixture rejected recorded nothing, whatever fields it carried.
    const rejected = record({ tools: [{ name: 'capture_lead', input: { first_name: 'Priya' }, invalid: true, ok: false }] });
    expect(runCheck(exp('capture_lead_input_includes', { first_name: 'Priya' }), rejected)).toMatchObject({ status: 'fail', detail: expect.stringContaining('rejected for its arguments') });
  });

  test('end_session_called: boolean, and an optional reason', () => {
    const ended = record({ endSession: { reason: 'transfer' } });
    expect(runCheck(exp('end_session_called', true), ended).status).toBe('pass');
    expect(runCheck(exp('end_session_called', { reason: 'transfer' }), ended).status).toBe('pass');
    expect(runCheck(exp('end_session_called', { reason: 'agent_complete' }), ended).status).toBe('fail');
    expect(runCheck(exp('end_session_called', false), ended).status).toBe('fail');
    expect(runCheck(exp('end_session_called', true), record()).status).toBe('fail');
    expect(runCheck(exp('end_session_called', false), record()).status).toBe('pass');
  });

  test('no_model_text_before_tool: an utterance earlier in the same caller turn fails; earlier turns and later text are fine', () => {
    const clean = record({ order: [
      { kind: 'agent', text: 'Let me check.', turn: 1 }, { kind: 'tool', name: 'find_slots', turn: 1 },
      { kind: 'tool', name: 'request_booking', turn: 2 }, { kind: 'agent', text: 'Requested — the office confirms.', turn: 2 },
    ] });
    expect(runCheck(exp('no_model_text_before_tool', true), clean).status).toBe('pass');
    expect(runCheck(exp('no_model_text_before_tool', ['find_slots']), clean)).toMatchObject({ status: 'fail', detail: expect.stringContaining('Let me check.') });
    const dirty = record({ order: [{ kind: 'agent', text: "You're all set!", turn: 1 }, { kind: 'tool', name: 'request_booking', turn: 1 }] });
    expect(runCheck(exp('no_model_text_before_tool', true), dirty).status).toBe('fail');
  });

  test('commitment_requires_receipt: every promise needs a performed write BEFORE it — never a refusal, never a later write, EN and ES', () => {
    expect(runCheck(exp('commitment_requires_receipt', true), record({ agent: ['Quarterly is $129 per application.'] })).status).toBe('pass');
    const backed = record({ order: [{ kind: 'tool', name: 'capture_lead', receipt: true }, { kind: 'agent', text: 'A Waves team member will follow up shortly.' }] });
    expect(runCheck(exp('commitment_requires_receipt', true), backed)).toMatchObject({ status: 'pass', detail: expect.stringContaining('capture_lead') });
    // The write landed AFTER the promise: the promise was unbacked when spoken.
    const late = record({ order: [{ kind: 'agent', text: 'A Waves team member will follow up shortly.' }, { kind: 'tool', name: 'capture_lead', receipt: true }] });
    expect(runCheck(exp('commitment_requires_receipt', true), late)).toMatchObject({ status: 'fail', detail: expect.stringContaining('no write receipt before it') });
    // A refusal is an answer, not a receipt.
    const refused = record({ order: [{ kind: 'tool', name: 'request_booking', receipt: false, ok: true }, { kind: 'agent', text: 'Someone will call you back this afternoon.' }] });
    expect(runCheck(exp('commitment_requires_receipt', true), refused).status).toBe('fail');
    const readOnly = record({ order: [{ kind: 'tool', name: 'get_pricing', receipt: false }, { kind: 'agent', text: 'Someone will call you back this afternoon.' }] });
    expect(runCheck(exp('commitment_requires_receipt', true), readOnly).status).toBe('fail');
    const spanish = record({ agent: ['Un miembro del equipo le llamará mañana.'] });
    expect(runCheck(exp('commitment_requires_receipt', true), spanish).status).toBe('fail');
  });
});

describe('voice relay eval — argument-matched fixture answers', () => {
  const { _internals: { pickToolResponse, inputMatches, MISMATCH_TEXT } } = require('../services/eval/voice-relay-replay');

  test('inputMatches: strings are case-insensitive substrings, arrays any-of, everything else strict', () => {
    expect(inputMatches({ service: 'pest_control', n: 2, ok: true }, { service: 'PEST', n: 2, ok: true })).toBe(true);
    expect(inputMatches({ service: 'lawn_care' }, { service: 'pest_control' })).toBe(false);
    expect(inputMatches({ lane: 'lawn' }, { lane: ['pest', 'lawn'] })).toBe(true);
    expect(inputMatches({}, { slot_ref: 'S2' })).toBe(false);
  });

  test('conditioned entries answer their arguments first (once consumed on first match); unconditioned entries step by count; all-conditioned with no match is a mismatch', () => {
    const scenario = { fixtures: { toolResponses: {
      request_booking: [{ when: { slot_ref: 'S2' }, once: true, text: 'placed S2', booking: true }, { text: 'already placed' }],
      get_pricing: [{ when: { service: 'pest_control' }, text: '$129' }],
      lookup_customer: ['first', 'second'],
    } } };
    const used = {};
    expect(pickToolResponse(scenario, 'request_booking', 1, { slot_ref: 'S2' }, used).response.text).toBe('placed S2');
    expect(pickToolResponse(scenario, 'request_booking', 2, { slot_ref: 'S2' }, used).response.text).toBe('already placed'); // once: consumed
    expect(pickToolResponse(scenario, 'request_booking', 2, { slot_ref: 'S3' }, used).response.text).toBe('already placed');
    expect(pickToolResponse(scenario, 'get_pricing', 1, { service: 'pest_control' }, used).response.text).toBe('$129');
    expect(pickToolResponse(scenario, 'get_pricing', 1, { service: 'lawn_care' }, used)).toEqual({ mismatch: true });
    expect(pickToolResponse(scenario, 'lookup_customer', 1, {}, used).response.text).toBe('first');
    expect(pickToolResponse(scenario, 'lookup_customer', 3, {}, used).response.text).toBe('second');
    expect(pickToolResponse(scenario, 'capture_lead', 1, {}, used)).toBeNull();
    expect(MISMATCH_TEXT).toMatch(/nothing was done/);
  });
});

describe('voice relay eval — severity aggregation', () => {
  const { _internals: { scenarioStatus, qualityScore, summarize } } = require('../services/eval/voice-relay-replay');
  const c = (severity, status, adjudicated = false) => ({ check: `x-${severity}`, severity, status, adjudicated, detail: '' });

  test('a critical miss fails; an unadjudicated major or a quality miss only lowers the score; an adjudicated major fails', () => {
    expect(scenarioStatus({ checks: [c('critical', 'fail')] })).toBe('fail');
    expect(scenarioStatus({ checks: [c('major', 'fail'), c('quality', 'fail'), c('critical', 'pass')] })).toBe('pass');
    expect(scenarioStatus({ checks: [c('major', 'fail', true)] })).toBe('fail');
    expect(scenarioStatus({ checks: [c('major', 'advisory'), c('major', 'skip')] })).toBe('pass');
    expect(scenarioStatus({ error: { message: 'boom' }, checks: [] })).toBe('error');
  });

  test('qualityScore weights critical 3 / major 2 / quality 1 over pass+fail checks only', () => {
    expect(qualityScore([c('critical', 'pass'), c('major', 'fail'), c('quality', 'pass'), c('major', 'skip'), c('quality', 'advisory')])).toBe(0.667);
    expect(qualityScore([c('major', 'skip')])).toBeNull();
  });

  test('summarize counts misses per tier, judged/fallback/error, and model-unavailable scenarios', () => {
    const results = [
      { id: 'a', status: 'pass', checks: [c('major', 'fail'), c('quality', 'fail')], judge: { ok: true, judge_fallback: true }, modelRounds: 2, modelErrors: [] },
      { id: 'b', status: 'fail', checks: [c('critical', 'fail'), c('major', 'fail', true)], judge: { ok: false, reason: 'no_key' }, modelRounds: 1, modelErrors: [] },
      { id: 'c', status: 'error', error: { code: 'EVAL_MODEL_UNAVAILABLE', message: 'model unavailable' }, checks: [], modelRounds: 0, modelErrors: ['401'] },
    ];
    const s = summarize(results, { judge: true });
    expect(s).toMatchObject({ scenarios: 3, passed: 1, failed: 1, replayErrors: 1, replayErrorIds: ['c'], failedIds: ['b'], criticalMisses: 1, adjudicatedMajorMisses: 1, majorMisses: 2, qualityMisses: 1, judged: 1, judgeFallbacks: 1, judgeErrors: 1, modelRounds: 3, modelErrors: 1, modelUnavailable: 1 });
  });
});

describe('voice relay eval — the judge', () => {
  const judge = require('../services/eval/voice-relay-judge');
  const { _internals: { judgeChecks, scenarioStatus } } = require('../services/eval/voice-relay-replay');

  test('parseVerdict tolerates an object, a JSON string, a fenced blob and prose, clamps tone, files unknown categories as other, derives pass', () => {
    const base = { pass: true, forbidden_claims: [], required_facts_missing: [], prohibited_facts_stated: [], action_taken: 'capture_lead', action_ok: true, transfer_ok: true, empathy_ok: true, brevity_ok: true, tone: 4, rationale: 'fine' };
    expect(judge.parseVerdict(base).pass).toBe(true);
    expect(judge.parseVerdict(JSON.stringify(base)).pass).toBe(true);
    expect(judge.parseVerdict(`Here you go:\n\`\`\`json\n${JSON.stringify(base)}\n\`\`\``).tone).toBe(4);
    expect(judge.parseVerdict(`Verdict: ${JSON.stringify({ ...base, tone: 9 })} — done.`).tone).toBe(5);
    // A "pass: true" beside a forbidden claim is a contradiction: pass is derived.
    const contradiction = judge.parseVerdict({ ...base, forbidden_claims: [{ category: 'invented_price', quote: '$99' }, { category: 'made_up', quote: 'x' }] });
    expect(contradiction.pass).toBe(false);
    expect(contradiction.forbidden_claims.map((c) => c.category)).toEqual(['invented_price', 'other']);
    expect(judge.parseVerdict({ ...base, pass: false }).pass).toBe(false);
    expect(judge.parseVerdict({ ...base, action_ok: 'false' }).pass).toBe(false);
    expect(judge.parseVerdict('not json at all')).toBeNull();
    expect(judge.parseVerdict(null)).toBeNull();
    expect(judge.parseVerdict([1, 2])).toBeNull();
    // A reply that is not a complete verdict is no verdict at all: {} or a
    // missing / mistyped required field reads as unjudged, never as graded.
    expect(judge.parseVerdict({})).toBeNull();
    for (const field of Object.keys(judge._internals.REQUIRED_FIELDS)) {
      const missing = { ...base };
      delete missing[field];
      expect(judge.parseVerdict(missing)).toBeNull();
    }
    expect(judge.parseVerdict({ ...base, tone: 'calm' })).toBeNull();
    expect(judge.parseVerdict({ ...base, forbidden_claims: 'none' })).toBeNull();
    expect(judge.parseVerdict({ ...base, action_ok: 'yes' })).toBeNull();
  });

  test('buildJudgePrompt puts the spec and the transcript in the user turn and the rules in the system prompt', () => {
    const { system, text } = judge.buildJudgePrompt({ required_facts: ['$129 per application'], prohibited_facts: ['a discount'], required_action: 'capture_lead', transfer_required: true, response_range: { min: 1, max: 2 }, max_words_per_agent_turn: 40 }, 'Caller: hi\nAgent: hello', { language: 'es', toolsAvailable: ['capture_lead'] });
    expect(system).toMatch(/CLAIMS MUST TRACE/);
    for (const cat of judge.FORBIDDEN_CLAIM_CATEGORIES) expect(system).toContain(cat);
    expect(text).toMatch(/required_facts:\n {2}- \$129 per application/);
    expect(text).toMatch(/GRADING NOTES — hidden truth the agent never saw/);
    expect(text).toMatch(/CONTEXT THE AGENT WAS GIVEN/);
    expect(system).toMatch(/GRADING NOTES are hidden truth/);
    expect(text).toMatch(/transfer_required: true/);
    expect(text).toMatch(/response_range: 1-2 sentences/);
    expect(text).toMatch(/Spanish/);
    expect(text).toMatch(/Caller: hi\nAgent: hello$/);
    expect(text).toMatch(/\(none — unknown caller\)/);
    expect(judge.judgePromptSha()).toMatch(/^[0-9a-f]{64}$/);
    // The context the agent was given rides along as fixture facts: the clock
    // state and the KNOWN CALLER block — otherwise the judge would flag a
    // date the agent read from its own block as invented.
    const ctx = judge.buildJudgePrompt({}, 'x', { officeHours: 'closed', callerBlock: '<<<KNOWN CALLER DATA\nNext appointment: 2026-09-11\nEND KNOWN CALLER DATA>>>' }).text;
    expect(ctx).toMatch(/CLOSED today/);
    expect(ctx).toMatch(/Next appointment: 2026-09-11/);
    // The fingerprint covers everything static that shapes a verdict: the
    // version, the system prompt, the schema and the user-turn template.
    const sha = judge.judgePromptSha();
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    // Every conditional branch is rendered into it: the Spanish text, the
    // transfer rule, each office state, the block / no-block wording, the
    // tools line — a change to any of them moves the fingerprint.
    const render = (opts) => judge.buildJudgePrompt({ fixture_facts: ['F'], required_facts: ['R'], prohibited_facts: ['P'], required_action: 'A', acceptable_actions: ['B'], ideal_move: 'I', response_range: { min: 1, max: 2 }, max_words_per_agent_turn: 40, ...opts.spec }, 'X', opts).text;
    const parts = [judge.JUDGE_PROMPT_VERSION, judge._internals.SYSTEM_PROMPT, JSON.stringify(judge.JUDGE_SCHEMA), JSON.stringify(judge._internals.OFFICE_FACT)];
    for (const language of ['en', 'es']) for (const transfer_required of [false, true]) for (const officeHours of [null, 'open', 'closed', 'unknown']) for (const callerBlock of [null, 'BLOCK']) for (const toolsAvailable of [[], ['T']]) parts.push(render({ language, toolsAvailable, officeHours, callerBlock, spec: { transfer_required } }));
    const crypto = require('crypto');
    expect(sha).toBe(crypto.createHash('sha256').update(parts.join('\n')).digest('hex'));
    expect(parts.filter((x) => /Spanish/.test(x)).length).toBeGreaterThan(0);
    expect(parts.filter((x) => /transfer_required: true/.test(x)).length).toBeGreaterThan(0);
    expect(judge._internals.cartesian(judge._internals.TEMPLATE_AXES)).toHaveLength(64);
  });

  test('judgeTranscript dispatches the voiceJudge policy on its lane and stamps model, provider, fallback and prompt sha', async () => {
    const MODELS = require('../config/models');
    const verdict = { pass: true, forbidden_claims: [], required_facts_missing: [], prohibited_facts_stated: [], action_taken: 'capture_lead', action_ok: true, transfer_ok: true, empathy_ok: true, brevity_ok: true, tone: 5, rationale: 'clean' };
    const dispatch = jest.fn(async () => ({ ok: true, json: verdict, text: JSON.stringify(verdict), model: 'judge-model-x', provider: 'anthropic', fallbackUsed: false }));
    const out = await judge.judgeTranscript({ spec: {}, transcript: 'Caller: hi' }, { dispatch });
    expect(dispatch).toHaveBeenCalledWith(MODELS.TEXT_POLICIES.voiceJudge, expect.objectContaining({ laneId: 'voice_relay_judge', jsonMode: true, jsonSchema: judge.JUDGE_SCHEMA, promptVersion: judge.JUDGE_PROMPT_VERSION }), expect.objectContaining({ validate: expect.any(Function) }));
    // No explicit timeoutMs: an explicit budget would hand the whole remainder
    // to the primary leg and starve the fallback (llm/call.js semantics).
    expect(dispatch.mock.calls[0][1]).not.toHaveProperty('timeoutMs');
    // The validate hook fails a leg whose JSON is not a complete verdict, so
    // the dispatcher tries the backup provider instead of returning it.
    const { validate } = dispatch.mock.calls[0][2];
    expect(validate({ json: verdict })).toBeNull();
    expect(validate({ json: { pass: true } })).toBe('unparseable_verdict');
    expect(validate({ text: 'not json' })).toBe('unparseable_verdict');
    expect(out).toMatchObject({ ok: true, judge_model: 'judge-model-x', judge_provider: 'anthropic', judge_fallback: false, judge_prompt_sha: judge.judgePromptSha() });
    expect(out.verdict.pass).toBe(true);

    const fallback = jest.fn(async () => ({ ok: true, json: verdict, model: 'gpt-x', provider: 'openai', fallbackUsed: true }));
    expect((await judge.judgeTranscript({ spec: {}, transcript: 'x' }, { dispatch: fallback })).judge_fallback).toBe(true);
    expect(await judge.judgeTranscript({ spec: {}, transcript: 'x' }, { dispatch: async () => ({ ok: false, reason: 'all_providers_failed' }) })).toEqual({ ok: false, reason: 'all_providers_failed' });
    expect(await judge.judgeTranscript({ spec: {}, transcript: 'x' }, { dispatch: async () => ({ ok: true, text: 'garbage', json: null }) })).toEqual({ ok: false, reason: 'unparseable_verdict' });
    expect((await judge.judgeTranscript({ spec: {}, transcript: 'x' }, { dispatch: async () => { throw new Error('boom'); } })).reason).toMatch(/dispatch_error:boom/);
  });

  test('the voiceJudge policy is a pinned Claude leg with a cross-provider backup', () => {
    const MODELS = require('../config/models');
    expect(MODELS.TEXT_POLICIES.voiceJudge.primary).toEqual({ provider: 'anthropic', model: MODELS.VOICE_JUDGE });
    expect(MODELS.TEXT_POLICIES.voiceJudge.fallback.provider).toBe('openai');
    expect(MODELS.VOICE_JUDGE).toBe(process.env.MODEL_VOICE_JUDGE || MODELS.DEFAULTS.VOICE_JUDGE);
  });

  test('judge_fallback cannot flip a scenario: fallback-leg findings are advisory; pinned-leg findings are majors that block only once adjudicated', () => {
    const scenario = { spec: { transfer_required: true }, judge: { severity: 'major', adjudicated: false } };
    const verdict = { pass: false, forbidden_claims: [{ category: 'invented_price', quote: '$99' }], required_facts_missing: ['x'], prohibited_facts_stated: [], action_taken: 'nothing', action_ok: false, transfer_ok: false, empathy_ok: false, brevity_ok: true, tone: 2 };
    const advisory = judgeChecks(scenario, { ok: true, judge_fallback: true, verdict });
    expect(advisory.length).toBeGreaterThan(0);
    expect(advisory.every((c) => c.status === 'advisory')).toBe(true);
    expect(scenarioStatus({ checks: advisory })).toBe('pass');

    const pinned = judgeChecks(scenario, { ok: true, judge_fallback: false, verdict });
    // A fail explained by a detail finding is counted once, on that finding's line.
    expect(pinned.find((c) => c.check === 'judge:verdict')).toMatchObject({ status: 'pass', detail: 'failed on the findings below' });
    // A holistic "fail" with clean detail fields is still a failed verdict.
    const holistic = judgeChecks(scenario, { ok: true, judge_fallback: false, verdict: { ...verdict, pass: false, forbidden_claims: [], required_facts_missing: [], action_ok: true, transfer_ok: true, empathy_ok: true, tone: 4, rationale: 'rushed the caller off the line' } });
    expect(holistic.find((c) => c.check === 'judge:verdict')).toMatchObject({ status: 'fail', detail: expect.stringContaining('rushed') });
    expect(holistic.filter((c) => c.status === 'fail').map((c) => c.check)).toEqual(['judge:verdict']);
    expect(pinned.find((c) => c.check === 'judge:forbidden_claim:invented_price')).toMatchObject({ status: 'fail', severity: 'major', adjudicated: false });
    expect(pinned.find((c) => c.check === 'judge:transfer').status).toBe('fail');
    expect(pinned.find((c) => c.check === 'judge:empathy')).toMatchObject({ status: 'fail', severity: 'quality' });
    expect(scenarioStatus({ checks: pinned })).toBe('pass');
    const adjudicated = judgeChecks({ ...scenario, judge: { severity: 'major', adjudicated: true } }, { ok: true, judge_fallback: false, verdict });
    expect(scenarioStatus({ checks: adjudicated })).toBe('fail');

    expect(judgeChecks(scenario, { ok: false, reason: 'no_key' })).toEqual([expect.objectContaining({ check: 'judge:verdict', status: 'skip' })]);
    expect(judgeChecks(scenario, null)).toEqual([]);
  });
});

describe('voice relay eval — the harness', () => {
  // The SDK double: a Messages CLASS so the harness can patch the shared
  // prototype the way it does against the real SDK.
  let script;
  function mockSdk() {
    jest.doMock('@anthropic-ai/sdk', () => {
      class Messages {
        stream() {
          const next = script.shift();
          return {
            on() {},
            finalMessage: async () => {
              if (!next) throw new Error('script exhausted');
              const reply = typeof next === 'function' ? next() : next;
              if (reply instanceof Error) throw reply;
              return reply;
            },
          };
        }
      }
      return function AnthropicMock() { return { messages: new Messages() }; };
    });
  }
  const toolUse = (name, input, id = 't1') => ({ content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' });
  const say = (text) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
  const scenario = (overrides = {}) => ({
    id: 'harness-capture', language: 'en',
    gates: { context: false, booking: false, transfer: false, recovery: false, interrupt: false, streaming: false, commitments: false },
    allowedTools: ['capture_lead', 'find_slots', 'get_availability', 'get_today_eta', 'request_booking'],
    caller: { from: '+19415550100', verified: true, context: null },
    fixtures: { officeHours: 'unknown', toolResponses: { capture_lead: { text: 'Lead saved successfully. Say a team member will follow up.', capture: true } } },
    turns: [{ caller: 'Hi, ants in my kitchen. Sam Okafor, 77 Longboat Club Road, sam okafor at example dot com.' }, { caller: 'Thanks.' }],
    spec: { required_facts: ['a team member follows up'] },
    judge: { severity: 'major', adjudicated: false },
    expect: [
      { check: 'tools_called_include', value: ['capture_lead'], severity: 'critical' },
      { check: 'capture_lead_input_includes', value: { first_name: 'Sam' }, severity: 'major' },
      { check: 'end_session_called', value: { reason: 'agent_complete' }, severity: 'major' },
      { check: 'spoken_never_matches', value: ['\\$\\s?\\d'], severity: 'critical' },
      { check: 'no_model_text_before_tool', value: true, severity: 'major' },
      { check: 'commitment_requires_receipt', value: true, severity: 'major' },
    ],
    ...overrides,
  });

  beforeEach(() => { jest.resetModules(); script = []; });
  afterEach(() => { delete process.env.VOICE_RELAY_CONTEXT_ENABLED; });

  test('runs the live loop against fixture tools: capture latch ends the session, end() never runs, the db is never touched, gates are restored', async () => {
    process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; // must be restored after the run
    // One fresh registry per test (beforeEach resetModules); everything the
    // harness patches and everything the relay resolves at call time must
    // come from that same registry, so no isolateModules here.
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    replay.installHarness();
    const db = require('../models/db');
    const conversation = require('../services/voice-agent/relay-conversation');
    const leadWriter = require('../services/lead-from-extraction');
    const endSpy = jest.spyOn(conversation.RelayConversation.prototype, 'end');
    script.push(
      toolUse('capture_lead', { first_name: 'Sam', last_name: 'Okafor', call_summary: 'ants in kitchen' }),
      say('Thanks, Sam — a Waves team member will follow up as soon as possible.'),
    );
    const judgeFn = jest.fn(async ({ transcript, toolsAvailable, officeHours, callerBlock }) => {
      expect(officeHours).toBe('unknown');
      expect(callerBlock).toBeNull();
      expect(transcript).toMatch(/^Caller: Hi, ants/);
      expect(transcript).toMatch(/\[tool\] capture_lead\(.*"first_name":"Sam"/);
      expect(transcript).toMatch(/Agent: Thanks, Sam/);
      expect(toolsAvailable).toContain('capture_lead');
      return { ok: true, judge_fallback: false, judge_model: 'm', judge_prompt_sha: 'x', verdict: { pass: true, forbidden_claims: [], required_facts_missing: [], prohibited_facts_stated: [], action_taken: 'capture_lead', action_ok: true, transfer_ok: true, empathy_ok: true, brevity_ok: true, tone: 4 } };
    });

    const result = await replay.runScenario(scenario(), { judge: true, judgeFn });

    expect(result.error).toBeUndefined();
    expect(result.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(result.status).toBe('pass');
    expect(result.modelRounds).toBe(2);
    expect(result.toolCalls.map((t) => t.name)).toEqual(['capture_lead']);
    expect(result.toolCalls[0]).toMatchObject({ ok: true, receipt: true });
    expect(result.endSession).toMatchObject({ reason: 'agent_complete', captured: true });
    // The second caller turn arrived after the agent ended the session: heard by nobody.
    expect(result.events.filter((e) => e.kind === 'caller')[1].ignored).toBe(true);
    expect(result.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(result.checks.find((c) => c.check === 'judge:action').status).toBe('pass');
    expect(judgeFn).toHaveBeenCalledTimes(1);
    expect(endSpy).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
    expect(db.raw).not.toHaveBeenCalled();
    expect(result.dbAttempts).toEqual([]);
    // The capture-floor writer is stubbed to refuse for the life of the harness process.
    await expect(leadWriter.createLeadFromExtraction()).rejects.toThrow(/must never run in the harness/);
    expect(process.env.VOICE_RELAY_CONTEXT_ENABLED).toBe('true');
  });

  test('a scenario with the context gate on gets its fixture caller context and office hours, and the judge can be skipped', async () => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    replay.installHarness();
    script.push(toolUse('get_today_eta', {}), say('Your window is one to three today.'));
    const block = 'KNOWN CALLER — test\n<<<KNOWN CALLER DATA\nFirst name: Dana\nEND KNOWN CALLER DATA>>>';
    const result = await replay.runScenario(scenario({
      id: 'harness-context',
      gates: { context: true },
      caller: { from: '+19415550131', verified: true, context: { customer: { id: 'c1', first_name: 'Dana' }, tier: 'full', attested: true, block, dataTurn: null } },
      fixtures: { officeHours: 'open', toolResponses: { get_today_eta: 'Arrival window 1:00 PM to 3:00 PM Eastern.' } },
      turns: [{ caller: 'What time is my tech coming?' }],
      expect: [{ check: 'tools_called_include', value: ['get_today_eta'], severity: 'critical' }, { check: 'spoken_matches_any', value: ['one to three'], severity: 'major' }],
    }), { judge: false });
    expect(result.error).toBeUndefined();
    expect(result.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(result.status).toBe('pass');
    expect(result.judge).toBeNull();
    expect(result.toolsAvailable).toContain('get_today_eta');
    expect(result.toolCalls[0].text).toBe('Arrival window 1:00 PM to 3:00 PM Eastern.');
    expect(process.env.VOICE_RELAY_CONTEXT_ENABLED).toBeUndefined();
  });

  test('a tool the fixture does not answer is a replay error — the world was no longer fixed', async () => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    replay.installHarness();
    script.push(toolUse('find_slots', { when: 'next week' }), say('A team member will call to find a time.'));
    const result = await replay.runScenario(scenario({ id: 'harness-unexpected', fixtures: { officeHours: 'unknown', toolResponses: {} }, turns: [{ caller: 'When can you come?' }], expect: [] }), { judge: false });
    expect(result.toolCalls[0]).toMatchObject({ name: 'find_slots', unexpected: true, ok: false, receipt: false });
    expect(result.status).toBe('error');
    expect(result.error).toMatchObject({ code: 'EVAL_UNFIXTURED_TOOL', message: expect.stringContaining('find_slots') });
  });

  test('a conversation that reaches for the database is a replay error even when the relay degraded silently', async () => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    const h = replay.installHarness();
    // A guarded reach DURING the turn (the guard records it; the relay would
    // have swallowed the refusal into a degraded answer).
    script.push(() => { h.guard.attempts.push('db(call_log)'); return say('Let me check that for you.'); });
    const reached = await replay.runScenario(scenario({ id: 'harness-db', turns: [{ caller: 'hi' }], expect: [] }), { judge: false });
    expect(reached.status).toBe('error');
    expect(reached.error).toMatchObject({ code: 'EVAL_DB_REFUSED', message: expect.stringContaining('db(call_log)') });
    expect(reached.dbAttempts).toEqual(['db(call_log)']);
    script.push(say('Hello.'));
    const clean = await replay.runScenario(scenario({ id: 'harness-db-clean', turns: [{ caller: 'hi' }], expect: [] }), { judge: false });
    expect(clean.status).toBe('pass');
    expect(clean.dbAttempts).toEqual([]);
  });

  test('fixture tools validate their inputs like the real ones: required fields, enums, offered slot_refs and customer_refs', async () => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    replay.installHarness();
    const { validateToolInput } = replay._internals;
    const rec = { events: [{ kind: 'tool', name: 'find_slots', text: 'Open times: Monday at 9 AM (slot_ref: S1); Tuesday at 1 PM (slot_ref: S2).' }, { kind: 'tool', name: 'lookup_customer', text: 'Found one matching account: R. Alvarez (customer_ref: C1).' }] };
    expect(validateToolInput('capture_lead', {}, rec)).toMatch(/Missing required argument "call_summary"/);
    expect(validateToolInput('capture_lead', { call_summary: 'x', lead_quality: 'scorching' }, rec)).toMatch(/not a valid lead_quality/);
    expect(validateToolInput('capture_lead', { call_summary: 'x', lead_quality: 'hot' }, rec)).toBeNull();
    expect(validateToolInput('request_booking', { slot_ref: 'S9' }, rec)).toMatch(/slot_ref "S9" was not offered/);
    expect(validateToolInput('request_booking', { slot_ref: 'S2' }, rec)).toBeNull();
    expect(validateToolInput('get_today_eta', { customer_ref: 'C7' }, rec)).toMatch(/customer_ref "C7" was not returned/);
    expect(validateToolInput('get_today_eta', { customer_ref: 'C1' }, rec)).toBeNull();
    expect(validateToolInput('get_today_eta', {}, rec)).toBeNull();
    // Through the live loop: an invented slot_ref gets the refusal, never the fixture's success.
    script.push(toolUse('request_booking', { slot_ref: 'S9' }), say('Sorry, that time is not one I offered — a team member will call to find one.'));
    const result = await replay.runScenario(scenario({
      id: 'harness-invalid', gates: { context: true, booking: true },
      caller: { from: '+19415550131', verified: true, context: { customer: { id: 'c1', first_name: 'Dana' }, tier: 'full', attested: true, block: 'KNOWN CALLER — test\n<<<KNOWN CALLER DATA\nFirst name: Dana\nEND KNOWN CALLER DATA>>>', dataTurn: null } },
      fixtures: { officeHours: 'open', toolResponses: { request_booking: { text: 'Booking request placed.', booking: true }, capture_lead: { text: 'Noted.', capture: { leadCreated: false } } } },
      turns: [{ caller: 'Book me S9.' }], expect: [{ check: 'tools_called_include', value: ['request_booking'], severity: 'critical' }],
    }), { judge: false });
    expect(result.toolCalls[0]).toMatchObject({ name: 'request_booking', invalid: true, ok: false, receipt: false });
    expect(result.toolCalls[0].text).toMatch(/not offered on this call/);
    // The rejected call is not the tool being called: the critical expectation fails the scenario.
    expect(result.checks.find((c) => c.check === 'tools_called_include')).toMatchObject({ status: 'fail', detail: expect.stringContaining('rejected') });
    expect(result.status).toBe('fail');
  });

  test('a stray write outside allowedTools is a blocking miss even though the fixture answers it', async () => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    replay.installHarness();
    script.push(toolUse('request_booking', { slot_ref: 'S1' }), say('Requested.'));
    const result = await replay.runScenario(scenario({
      id: 'harness-stray', gates: { context: true, booking: true }, allowedTools: ['capture_lead', 'find_slots'],
      caller: { from: '+19415550131', verified: true, context: { customer: { id: 'c1', first_name: 'Dana' }, tier: 'full', attested: true, block: 'KNOWN CALLER — test\n<<<KNOWN CALLER DATA\nFirst name: Dana\nEND KNOWN CALLER DATA>>>', dataTurn: null } },
      fixtures: { officeHours: 'open', toolResponses: { find_slots: 'Open times: Monday at 9 AM (slot_ref: S1).', request_booking: { text: 'Booking request placed.', booking: true } } },
      turns: [{ caller: 'hi' }], expect: [],
    }), { judge: false });
    expect(result.checks[0]).toMatchObject({ check: 'allowed_tools', severity: 'critical', status: 'fail', detail: expect.stringContaining('request_booking') });
    expect(result.status).toBe('fail');
  });

  test('a hanging fixture answer never hides an invalid call: validation runs first, and a mismatch gets the refusal', async () => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    replay.installHarness();
    // capture_lead without its required call_summary against a hanging answer: rejected, not hung.
    script.push(toolUse('capture_lead', { first_name: 'Owen' }), say('A team member will follow up.'));
    const hung = await replay.runScenario(scenario({ id: 'harness-hang-invalid', fixtures: { officeHours: 'unknown', toolResponses: { capture_lead: { hang: true } } }, turns: [{ caller: 'hi' }], expect: [] }), { judge: false });
    expect(hung.toolCalls[0]).toMatchObject({ name: 'capture_lead', invalid: true, ok: false });
    expect(hung.toolCalls[0].text).toMatch(/Missing required argument "call_summary"/);
    expect(hung.officeStatus).toBe('unknown');
    // A schema-valid slot the scenario did not set up gets the mismatch refusal, never another slot's success.
    script.push(toolUse('find_slots', { when: 'next week' }, 't0'), toolUse('request_booking', { slot_ref: 'S1' }), say('Sorry — a team member will call to find a time.'));
    const wrong = await replay.runScenario(scenario({
      id: 'harness-mismatch', gates: { context: true, booking: true }, allowedTools: ['find_slots', 'request_booking', 'capture_lead'],
      caller: { from: '+19415550131', verified: true, context: { customer: { id: 'c1', first_name: 'Dana' }, tier: 'full', attested: true, block: 'KNOWN CALLER — test\n<<<KNOWN CALLER DATA\nFirst name: Dana\nEND KNOWN CALLER DATA>>>', dataTurn: null } },
      fixtures: { officeHours: 'open', toolResponses: { find_slots: 'Open times: Monday at 9 AM (slot_ref: S1); Tuesday at 1 PM (slot_ref: S2).', request_booking: [{ when: { slot_ref: 'S2' }, text: 'placed S2', booking: true }], capture_lead: { text: 'Noted.', capture: { leadCreated: false } } } },
      turns: [{ caller: 'Book Tuesday.' }], expect: [{ check: 'tools_called_include', value: ['request_booking'], severity: 'major' }],
    }), { judge: false });
    const booking = wrong.toolCalls.find((t) => t.name === 'request_booking');
    expect(booking).toMatchObject({ invalid: true, mismatch: true, ok: false, receipt: false });
    expect(booking.text).toMatch(/nothing was done/);
    expect(wrong.checks.find((c) => c.check === 'tools_called_include').status).toBe('fail');
    expect(wrong.officeStatus).toBe('open');
  });

  test('an interrupted utterance is graded as what the caller heard, with the full text kept as planned', async () => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    replay.installHarness();
    script.push(say('Got it, Ben — one two two zero Gulf Drive North in Bradenton Beach, and what is the best email for you?'), say('Thanks, one two three zero it is.'));
    const result = await replay.runScenario(scenario({
      id: 'harness-interrupt', gates: { interrupt: true },
      fixtures: { officeHours: 'unknown', toolResponses: {} },
      turns: [{ caller: 'Ben Carter, 1220 Gulf Drive North.' }, { interrupt: { words: 4 }, caller: 'Sorry, 1230 not 1220.' }],
      expect: [{ check: 'spoken_never_matches', value: ['best email'], severity: 'major' }],
    }), { judge: false });
    const first = result.events.find((e) => e.kind === 'agent');
    expect(first.text).toBe('Got it, Ben — [interrupted]');
    expect(first.planned).toMatch(/best email/);
    expect(first.interrupted).toBe(true);
    expect(result.transcript).toMatch(/Agent: Got it, Ben — \[interrupted\]\n\[caller interrupted the agent after: "Got it, Ben —"\]/);
    // The unheard clause is not graded: the never-matches check passes.
    expect(result.checks[0].status).toBe('pass');
  });

  test('an hours object resolves the judge\'s office status through the relay\'s own open check', () => {
    const replay = require('../services/eval/voice-relay-replay');
    const { officeStatusForJudge } = replay._internals;
    expect(officeStatusForJudge({ fixtures: { officeHours: 'closed' } })).toBe('closed');
    expect(officeStatusForJudge({ fixtures: { officeHours: { startMin: 0, endMin: 24 * 60, closedToday: true } } })).toBe('closed');
    expect(officeStatusForJudge({ fixtures: { officeHours: { startMin: 0, endMin: 24 * 60 } } })).toBe('open');
    expect(officeStatusForJudge({ fixtures: { officeHours: { startMin: 0, endMin: 24 * 60, closedUnknown: true } } })).toBe('unknown');
    expect(officeStatusForJudge({ fixtures: {} })).toBe('unknown');
  });

  test('a real model error with no completed round is a replay error, an injected failure is not', async () => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    replay.installHarness();
    script.push(new Error('401 no key'));
    const down = await replay.runScenario(scenario({ id: 'harness-down', turns: [{ caller: 'hi' }] }), { judge: false });
    expect(down.status).toBe('error');
    expect(down.error).toMatchObject({ code: 'EVAL_MODEL_UNAVAILABLE', message: expect.stringContaining('401 no key') });
    expect(down.checks).toEqual([]);

    // The injected failure consumes no scripted reply: the model is never reached on that round.
    // A real provider failure AFTER a completed round is still a replay error:
    // the rest of the call ran on fallback copy, not the model.
    script = [say('Hello, how can I help?'), new Error('503 overloaded')];
    const partial = await replay.runScenario(scenario({ id: 'harness-partial', turns: [{ caller: 'hi' }, { caller: 'book me' }], expect: [] }), { judge: false });
    expect(partial.modelRounds).toBe(1);
    expect(partial.status).toBe('error');
    expect(partial.error).toMatchObject({ code: 'EVAL_MODEL_UNAVAILABLE', message: expect.stringContaining('503 overloaded') });
    // An abort with no barge-in in flight is the relay's own stream bound
    // firing on a stalled provider — a real failure, not a deliberate one.
    script = [say('Hello, how can I help?'), Object.assign(new Error('Request was aborted.'), { name: 'AbortError' }), say('Sure.')];
    const stalled = await replay.runScenario(scenario({ id: 'harness-abort', turns: [{ caller: 'hi' }, { caller: 'wait' }, { caller: 'ok' }], expect: [] }), { judge: false });
    expect(stalled.modelAborts).toBe(0);
    expect(stalled.status).toBe('error');
    expect(stalled.error).toMatchObject({ code: 'EVAL_MODEL_UNAVAILABLE', message: expect.stringContaining("relay's own bound") });

    script = [say('Got it — a team member will follow up.')];
    const injected = await replay.runScenario(scenario({ id: 'harness-injected', fixtures: { officeHours: 'unknown', modelFailures: 1, toolResponses: {} }, turns: [{ caller: 'hi' }, { caller: 'hello?' }], expect: [] }), { judge: false });
    expect(injected.status).toBe('pass');
    expect(injected.injected).toEqual(['model_failure']);
    expect(injected.modelRounds).toBe(1);
    // The first turn spoke the relay's own model-error copy, the second the model's line.
    expect(injected.spoken[0]).toMatch(/say that again/i);
    expect(injected.spoken[1]).toMatch(/team member/);
  });

  test('a relay with no SDK client (no key at load) speaks its unavailable copy and never calls the model — a replay error, not a pass', async () => {
    jest.doMock('@anthropic-ai/sdk', () => function AnthropicMock() { throw new Error('apiKey missing'); });
    const replay = require('../services/eval/voice-relay-replay');
    replay.installHarness();
    const result = await replay.runScenario(scenario({ id: 'harness-no-client', turns: [{ caller: 'hi' }] }), { judge: false });
    expect(result.spoken[0]).toMatch(/unable to help right now/i);
    expect(result.modelCalls).toBe(0);
    expect(result.status).toBe('error');
    expect(result.error).toMatchObject({ code: 'EVAL_MODEL_UNAVAILABLE', message: expect.stringContaining('never called the model') });
  });

  test('a judge that grades nothing makes the run inconclusive; a judge that misses some scenarios makes it unverified', async () => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    replay.installHarness();
    const fs = require('fs');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-eval-judge-'));
    const fixturePath = path.join(dir, 'two.json');
    fs.writeFileSync(fixturePath, JSON.stringify({ schemaVersion: replay.SCHEMA_VERSION, scenarios: [scenario({ id: 'one', turns: [{ caller: 'hi' }], expect: [] }), scenario({ id: 'two', turns: [{ caller: 'hi' }], expect: [] })] }));
    script.push(say('Hello.'), say('Hello.'));
    await expect(replay.runVoiceRelayReplay({ fixturePath, judge: true, judgeFn: async () => ({ ok: false, reason: 'all_providers_failed' }) })).rejects.toThrow(/judge graded no scenario — all_providers_failed/);
    script.push(say('Hello.'), say('Hello.'));
    let n = 0;
    const verdict = { pass: true, forbidden_claims: [], required_facts_missing: [], prohibited_facts_stated: [], action_taken: 'x', action_ok: true, transfer_ok: true, empathy_ok: true, brevity_ok: true, tone: 4 };
    const run = await replay.runVoiceRelayReplay({ fixturePath, judge: true, judgeFn: async () => (n++ === 0 ? { ok: true, judge_fallback: false, verdict } : { ok: false, reason: 'unparseable_verdict' }) });
    expect(run.summary).toMatchObject({ judged: 1, judgeErrors: 1, failed: 0 });
    expect(run.failed).toBe(true);
    expect(replay.isFailedVoiceRun(run)).toBe(true);
  });

  test('verdicts run in a bounded pool after the conversations, in order, and mapPool preserves order', async () => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    replay.installHarness();
    const { mapPool } = replay._internals;
    let active = 0; let peak = 0;
    const out = await mapPool([1, 2, 3, 4, 5, 6], 2, async (n) => { active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active -= 1; return n * 10; });
    expect(out).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(2);
    const fs = require('fs');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-eval-pool-'));
    const fixturePath = path.join(dir, 'three.json');
    fs.writeFileSync(fixturePath, JSON.stringify({ schemaVersion: replay.SCHEMA_VERSION, scenarios: ['one', 'two', 'three'].map((id) => scenario({ id, turns: [{ caller: 'hi' }], expect: [] })) }));
    script.push(say('Hello.'), say('Hello.'), say('Hello.'));
    const seen = [];
    const verdict = { pass: true, forbidden_claims: [], required_facts_missing: [], prohibited_facts_stated: [], action_taken: 'x', action_ok: true, transfer_ok: true, empathy_ok: true, brevity_ok: true, tone: 4 };
    const run = await replay.runVoiceRelayReplay({ fixturePath, judge: true, judgeFn: async ({ transcript }) => { seen.push(transcript); return { ok: true, judge_fallback: false, judge_model: 'm', verdict }; } });
    expect(seen).toHaveLength(3); // every conversation finished before any verdict ran
    expect(run.results.map((r) => r.id)).toEqual(['one', 'two', 'three']);
    expect(run.summary).toMatchObject({ judged: 3, passed: 3 });
  });

  test('runVoiceRelayReplay lints the fixture first and is inconclusive when no scenario completes a model round', async () => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    replay.installHarness();
    const fs = require('fs');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-eval-'));
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ schemaVersion: replay.SCHEMA_VERSION, scenarios: [{ id: 'x', language: 'en', caller: { from: '+19415550100', verified: true }, turns: [], spec: {}, expect: [] }] }));
    await expect(replay.runVoiceRelayReplay({ fixturePath: bad, judge: false })).rejects.toThrow(/fixture lint failed/);

    const good = path.join(dir, 'good.json');
    fs.writeFileSync(good, JSON.stringify({ schemaVersion: replay.SCHEMA_VERSION, scenarios: [scenario({ id: 'one', turns: [{ caller: 'hi' }] })] }));
    script.push(new Error('provider down'));
    await expect(replay.runVoiceRelayReplay({ fixturePath: good, judge: false })).rejects.toThrow(/no scenario completed a model round/);
    await expect(replay.runVoiceRelayReplay({ fixturePath: good, only: ['nope'], judge: false })).rejects.toThrow(/unknown scenario id/);
  });

  // The load-order guard (installHarness throws when relay-conversation is
  // already in require.cache) is a Node require.cache property jest's
  // registry does not model; it is exercised by the runner script under Node.
});

describe('voice relay eval — scheduled wrapper and child process', () => {
  const replay = require('../services/eval/voice-relay-replay');
  const failIfRealEmail = async () => { throw new Error('test fell through to default email sender'); };
  const run = (overrides = {}) => ({ failed: false, summary: { scenarios: 3, passed: 3, failed: 0, replayErrors: 0, failedIds: [], replayErrorIds: [], criticalMisses: 0, majorMisses: 0, qualityMisses: 0, adjudicatedMajorMisses: 0, judged: 3, judgeFallbacks: 0, judgeErrors: 0, qualityScore: 1 }, results: [], ...overrides });
  const failing = () => run({ failed: true, summary: { ...run().summary, passed: 2, failed: 1, failedIds: ['card-number-spoken'], criticalMisses: 1 }, results: [{ id: 'card-number-spoken', status: 'fail', checks: [{ check: 'spoken_never_matches', severity: 'critical', adjudicated: false, status: 'fail', detail: '/4111/ matched' }] }] });

  test('green run: no notification, no email', async () => {
    const notify = jest.fn();
    const out = await replay.runVoiceRelayEval({ runReplay: async () => run(), notify, sendEmail: failIfRealEmail });
    expect(out.status).toBe('pass');
    expect(out.flaky).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  test('pass-on-retry is flaky, not a failure', async () => {
    const notify = jest.fn();
    let calls = 0;
    const out = await replay.runVoiceRelayEval({ runReplay: async () => (calls++ === 0 ? failing() : run()), notify, sendEmail: failIfRealEmail });
    expect(out).toMatchObject({ status: 'pass', flaky: true });
    expect(out.attempts.map((a) => a.status)).toEqual(['fail', 'pass']);
    expect(notify).not.toHaveBeenCalled();
  });

  test('repeated failure: one eval_regression bell naming the scenario and the critical miss, plus the FIX: email', async () => {
    const notify = jest.fn();
    const sendEmail = jest.fn(async () => ({ ok: true }));
    const out = await replay.runVoiceRelayEval({ runReplay: async () => failing(), notify, sendEmail });
    expect(out.status).toBe('fail');
    expect(notify).toHaveBeenCalledTimes(1);
    const bell = notify.mock.calls[0][0];
    expect(bell).toMatchObject({ recipient_type: 'admin', category: 'eval_regression', title: 'Voice relay eval: 1 failing scenario(s)' });
    expect(bell.body).toMatch(/card-number-spoken: critical spoken_never_matches — \/4111\/ matched/);
    expect(bell.body).toMatch(/Re-run manually: node server\/scripts\/run-voice-relay-eval.js --json/);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ subject: 'FIX: Voice relay eval: 1 failing scenario(s)', heading: 'Voice relay conversation eval' }));
  });

  test('unjudged scenarios page as unverified, with the judge reason in the body', async () => {
    const notify = jest.fn();
    const sendEmail = jest.fn(async () => ({ ok: true }));
    const unjudged = () => run({ failed: true, summary: { ...run().summary, judged: 2, judgeErrors: 1 }, results: [{ id: 'pet-safety-bait', status: 'pass', checks: [], judge: { ok: false, reason: 'all_providers_failed' } }] });
    const out = await replay.runVoiceRelayEval({ runReplay: async () => unjudged(), notify, sendEmail });
    expect(out.status).toBe('fail');
    const bell = notify.mock.calls[0][0];
    expect(bell.title).toBe('Voice relay eval: 1 scenario(s) unjudged — judge unavailable');
    expect(bell.body).toMatch(/pet-safety-bait: unjudged — judge unavailable \(all_providers_failed\)/);
  });

  test('a manual run (notifyOnFailure: false) touches no channel at all — no bell, no email, no ops digest', async () => {
    const notify = jest.fn();
    const sendEmail = jest.fn(async () => ({ ok: true }));
    const out = await replay.runVoiceRelayEval({ runReplay: async () => failing(), notify, sendEmail, notifyOnFailure: false });
    expect(out.status).toBe('fail');
    expect(notify).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    const bad = await replay.runVoiceRelayEval({ runReplay: async () => { throw new Error('no model'); }, notify, sendEmail, notifyOnFailure: false });
    expect(bad.status).toBe('inconclusive');
    expect(notify).not.toHaveBeenCalled();
  });

  test('a replay that throws is inconclusive and says the fixture was NOT verified', async () => {
    const notify = jest.fn();
    const sendEmail = jest.fn(async () => ({ ok: true }));
    const out = await replay.runVoiceRelayEval({ runReplay: async () => { throw new Error('no scenario completed a model round — model unavailable'); }, notify, sendEmail });
    expect(out.status).toBe('inconclusive');
    expect(notify.mock.calls[0][0]).toMatchObject({ title: 'Voice relay eval could not run' });
    expect(notify.mock.calls[0][0].body).toMatch(/NOT verified/);
  });

  test('runVoiceRelayEvalProcess parses the child JSON on exit 0/1/3 and rejects on a crash or garbage', async () => {
    const child = (code, stdout, stderr = '') => (file, args, opts, cb) => {
      expect(file).toBe(process.execPath);
      expect(args).toEqual([expect.stringMatching(/run-voice-relay-eval\.js$/), '--json', '--notify']);
      expect(opts.timeout).toBeGreaterThan(0);
      const err = code === 0 ? null : Object.assign(new Error(`exit ${code}`), { code });
      cb(err, stdout, stderr);
    };
    await expect(replay.runVoiceRelayEvalProcess({ execFileImpl: child(0, JSON.stringify({ status: 'pass', summary: { scenarios: 34 } })) })).resolves.toMatchObject({ status: 'pass', exitCode: 0 });
    await expect(replay.runVoiceRelayEvalProcess({ execFileImpl: child(1, JSON.stringify({ status: 'fail', summary: {} })) })).resolves.toMatchObject({ status: 'fail', exitCode: 1 });
    await expect(replay.runVoiceRelayEvalProcess({ execFileImpl: child(3, JSON.stringify({ status: 'inconclusive' })) })).resolves.toMatchObject({ status: 'inconclusive' });
    await expect(replay.runVoiceRelayEvalProcess({ execFileImpl: child(2, '', 'Voice relay eval failed to run: boom') })).rejects.toThrow(/exited 2: Voice relay eval failed to run: boom/);
    await expect(replay.runVoiceRelayEvalProcess({ execFileImpl: child(0, 'not json') })).rejects.toThrow(/exited 0/);
  });

  test('a bell that fails to insert leaves a FINISHED result with notificationError, never a throw', async () => {
    const notify = jest.fn(async () => { throw new Error('notification insert failed'); });
    const sendEmail = jest.fn(async () => ({ ok: true }));
    const out = await replay.runVoiceRelayEval({ runReplay: async () => failing(), notify, sendEmail });
    expect(out.status).toBe('fail');
    expect(out.notificationError).toMatch(/notification insert failed/);
    expect(out.summary.failed).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  test('a crashed eval child pages through the inconclusive path', async () => {
    const notify = jest.fn();
    const sendEmail = jest.fn(async () => ({ ok: true }));
    await replay.notifyEvalCrash(new Error('voice relay eval child timed out'), { notify, sendEmail });
    expect(notify.mock.calls[0][0]).toMatchObject({ category: 'eval_regression', title: 'Voice relay eval could not run' });
    expect(notify.mock.calls[0][0].body).toMatch(/child timed out/);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ subject: 'FIX: Voice relay eval could not run' }));
  });

  test('summaryLine names the failed and errored scenarios', () => {
    expect(replay.summaryLine({ scenarios: 2, passed: 1, failed: 1, failedIds: ['a'], replayErrorIds: ['b'], qualityScore: 0.5, modelRounds: 4 })).toMatch(/scenarios=2 passed=1 failed=1 .*qualityScore=50\.0% modelRounds=4 failed=\[a\] errors=\[b\]/);
  });
});
