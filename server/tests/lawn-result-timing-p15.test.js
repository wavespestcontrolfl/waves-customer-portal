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
    expect(on).toMatch(/never say when a result will show/);
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
    // Every phrase the prompt names is caught, "over time" included.
    for (const phrase of ['over time', 'over the coming weeks', 'soon', 'in a few days', 'within weeks', 'next month', 'within 2 weeks', 'next week', 'tomorrow']) {
      expect(validateNarrative(`The treated weeds should fade ${phrase}.`, [], [], { noTiming: true })).toBe('lawn_timing');
    }
    // Result timing only: the section's own "today", "peak season" protection
    // framing and a past window pass (the prompt asks for them).
    for (const ok of [
      'Today we applied a selective weed control to the broadleaf weeds.',
      'An insect control was applied to protect against chinch bugs during their peak season.',
      'Rain fell in the seven days before the visit, so the granular feed was watered in.',
    ]) {
      expect(validateNarrative(ok, [], [], { noTiming: true })).toBeNull();
    }
  });

  test('with the record\'s line, the PDF signature reads only that line\'s active version (either toggle order)', async () => {
    const seen = [];
    const c = {
      where() { return c; },
      whereIn(col, vals) { seen.push(vals); return c; },
      orderBy() { return c; },
      first: async () => ({ status: 'ready', generated_at: '2026-10-02T12:00:00Z' }),
    };
    live();
    await treatmentNarrativePdfSignature('svc-1', () => c, { serviceLine: 'lawn' });
    await treatmentNarrativePdfSignature('svc-1', () => c, { serviceLine: 'tree_shrub' });
    delete process.env.GATE_LAWN_REPORT_COPY_V6;
    await treatmentNarrativePdfSignature('svc-1', () => c, { serviceLine: 'lawn' });
    expect(seen).toEqual([[LAWN_NO_TIMING_PROMPT_VERSION], [PROMPT_VERSION], [PROMPT_VERSION]]);
  });

  test('both PDF-signature callers pass the record\'s line, resolved as report-data resolves it', () => {
    const fs = require('fs'); const path = require('path');
    for (const file of ['../services/service-report/pdf-queue.js', '../routes/reports-public.js']) {
      expect(fs.readFileSync(path.join(__dirname, file), 'utf8')).toMatch(/treatmentNarrativePdfSignature\(service\.id, \w+, \{ serviceLine: service\.service_line \|\| detectServiceLine\(service\.service_type\) \}\)/);
    }
  });

  test('its own prompt version, and the PDF signature reads only the versions a render can read', async () => {
    expect(LAWN_NO_TIMING_PROMPT_VERSION).not.toBe(PROMPT_VERSION);
    const sigCalls = async () => {
      const seen = [];
      const c = {
        where() { return c; },
        whereIn(col, vals) { seen.push([col, vals]); return c; },
        orderBy() { return c; },
        first: async () => ({ status: 'ready', generated_at: '2026-10-02T12:00:00Z' }),
      };
      await treatmentNarrativePdfSignature('svc-1', () => c);
      return seen;
    };
    // Gate off: a newer lawn no-timing row is inactive, so only v5 keys the PDF.
    expect(await sigCalls()).toEqual([['prompt_version', [PROMPT_VERSION]]]);
    live();
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

describe('lawnResultTimingViolation: a closed world on durations', () => {
  const { lawnResultTimingViolation } = require('../services/service-report/report-writer-rules');
  test.each([
    'Treated weeds typically yellow after two weeks.',
    'Visible improvement develops over several weeks.',
    'Weeds fade in 3-7 days.',
    'Color returns in about a week.',
    'The weeds should fade next week.',
    'You will see improvement tomorrow.',
    'Results build over weeks.',
    'Weeds should yellow by Friday.',
    'Improvement will appear later this week.',
    'Color should return by October 10.',
    'You will see it this weekend.',
    'Expect greener turf in a month or two.',
    'The weeds should fade by your next visit.',
    'The lawn should look greener every week.',
    'Visible improvement should arrive by 10/10.',
    'The treated weeds will fade a little more each day.',
    'The treatment will improve the lawn every week.',
    'We apply this once a week in summer.',
    'The lawn should green up by spring.',
    'The treatment works immediately.',
    'The weeds begin fading right away.',
    'The weeds were treated and should fade in a week.',
    'A selective herbicide was applied, and visible improvement develops after two weeks.',
    'The treatment will last weeks.',
    'Results should last months.',
  ])('any forward duration or calendar deadline fails: %s', (text) => {
    expect(lawnResultTimingViolation(text)).toBe(true);
  });
  test.each([
    'Today we applied a selective weed control.',
    'Applied to protect against chinch bugs during their peak season.',
    'In the seven days before the visit it rained.',
    'You noticed weeds two weeks ago.',
    'Over the last two weeks the lawn browned.',
    'We will recheck at your next visit.',
    'The lawn has been browning for three days.',
    'Three weeks of dry weather stressed the lawn before our visit.',
  ])('past windows, history and "next visit" pass: %s', (text) => {
    expect(lawnResultTimingViolation(text)).toBe(false);
  });
});

describe('the fallback (pending or failed generation) is timing-free for lawn too', () => {
  test('gate live: the systemic clause drops "for several weeks"; gate off keeps it', async () => {
    const { buildTreatmentSummary } = require('../services/service-report/treatment-summary');
    const treatment = { products: [{ name: 'Test Systemic C', kind: 'systemic', activeIngredient: 'Testacloprid' }] };
    expect(buildTreatmentSummary(treatment)).toMatch(/for several weeks after the visit/);
    const quiet = buildTreatmentSummary(treatment, { noTiming: true });
    expect(quiet).toMatch(/keep working after the visit\./);
    expect(validateNarrative(quiet, [], [], { noTiming: true })).toBeNull();
  });
});

describe('generate-report screens lawn drafts that carried the RESULT TIMING rule', () => {
  test('the route applies lawnResultTimingViolation exactly when the prompt holds the rule', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    expect(source).toMatch(/const lawnTimingOn = String\(effectiveSystemPrompt \|\| ''\)\.includes\(LAWN_RESULT_TIMING_RULE\)/);
    expect(source).toMatch(/lawnTimingOn && lawnResultTimingViolation\(text\) \? 'lawn_timing' : null/);
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
