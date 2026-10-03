// Lawn result timing (lawn report rebuild P15, rides GATE_LAWN_REPORT_COPY_V6):
// the lawn technician writer gets the RESULT TIMING rule, and the lawn "What
// we applied today" paragraph states no timing (own prompt version, timing
// backstop). Gate off: both byte-identical to before. Pure, no network.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { selectReportCopyPrompt, LAWN_RESULT_TIMING_RULE } = require('../services/service-report/lawn-report-copy-prompt');
const {
  PROMPT_VERSION, LAWN_NO_TIMING_PROMPT_VERSION, buildTreatmentNarrativePrompt, validateNarrative, treatmentNarrativePdfSignature,
} = require('../services/service-report/treatment-narrative');

const SHARED = '# SHARED\n## HARD CONSTRAINTS\nShared safety.\n## ANTI-TEMPLATE RULES\nOld examples.';
const LAWN = { serviceKey: 'lawn_care_recurring', findingsType: null };
const PRODUCTS = [{ name: 'Test Herbicide B', kind: 'herbicide', activeIngredient: 'Testazone', method: 'spot', targets: ['broadleaf weeds'] }];

const ENV = ['GATE_LAWN_REPORT_COPY_V6', 'GATE_LAWN_REPORT_LEAD'];
const saved = {};
beforeEach(() => { ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }); });
afterEach(() => { ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });
const live = () => { process.env.GATE_LAWN_REPORT_COPY_V6 = 'true'; process.env.GATE_LAWN_REPORT_LEAD = 'true'; };

describe('lawn technician writer: RESULT TIMING rule', () => {
  test('gate live: the lawn prompt is the old one plus the rule, appended last', () => {
    const off = selectReportCopyPrompt(SHARED, 'Lawn Care', LAWN);
    live();
    const on = selectReportCopyPrompt(SHARED, 'Lawn Care', LAWN);
    expect(on).toBe(`${off}\n\n${LAWN_RESULT_TIMING_RULE}`);
    expect(on).toMatch(/quoting an EXPECTATIONS sentence word for word/);
  });

  test('gate live never touches another writer', () => {
    const pest = { serviceKey: 'pest_general_quarterly', findingsType: null };
    const off = selectReportCopyPrompt(SHARED, 'Pest', pest);
    live();
    expect(selectReportCopyPrompt(SHARED, 'Pest', pest)).toBe(off);
  });
});

describe('lawn treatment paragraph: no timing', () => {
  test('gate off: the v5 prompt asks for "roughly when", as before', () => {
    const prompt = buildTreatmentNarrativePrompt({ serviceLine: 'lawn', products: PRODUCTS });
    expect(prompt).toMatch(/and roughly when/);
    expect(prompt).toMatch(/within days/);
  });

  test('gate live: the lawn prompt drops all timing asks; pest keeps its prompt', () => {
    const pestOff = buildTreatmentNarrativePrompt({ serviceLine: 'pest', products: PRODUCTS });
    live();
    const lawn = buildTreatmentNarrativePrompt({ serviceLine: 'lawn', products: PRODUCTS });
    expect(lawn).not.toMatch(/roughly when|within days|over the coming weeks, and/);
    expect(lawn).toMatch(/Do NOT say when/);
    expect(buildTreatmentNarrativePrompt({ serviceLine: 'pest', products: PRODUCTS })).toBe(pestOff);
  });

  test('the backstop: time language fails a no-timing paragraph (deterministic summary served), not a v5 one', () => {
    const timed = 'A selective weed control was applied to the broadleaf weeds, and they should curl within a week.';
    const clean = 'A selective weed control was applied to the broadleaf weeds so they curl and fade.';
    expect(validateNarrative(timed, [], [], { noTiming: true })).toBe('lawn_timing');
    expect(validateNarrative(clean, [], [], { noTiming: true })).toBeNull();
    expect(validateNarrative(timed)).toBeNull();
  });

  test('its own prompt version, and the PDF signature reads rows of either version', async () => {
    expect(LAWN_NO_TIMING_PROMPT_VERSION).not.toBe(PROMPT_VERSION);
    const calls = [];
    const chain = {
      where(w) { calls.push(['where', w]); return chain; },
      whereIn(col, vals) { calls.push(['whereIn', col, vals]); return chain; },
      orderBy() { return chain; },
      first: async () => ({ status: 'ready', generated_at: '2026-10-02T12:00:00Z' }),
    };
    const sig = await treatmentNarrativePdfSignature('svc-1', () => chain);
    expect(sig).toMatch(/^-tnready\d+$/);
    expect(calls).toContainEqual(['whereIn', 'prompt_version', [PROMPT_VERSION, LAWN_NO_TIMING_PROMPT_VERSION]]);
  });
});

describe('buildTreatmentNarrative claims its cache row under the line\'s version', () => {
  const claimVersion = async (serviceLine) => {
    const { buildTreatmentNarrative } = require('../services/service-report/treatment-narrative');
    const inserted = [];
    const knex = () => {
      const chain = {
        where: () => chain,
        first: async () => null,
        insert: (row) => { inserted.push(row); return { onConflict: () => ({ ignore: () => ({ returning: () => ({ catch: async () => [] }) }) }) }; },
      };
      return chain;
    };
    await buildTreatmentNarrative({ serviceRecordId: 'svc-1', serviceLine, treatment: { products: [{ name: 'Test Herbicide B', kind: 'herbicide', activeIngredient: 'Testazone' }] }, knex });
    return inserted[0] && inserted[0].prompt_version;
  };

  test('gate off: v5 for lawn; gate live: the no-timing version for lawn, v5 for tree & shrub', async () => {
    expect(await claimVersion('lawn')).toBe(PROMPT_VERSION);
    live();
    expect(await claimVersion('lawn')).toBe(LAWN_NO_TIMING_PROMPT_VERSION);
    expect(await claimVersion('tree_shrub')).toBe(PROMPT_VERSION);
  });
});
