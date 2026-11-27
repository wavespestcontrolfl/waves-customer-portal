// GATE_CALL_EXTRACTION_SYSTEM_PROMPT: call extraction V2 sends its rules and output contract as
// a static system part and the call's own facts and transcript as the user message. Off, the
// one-message prompt and its version are unchanged.
const {
  buildExtractionPrompt, buildExtractionPromptParts, extractionPromptVersion,
  PROMPT_VERSION, PROMPT_HASH, APS_PROMPT_HASH, SYSTEM_PROMPT_HASH, SYSTEM_APS_PROMPT_HASH,
} = require('../services/prompts/call-extraction-v1');

const TRANSCRIPT = 'Agent: Waves Pest Control, how can I help?\nCaller: I have roaches in my kitchen.';
const PHONE = '+19415550134';
const CATALOG = ['General Pest Control', 'Waves Assessment'];
const CALL_OPTS = {
  bookableServiceNames: CATALOG,
  callTimeET: '2:15 PM',
  knownCaller: { name: 'Pat Example', accountType: 'established_customer' },
  callerIdName: 'EXAMPLE PAT',
  callDirection: 'outbound',
  priorCall: { hoursAgo: 3, summary: 'asked about ants', captured: { name: 'Pat' } },
};

describe('system layout of the extraction prompt', () => {
  test('the system part is the same for every call under one catalog', () => {
    const a = buildExtractionPromptParts(TRANSCRIPT, PHONE, '2026-10-09', CALL_OPTS);
    const b = buildExtractionPromptParts('Caller: wrong number, sorry.', '+19415550177', '2026-01-02', { bookableServiceNames: CATALOG });
    expect(a.system).toBe(b.system);
    expect(a.user).not.toBe(b.user);
  });

  test('nothing from the call is in the system part', () => {
    const { system } = buildExtractionPromptParts(TRANSCRIPT, PHONE, '2026-10-09', CALL_OPTS);
    for (const fromCall of ['roaches in my kitchen', PHONE, '2026-10-09', '2:15 PM', 'Pat Example', 'EXAMPLE PAT', 'CALL DIRECTION: OUTBOUND', 'PRIOR_CALL_DATA', 'asked about ants']) {
      expect(system).not.toContain(fromCall);
    }
  });

  test('the user message is the call alone: its facts, then the transcript, no rules', () => {
    const { user } = buildExtractionPromptParts(TRANSCRIPT, PHONE, '2026-10-09', CALL_OPTS);
    for (const fromCall of [PHONE, 'Call date in Eastern Time: 2026-10-09', '2:15 PM', 'Pat Example', 'EXAMPLE PAT', 'CALL DIRECTION: OUTBOUND', 'PRIOR_CALL_DATA', TRANSCRIPT]) {
      expect(user).toContain(fromCall);
    }
    expect(user).not.toContain('═══ EXTRACTION RULES ═══');
    expect(user).not.toContain('EVIDENCE PINNING');
    expect(user.indexOf('Call date in Eastern Time')).toBeLessThan(user.indexOf('Transcript:'));
  });

  test('the system part carries every rule line of the one-message prompt', () => {
    const single = buildExtractionPrompt('', '', '', { bookableServiceNames: CATALOG });
    const { system } = buildExtractionPromptParts('', '', '', { bookableServiceNames: CATALOG });
    const rules = single.slice(single.indexOf('═══ EXTRACTION RULES ═══'));
    // The three lines that name the call date point at the user message instead of carrying it.
    const dateFree = (line) => !line.includes('"today" = ') && !line.includes('the day is TODAY (') && !line.includes('the CALL DATE itself (');
    const ruleLines = rules.split('\n').filter((line) => line.trim() && dateFree(line));
    expect(ruleLines.length).toBeGreaterThan(150);
    for (const line of ruleLines) expect(system).toContain(line);
    expect(system).toContain('"today" = the "Call date in Eastern Time" given in the user message.');
    expect(system).toContain('which is the CALL DATE itself (the "Call date in Eastern Time" given in the user message)');
    expect(system).toContain('BOOKABLE SERVICE CATALOG');
    expect(system).toContain('- Waves Assessment');
  });

  test('the agent-proposed slot block is in the system part, after the rules that point to it', () => {
    const { system, user } = buildExtractionPromptParts(TRANSCRIPT, PHONE, '2026-10-09', { agentProposedSlotCommitment: true });
    const off = buildExtractionPromptParts(TRANSCRIPT, PHONE, '2026-10-09', {});
    expect(system).toContain('\nAGENT-PROPOSED SLOT (NEW bookings only');
    expect(system.indexOf('\nAGENT-PROPOSED SLOT (NEW bookings only')).toBeGreaterThan(system.indexOf('═══ EXTRACTION RULES ═══'));
    expect(user).not.toContain('AGENT-PROPOSED SLOT (NEW bookings only');
    expect(off.system).not.toContain('\nAGENT-PROPOSED SLOT (NEW bookings only');
  });

  test('the one-message prompt is not changed by the split', () => {
    const prompt = buildExtractionPrompt(TRANSCRIPT, PHONE, '2026-10-09', CALL_OPTS);
    expect(typeof prompt).toBe('string');
    expect(prompt.indexOf('Transcript:')).toBeLessThan(prompt.indexOf('═══ EXTRACTION RULES ═══'));
    expect(prompt).toContain('"today" = 2026-10-09.');
    expect(prompt).toContain('appended at the end of this prompt');
  });
});

describe('system layout prompt versions', () => {
  test('gate off versions are the existing ones', () => {
    expect(extractionPromptVersion([])).toBe(PROMPT_HASH);
    expect(extractionPromptVersion([], { systemLayout: false })).toBe(PROMPT_HASH);
    expect(extractionPromptVersion([], { systemLayout: 'true' })).toBe(PROMPT_HASH);
    expect(extractionPromptVersion([], { agentProposedSlotCommitment: true })).toBe(APS_PROMPT_HASH);
  });

  test('the system layout is its own cohort, one letter inside the leading token', () => {
    expect(SYSTEM_PROMPT_HASH).toMatch(new RegExp(`^${PROMPT_VERSION}s-[a-f0-9]{12}$`));
    expect(SYSTEM_APS_PROMPT_HASH).toMatch(new RegExp(`^${PROMPT_VERSION}b-[a-f0-9]{12}$`));
    expect(extractionPromptVersion([], { systemLayout: true })).toBe(SYSTEM_PROMPT_HASH);
    expect(extractionPromptVersion([], { systemLayout: true, agentProposedSlotCommitment: true })).toBe(SYSTEM_APS_PROMPT_HASH);
    expect(new Set([PROMPT_HASH, APS_PROMPT_HASH, SYSTEM_PROMPT_HASH, SYSTEM_APS_PROMPT_HASH]).size).toBe(4);
  });

  test('every version still fits the varchar(30) version columns with a catalog', () => {
    for (const opts of [{}, { agentProposedSlotCommitment: true }, { systemLayout: true }, { systemLayout: true, agentProposedSlotCommitment: true }]) {
      const version = extractionPromptVersion(CATALOG, opts);
      expect(version).toMatch(/-cat\.[a-f0-9]{8}$/);
      expect(version.length).toBeLessThanOrEqual(30);
    }
  });
});

describe('extractCallDataV2 request', () => {
  const realFetch = global.fetch;
  const saved = {};
  const ENV = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GATE_CALL_EXTRACTION_SYSTEM_PROMPT', 'CALL_EXTRACTION_PROVIDER', 'CALL_EXTRACTION_MODEL'];
  let bodies;

  beforeEach(() => {
    for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.OPENAI_API_KEY = 'test-key';
    bodies = [];
    // The provider answers 500: the request body is all this test reads.
    global.fetch = jest.fn(async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
    });
  });

  afterEach(() => {
    global.fetch = realFetch;
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  const { extractCallDataV2 } = require('../services/call-recording-processor')._test;
  const run = (opts = {}) => extractCallDataV2(TRANSCRIPT, PHONE, { callStartedAt: new Date('2026-10-09T15:00:00Z'), bookableServiceNames: CATALOG, ...opts });

  test('gate off: one user message holds the whole prompt, no system part', async () => {
    await run();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].instructions).toBeUndefined();
    const text = bodies[0].input[0].content[0].text;
    expect(text).toContain(TRANSCRIPT);
    expect(text).toContain('═══ EXTRACTION RULES ═══');
    expect(text).toContain('═══ OUTPUT CONTRACT ═══');
  });

  test('gate on: rules and contract ride the system channel, the call rides the user message', async () => {
    process.env.GATE_CALL_EXTRACTION_SYSTEM_PROMPT = 'true';
    await run();
    expect(bodies).toHaveLength(1);
    const { instructions } = bodies[0];
    const text = bodies[0].input[0].content[0].text;
    expect(instructions).toContain('═══ EXTRACTION RULES ═══');
    expect(instructions.endsWith(JSON.stringify(require('../schemas/call-extraction.model-output.schema.json')))).toBe(true);
    expect(instructions).not.toContain('roaches in my kitchen');
    expect(text).toContain(TRANSCRIPT);
    expect(text).toContain(PHONE);
    expect(text).not.toContain('═══ EXTRACTION RULES ═══');
    expect(text).not.toContain('═══ OUTPUT CONTRACT ═══');
  });

  test('the value the processor hands in wins over the live gate, both ways', async () => {
    process.env.GATE_CALL_EXTRACTION_SYSTEM_PROMPT = 'true';
    await run({ systemPromptLayout: false });
    expect(bodies[0].instructions).toBeUndefined();
    delete process.env.GATE_CALL_EXTRACTION_SYSTEM_PROMPT;
    await run({ systemPromptLayout: true });
    expect(bodies[1].instructions).toContain('═══ EXTRACTION RULES ═══');
  });

  test('only the exact string true turns the layout on', async () => {
    process.env.GATE_CALL_EXTRACTION_SYSTEM_PROMPT = '1';
    await run();
    expect(bodies[0].instructions).toBeUndefined();
  });
});

describe('prompt v32: the day/time conflict rule and billing_choice, in both layouts', () => {
  const { DAY_TIME_CONFLICT_RULE } = require('../services/prompts/appointment-confirmed-rules');
  const oneMessage = buildExtractionPrompt(TRANSCRIPT, PHONE, '2026-10-29', CALL_OPTS);
  const { system } = buildExtractionPromptParts(TRANSCRIPT, PHONE, '2026-10-29', CALL_OPTS);

  test('this is the v36 cohort, one hash per layout', () => {
    expect(PROMPT_VERSION).toBe('v36');
    expect(PROMPT_HASH).toMatch(/^v36-[a-f0-9]{12}$/);
    expect(APS_PROMPT_HASH).toMatch(/^v36a-[a-f0-9]{12}$/);
    expect(SYSTEM_PROMPT_HASH).toMatch(/^v36s-[a-f0-9]{12}$/);
    expect(SYSTEM_APS_PROMPT_HASH).toMatch(/^v36b-[a-f0-9]{12}$/);
    expect(new Set([PROMPT_HASH, APS_PROMPT_HASH, SYSTEM_PROMPT_HASH, SYSTEM_APS_PROMPT_HASH]).size).toBe(4);
  });

  test('the day/time conflict rule is in the one-message prompt, the system part and the gate-on prompts', () => {
    for (const text of [oneMessage, system, buildExtractionPrompt(TRANSCRIPT, PHONE, '2026-10-29', { agentProposedSlotCommitment: true }),
      buildExtractionPromptParts(TRANSCRIPT, PHONE, '2026-10-29', { agentProposedSlotCommitment: true }).system]) {
      expect(text).toContain(DAY_TIME_CONFLICT_RULE);
    }
    expect(buildExtractionPromptParts(TRANSCRIPT, PHONE, '2026-10-29', CALL_OPTS).user).not.toContain('DAY/TIME CONFLICT');
  });

  test('billing_choice: the prompt gives the field, its two plans, the caller-only bar and the evidence pin', () => {
    for (const text of [oneMessage, system]) {
      expect(text).toContain('- billing_choice: the billing plan the CALLER chose for a RECURRING plan');
      expect(text).toContain('"annual_prepay" when the caller chose to pay for the year up front ("we\'ll prepay for the year"');
      expect(text).toContain('"per_application" when the caller chose to be billed each application or visit ("just bill each application"');
      expect(text).toContain('Staff explaining, offering or recommending the options is NOT a choice');
      expect(text).toContain('null when no choice was made, it is unclear, or no recurring plan was discussed');
      expect(text).toContain('pin the caller\'s own choice sentence to /service_request/billing_choice with speaker "caller"');
      expect(text).toContain('- service_request.billing_choice (when non-null — the CALLER\'s own sentence choosing that plan; speaker must be "caller")');
    }
  });

  test('billing_choice sits in the SERVICE REQUEST section, before the price object', () => {
    expect(oneMessage.indexOf('- billing_choice:')).toBeGreaterThan(oneMessage.indexOf('SERVICE REQUEST:'));
    expect(oneMessage.indexOf('- billing_choice:')).toBeLessThan(oneMessage.indexOf('- price: The PRIMARY price'));
  });

  test('estimate_response: the prompt gives the field, its four answers, the caller-only bar and the evidence pin', () => {
    for (const text of [oneMessage, system]) {
      expect(text).toContain('- estimate_response: the CALLER\'s answer to an estimate or quote that Waves ALREADY SENT before this call');
      expect(text).toContain('A price first quoted on this call is price.caller_response\'s job, not this field\'s, and a call with no earlier estimate is null.');
      expect(text).toContain('"accepted" when the caller plainly says they go ahead with the service or plan on that estimate ("let\'s do it", "go ahead and sign me up", "yes, book it") and no condition of theirs is still open at hangup');
      expect(text).toContain('"accepted_with_condition" when the caller says yes but ties it to something not settled at hangup (a day still to be found, a spouse or landlord to ask, a change to the price or the scope, a question still to be answered)');
      expect(text).toContain('"undecided" when the estimate was discussed and the caller gave no yes and no no ("I\'ll think about it", "let me look at it again")');
      expect(text).toContain('"declined" when the caller says no, not now, or that they chose another company');
      expect(text).toContain('Staff offering, recommending or pressing is NOT an answer, and a bare "okay" or "uh-huh" after staff reads a price or explains the plan is not "accepted".');
      expect(text).toContain('Booking a visit is not by itself "accepted"');
      expect(text).toContain('When the caller changed their mind, take the FINAL answer at hangup.');
      expect(text).toContain('null when no estimate that Waves already sent was discussed, or the answer is unclear.');
      expect(text).toContain('pin the caller\'s own answer sentence to /service_request/estimate_response with speaker "caller"');
      expect(text).toContain('- service_request.estimate_response (when non-null — the CALLER\'s own sentence answering the estimate Waves already sent; speaker must be "caller")');
    }
  });

  test('estimate_response sits right after billing_choice, before the price object', () => {
    expect(oneMessage.indexOf('- estimate_response:')).toBeGreaterThan(oneMessage.indexOf('- billing_choice:'));
    expect(oneMessage.indexOf('- estimate_response:')).toBeLessThan(oneMessage.indexOf('- price: The PRIMARY price'));
  });

  test('the output contract the model is given carries estimate_response', () => {
    const schema = require('../schemas/call-extraction.model-output.schema.json');
    expect(schema.properties.service_request.properties.estimate_response).toBeDefined();
  });

  test('synthetic fixture: every case is synthetic, uses a valid answer and pins the caller\'s own words', () => {
    const fixture = require('../fixtures/call-extraction-eval/synthetic-estimate-response.json');
    const allowed = ['accepted', 'accepted_with_condition', 'undecided', 'declined', null];
    const answers = fixture.cases.map((c) => c.expect.estimate_response);
    for (const want of ['accepted', 'accepted_with_condition', 'undecided', 'declined', null]) expect(answers).toContain(want);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(7);
    for (const c of fixture.cases) {
      expect(allowed).toContain(c.expect.estimate_response);
      expect(c.transcript).not.toMatch(/\b\d{3}[-. ]\d{4}\b/); // no phone numbers
      const evidence = c.expect.estimate_response_evidence;
      if (c.expect.estimate_response === null) { expect(evidence).toBeUndefined(); continue; }
      expect(evidence.field_path).toBe('/service_request/estimate_response');
      expect(evidence.speaker).toBe('caller');
      expect(c.transcript).toContain(evidence.quote);
      const turn = c.transcript.split('\n').find((line) => line.includes(evidence.quote));
      expect(turn.startsWith('Caller:')).toBe(true);
    }
    const byId = (id) => fixture.cases.find((c) => c.id === id);
    expect(byId('estimate-response-changed-mind').expect.estimate_response).toBe('undecided');
    expect(byId('estimate-response-null-price-first-quoted-on-call').expect.estimate_response).toBeNull();
    expect(byId('estimate-response-null-only-staff-spoke').expect.estimate_response).toBeNull();
  });

  test('household safety notes: the prompt gives each field, its caller-only bar and the evidence pin', () => {
    for (const text of [oneMessage, system]) {
      expect(text).toContain('- household_children_or_elderly: a SHORT note (a few words) ONLY when the CALLER says children or elderly people LIVE at the service address or will be PRESENT at the visit');
      expect(text).toContain('visitors who will not be there at service time ("my grandkids visit at Christmas")');
      expect(text).toContain('- no_spray_areas: a SHORT note naming the areas of THIS property the caller asks us NOT to spray or treat');
      expect(text).toContain('a pond or garden merely mentioned with no request to avoid it is null');
      expect(text).toContain('- chemical_sensitivity_note: a SHORT note ONLY when the CALLER says someone in the home is sensitive to chemicals');
      expect(text).toContain('a plain preference for pet-safe or natural products with no health reason is null');
      expect(text).toContain('- property.household_children_or_elderly, property.no_spray_areas and property.chemical_sensitivity_note (when non-null — the CALLER\'s own sentence; speaker must be "caller")');
    }
    // They sit in the PROPERTY section, after the building rules and before MULTIPLE PROPERTIES.
    const at = oneMessage.indexOf('- household_children_or_elderly:');
    expect(at).toBeGreaterThan(oneMessage.indexOf('- whole_building_occupancy_final'));
    expect(at).toBeLessThan(oneMessage.indexOf('MULTIPLE PROPERTIES (service_address'));
  });

  test('the output contract the model is given carries the three household safety notes', () => {
    const schema = require('../schemas/call-extraction.model-output.schema.json');
    for (const key of ['household_children_or_elderly', 'no_spray_areas', 'chemical_sensitivity_note']) {
      expect(schema.properties.property.properties[key]).toBeDefined();
    }
  });

  test('the output contract the model is given carries billing_choice', () => {
    const schema = require('../schemas/call-extraction.model-output.schema.json');
    expect(JSON.stringify(schema)).toContain('"billing_choice"');
  });
});
