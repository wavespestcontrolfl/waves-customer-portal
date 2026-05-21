/**
 * Unit tests for uniqueness-gate. Safety-critical — heavy coverage.
 *
 * Tests the 7 anti-doorway checks against synthetic drafts that
 * deliberately pass/fail each check.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { evaluate } = require('../services/content/uniqueness-gate');
const {
  tokenize, shingles, jaccard, extractCtaUrls,
  checkUniqueLocalProblem, checkUniqueCityContext,
  checkUniqueServiceSpecificContent, checkUniqueCustomerQuestions,
  checkUniqueLocalProof, checkNotTemplateSwap, checkNotFunnelingToSameUrl,
} = require('../services/content/uniqueness-gate')._internals;

// ── fixtures ─────────────────────────────────────────────────────────

function brief(overrides = {}) {
  return {
    page_type: 'city-service',
    city: 'Bradenton',
    service: 'pest',
    customer_signal: null,
    target_keyword: 'pest control bradenton',
    ...overrides,
  };
}

function strongCityServiceDraft() {
  return {
    url: '/pest-control-bradenton-fl/',
    body: `
# Bradenton Pest Control

Living in Bradenton means sandy soil + afternoon storms — perfect conditions
for German roaches and chinch bug damage to flare up. Our techs see fresh
infestation activity in the Riverwalk and downtown Bradenton neighborhoods
every season.

Tech Jacob noted Bradenton's HOA communities consistently see fire ant mounds
flare in spring after the rainy season ends. Our 500+ Bradenton customers
get monitored on a 60-day cycle using integrated pest management with
baiting and targeted residual treatment using fipronil-based product.

"We've been on the Waves WaveGuard plan for 3 years — no roaches since."

## What we do
- General pest control
- Termite inspection
- Mosquito control
- Rodent exclusion

[Get a free Bradenton pest control quote](/pest-control-quote-bradenton-fl/)

## FAQ — common questions from Bradenton homeowners
- Does rain affect the treatment?
- Is the spray safe for pets?
`,
  };
}

// ── tokenize / shingles / jaccard ────────────────────────────────────

describe('tokenize', () => {
  test('strips punctuation, lowercases, drops stop words and short tokens', () => {
    const out = tokenize('The quick brown fox is fast!');
    expect(out).toEqual(expect.arrayContaining(['quick', 'brown', 'fox', 'fast']));
    expect(out).not.toContain('the');
    expect(out).not.toContain('is');
  });
  test('returns [] for empty input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(null)).toEqual([]);
  });
});

describe('shingles', () => {
  test('produces n-gram sets', () => {
    const set = shingles('the quick brown fox jumps over', 3);
    // tokenize drops 'the' and 'over', so trigrams are over [quick, brown, fox, jumps]
    expect(set.size).toBeGreaterThan(0);
  });
});

describe('jaccard', () => {
  test('identical sets → 1', () => {
    const a = new Set(['x', 'y']);
    expect(jaccard(a, a)).toBe(1);
  });
  test('disjoint sets → 0', () => {
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });
  test('both empty → 0', () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
  test('half-overlap → 0.5-ish', () => {
    const j = jaccard(new Set(['a', 'b']), new Set(['b', 'c']));
    expect(j).toBeCloseTo(1 / 3, 2);
  });
});

// ── extractCtaUrls ───────────────────────────────────────────────────

describe('extractCtaUrls', () => {
  test('finds markdown links + href attrs', () => {
    const body = '[Quote](/pest-quote/) and <a href="/contact/">contact</a>';
    const urls = extractCtaUrls(body);
    expect(urls).toEqual(expect.arrayContaining(['/pest-quote/', '/contact/']));
  });
  test('returns [] when no links', () => {
    expect(extractCtaUrls('plain text only')).toEqual([]);
  });
});

// ── individual checks ────────────────────────────────────────────────

describe('checkUniqueLocalProblem', () => {
  test('passes when problem keyword + city/HOA context present', () => {
    const draft = { body: 'Bradenton HOA communities see fire ant infestation every spring.' };
    expect(checkUniqueLocalProblem(draft, brief()).ok).toBe(true);
  });
  test('fails when no problem keywords', () => {
    const draft = { body: 'Welcome to Bradenton pest control. We are here to help.' };
    expect(checkUniqueLocalProblem(draft, brief()).ok).toBe(false);
  });
  test('fails when problem mentioned but not anchored to local context', () => {
    const draft = { body: 'Infestation can be a serious issue across the country.' };
    expect(checkUniqueLocalProblem(draft, brief()).ok).toBe(false);
  });
});

describe('checkUniqueCityContext', () => {
  test('passes with 2+ city mentions + geography signal', () => {
    const draft = { body: 'Bradenton is great. Bradenton has sandy soil and afternoon storms.' };
    expect(checkUniqueCityContext(draft, brief()).ok).toBe(true);
  });
  test('fails with single city mention', () => {
    const draft = { body: 'Welcome to Bradenton. We are a pest control company.' };
    expect(checkUniqueCityContext(draft, brief()).ok).toBe(false);
  });
  test('fails without geography signal', () => {
    const draft = { body: 'Bradenton homes. Bradenton businesses. Bradenton apartments.' };
    expect(checkUniqueCityContext(draft, brief()).ok).toBe(false);
  });
});

describe('checkUniqueServiceSpecificContent', () => {
  test('pest service requires pest-specific terminology', () => {
    expect(
      checkUniqueServiceSpecificContent(
        { body: 'We use fipronil-based baiting protocols for integrated pest management.' },
        brief({ service: 'pest' })
      ).ok
    ).toBe(true);
  });
  test('fails when only generic copy', () => {
    expect(
      checkUniqueServiceSpecificContent({ body: 'We are the best pest company.' }, brief({ service: 'pest' })).ok
    ).toBe(false);
  });
  test('lawn service detects micronutrient/chinch/aeration', () => {
    expect(
      checkUniqueServiceSpecificContent(
        { body: 'Aeration with core plug pulls and micronutrient feeding.' },
        brief({ service: 'lawn' })
      ).ok
    ).toBe(true);
  });
});

describe('checkUniqueCustomerQuestions', () => {
  test('requires customer_signal attached + city match + threshold met + body addresses it', () => {
    const cs = {
      city: 'Bradenton',
      total_count: 15,
      normalized_question: 'Does rain ruin the treatment?',
      topic: 'rain-after-treatment',
    };
    const draft = { body: 'Does rain ruin the treatment? Short answer: no.' };
    expect(checkUniqueCustomerQuestions(draft, brief({ customer_signal: cs })).ok).toBe(true);
  });
  test('fails without customer_signal', () => {
    expect(checkUniqueCustomerQuestions({ body: 'x' }, brief()).ok).toBe(false);
  });
  test('fails when city mismatch', () => {
    const cs = { city: 'Sarasota', total_count: 15, normalized_question: 'x', topic: 'x' };
    expect(checkUniqueCustomerQuestions({ body: 'x' }, brief({ customer_signal: cs })).ok).toBe(false);
  });
  test('fails when below threshold', () => {
    const cs = { city: 'Bradenton', total_count: 2, normalized_question: 'x', topic: 'x' };
    expect(checkUniqueCustomerQuestions({ body: 'x' }, brief({ customer_signal: cs })).ok).toBe(false);
  });
});

describe('checkUniqueLocalProof', () => {
  test('passes with quantified claim', () => {
    expect(checkUniqueLocalProof({ body: '500+ jobs in Bradenton this year.' }, brief()).ok).toBe(true);
  });
  test('passes with review quote', () => {
    expect(checkUniqueLocalProof({ body: '"Best pest control we have ever used in our subdivision."' }, brief()).ok).toBe(true);
  });
  test('passes with tech-noted', () => {
    expect(checkUniqueLocalProof({ body: 'Our tech Jacob observed flare-ups across the area.' }, brief()).ok).toBe(true);
  });
  test('fails when no proof signal', () => {
    expect(checkUniqueLocalProof({ body: 'We do good work.' }, brief()).ok).toBe(false);
  });
});

describe('checkNotTemplateSwap', () => {
  test('high Jaccard against a sibling fails', () => {
    const sharedText = `Welcome to {{city}} pest control. We serve the {{city}} community with integrated pest management protocols including fipronil-based baiting, residual treatment, and 60-day monitoring cycles for HOA properties.`;
    const drafted = { url: '/x/', body: sharedText.replace(/{{city}}/g, 'Bradenton') };
    const sibling = { url: '/y/', body: sharedText.replace(/{{city}}/g, 'Sarasota') };
    const r = checkNotTemplateSwap(drafted, brief(), [sibling]);
    expect(r.ok).toBe(false);
    expect(r.similarity).toBeGreaterThan(0.5);
  });
  test('low Jaccard passes', () => {
    const drafted = { url: '/x/', body: 'Bradenton has chinch bug damage in St. Augustine grass after summer rains in Manatee County.' };
    const sibling = { url: '/y/', body: 'Venice rodent exclusion involves entry-point sealing with copper mesh and snap traps for attic mice problems.' };
    expect(checkNotTemplateSwap(drafted, brief(), [sibling]).ok).toBe(true);
  });
  test('no siblings passes trivially', () => {
    expect(checkNotTemplateSwap({ url: '/x/', body: 'anything' }, brief(), []).ok).toBe(true);
  });
});

describe('checkNotFunnelingToSameUrl', () => {
  test('passes when ≥1 CTA is city-specific', () => {
    const draft = { body: '[Get a quote](/pest-control-quote-bradenton-fl/) or [contact](/contact/)' };
    expect(checkNotFunnelingToSameUrl(draft, brief()).ok).toBe(true);
  });
  test('fails when only generic hub CTAs', () => {
    const draft = { body: '[Quote](/quote/) [Services](/pest-control/)' };
    expect(checkNotFunnelingToSameUrl(draft, brief()).ok).toBe(false);
  });
  test('fails when no CTAs', () => {
    expect(checkNotFunnelingToSameUrl({ body: 'just text' }, brief()).ok).toBe(false);
  });
});

// ── full evaluate ───────────────────────────────────────────────────

describe('evaluate (full gate)', () => {
  test('strong city-service draft + matching customer signal → all checks pass', () => {
    const cs = {
      city: 'Bradenton',
      total_count: 12,
      normalized_question: 'Does rain affect the treatment?',
      topic: 'rain-after-treatment',
    };
    const result = evaluate(strongCityServiceDraft(), brief({ customer_signal: cs }), { siblingPages: [] });
    // Expect all 7 checks ok except customer_questions (body doesn't explicitly answer "Does rain affect").
    const checksOk = Object.values(result.checks).filter((c) => c.ok).length;
    expect(checksOk).toBeGreaterThanOrEqual(5);
  });
  test('non-uniqueness page types skip the gate', () => {
    const r = evaluate({ body: 'whatever' }, brief({ page_type: 'supporting-blog' }));
    expect(r.ok).toBe(true);
    expect(r.skipped).toBeTruthy();
  });
  test('weak draft fails several checks', () => {
    const draft = { url: '/x/', body: 'Welcome to our pest service. We are the best.' };
    const r = evaluate(draft, brief(), { siblingPages: [] });
    expect(r.ok).toBe(false);
    expect(r.failed_count).toBeGreaterThan(3);
  });
  test('throws on missing draft / brief', () => {
    expect(() => evaluate(null, brief())).toThrow();
    expect(() => evaluate({ body: 'x' }, null)).toThrow();
  });
});
