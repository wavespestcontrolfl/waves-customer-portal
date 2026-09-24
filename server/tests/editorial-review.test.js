const crypto = require('crypto');

const mockDispatch = jest.fn();
const mockFetchPage = jest.fn();

jest.mock('../services/llm/deep', () => ({
  createDeepMessage: (...args) => mockDispatch(...args),
}));
jest.mock('../services/seo/contact-finder', () => ({
  fetchPage: (...args) => mockFetchPage(...args),
}));

const editorial = require('../services/content/editorial-review');
const inventory = require('../services/content/editorial-review-inventory');

const DOCUMENT = `---
title: Stop Mosquito Breeding
description: A practical guide
---

# Stop Mosquito Breeding

Standing water gives mosquitoes a place to breed.

## What should you remove each week?

Empty buckets and plant saucers every week. This interrupts the breeding cycle.

## When should you check again?

Check the property after rain on June 5, 2026.`;

function sourcePage() {
  return {
    status: 200,
    finalUrl: 'https://health.example.gov/mosquitoes',
    blocked: false,
    truncated: false,
    contentType: 'text/html; charset=utf-8',
    html: '<html><head><meta property="og:site_name" content="County Health"></head><body><p>Standing water allows mosquitoes to breed. Empty buckets and plant saucers once a week.</p></body></html>',
  };
}

function modelReview(document = DOCUMENT, { sources = true, overrides = {} } = {}) {
  const analysis = inventory.analyzeDocument(document, 'Stop Mosquito Breeding');
  const checks = editorial.CHECK_NAMES.map((name) => ({ name, status: 'pass', findings: [] }));
  const claims = analysis.claims.map((claim) => {
    const quantitative = /\b\d+|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(claim.passage);
    return {
      claimId: claim.id,
      passage: claim.passage,
      verdict: sources ? 'supported' : (quantitative ? 'unsupported' : 'non_external'),
      claimKind: sources ? (quantitative ? 'quantitative' : 'general') : (quantitative ? 'quantitative' : 'non_external'),
      sourceSuitability: sources ? 'primary_authoritative' : 'not_applicable',
      sourceIndex: sources ? 0 : -1,
      sourceQuote: sources ? 'Standing water allows mosquitoes to breed.' : '',
      action: !sources && quantitative ? 'Remove the date or provide primary evidence.' : '',
    };
  });
  const unsupported = claims.filter((claim) => claim.verdict === 'unsupported');
  if (unsupported.length) {
    const sourceCheck = checks.find((check) => check.name === 'source_support');
    sourceCheck.status = 'fail';
    sourceCheck.findings = unsupported.map((claim) => ({
      passage: claim.passage,
      detail: 'No fetched primary source supports this claim.',
      action: claim.action,
      sourceIndexes: [],
      sourceQuote: '',
    }));
  }
  return {
    claimInventoryComplete: true,
    checks,
    claims,
    sectionCoverage: analysis.sections.map((section) => ({ sectionId: section.id, status: 'pass' })),
    passageCoverage: analysis.passages.map((passage) => ({ passageId: passage.id, status: 'pass' })),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchPage.mockResolvedValue(sourcePage());
});

describe('editorial review', () => {
  test('reviews the exact document with fetched evidence and all required checks', async () => {
    mockDispatch.mockResolvedValue({ ok: true, json: modelReview(), model: 'test-deep-model' });

    const result = await editorial.review({
      document: DOCUMENT,
      title: 'Stop Mosquito Breeding',
      domain: { hostname: 'example.test', tokens: { brandName: 'Example Pest' } },
      sourceUrls: ['https://health.example.gov/mosquitoes'],
      factsPack: { note: 'Writer-supplied context is not proof.' },
    });

    expect(result.pass).toBe(true);
    expect(result.checks.map((check) => check.name)).toEqual(editorial.CHECK_NAMES);
    expect(result.checks.every((check) => check.status === 'pass')).toBe(true);
    expect(result.model).toBe('test-deep-model');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      url: 'https://health.example.gov/mosquitoes',
      publisher: 'County Health',
      excerpt: expect.stringContaining('Standing water allows mosquitoes to breed.'),
    });
    expect(result.sources[0].contentHash).toBe(crypto.createHash('sha256').update(result.sources[0].excerpt).digest('hex'));
    expect(mockFetchPage).toHaveBeenCalledWith('https://health.example.gov/mosquitoes', expect.objectContaining({ maxRedirects: 3 }));
    expect(mockDispatch).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ laneId: 'editorial_review', max_tokens: 12000 }),
      expect.objectContaining({ jsonSchema: expect.any(Object), validate: expect.any(Function) }),
    );
    const prompt = mockDispatch.mock.calls[0][1].messages[0].content;
    expect(prompt).toContain('EXACT FINAL DOCUMENT:');
    expect(prompt).toContain(DOCUMENT);
    expect(prompt).toContain('SUPPLEMENTAL FACTS PACK (not source evidence)');
  });

  test('fails closed when model output omits required check coverage', async () => {
    const malformed = modelReview();
    malformed.checks = malformed.checks.slice(0, 4);
    mockDispatch.mockResolvedValue({ ok: true, json: malformed, model: 'test-model' });

    const result = await editorial.review({ document: DOCUMENT, title: 'Stop Mosquito Breeding', sourceUrls: ['https://health.example.gov/mosquitoes'] });

    expect(result.pass).toBe(false);
    expect(result.model).toBeNull();
    expect(result.checks.every((check) => check.status === 'error')).toBe(true);
    expect(result.checks[0].findings[0].detail).toContain('checks_coverage');
  });

  test.each(['Another title', 42])('rejects mismatched published title %s before dispatch', async (title) => {
    const result = await editorial.review({ document: DOCUMENT.replace('title: Stop Mosquito Breeding', `title: ${title}`), title: 'Stop Mosquito Breeding' });
    expect(result.checks.every((check) => check.status === 'error')).toBe(true);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('rejects unclosed frontmatter before dispatch', async () => {
    const result = await editorial.review({ document: '---\ntitle: Broken\n\n# Broken', title: 'Broken' });
    expect(result.checks.every((check) => check.status === 'error')).toBe(true);
    expect(result.checks[0].findings[0].detail).toContain('frontmatter is invalid');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('fails closed when dispatch is unavailable', async () => {
    mockDispatch.mockResolvedValue({ ok: false, reason: 'all_providers_failed' });
    const result = await editorial.review({ document: DOCUMENT, title: 'Stop Mosquito Breeding' });
    expect(result.pass).toBe(false);
    expect(result.checks).toHaveLength(5);
    expect(result.checks.every((check) => check.status === 'error')).toBe(true);
  });

  test('rejects a supported claim whose quote is not exact fetched evidence', async () => {
    const reply = modelReview();
    reply.claims[0].sourceQuote = 'This quote was invented.';
    mockDispatch.mockResolvedValue({ ok: true, json: reply, model: 'test-model' });
    const result = await editorial.review({ document: DOCUMENT, title: 'Stop Mosquito Breeding', sourceUrls: ['https://health.example.gov/mosquitoes'] });
    expect(result.pass).toBe(false);
    expect(result.checks[0].status).toBe('error');
    expect(result.checks[0].findings[0].detail).toContain('claim_quote');
  });

  test('turns blocked or failed source retrieval into a source_support error', async () => {
    mockFetchPage.mockResolvedValue({ status: 0, finalUrl: null, blocked: true, html: null, error: 'blocked_host' });
    mockDispatch.mockResolvedValue({ ok: true, json: modelReview(DOCUMENT, { sources: false }), model: 'test-model' });
    const result = await editorial.review({ document: DOCUMENT, title: 'Stop Mosquito Breeding', sourceUrls: ['http://127.0.0.1/private'] });
    const check = result.checks.find((item) => item.name === 'source_support');
    expect(result.pass).toBe(false);
    expect(check.status).toBe('error');
    expect(check.findings.some((item) => item.detail.includes('could not be safely retrieved'))).toBe(true);
    await expect(editorial.repair({ document: DOCUMENT, findings: check.findings })).rejects.toThrow(/require retry/);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  test('rejects unknown unresolved domain tokens while allowing known caller tokens', async () => {
    const tokenDocument = `${DOCUMENT}\n\nCall {{cityPhone}} and ask {{mysteryOffice}} for details.`;
    mockDispatch.mockResolvedValue({ ok: true, json: modelReview(tokenDocument, { sources: false }), model: 'test-model' });
    const result = await editorial.review({ document: tokenDocument, title: 'Stop Mosquito Breeding' });
    const check = result.checks.find((item) => item.name === 'editorial_quality');
    expect(result.pass).toBe(false);
    expect(check.status).toBe('fail');
    expect(check.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ passage: '{{mysteryOffice}}', action: expect.stringContaining('Resolve this token') }),
    ]));
    expect(check.findings.some((item) => item.passage === '{{cityPhone}}')).toBe(false);
  });

  test('an unsupported claim requires a failing source_support check', async () => {
    const reply = modelReview(DOCUMENT, { sources: false });
    reply.claims[0] = { ...reply.claims[0], verdict: 'unsupported', claimKind: 'general', sourceSuitability: 'not_applicable', action: 'Remove the claim or cite authoritative evidence.' };
    const sourceCheck = reply.checks.find((check) => check.name === 'source_support');
    sourceCheck.status = 'fail';
    sourceCheck.findings.push({
      passage: reply.claims[0].passage,
      detail: 'No fetched source entails this claim.',
      action: 'Remove the claim or provide an authoritative source.',
      sourceIndexes: [],
      sourceQuote: '',
    });
    mockDispatch.mockResolvedValue({ ok: true, json: reply, model: 'test-model' });
    const result = await editorial.review({ document: DOCUMENT, title: 'Stop Mosquito Breeding' });
    expect(result.pass).toBe(false);
    expect(result.checks.find((check) => check.name === 'source_support').status).toBe('fail');
  });

  test('requires primary or authoritative evidence for quantitative claims', async () => {
    const reply = modelReview();
    const quantitative = reply.claims.find((claim) => claim.claimKind === 'quantitative');
    quantitative.sourceSuitability = 'suitable_secondary';
    mockDispatch.mockResolvedValue({ ok: true, json: reply, model: 'test-model' });
    const result = await editorial.review({ document: DOCUMENT, title: 'Stop Mosquito Breeding', sourceUrls: ['https://health.example.gov/mosquitoes'] });
    expect(result.pass).toBe(false);
    expect(result.checks[0].findings[0].detail).toContain('claim_primary_source_required');
  });

});

describe('editorial repair', () => {
  const repairDocument = `---
title: Guide
slug: guide
---

import Callout from '../components/Callout.astro';

## Answer {#answer}

<Callout kind="tip">
Vague filler about {{brandName}}.
</Callout>

![Mosquito container](/images/container.webp)`;

  test('revises only the body and preserves structural MDX artifacts and frontmatter', async () => {
    const body = inventory.splitFrontmatter(repairDocument).body;
    const revised = body.replace('Vague filler about {{brandName}}.', 'Empty water-holding containers weekly with {{brandName}}.');
    mockDispatch.mockResolvedValue({ ok: true, json: { sectionPlan: [{ section: 'Answer', answer: 'Lead with the weekly action.' }], body: revised }, model: 'test-model' });

    const result = await editorial.repair({
      document: repairDocument,
      title: 'Guide',
      findings: [{ passage: 'Vague filler about {{brandName}}.', action: 'Give a concrete action.' }],
      sources: [],
    });

    expect(result.startsWith('---\ntitle: Guide\nslug: guide\n---')).toBe(true);
    expect(result).toContain("import Callout from '../components/Callout.astro';");
    expect(result).toContain('<Callout kind="tip">');
    expect(result).toContain('![Mosquito container](/images/container.webp)');
    expect(result).toContain('{#answer}');
    expect(result).toContain('{{brandName}}');
    expect(mockDispatch.mock.calls[0][1].system).toContain('Before drafting prose, create sectionPlan');
  });

  test('refuses a repair that removes a template token or component', async () => {
    const body = inventory.splitFrontmatter(repairDocument).body;
    const revised = body.replace('{{brandName}}', 'the company').replace('<Callout kind="tip">', '').replace('</Callout>', '');
    mockDispatch.mockResolvedValue({ ok: true, json: { sectionPlan: [], body: revised }, model: 'test-model' });
    await expect(editorial.repair({ document: repairDocument, findings: [] })).rejects.toThrow(/editorial repair rejected/);
  });

  test('preserves original source indexes after rejecting invalid repair evidence', async () => {
    const body = inventory.splitFrontmatter(repairDocument).body;
    const excerpt = 'Empty standing water from containers once a week.';
    mockDispatch.mockResolvedValue({ ok: true, json: { sectionPlan: [], body }, model: 'test-model' });
    await editorial.repair({
      document: repairDocument,
      findings: [],
      sources: [
        { url: 'invalid', excerpt: 'Do not use.', contentHash: 'invalid' },
        { url: 'https://health.example.gov/mosquitoes', excerpt, contentHash: crypto.createHash('sha256').update(excerpt).digest('hex') },
      ],
    });
    const prompt = mockDispatch.mock.calls[0][1].messages[0].content;
    expect(prompt).toContain('"index":1');
    expect(prompt).not.toContain('"index":0');
  });

  test('rejects frontmatter-only findings before body-only repair', async () => {
    await expect(editorial.repair({
      document: repairDocument,
      findings: [{ passage: 'title: Guide', action: 'Change the title.' }],
    })).rejects.toThrow(/Frontmatter findings require retry/);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('editorial section-answer plan review', () => {
  const sections = [
    { heading: 'When should containers be emptied?', question: 'How often should readers empty containers?', answer: 'Empty water-holding containers once a week.' },
    { heading: 'What follows rain?', question: 'What should readers do after rain?', answer: 'Walk the property after rain and empty newly collected water.' },
  ];

  test('passes only after every planned section answer receives semantic coverage', async () => {
    mockDispatch.mockResolvedValue({
      ok: true,
      model: 'test-deep-model',
      json: {
        pass: true,
        findings: [],
        sectionCoverage: sections.map((_, sectionIndex) => ({ sectionIndex, status: 'pass' })),
      },
    });
    const result = await editorial.reviewPlan({ title: 'Stop Mosquito Breeding', sections });
    expect(result).toMatchObject({ pass: true, findings: [], model: 'test-deep-model' });
    expect(mockDispatch).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ laneId: 'editorial_plan_review', max_tokens: 5000 }),
      expect.objectContaining({ jsonSchema: expect.any(Object), validate: expect.any(Function) }),
    );
  });

  test('fails closed on missing coverage or provider failure', async () => {
    mockDispatch.mockResolvedValue({ ok: false, reason: 'all_providers_failed' });
    const result = await editorial.reviewPlan({ title: 'Stop Mosquito Breeding', sections });
    expect(result.pass).toBe(false);
    expect(result.model).toBeNull();
    expect(result.findings[0].detail).toContain('failed closed');
  });

  test('requires failing findings to anchor the complete proposed answer', async () => {
    mockDispatch.mockResolvedValue({
      ok: true,
      model: 'test-model',
      json: {
        pass: false,
        findings: [{ sectionIndex: 0, passage: 'a paraphrase', detail: 'Too vague.', action: 'State the cadence.' }],
        sectionCoverage: [{ sectionIndex: 0, status: 'fail' }, { sectionIndex: 1, status: 'pass' }],
      },
    });
    const result = await editorial.reviewPlan({ title: 'Stop Mosquito Breeding', sections });
    expect(result.pass).toBe(false);
    expect(result.findings[0].detail).toContain('plan_finding');
  });
});
