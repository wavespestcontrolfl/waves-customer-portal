jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const { dispatchWithFallback } = require('../services/llm/call');
const MODELS = require('../config/models');
const { extractCompanyNames, _internals } = require('../services/content/business-name-confirmer');

// Synthetic drafts only. One structured FAST call per unattended blog draft
// lists every home-service company the whole draft names, links or
// references (Codex r3 on #5146: no deterministic detector converges on
// "Bug Out", a /hulett-alternatives/ slug, or "Lawn Doctor" used two ways).
const DRAFT = {
  title: 'Comparing Termite Plans in Sarasota',
  frontmatter: { slug: '/pest-control/hulett-alternatives/', meta_description: 'How to compare plans.' },
  body: 'Compare plans before you switch. See [their terms](https://example.com/providers/terms).',
};

beforeEach(() => jest.clearAllMocks());

describe('extractCompanyNames', () => {
  test('one fastStructured call on the registered lane, with title, slug, meta, links and body; curated names canonicalized, own brand dropped', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { companies: ['Hulett', 'Massey', 'Waves Pest Control', 'Bug Out'] } });

    const r = await extractCompanyNames(DRAFT);

    expect(r).toMatchObject({ ok: true, companies: ['Bug Out', 'Hulett', 'Massey Services'] });
    expect(r.key).toMatch(/^[0-9a-f]{64}$/);
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    const [policy, payload] = dispatchWithFallback.mock.calls[0];
    expect(policy).toBe(MODELS.TEXT_POLICIES.fastStructured);
    expect(payload).toMatchObject({ laneId: 'business_name_confirm', jsonMode: true });
    for (const part of ['Comparing Termite Plans', '/pest-control/hulett-alternatives/', 'How to compare plans.', 'https://example.com/providers/terms', 'Compare plans before you switch.']) {
      expect(payload.text).toContain(part);
    }
  });

  test('both metadata shapes are sent when top-level and frontmatter values differ (pre-push r7)', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { companies: ['Bug Out'] } });
    await extractCompanyNames({
      ...DRAFT,
      title: 'Comparing Termite Plans',
      meta_description: 'Generic meta.',
      frontmatter: { ...DRAFT.frontmatter, title: 'Bug Out vs. Local Providers', meta_description: 'Bug Out plans compared.' },
    });
    const { text } = dispatchWithFallback.mock.calls[0][1];
    for (const part of ['Comparing Termite Plans', 'Bug Out vs. Local Providers', 'Generic meta.', 'Bug Out plans compared.']) {
      expect(text).toContain(part);
    }
  });

  test('every published text field goes in — including secondary_keywords and brief-derived primary_keyword (Codex r4)', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { companies: ['Bug Out'] } });
    const draft = { ...DRAFT, frontmatter: { ...DRAFT.frontmatter, secondary_keywords: ['bug out alternatives sarasota'] } };

    const r = await extractCompanyNames(draft, { brief: { target_keyword: 'termite plan comparison' } });

    const { text } = dispatchWithFallback.mock.calls[0][1];
    expect(text).toContain('secondary_keywords[0]: bug out alternatives sarasota');
    expect(text).toContain('primary_keyword: termite plan comparison');
    expect(r.companies).toEqual(['Bug Out']);
    // …and a company only there is off the owner list.
    const gate = require('../services/content/comparison-table-gate');
    expect(gate.namedCompetitorListVerdict({ namedCompetitors: [], companyExtraction: r }))
      .toMatchObject({ ok: false, reason: 'named_competitor_off_list', offList: ['Bug Out'] });
  });

  test('own-brand filtering drops only OUR exact names and domains — never a company merely containing "Waves" (Codex r4)', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { companies: [
      'Making Waves Pest Control', 'Waves Pest Control', 'WAVES PEST CONTROL, LLC', 'Waves Pest Control Sarasota',
      'Sarasota Pest Control', 'Bradenton Lawn Care', 'www.sarasotaflpestcontrol.com', 'Waves',
    ] } });

    const r = await extractCompanyNames(DRAFT);

    expect(r.companies).toEqual(['Making Waves Pest Control']);
    const gate = require('../services/content/comparison-table-gate');
    expect(gate.namedCompetitorListVerdict({ namedCompetitors: ['Orkin'], companyExtraction: r }))
      .toMatchObject({ ok: false, reason: 'named_competitor_off_list', offList: ['Making Waves Pest Control'] });
  });

  test('an empty list is a clean result', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { companies: [] } });
    expect(await extractCompanyNames(DRAFT)).toMatchObject({ ok: true, companies: [] });
  });

  test('a provider failure, a throw, or malformed output is a RETRYABLE failure', async () => {
    dispatchWithFallback.mockResolvedValueOnce({ ok: false, reason: 'no_key' });
    expect(await extractCompanyNames(DRAFT)).toMatchObject({ ok: false, reason: 'no_key', retryable: true });
    dispatchWithFallback.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await extractCompanyNames(DRAFT)).toMatchObject({ ok: false, retryable: true });
    dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { companies: 'Hulett' } });
    expect(await extractCompanyNames(DRAFT)).toMatchObject({ ok: false, retryable: true });
  });

  test('a stored result for the same text is reused without a call; changed text calls again; an over-long draft never calls', async () => {
    const prior = { ok: true, key: _internals.inputKey(_internals.extractionInput(DRAFT)), companies: ['Hulett'] };
    expect(await extractCompanyNames(DRAFT, { prior })).toBe(prior);
    expect(dispatchWithFallback).not.toHaveBeenCalled();

    dispatchWithFallback.mockResolvedValue({ ok: true, json: { companies: [] } });
    expect(await extractCompanyNames({ ...DRAFT, body: `${DRAFT.body} More text.` }, { prior })).toMatchObject({ ok: true, companies: [] });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);

    const huge = { ...DRAFT, body: 'x'.repeat(_internals.MAX_INPUT_CHARS) };
    expect(await extractCompanyNames(huge)).toMatchObject({ ok: false, retryable: false, reason: 'draft_too_long_for_extraction' });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
  });
});
