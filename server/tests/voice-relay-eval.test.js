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
  if (order) for (const e of order) push({ turn: 1, ...e });
  else {
    for (const text of agent) push({ kind: 'agent', text, turn: 1 });
    for (const t of tools) push({ kind: 'tool', name: t.name, input: t.input || {}, text: t.text || 'ok', ok: t.ok !== false, turn: 1 });
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
    for (const s of fixture.scenarios) {
      expect(s.spec).toBeTruthy();
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
      id: 'ok-one', language: 'en', gates: {}, caller: { from: '+19415550100', verified: true, context: null }, fixtures: {},
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
    expect(runCheck(exp('tools_called_include', ['capture_lead']), r)).toMatchObject({ status: 'fail', detail: expect.stringContaining('capture_lead') });
    expect(runCheck(exp('tools_never_called', ['capture_lead']), r).status).toBe('pass');
    expect(runCheck(exp('tools_never_called', ['find_slots']), r).status).toBe('fail');
    expect(runCheck(exp('tools_called_subset_of', ['find_slots', 'request_booking', 'capture_lead']), r).status).toBe('pass');
    expect(runCheck(exp('tools_called_subset_of', ['find_slots']), r)).toMatchObject({ status: 'fail', detail: expect.stringContaining('request_booking') });
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

  test('preamble_category is skipped until the deterministic preamble table ships', () => {
    const r = record({ order: [{ kind: 'agent', text: 'Let me look that up.' }, { kind: 'tool', name: 'get_account_overview' }] });
    expect(runCheck(exp('preamble_category', { tool: 'get_account_overview', category: 'lookup' }), r)).toMatchObject({ status: 'skip', detail: expect.stringContaining('PR 5') });
  });

  test('commitment_requires_receipt: a promise needs a successful write behind it, EN and ES', () => {
    expect(runCheck(exp('commitment_requires_receipt', true), record({ agent: ['Quarterly is $129 per application.'] })).status).toBe('pass');
    const backed = record({ agent: ['A Waves team member will follow up shortly.'], tools: [{ name: 'capture_lead', ok: true }] });
    expect(runCheck(exp('commitment_requires_receipt', true), backed).status).toBe('pass');
    const unbacked = record({ agent: ['Someone will call you back this afternoon.'], tools: [{ name: 'get_pricing', ok: true }] });
    expect(runCheck(exp('commitment_requires_receipt', true), unbacked)).toMatchObject({ status: 'fail', detail: expect.stringContaining('Someone will call you back') });
    const hung = record({ agent: ['A team member will reach out.'], tools: [{ name: 'capture_lead', ok: false }] });
    expect(runCheck(exp('commitment_requires_receipt', true), hung).status).toBe('fail');
    const spanish = record({ agent: ['Un miembro del equipo le llamará mañana.'] });
    expect(runCheck(exp('commitment_requires_receipt', true), spanish).status).toBe('fail');
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
  });

  test('buildJudgePrompt puts the spec and the transcript in the user turn and the rules in the system prompt', () => {
    const { system, text } = judge.buildJudgePrompt({ required_facts: ['$129 per application'], prohibited_facts: ['a discount'], required_action: 'capture_lead', transfer_required: true, response_range: { min: 1, max: 2 }, max_words_per_agent_turn: 40 }, 'Caller: hi\nAgent: hello', { language: 'es', toolsAvailable: ['capture_lead'] });
    expect(system).toMatch(/CLAIMS MUST TRACE/);
    for (const cat of judge.FORBIDDEN_CLAIM_CATEGORIES) expect(system).toContain(cat);
    expect(text).toMatch(/required_facts:\n {2}- \$129 per application/);
    expect(text).toMatch(/transfer_required: true/);
    expect(text).toMatch(/response_range: 1-2 sentences/);
    expect(text).toMatch(/Spanish/);
    expect(text).toMatch(/Caller: hi\nAgent: hello$/);
    expect(judge.judgePromptSha()).toMatch(/^[0-9a-f]{64}$/);
  });

  test('judgeTranscript dispatches the voiceJudge policy on its lane and stamps model, provider, fallback and prompt sha', async () => {
    const MODELS = require('../config/models');
    const verdict = { pass: true, forbidden_claims: [], required_facts_missing: [], prohibited_facts_stated: [], action_taken: 'capture_lead', action_ok: true, transfer_ok: true, empathy_ok: true, brevity_ok: true, tone: 5, rationale: 'clean' };
    const dispatch = jest.fn(async () => ({ ok: true, json: verdict, text: JSON.stringify(verdict), model: 'judge-model-x', provider: 'anthropic', fallbackUsed: false }));
    const out = await judge.judgeTranscript({ spec: {}, transcript: 'Caller: hi' }, { dispatch });
    expect(dispatch).toHaveBeenCalledWith(MODELS.TEXT_POLICIES.voiceJudge, expect.objectContaining({ laneId: 'voice_relay_judge', jsonMode: true, jsonSchema: judge.JUDGE_SCHEMA, promptVersion: judge.JUDGE_PROMPT_VERSION }));
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
  const scenario = (overrides = {}) => ({
    id: 'harness-capture', language: 'en',
    gates: { context: false, booking: false, transfer: false, recovery: false, interrupt: false, streaming: false, commitments: false },
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
    const judgeFn = jest.fn(async ({ transcript, toolsAvailable }) => {
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
    expect(result.toolCalls[0].ok).toBe(true);
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

  test('a tool with no fixture response is answered neutrally and flagged; a hanging tool degrades through the live bound', async () => {
    jest.useFakeTimers({ advanceTimers: true });
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    replay.installHarness();
    script.push(toolUse('find_slots', { when: 'next week' }), say('A team member will call to find a time.'));
    const result = await replay.runScenario(scenario({ id: 'harness-unexpected', fixtures: { officeHours: 'unknown', toolResponses: {} }, turns: [{ caller: 'When can you come?' }], expect: [] }), { judge: false });
    expect(result.toolCalls[0]).toMatchObject({ name: 'find_slots', unexpected: true, ok: false });
    expect(result.warnings).toEqual([expect.stringContaining('find_slots')]);
    jest.useRealTimers();
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

  test('summaryLine names the failed and errored scenarios', () => {
    expect(replay.summaryLine({ scenarios: 2, passed: 1, failed: 1, failedIds: ['a'], replayErrorIds: ['b'], qualityScore: 0.5, modelRounds: 4 })).toMatch(/scenarios=2 passed=1 failed=1 .*qualityScore=50\.0% modelRounds=4 failed=\[a\] errors=\[b\]/);
  });
});
