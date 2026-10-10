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
    // The two lines that name the call date point at the user message instead of carrying it.
    const dateFree = (line) => !line.includes('"today" = ') && !line.includes('the day is TODAY (');
    const ruleLines = rules.split('\n').filter((line) => line.trim() && dateFree(line));
    expect(ruleLines.length).toBeGreaterThan(150);
    for (const line of ruleLines) expect(system).toContain(line);
    expect(system).toContain('"today" = the "Call date in Eastern Time" given in the user message.');
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
