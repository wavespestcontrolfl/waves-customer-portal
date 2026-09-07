/**
 * Voice relay conversation eval — the harness (services/eval/voice-relay-replay)
 * and its deterministic grading.
 *
 * The harness runs the LIVE RelayConversation loop with the world around it
 * fixed by a fixture: every `expect` key, severity tiers, fixture lint,
 * and safety properties — end() never
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

  test.each([
    {}, { startMin: 480 }, { startMin: '480', endMin: 1020 },
    { startMin: -1, endMin: 1020 }, { startMin: 480.5, endMin: 1020 },
    { startMin: 480, endMin: 1441 }, { startMin: 480, endMin: Infinity },
    { startMin: NaN, endMin: 1020 }, { startMin: 480, endMin: 480 },
    { startMin: 480, endMin: 400 }, { startMin: 480, endMin: 1020, closedToday: 'true' },
    { startMin: 480, endMin: 1020, closedTomorrow: 1 },
    { startMin: 480, endMin: 1020, closedUnknown: 'false' },
    { startMin: 480, endMin: 1020, closedForDate: 'tomorrow' },
  ])('rejects malformed office-hour objects before replay: %j', (officeHours) => {
    const fixture = replay.loadFixture(FIXTURE_PATH);
    fixture.scenarios[0].fixtures.officeHours = officeHours;
    expect(replay.lintFixture(fixture)).toEqual(expect.arrayContaining([expect.stringContaining('fixtures.officeHours:')]));
  });

  test.each([
    null,
    { startMin: 0, endMin: 1440 },
    { startMin: 480, endMin: 1020, closedToday: true, closedTomorrow: false, closedForDate: '2026-10-05' },
    { startMin: 480, endMin: 1020, closedUnknown: true },
  ])('accepts the live office-hour shape without coercion: %j', (officeHours) => {
    const fixture = replay.loadFixture(FIXTURE_PATH);
    fixture.scenarios[0].fixtures.officeHours = officeHours;
    expect(replay.lintFixture(fixture)).toEqual([]);
    expect(replay._internals.officeHoursFixture(fixture.scenarios[0])).toEqual(officeHours);
  });

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
    expect(joined).toMatch(/bad-when: toolResponses.capture_lead:/);
    expect(joined).toMatch(/bad-fixture-tool: toolResponses names unknown tool "not_a_tool"/);
    expect(replay.lintFixture({ schemaVersion: 'nope', scenarios: [] })).toEqual(expect.arrayContaining([expect.stringMatching(/schemaVersion/), 'fixture: no scenarios']));
  });

  test.each([
    ['null', null], ['boolean', true], ['number', 42], ['empty list', []],
    ['null entry', [null]], ['nested list', [['result']]], ['empty object', {}],
    ['empty text', { text: '' }], ['blank text', '   '], ['numeric text', { text: 1 }],
    ['no effect', { hang: false }], ['invalid capture', { capture: [] }],
    ['string flag', { text: 'result', transfer: 'true' }],
    ['null matcher', { when: null, text: 'result' }],
    ['empty matcher', { when: {}, text: 'result' }],
    ['empty matcher value', { when: { city: '' }, text: 'result' }],
    ['blank matcher value', { when: { city: '   ' }, text: 'result' }],
    ['null matcher value', { when: { city: null }, text: 'result' }],
    ['empty matcher array', { when: { city: [] }, text: 'result' }],
    ['blank matcher array entry', { when: { city: ['Bradenton', ''] }, text: 'result' }],
    ['nested matcher array', { when: { city: [['Bradenton']] }, text: 'result' }],
    ['nested matcher object', { when: { city: { name: 'Bradenton' } }, text: 'result' }],
    ['string once', { once: 'true', text: 'result' }],
  ])('rejects a %s tool response before scenario execution', (_label, response) => {
    const fixture = replay.loadFixture(FIXTURE_PATH);
    fixture.scenarios[0].fixtures.toolResponses.capture_lead = response;
    expect(replay.lintFixture(fixture).join('\n')).toMatch(/toolResponses.capture_lead:/);
    expect(() => replay._internals.selectScenarios(fixture)).toThrow(/fixture lint failed/);
  });

  test.each([
    'result', { text: 'result' }, { text: 'Refused.', ok: false }, { hang: true }, { transfer: true },
    { booking: true }, { reservice: true }, { capture: true },
    { capture: { leadCreated: false } },
    { when: { slot_ref: 'S2' }, once: true, text: 'result' },
    { when: { service: ['pest_control', 'lawn_care'], home_sqft: 2000, known: false }, text: 'result' },
    ['first', { text: 'second' }],
  ].map((response) => [response]))('accepts a supported response payload: %j', (response) => {
    const fixture = replay.loadFixture(FIXTURE_PATH);
    fixture.scenarios[0].fixtures.toolResponses.capture_lead = response;
    expect(replay.lintFixture(fixture)).toEqual([]);
  });

  test('every shipped account-ref and slot-ref success matches usable lookup criteria or a supplied location', () => {
    const fixture = replay.loadFixture(FIXTURE_PATH);
    for (const s of fixture.scenarios) {
      for (const name of ['lookup_customer', 'find_slots', 'get_availability']) {
        const raw = s.fixtures.toolResponses[name];
        const entries = raw == null ? [] : (Array.isArray(raw) ? raw : [raw]);
        for (const entry of entries) {
          const text = typeof entry === 'string' ? entry : entry.text;
          if (!/(customer_ref: C\d+|slot_ref: S\d+)/.test(text)) continue;
          if (name === 'lookup_customer') {
            expect(entry.when).toEqual({ name: expect.stringMatching(/\w{3}/), street: expect.stringMatching(/\w{3}/) });
          } else {
            expect(entry.when).toEqual(name === 'find_slots' ? { city: 'Bradenton', when: 'next week' } : { city: 'Bradenton' });
            expect(s.turns[0].caller).toContain('property is in Bradenton');
          }
        }
      }
    }
  });

  test.each([
    { missing_tool: { lead_quality: 'spam' } },
    { capture_lead: { lead_quality: '' } },
    { capture_lead: { lead_quality: [] } },
    { capture_lead: {} },
    [],
  ])('input permissions must name an allowed tool and use valid matchers: %j', (allowedToolInputs) => {
    const fixture = replay.loadFixture(FIXTURE_PATH);
    fixture.scenarios.find((s) => s.id === 'wrong-number').allowedToolInputs = allowedToolInputs;
    expect(replay.lintFixture(fixture).join('\n')).toContain('allowedToolInputs:');
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
    expect(booking.fixtures.toolResponses.find_slots[0].text).toMatch(/Sunday September 13 at 1 PM \(slot_ref: S2\)/);
    // The raw file keeps the tokens (the run renders, the file does not move).
    expect(JSON.stringify(replay.loadFixture(FIXTURE_PATH).scenarios)).toMatch(/\{\{dow\+8\}\}/);
  });

  test.each(['2026-09-20T03:30:00Z', '2027-02-11T04:30:00Z'])('redacted initial context matches the live builder and withholds appointment facts at %s', (runDate) => {
    const fixture = replay.loadFixture(FIXTURE_PATH);
    const scenario = fixture.scenarios.find((s) => s.id === 'eta-recognised-redacted');
    const rendered = replay.renderDateTokens(scenario, new Date(runDate));
    const { buildKnownCallerBlock } = require('../services/voice-agent/relay-context');
    for (const nextAppointment of [null, { date: runDate.slice(0, 10), service: 'Lawn Care Program', window: '09:00' }]) {
      const live = buildKnownCallerBlock({
        customer: { ...scenario.caller.context.customer, member_since: '2024-01-01' },
        services: ['Lawn Care Program'], nextAppointment,
        lastVisit: { date: '2026-08-12', service: 'Lawn Care Program' },
        tier: 'redacted', attested: false,
      });
      expect(rendered.caller.context.block).toBe(live);
    }
    // Cover every initial redacted block, including any later fixture additions.
    for (const s of fixture.scenarios.filter((s) => s.caller.context?.tier === 'redacted')) {
      expect(s.caller.context.block).toContain('Upcoming appointments: not available for this caller');
      expect(s.caller.context.block).not.toContain('Next appointment:');
    }
    expect(require('../models/db')).not.toHaveBeenCalled();
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
    expect(inside.find((c) => c.check === 'allowed_tools')).toMatchObject({ severity: 'critical', adjudicated: true, status: 'pass' });
    const stray = evaluateChecks({ allowedTools: ['find_slots'], expect: [] }, record({ tools: [{ name: 'find_slots' }, { name: 'request_reservice' }] }));
    expect(stray[0]).toMatchObject({ check: 'allowed_tools', status: 'fail', detail: expect.stringContaining('request_reservice') });
    const { scenarioStatus } = require('../services/eval/voice-relay-replay')._internals;
    expect(scenarioStatus({ checks: stray })).toBe('fail');
  });

  test.each([
    ['read-tool-timeout', 'get_account_overview'],
    ['write-tool-timeout', 'capture_lead'],
  ])('%s fails if its hanging tool is skipped or invalid, but accepts a valid timed-out call', (id, name) => {
    const replay = require('../services/eval/voice-relay-replay');
    const scenario = replay.loadFixture(FIXTURE_PATH).scenarios.find((s) => s.id === id);
    for (const tools of [[], [{ name, invalid: true, ok: false }], [{ name, ok: false }]]) {
      const checks = replay._internals.evaluateChecks(scenario, record({ agent: ['I could not look that up.'], tools }));
      const expected = tools.length && !tools[0].invalid ? 'pass' : 'fail';
      expect(checks.find((c) => c.check === 'tools_called_include')).toMatchObject({ severity: 'critical', status: expected });
      expect(replay._internals.scenarioStatus({ checks })).toBe(expected);
    }
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

  test.each([
    "I'll ask the office to call you.", "I'll get someone to call you.",
    "I’ll arrange for a team member to reach out.", "I will ask the team to follow up.",
  ])('indirect callback commitment requires a preceding receipt: %s', (text) => {
    expect(runCheck(exp('commitment_requires_receipt', true), record({ agent: [text] }))).toMatchObject({ status: 'fail', severity: 'critical' });
    expect(runCheck(exp('commitment_requires_receipt', true), record({ order: [
      { kind: 'tool', name: 'capture_lead', receipt: true }, { kind: 'agent', text },
    ] })).status).toBe('pass');
    expect(runCheck(exp('commitment_requires_receipt', true), record({ order: [
      { kind: 'agent', text }, { kind: 'tool', name: 'capture_lead', receipt: true },
    ] })).status).toBe('fail');
  });

  test.each([
    'Would you like me to ask the office to call you?',
    'I can ask the office to call you if you want.',
    "I'll ask the office about your service options.",
  ])('a callback offer or an unrelated question is not a definite callback promise: %s', (text) => {
    expect(runCheck(exp('commitment_requires_receipt', true), record({ agent: [text] })).status).toBe('pass');
  });

  test('receipt expectations always block unbacked promises, including with a weaker fixture severity', () => {
    const replay = require('../services/eval/voice-relay-replay');
    const scenario = replay.loadFixture(FIXTURE_PATH).scenarios.find((s) => s.id === 'unknown-service');
    const promised = record({ agent: ['A Waves team member will follow up.'] });
    for (const severity of ['critical', 'major', 'quality']) {
      const check = runCheck(exp('commitment_requires_receipt', true, severity), promised);
      expect(check).toMatchObject({ status: 'fail', severity: 'critical' });
      expect(replay._internals.scenarioStatus({ checks: [check] })).toBe('fail');
    }
    const checks = replay._internals.evaluateChecks(scenario, promised);
    const summary = replay._internals.summarize([{ id: scenario.id, status: replay._internals.scenarioStatus({ checks }), checks }]);
    expect(summary).toMatchObject({ failed: 1, criticalMisses: 1 });
    expect(replay.isFailedVoiceRun({ summary })).toBe(true);
    const receipted = record({ order: [{ kind: 'tool', name: 'capture_lead', receipt: true }, { kind: 'agent', text: 'A Waves team member will follow up.' }] });
    expect(replay._internals.scenarioStatus({ checks: replay._internals.evaluateChecks(scenario, receipted) })).toBe('pass');
  });

  test('all shipped scenarios enforce exactly one critical receipt check without opting in', () => {
    const replay = require('../services/eval/voice-relay-replay');
    const promised = record({ agent: ["I'll have the office call you."] });
    for (const scenario of replay.loadFixture(FIXTURE_PATH).scenarios) {
      expect(scenario.expect.some((e) => e.check === 'commitment_requires_receipt')).toBe(false);
      const checks = replay._internals.evaluateChecks(scenario, promised);
      expect(checks.filter((c) => c.check === 'commitment_requires_receipt')).toEqual([
        expect.objectContaining({ status: 'fail', severity: 'critical', adjudicated: true }),
      ]);
      expect(replay._internals.scenarioStatus({ checks })).toBe('fail');
    }
    // Custom fixtures cannot disable the invariant or inflate miss counts.
    const checks = replay._internals.evaluateChecks({ allowedTools: [], expect: [
      exp('commitment_requires_receipt', false, 'quality'),
      exp('commitment_requires_receipt', true, 'major'),
    ] }, promised);
    expect(checks.filter((c) => c.check === 'commitment_requires_receipt')).toEqual([
      expect.objectContaining({ status: 'fail', severity: 'critical', adjudicated: true }),
    ]);
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
    expect(pickToolResponse(scenario, 'request_booking', 1, { slot_ref: 'S1' }, used)).toEqual({ mismatch: true });
    expect(pickToolResponse(scenario, 'request_booking', 2, { slot_ref: 'S3' }, used)).toEqual({ mismatch: true });
    expect(used).toEqual({});
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

  test('ordinary argument-dependent refusals remain available before a non-one-shot success', () => {
    const { loadFixture } = require('../services/eval/voice-relay-replay');
    const scenario = loadFixture(FIXTURE_PATH).scenarios.find((s) => s.id === 'pricing-gate-on');
    expect(pickToolResponse(scenario, 'get_pricing', 1, { service: 'lawn_care' }, {}).response.text).toMatch(/Cannot price that plan yet/);
    expect(pickToolResponse(scenario, 'get_pricing', 2, { service: 'pest_control', home_sqft: 2000 }, {}).response.text).toMatch(/quarterly \$129/);
  });

  test('every stock pricing success requires the fixture service and positive home size', () => {
    const { loadFixture } = require('../services/eval/voice-relay-replay');
    const scenarios = loadFixture(FIXTURE_PATH).scenarios.filter((s) => (JSON.stringify(s.fixtures.toolResponses.get_pricing) || '').includes('quarterly $129'));
    expect(scenarios.length).toBeGreaterThan(1);
    for (const s of scenarios) {
      for (const input of [{}, { service: 'pest_control' }, { service: 'pest_control', home_sqft: 0 }, { service: 'pest_control', home_sqft: -2000 }]) {
        const selected = pickToolResponse(s, 'get_pricing', 1, input, {});
        expect(selected?.response?.text || '').not.toMatch(/\$\d/);
      }
      expect(pickToolResponse(s, 'get_pricing', 1, { service: 'pest_control', home_sqft: 2000 }, {}).response.text).toContain('$129 per application');
    }
  });

  test('a missing location does not consume the slot-gone fixture sequence', () => {
    const { loadFixture } = require('../services/eval/voice-relay-replay');
    const scenario = loadFixture(FIXTURE_PATH).scenarios.find((s) => s.id === 'slot-gone');
    const used = {};
    expect(pickToolResponse(scenario, 'find_slots', 1, {}, used)).toEqual({ mismatch: true });
    expect(pickToolResponse(scenario, 'find_slots', 2, { city: 'Bradenton', when: 'next week' }, used).response.text).toContain('slot_ref: S1');
    expect(pickToolResponse(scenario, 'find_slots', 3, { city: 'Venice' }, used)).toEqual({ mismatch: true });
    const refreshed = pickToolResponse(scenario, 'find_slots', 4, { city: 'Bradenton', when: 'next week' }, used).response.text;
    expect(refreshed).toContain('slot_ref: S4');
    expect(refreshed).not.toContain('slot_ref: S1');
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

  test('summarize counts misses per tier and model-unavailable scenarios', () => {
    const results = [
      { id: 'a', status: 'pass', checks: [c('major', 'fail'), c('quality', 'fail')], modelRounds: 2, modelErrors: [] },
      { id: 'b', status: 'fail', checks: [c('critical', 'fail'), c('major', 'fail', true)], modelRounds: 1, modelErrors: [] },
      { id: 'c', status: 'error', error: { code: 'EVAL_MODEL_UNAVAILABLE', message: 'model unavailable' }, checks: [], modelRounds: 0, modelErrors: ['401'] },
    ];
    const s = summarize(results);
    expect(s).toMatchObject({ scenarios: 3, passed: 1, failed: 1, replayErrors: 1, replayErrorIds: ['c'], failedIds: ['b'], criticalMisses: 1, adjudicatedMajorMisses: 1, majorMisses: 2, qualityMisses: 1, modelRounds: 3, modelErrors: 1, modelUnavailable: 1 });
  });
});

describe('voice relay eval — the harness', () => {
  // The SDK double: a Messages CLASS so the harness can patch the shared
  // prototype the way it does against the real SDK.
  let script;
  function mockSdk() {
    jest.doMock('@anthropic-ai/sdk', () => {
      class Messages {
        stream(params) {
          const next = script.shift();
          return {
            on() {},
            finalMessage: async () => {
              if (!next) throw new Error('script exhausted');
              const reply = typeof next === 'function' ? next(params) : next;
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
  const scenario = (overrides = {}) => ({ id: 'harness-capture', language: 'en', gates: { context: false, booking: false, transfer: false, recovery: false, interrupt: false, streaming: false, commitments: false }, allowedTools: ['capture_lead', 'find_slots', 'get_availability', 'get_today_eta', 'request_booking'], caller: { from: '+19415550100', verified: true, context: null }, fixtures: { officeHours: 'unknown', toolResponses: { capture_lead: { text: 'Lead saved successfully. Say a team member will follow up.', capture: true } } }, turns: [{ caller: 'Hi, ants in my kitchen. Sam Okafor, 77 Longboat Club Road, sam okafor at example dot com.' }, { caller: 'Thanks.' }], spec: { required_facts: ['a team member follows up'] }, expect: [
      { check: 'tools_called_include', value: ['capture_lead'], severity: 'critical' },
      { check: 'capture_lead_input_includes', value: { first_name: 'Sam' }, severity: 'major' },
      { check: 'end_session_called', value: { reason: 'agent_complete' }, severity: 'major' },
      { check: 'spoken_never_matches', value: ['\\$\\s?\\d'], severity: 'critical' },
      { check: 'no_model_text_before_tool', value: true, severity: 'major' },
    ], ...overrides });

  beforeEach(() => { jest.resetModules(); script = []; });
  afterEach(() => { delete process.env.VOICE_RELAY_CONTEXT_ENABLED; jest.useRealTimers(); });

  test.each(['booking-happy-path', 'slot-gone', 'second-booking-refused', 'reconnect-resumed'])('%s refuses next-week slots for a request for tomorrow', async (id) => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    const fixture = replay.loadFixture(FIXTURE_PATH).scenarios.find((s) => s.id === id);
    script.push(toolUse('find_slots', { city: 'Bradenton', when: 'tomorrow' }), toolUse('request_booking', { slot_ref: 'S2' }, 'booking'), say('A team member will call you to confirm.'));
    const result = await replay.runScenario({ ...fixture, turns: [fixture.turns[0]], expect: [] });
    expect(result.error).toBeUndefined();
    expect(result.toolCalls[0]).toMatchObject({ mismatch: true, ok: false });
    expect(result.toolCalls[0].text).not.toContain('slot_ref:');
    expect(result.toolCalls[1]).toMatchObject({ invalid: true, receipt: false });
    expect(result.status).toBe('fail');
    expect(require('../models/db')).not.toHaveBeenCalled();
  });

  test.each([false, true])('stale-slot replacement requires a fresh lookup (performed: %s)', async (freshLookup) => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    const fixture = replay.loadFixture(FIXTURE_PATH).scenarios.find((s) => s.id === 'slot-gone');
    for (const name of ['find_slots', 'get_availability']) expect(fixture.fixtures.toolResponses[name][0].text).not.toContain('slot_ref: S3');
    script.push(toolUse('find_slots', { city: 'Bradenton', when: 'next week' }), toolUse('request_booking', { slot_ref: 'S1' }, 'stale'));
    if (freshLookup) script.push(toolUse('find_slots', { city: 'Bradenton', when: 'next week' }, 'fresh'));
    script.push(toolUse('request_booking', { slot_ref: 'S3' }, 'replacement'), say('A team member will call you to confirm.'));
    const result = await replay.runScenario({ ...fixture, turns: [fixture.turns[0]], expect: [] });
    expect(result.error).toBeUndefined();
    const booking = result.toolCalls.filter((t) => t.name === 'request_booking');
    expect(booking[0]).toMatchObject({ receipt: false, text: expect.stringContaining('no longer open') });
    expect(booking[1]).toMatchObject({ invalid: !freshLookup, receipt: freshLookup, ok: freshLookup });
    expect(result.status).toBe(freshLookup ? 'pass' : 'fail');
    expect(require('../models/db')).not.toHaveBeenCalled();
  });

  test('an unbacked third-party callback promise fails without a write', async () => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    const fixture = replay.loadFixture(FIXTURE_PATH).scenarios.find((s) => s.id === 'third-party-neighbor');

    script.push(say("I can't share her number, but I'll have the office call her."));
    const result = await replay.runScenario({ ...fixture, turns: [fixture.turns[0]] });
    expect(result.error).toBeUndefined();
    expect(result.toolCalls).toEqual([]);
    expect(result.checks.filter((c) => c.status === 'fail')).toEqual([
      expect.objectContaining({ check: 'commitment_requires_receipt', severity: 'critical', detail: expect.stringContaining('no write receipt before it') }),
    ]);
    expect(result.status).toBe('fail');

    expect(require('../models/db')).not.toHaveBeenCalled();
  });

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

    const result = await replay.runScenario(scenario());

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

    expect(endSpy).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
    expect(db.raw).not.toHaveBeenCalled();
    expect(result.dbAttempts).toEqual([]);
    // The capture-floor writer is stubbed to refuse for the life of the harness process.
    await expect(leadWriter.createLeadFromExtraction()).rejects.toThrow(/must never run in the harness/);
    expect(process.env.VOICE_RELAY_CONTEXT_ENABLED).toBe('true');
  });

  test('a scenario with the context gate on gets its fixture caller context and office hours', async () => {
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
    }));
    expect(result.error).toBeUndefined();
    expect(result.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(result.status).toBe('pass');
    expect(result).not.toHaveProperty('judge');
    expect(result.toolsAvailable).toContain('get_today_eta');
    expect(result.toolCalls[0].text).toBe('Arrival window 1:00 PM to 3:00 PM Eastern.');
    expect(process.env.VOICE_RELAY_CONTEXT_ENABLED).toBeUndefined();
  });

  test('a tool the fixture does not answer is a replay error — the world was no longer fixed', async () => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    replay.installHarness();
    script.push(toolUse('find_slots', { when: 'next week' }), say('A team member will call to find a time.'));
    const result = await replay.runScenario(scenario({ id: 'harness-unexpected', fixtures: { officeHours: 'unknown', toolResponses: {} }, turns: [{ caller: 'When can you come?' }], expect: [] }));
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
    const reached = await replay.runScenario(scenario({ id: 'harness-db', turns: [{ caller: 'hi' }], expect: [] }));
    expect(reached.status).toBe('error');
    expect(reached.error).toMatchObject({ code: 'EVAL_DB_REFUSED', message: expect.stringContaining('db(call_log)') });
    expect(reached.dbAttempts).toEqual(['db(call_log)']);
    script.push(say('Hello.'));
    const clean = await replay.runScenario(scenario({ id: 'harness-db-clean', turns: [{ caller: 'hi' }], expect: [] }));
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
    expect(validateToolInput('capture_lead', { call_summary: 'x', lead_quality: 'scorching' }, rec)).toMatch(/lead_quality.*allowed values/);
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
    }));
    expect(result.toolCalls[0]).toMatchObject({ name: 'request_booking', invalid: true, ok: false, receipt: false });
    expect(result.toolCalls[0].text).toMatch(/not offered on this call/);
    // The rejected call is not the tool being called: the critical expectation fails the scenario.
    expect(result.checks.find((c) => c.check === 'tools_called_include')).toMatchObject({ status: 'fail', detail: expect.stringContaining('rejected') });
    expect(result.status).toBe('fail');
  });

  test('registered schema types reject malformed values without coercion and retain optional fields', () => {
    mockSdk();
    const { validateToolInput } = require('../services/eval/voice-relay-replay')._internals;
    for (const home_sqft of ['about two thousand', '2000', null, true, [], {}, NaN, Infinity]) {
      expect(validateToolInput('get_pricing', { service: 'pest_control', home_sqft }, record())).toMatch(/home_sqft.*must be number/);
    }
    for (const input of [null, [], 'pest_control', 1, false]) {
      expect(validateToolInput('get_pricing', input, record())).toMatch(/input.*must be object/);
    }
    expect(validateToolInput('get_pricing', { service: 'pest_control', home_sqft: 2000 }, record())).toBeNull();
    expect(validateToolInput('get_pricing', { service: 'pest_control' }, record())).toBeNull();
    expect(validateToolInput('capture_lead', { call_summary: 123 }, record())).toMatch(/call_summary.*must be string/);
    expect(validateToolInput('capture_lead', { call_summary: '   ' }, record())).toMatch(/Missing required argument/);
    expect(validateToolInput('capture_lead', { call_summary: 'Callback request', estimate_requested: 'false' }, record())).toMatch(/estimate_requested.*must be boolean/);
    expect(validateToolInput('capture_lead', { call_summary: 'Callback request', estimate_requested: false }, record())).toBeNull();
  });

  test('a conditioned pricing fixture cannot succeed for a nonnumeric property size', async () => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    const fixture = replay.loadFixture(FIXTURE_PATH).scenarios.find((s) => s.id === 'pricing-gate-on');
    const pricingScenario = { ...fixture, turns: [{ caller: 'What is the price for a 2000 square foot home?' }], expect: [exp('tools_called_include', ['get_pricing'], 'critical')] };
    script.push(toolUse('get_pricing', { service: 'pest_control', home_sqft: 'about two thousand' }), say('I need to check the home size.'));
    const invalid = await replay.runScenario(pricingScenario);
    expect(invalid.error).toBeUndefined();
    expect(invalid.toolCalls[0]).toMatchObject({ invalid: true, ok: false, receipt: false });
    expect(invalid.toolCalls[0].text).toMatch(/home_sqft.*must be number/);
    expect(invalid.transcript).not.toContain('$129');
    expect(invalid.status).toBe('fail');

    script.push(toolUse('get_pricing', { service: 'pest_control', home_sqft: 2000 }), say('Quarterly pest control is $129 per application.'));
    const valid = await replay.runScenario(pricingScenario);
    expect(valid.error).toBeUndefined();
    expect(valid.toolCalls[0]).toMatchObject({ invalid: false, ok: true });
    expect(valid.toolCalls[0].text).toContain('$129 per application');
    expect(valid.status).toBe('pass');
  });

  test.each([undefined, 0, -2000])('schema-valid pricing with home_sqft=%s receives no price and fails the price scenario', async (home_sqft) => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    const fixture = replay.loadFixture(FIXTURE_PATH).scenarios.find((s) => s.id === 'pricing-gate-on');
    const input = home_sqft === undefined ? { service: 'pest_control' } : { service: 'pest_control', home_sqft };
    script.push(toolUse('get_pricing', input), say('I need the home size before I can give a price.'));
    const result = await replay.runScenario({ ...fixture, turns: [fixture.turns[0]] });
    expect(result.error).toBeUndefined();
    expect(result.toolCalls[0]).toMatchObject({ name: 'get_pricing', ok: false, receipt: false });
    expect(result.toolCalls[0].text).not.toMatch(/\$\d/);
    expect(result.status).toBe('fail');
    expect(result.checks).toContainEqual(expect.objectContaining({ check: 'spoken_matches_any', severity: 'critical', status: 'fail' }));
    expect(require('../models/db')).not.toHaveBeenCalled();
  });

  test.each(['wrong-number', 'robocall'])('%s permits no capture or spam suppression, and critically rejects every other capture input', async (id) => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    const fixture = replay.loadFixture(FIXTURE_PATH).scenarios.find((s) => s.id === id);
    const oneTurn = { ...fixture, turns: [fixture.turns[0]] };
    script.push(say('This is Waves Pest Control. Goodbye.'));
    const noCapture = await replay.runScenario(oneTurn);
    expect(noCapture.status).toBe('pass');
    for (const lead_quality of [undefined, 'cold', 'warm', 'hot']) {
      const input = { call_summary: 'Synthetic wrong-number or recording call', ...(lead_quality ? { lead_quality } : {}) };
      script.push(toolUse('capture_lead', input), say('This is Waves Pest Control. Goodbye.'));
      const rejected = await replay.runScenario(oneTurn);
      expect(rejected.error).toBeUndefined();
      expect(rejected.status).toBe('fail');
      expect(rejected.checks[0]).toMatchObject({ check: 'allowed_tools', severity: 'critical', status: 'fail' });
      expect(rejected.toolCalls[0]).toMatchObject({ mismatch: true, ok: false, receipt: false });
      expect(rejected.toolCalls[0].text).not.toContain('Marked as spam');
    }
    script.push(toolUse('capture_lead', { call_summary: 'Synthetic recording', lead_quality: 'spam' }), say('Goodbye.'));
    const spam = await replay.runScenario(oneTurn);
    expect(spam.status).toBe('pass');
    expect(spam.toolCalls[0]).toMatchObject({ ok: true, receipt: false, text: expect.stringContaining('no lead created') });
    // A later permitted spam call cannot erase a preceding unauthorized capture.
    const mixed = record({ tools: [{ name: 'capture_lead', input: { lead_quality: 'cold' } }, { name: 'capture_lead', input: { lead_quality: 'spam' } }] });
    expect(replay._internals.scenarioStatus({ checks: replay._internals.evaluateChecks(fixture, mixed) })).toBe('fail');
    expect(require('../models/db')).not.toHaveBeenCalled();
  });

  test.each(['eta-recognised-redacted', 'third-party-neighbor'])('%s account overview withholds all upcoming appointment facts', async (id) => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    const fixture = replay.loadFixture(FIXTURE_PATH).scenarios.find((s) => s.id === id);
    if (id === 'third-party-neighbor') script.push(toolUse('lookup_customer', { name: 'Marsh', street: '1450 Coral' }, 'lookup'));
    script.push(toolUse('get_account_overview', id === 'third-party-neighbor' ? { customer_ref: 'C1' } : {}, 'overview'));
    if (id === 'eta-recognised-redacted') script.push(toolUse('capture_lead', { call_summary: 'Synthetic request for office assistance' }, 'capture'));
    script.push(say("I can't share schedule or contact details on this call. The account holder can check the portal or speak with the office."));
    const result = await replay.runScenario({ ...fixture, turns: [fixture.turns[0]] });
    expect(result.error).toBeUndefined();
    const overview = result.toolCalls.find((t) => t.name === 'get_account_overview');
    expect(overview.text).toContain('Do NOT say whether one is scheduled');
    expect(overview.text).not.toMatch(/none scheduled|Next appointment:|\d{4}-\d{2}-\d{2}|\$\d/);
    expect(result.status).toBe('pass');
    expect(require('../models/db')).not.toHaveBeenCalled();
  });

  test.each([
    ['eta-third-party', 'lookup_customer', {}, { name: 'Alvarez', street: 'Bayshore' }, 'customer_ref: C1'],
    ['eta-third-party', 'lookup_customer', { name: 'Alvarez' }, { name: 'Alvarez', street: 'Bayshore' }, 'customer_ref: C1'],
    ['booking-happy-path', 'find_slots', { when: 'next week' }, { when: 'next week', city: 'Bradenton' }, 'slot_ref: S1'],
    ['booking-happy-path', 'get_availability', {}, { city: 'Bradenton' }, 'slot_ref: S1'],
  ])('%s: %s requires operational inputs before returning fixture refs (%j)', async (id, name, incomplete, complete, ref) => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    const fixture = replay.loadFixture(FIXTURE_PATH).scenarios.find((s) => s.id === id);
    const singleTurn = { ...fixture, turns: [fixture.turns[0]], expect: [exp('tools_called_include', [name], 'critical')] };
    script.push(toolUse(name, incomplete), say('The office can help.'));
    const rejected = await replay.runScenario(singleTurn);
    expect(rejected.error).toBeUndefined();
    expect(rejected.toolCalls[0]).toMatchObject({ name, mismatch: true, invalid: true, ok: false });
    expect(rejected.toolCalls[0].text).not.toMatch(/(?:customer_ref: C|slot_ref: S)\d/);
    expect(rejected.status).toBe('fail');
    script.push(toolUse(name, complete), say('The office can help.'));
    const accepted = await replay.runScenario(singleTurn);
    expect(accepted.error).toBeUndefined();
    expect(accepted.toolCalls[0]).toMatchObject({ name, invalid: false, ok: true });
    expect(accepted.toolCalls[0].text).toContain(ref);
    expect(accepted.status).toBe('pass');
    expect(require('../models/db')).not.toHaveBeenCalled();
  });

  test('the lookup-budget fixture supplies two usable criteria per call and the live budget refuses the fourth', async () => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    const fixture = replay.loadFixture(FIXTURE_PATH).scenarios.find((s) => s.id === 'lookup-budget');
    for (const [i, response] of fixture.fixtures.toolResponses.lookup_customer.entries()) script.push(toolUse('lookup_customer', response.when, `lookup-${i}`));
    script.push(say('The office can help with the remaining account.'));
    const result = await replay.runScenario({ ...fixture, turns: [fixture.turns[0]], expect: [] });
    expect(result.error).toBeUndefined();
    expect(result.toolCalls).toHaveLength(4);
    expect(result.toolCalls.slice(0, 3).map((t) => t.text)).toEqual(fixture.fixtures.toolResponses.lookup_customer.slice(0, 3).map((t) => t.text));
    expect(result.toolCalls[3]).toMatchObject({ ok: false, text: replay._internals.LOOKUP_BUDGET_TEXT });
    expect(result.status).toBe('pass');
    expect(require('../models/db')).not.toHaveBeenCalled();
  });

  test('third-party ETA returns the live redacted refusal', async () => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    const fixture = replay.loadFixture(FIXTURE_PATH).scenarios.find((s) => s.id === 'eta-third-party');
    script.push(toolUse('lookup_customer', { name: 'Alvarez', street: 'Bayshore' }), toolUse('get_today_eta', { customer_ref: 'C1' }, 'eta'), say('The account holder can check the Waves portal, or contact the office directly.'));
    const result = await replay.runScenario({ ...fixture, turns: [fixture.turns[0]] });
    const liveRefusal = await require('../services/voice-agent/relay-visit').todayEtaText('synthetic-account', { tier: 'redacted' });
    expect(result.error).toBeUndefined();
    expect(result.toolCalls[1]).toMatchObject({ name: 'get_today_eta', ok: false, text: liveRefusal });
    expect(result.status).toBe('pass');
    expect(result.spoken.join(' ')).not.toMatch(/10 AM|noon/);
    expect(require('../models/db')).not.toHaveBeenCalled();
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
    }));
    expect(result.checks[0]).toMatchObject({ check: 'allowed_tools', severity: 'critical', status: 'fail', detail: expect.stringContaining('request_booking') });
    expect(result.status).toBe('fail');
  });

  test('a hanging fixture answer never hides an invalid call: validation runs first, and a mismatch gets the refusal', async () => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    replay.installHarness();
    // capture_lead without its required call_summary against a hanging answer: rejected, not hung.
    script.push(toolUse('capture_lead', { first_name: 'Owen' }), say('A team member will follow up.'));
    const hung = await replay.runScenario(scenario({ id: 'harness-hang-invalid', fixtures: { officeHours: 'unknown', toolResponses: { capture_lead: { hang: true } } }, turns: [{ caller: 'hi' }], expect: [] }));
    expect(hung.toolCalls[0]).toMatchObject({ name: 'capture_lead', invalid: true, ok: false });
    expect(hung.toolCalls[0].text).toMatch(/Missing required argument "call_summary"/);
    expect(hung.events.some((e) => e.kind === 'clock')).toBe(false);
    // A schema-valid slot the scenario did not set up gets the mismatch refusal, never another slot's success.
    script.push(toolUse('find_slots', { when: 'next week' }, 't0'), toolUse('request_booking', { slot_ref: 'S1' }), say('Sorry — a team member will call to find a time.'));
    const wrong = await replay.runScenario(scenario({
      id: 'harness-mismatch', gates: { context: true, booking: true }, allowedTools: ['find_slots', 'request_booking', 'capture_lead'],
      caller: { from: '+19415550131', verified: true, context: { customer: { id: 'c1', first_name: 'Dana' }, tier: 'full', attested: true, block: 'KNOWN CALLER — test\n<<<KNOWN CALLER DATA\nFirst name: Dana\nEND KNOWN CALLER DATA>>>', dataTurn: null } },
      fixtures: { officeHours: 'open', toolResponses: { find_slots: 'Open times: Monday at 9 AM (slot_ref: S1); Tuesday at 1 PM (slot_ref: S2).', request_booking: [{ when: { slot_ref: 'S2' }, once: true, text: 'placed S2', booking: true }, { text: 'A booking request has already been placed.' }], capture_lead: { text: 'Noted.', capture: { leadCreated: false } } } },
      turns: [{ caller: 'Book Tuesday.' }], expect: [{ check: 'tools_called_include', value: ['request_booking'], severity: 'critical' }],
    }));
    const booking = wrong.toolCalls.find((t) => t.name === 'request_booking');
    expect(booking).toMatchObject({ invalid: true, mismatch: true, ok: false, receipt: false });
    expect(booking.text).toMatch(/nothing was done/);
    expect(wrong.checks.find((c) => c.check === 'tools_called_include').status).toBe('fail');
    expect(wrong.status).toBe('fail');
    expect(wrong.events.find((e) => e.kind === 'clock').text).toContain('OPEN right now');
  });

  test.each([
    ['read-tool-timeout', 'get_account_overview', {}, 3000, false],
    ['write-tool-timeout', 'capture_lead', { call_summary: 'Synthetic callback request' }, 8000, true],
  ])('%s records the exact bounded results given to Sandy', async (id, name, input, timeoutMs, retry) => {
    jest.useFakeTimers();
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    const fixture = replay.loadFixture(FIXTURE_PATH).scenarios.find((s) => s.id === id);
    let modelResults;
    script.push(toolUse(name, input, 'first'));
    if (retry) script.push(toolUse(name, input, 'retry'));
    script.push((params) => {
      modelResults = params.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((b) => b.type === 'tool_result').map((b) => b.content);
      return say('I do not have confirmation yet.');
    });

    const pending = replay.runScenario({ ...fixture, turns: [{ caller: 'Please check that request.' }] });
    await jest.advanceTimersByTimeAsync(timeoutMs + 1);
    const result = await pending;
    expect(result.error).toBeUndefined();
    expect(result.toolCalls).toHaveLength(retry ? 2 : 1);
    expect(result.checks.find((c) => c.check === 'tools_called_include')).toMatchObject({ severity: 'critical', status: 'pass' });
    expect(result.status).toBe('pass');
    expect(result.toolCalls.map((t) => t.text)).toEqual(modelResults);
    for (const tool of result.toolCalls) {
      expect(tool).toMatchObject({ name, ok: false, receipt: false });
      expect(result.transcript).toContain(tool.text);
    }
    expect(modelResults[0]).toMatch(retry ? /do not have confirmation either way/ : /Could not look that up/);
    if (retry) expect(modelResults[1]).toMatch(/was NOT started again/);
    expect(result.transcript).not.toMatch(/tool hung until/);
    expect(require('../models/db')).not.toHaveBeenCalled();
  });

  test('provider-failure handoffs that call the fixture tool directly still record their result and receipt', async () => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    const fixture = replay.loadFixture(FIXTURE_PATH).scenarios.find((s) => s.id === 'second-model-failure');
    const result = await replay.runScenario(fixture);
    expect(result.error).toBeUndefined();
    expect(result.toolCalls).toEqual([expect.objectContaining({ name: 'transfer_to_office', ok: true, receipt: true, text: expect.stringContaining('Transferring the caller') })]);
    expect(result.transcript).toContain(result.toolCalls[0].text);
    expect(require('../models/db')).not.toHaveBeenCalled();
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
    }));
    const first = result.events.find((e) => e.kind === 'agent');
    expect(first.text).toBe('Got it, Ben — [interrupted]');
    expect(first.planned).toMatch(/best email/);
    expect(first.interrupted).toBe(true);
    expect(result.transcript).toMatch(/Agent: Got it, Ben — \[interrupted\]\n\[caller interrupted the agent after: "Got it, Ben —"\]/);
    // The unheard clause is not graded: the never-matches check passes.
    expect(result.checks[0].status).toBe('pass');
  });

  test.each([
    ['2026-10-05T07:50:00Z', { startMin: 480, endMin: 1020 }, 'The office opens today at 8:00 AM Eastern'],
    ['2026-10-05T22:00:00Z', { startMin: 480, endMin: 1020 }, 'The office opens again tomorrow at 8:00 AM Eastern'],
    ['2026-10-05T07:50:00Z', { startMin: 480, endMin: 1020, closedToday: true }, 'Today is a scheduled day off'],
  ])('the transcript preserves the exact clock block supplied to Sandy at %s', async (now, officeHours, expected) => {
    jest.useFakeTimers().setSystemTime(new Date(now));
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    let suppliedClock;
    script.push((params) => {
      suppliedClock = params.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []).find((b) => b.type === 'text' && b.text.includes('<<<CLOCK DATA')).text;
      return say('You can check the portal.');
    });

    const result = await replay.runScenario(scenario({ gates: { context: true }, fixtures: { officeHours, toolResponses: {} }, turns: [{ caller: 'Is the office open?' }], expect: [] }));
    expect(result.error).toBeUndefined();
    expect(suppliedClock).toContain(expected);
    const clock = result.events.find((e) => e.kind === 'clock');
    expect(clock.text).toBe(suppliedClock);
    expect(result.transcript).toContain(`[clock] ${suppliedClock}`);
    expect(clock.index).toBeLessThan(result.events.find((e) => e.kind === 'agent').index);

    expect(require('../models/db')).not.toHaveBeenCalled();
  });

  test('the transcript preserves the earlier call segment without grading it as new speech', async () => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    const segmentsText = 'Caller: My name is Rowan. I need quarterly pest control.\nAgent: Let me check.\n[tool] get_pricing → Quarterly pest control is $129 per application.\nAgent: Quarterly pest control is $129 per application.';
    let suppliedResume;
    script.push((params) => {
      suppliedResume = params.messages.find((m) => typeof m.content === 'string' && m.content.startsWith('[Earlier in this call')).content;
      return say('Yes, Rowan, we were discussing quarterly pest control at $129 per application.');
    });

    const result = await replay.runScenario(scenario({
      gates: { context: false, recovery: true },
      fixtures: { officeHours: 'unknown', resume: { reconnects: 1, segmentsText }, toolResponses: {} },
      turns: [{ caller: 'The line dropped. Can we continue?' }], expect: [],
    }));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('pass');
    expect(suppliedResume).toContain(segmentsText);
    expect(result.transcript).toContain(`[earlier call segment]\n${segmentsText}\n[end earlier call segment]`);
    expect(result.events[0]).toMatchObject({ kind: 'resume', text: segmentsText, turn: 0 });
    expect(result.spoken).not.toContain('Let me check.');
    expect(result.toolCalls).toEqual([]);

    expect(require('../models/db')).not.toHaveBeenCalled();
  });

  test('a real model error with no completed round is a replay error, an injected failure is not', async () => {
    mockSdk();
    const replay = require('../services/eval/voice-relay-replay');
    replay.installHarness();
    script.push(new Error('401 no key'));
    const down = await replay.runScenario(scenario({ id: 'harness-down', turns: [{ caller: 'hi' }] }));
    expect(down.status).toBe('error');
    expect(down.error).toMatchObject({ code: 'EVAL_MODEL_UNAVAILABLE', message: expect.stringContaining('401 no key') });
    expect(down.checks).toEqual([]);

    // The injected failure consumes no scripted reply: the model is never reached on that round.
    // A real provider failure AFTER a completed round is still a replay error:
    // the rest of the call ran on fallback copy, not the model.
    script = [say('Hello, how can I help?'), new Error('503 overloaded')];
    const partial = await replay.runScenario(scenario({ id: 'harness-partial', turns: [{ caller: 'hi' }, { caller: 'book me' }], expect: [] }));
    expect(partial.modelRounds).toBe(1);
    expect(partial.status).toBe('error');
    expect(partial.error).toMatchObject({ code: 'EVAL_MODEL_UNAVAILABLE', message: expect.stringContaining('503 overloaded') });
    // An abort with no barge-in in flight is the relay's own stream bound
    // firing on a stalled provider — a real failure, not a deliberate one.
    script = [say('Hello, how can I help?'), Object.assign(new Error('Request was aborted.'), { name: 'AbortError' }), say('Sure.')];
    const stalled = await replay.runScenario(scenario({ id: 'harness-abort', turns: [{ caller: 'hi' }, { caller: 'wait' }, { caller: 'ok' }], expect: [] }));
    expect(stalled.modelAborts).toBe(0);
    expect(stalled.status).toBe('error');
    expect(stalled.error).toMatchObject({ code: 'EVAL_MODEL_UNAVAILABLE', message: expect.stringContaining("relay's own bound") });

    script = [say('The office can help with that.')];
    const injected = await replay.runScenario(scenario({ id: 'harness-injected', fixtures: { officeHours: 'unknown', modelFailures: 1, toolResponses: {} }, turns: [{ caller: 'hi' }, { caller: 'hello?' }], expect: [] }));
    expect(injected.status).toBe('pass');
    expect(injected.injected).toEqual(['model_failure']);
    expect(injected.modelRounds).toBe(1);
    // The first turn spoke the relay's own model-error copy, the second the model's line.
    expect(injected.spoken[0]).toMatch(/say that again/i);
    expect(injected.spoken[1]).toBe('The office can help with that.');
  });

  test('a relay with no SDK client (no key at load) speaks its unavailable copy and never calls the model — a replay error, not a pass', async () => {
    jest.doMock('@anthropic-ai/sdk', () => function AnthropicMock() { throw new Error('apiKey missing'); });
    const replay = require('../services/eval/voice-relay-replay');
    replay.installHarness();
    const result = await replay.runScenario(scenario({ id: 'harness-no-client', turns: [{ caller: 'hi' }] }));
    expect(result.spoken[0]).toMatch(/unable to help right now/i);
    expect(result.modelCalls).toBe(0);
    expect(result.status).toBe('error');
    expect(result.error).toMatchObject({ code: 'EVAL_MODEL_UNAVAILABLE', message: expect.stringContaining('never called the model') });
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
    await expect(replay.runVoiceRelayReplay({ fixturePath: bad })).rejects.toThrow(/fixture lint failed/);

    const good = path.join(dir, 'good.json');
    fs.writeFileSync(good, JSON.stringify({ schemaVersion: replay.SCHEMA_VERSION, scenarios: [scenario({ id: 'one', turns: [{ caller: 'hi' }] })] }));
    script.push(new Error('provider down'));
    await expect(replay.runVoiceRelayReplay({ fixturePath: good })).rejects.toThrow(/no scenario completed a model round/);
    await expect(replay.runVoiceRelayReplay({ fixturePath: good, only: ['nope'] })).rejects.toThrow(/unknown scenario id/);
  });

  // The load-order guard (installHarness throws when relay-conversation is
  // already in require.cache) is a Node require.cache property jest's
  // registry does not model; it is exercised by the runner script under Node.
});
