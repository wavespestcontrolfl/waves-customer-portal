const { buildExtractionPrompt, extractionPromptVersion, PROMPT_VERSION, PROMPT_HASH } = require('../services/prompts/call-extraction-v1');
const { SCHEMA_VERSION } = require('../schemas/validate-extraction');

describe('v2 extraction prompt', () => {
  const transcript = 'Agent: Waves Pest Control, how can I help?\nCaller: I have roaches in my kitchen.';
  const callerPhone = '+19415551234';
  const callDateET = '2026-05-28';

  test('builds prompt with all variables interpolated', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    expect(prompt).toContain('Waves Pest Control');
    expect(prompt).toContain('+19415551234');
    expect(prompt).toContain('2026-05-28');
    expect(prompt).toContain('I have roaches in my kitchen');
  });

  test('includes scheduling status rules', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    expect(prompt).toContain('scheduling.status');
    expect(prompt).toContain('"confirmed"');
    expect(prompt).toContain('"requested"');
    expect(prompt).toContain('"offered"');
    expect(prompt).toContain('"ambiguous"');
  });

  test('includes evidence pinning instructions', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    expect(prompt).toContain('EVIDENCE PINNING');
    expect(prompt).toContain('service_address');
    expect(prompt).toContain('sms_consent_given');
    expect(prompt).toContain('on_site_authorization');
  });

  test('includes pests_observed_status instructions', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    expect(prompt).toContain('pests_observed_status');
    expect(prompt).toContain('not_observed_preventative');
    expect(prompt).toContain('not_discussed');
  });

  test('includes appointment confirmation guardrails', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    expect(prompt).toContain('Vague references');
    expect(prompt).toContain('pre-slab');
    expect(prompt).toContain('invoice');
  });

  test('includes name extraction rules', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    expect(prompt).toContain('Do NOT invent names');
    expect(prompt).toContain('name_confidence');
  });

  test('includes TCPA consent rules', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    expect(prompt).toContain('sms_consent_given');
    expect(prompt).toContain('Implied consent');
    expect(prompt).toContain('do_not_contact_request');
  });

  test('includes the multi-party arranger rules (v3 — WDO/realtor gap)', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    // Arranger calls must be treated as multi-party by default, relayed
    // contact details must never land on the caller, and arranger callers
    // get real relationship values instead of "other".
    expect(prompt).toContain('ARRANGER CALLS ARE MULTI-PARTY BY DEFAULT');
    expect(prompt).toContain('RELAYED CONTACT DETAILS');
    expect(prompt).toContain('ATTRIBUTION');
    expect(prompt).toContain('CALLER RELATIONSHIP');
    expect(prompt).toContain('"real_estate_agent"');
    expect(prompt).toContain('"lender"');
    expect(prompt).toContain('The ACCESS person is a party');
  });

  test('handles null caller phone', () => {
    const prompt = buildExtractionPrompt(transcript, null, callDateET);
    expect(prompt).toContain('unknown');
  });

  test('prompt version and hash are stable', () => {
    expect(PROMPT_VERSION).toBe('v3');
    expect(PROMPT_HASH).toMatch(/^v3-[a-f0-9]{12}$/);
  });

  test('extractionPromptVersion appends an order-sensitive catalog hash', () => {
    // No catalog → bare PROMPT_HASH, so pre-catalog rows keep their version.
    expect(extractionPromptVersion()).toBe(PROMPT_HASH);
    expect(extractionPromptVersion([])).toBe(PROMPT_HASH);
    expect(extractionPromptVersion([null, undefined, ''])).toBe(PROMPT_HASH);

    const a = extractionPromptVersion(['Cockroach Control Service', 'Rodent Control']);
    expect(a).toMatch(new RegExp(`^${PROMPT_HASH}-cat\\.[a-f0-9]{8}$`));
    // Deterministic for the same rendered catalog…
    expect(extractionPromptVersion(['Cockroach Control Service', 'Rodent Control'])).toBe(a);
    // …but a reorder renders a different prompt and must version separately,
    expect(extractionPromptVersion(['Rodent Control', 'Cockroach Control Service'])).not.toBe(a);
    // …as must an edited catalog.
    expect(extractionPromptVersion(['Cockroach Control Service'])).not.toBe(a);
  });
});

describe('v2 extraction function (extractCallDataV2)', () => {
  const CallRecordingProcessor = require('../services/call-recording-processor');
  const { extractCallDataV2 } = CallRecordingProcessor._test;

  test('extractCallDataV2 is exported for testing', () => {
    expect(typeof extractCallDataV2).toBe('function');
  });

  test('returns not_run when no provider key exists for either route leg', async () => {
    const KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    KEYS.forEach((k) => delete process.env[k]);
    try {
      const result = await extractCallDataV2('test transcript', '+19415551234', {});
      expect(result.status).toBe('not_run');
      expect(result.extraction).toBeNull();
    } finally {
      KEYS.forEach((k) => {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      });
    }
  });

  test('extraction route crosses providers and pins the bake-off winner', () => {
    const { CALL_EXTRACTION_ROUTE } = CallRecordingProcessor._test;
    expect(CALL_EXTRACTION_ROUTE.primary).toEqual({ provider: 'openai', model: 'gpt-5.6-sol' });
    expect(CALL_EXTRACTION_ROUTE.fallback.provider).toBe('anthropic');
    // dispatchWithFallback rejects same-provider policies — the route must
    // never collapse to one provider.
    expect(CALL_EXTRACTION_ROUTE.fallback.provider).not.toBe(CALL_EXTRACTION_ROUTE.primary.provider);
  });

  test('gemini kill switch ignores a lingering OpenAI model override', () => {
    jest.resetModules();
    const saved = { p: process.env.CALL_EXTRACTION_PROVIDER, m: process.env.CALL_EXTRACTION_MODEL };
    process.env.CALL_EXTRACTION_PROVIDER = 'gemini';
    process.env.CALL_EXTRACTION_MODEL = 'gpt-5.6-sol'; // stale override from the Sol era
    try {
      const fresh = require('../services/call-recording-processor');
      const route = fresh._test.CALL_EXTRACTION_ROUTE;
      // One-variable rollback: the gemini leg must run a GEMINI model.
      expect(route.primary.provider).toBe('gemini');
      expect(route.primary.model).toMatch(/^gemini-/);
      expect(route.fallback.provider).toBe('anthropic');
    } finally {
      if (saved.p === undefined) delete process.env.CALL_EXTRACTION_PROVIDER; else process.env.CALL_EXTRACTION_PROVIDER = saved.p;
      if (saved.m === undefined) delete process.env.CALL_EXTRACTION_MODEL; else process.env.CALL_EXTRACTION_MODEL = saved.m;
      jest.resetModules();
    }
  });

  test('report-writer env overrides must not move the extraction default', () => {
    jest.resetModules();
    const prev = process.env.MODEL_OPENAI_REPORT_WRITER;
    process.env.MODEL_OPENAI_REPORT_WRITER = 'gpt-hypothetical-writer';
    try {
      const fresh = require('../services/call-recording-processor');
      expect(fresh._test.CALL_EXTRACTION_ROUTE.primary.model).toBe('gpt-5.6-sol');
    } finally {
      if (prev === undefined) delete process.env.MODEL_OPENAI_REPORT_WRITER;
      else process.env.MODEL_OPENAI_REPORT_WRITER = prev;
      jest.resetModules();
    }
  });
});

describe('schema version alignment', () => {
  test('schema version matches between validator and prompt', () => {
    expect(SCHEMA_VERSION).toBe('1.7.0');
  });

  test('prompt hash is deterministic', () => {
    const hash1 = PROMPT_HASH;
    const hash2 = PROMPT_HASH;
    expect(hash1).toBe(hash2);
  });
});

describe('migration columns', () => {
  const migration = require('../models/migrations/20260528000001_v2_extraction_columns');

  test('exports up and down functions', () => {
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');
  });
});
