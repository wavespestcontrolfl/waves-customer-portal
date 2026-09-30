jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const { dispatchWithFallback } = require('../services/llm/call');
const MODELS = require('../config/models');
const confirmer = require('../services/content/business-name-confirmer');
const { extractCompanyNames, assertOwnerListForCommit, _internals } = confirmer;

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
    // #5146 r9: reserve budget for the fallback rather than handing the
    // primary the whole explicit CALL_TIMEOUT_MS (see
    // business-name-confirmer-fallback-budget.test.js for the real-dispatch
    // proof that a stalled primary still leaves the fallback its share).
    const options = dispatchWithFallback.mock.calls[0][2];
    expect(options).toMatchObject({ reserveFallbackBudget: true });
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

  test('possessive mentions resolve to the company itself; own-brand possessives are dropped (#5146 r11)', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { companies: ["Orkin's", 'Aptive’s', "Lowe's", "Waves'", 'Orkin'] } });
    const r = await extractCompanyNames(DRAFT);
    expect(r.companies).toEqual(['Aptive Environmental', "Lowe's", 'Orkin']);
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

// The owner-list check at the publisher's commit chokepoint, on the FINAL
// committed text (Codex r5 on #5146).
describe('assertOwnerListForCommit', () => {
  // An operator-intercept brief naming the competitors the drafts mention
  // (the final-text comparison gate authorizes exactly as the runner does).
  const BLOG_BRIEF = {
    action_type: 'new_supporting_blog',
    gsc_signal: { bucket: 'operator_intercept' },
    voice_constraints: { operator_brief: { working_title: 'Orkin, Bug Out and local alternatives', primary_kw: 'orkin alternatives' } },
  };
  const TABLE = (cols) => `Intro.\n\n<ComparisonTable columns={${JSON.stringify(cols)}} rows={[{ label: "Recurring plans", values: ["Yes","Yes","Yes"] }]} caption="Attributes as of June 2026, per each company public website." />\n\nOutro.`;
  const finalFm = { title: 'Orkin alternatives in Sarasota', slug: '/pest-control/orkin-alternatives/', meta_description: 'Compare plans.' };

  test('an unchanged final text reuses the stored result (no model call)', async () => {
    const body = 'Orkin offers recurring residential plans.';
    const key = _internals.inputKey(_internals.extractionInput({ frontmatter: finalFm, body, title: finalFm.title, meta_description: finalFm.meta_description }, BLOG_BRIEF, { final: true }));
    const draft = { company_extraction: { ok: true, key, companies: ['Orkin'] } };

    await assertOwnerListForCommit({ draft, brief: BLOG_BRIEF, frontmatter: finalFm, body });

    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(draft.competitors_approved_by_list).toEqual(['Orkin']);
  });

  test('a compared retailer column goes off-list through the extraction; a Title-Cased category column is no company (Codex r10)', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { companies: ['Orkin', 'Home Depot'] } });
    await expect(assertOwnerListForCommit({ draft: {}, brief: BLOG_BRIEF, frontmatter: finalFm, body: TABLE(['What to weigh', 'Orkin', 'Home Depot', 'Waves']) }))
      .rejects.toMatchObject({ code: 'BLOG_OWNER_LIST_BLOCKED', reason: 'named_competitor_off_list', offList: ['Home Depot'] });
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { companies: ['Orkin'] } });
    const draft = {};
    await assertOwnerListForCommit({ draft, brief: BLOG_BRIEF, frontmatter: finalFm, body: TABLE(['What to weigh', 'Orkin', 'Local SWFL Company', 'Waves']) });
    expect(draft.competitors_approved_by_list).toEqual(['Orkin']);
  });

  test('each frontmatter field is judged on its own: a slug and an unrelated meta phrase are not one sentence (Codex r10)', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { companies: ['Orkin'] } });
    const fm2 = { title: 'Roach control options in Sarasota', slug: '/pest-control/orkin-alternatives/', meta_description: 'Worst roach problems in Sarasota and how to fix them fast.', secondary_keywords: ['worst roach problems'] };
    const body = 'German roaches hide near sinks and dishwashers. Seal gaps and keep counters dry.';
    const draft = {};
    await assertOwnerListForCommit({ draft, brief: BLOG_BRIEF, frontmatter: fm2, body });
    expect(draft.competitors_approved_by_list).toEqual(['Orkin']);
    // Disparagement inside ONE field still blocks.
    await expect(assertOwnerListForCommit({ draft: {}, brief: BLOG_BRIEF, body,
      frontmatter: { ...fm2, hero_image: { src: '/images/blog/x/hero.webp', alt: 'Orkin scams customers with hidden fees' } } }))
      .rejects.toMatchObject({ code: 'BLOG_OWNER_LIST_BLOCKED', reason: 'comparison_table_failed' });
    // The refresh lane's camelCase meta fields are read by the gate itself.
    await expect(assertOwnerListForCommit({ draft: {}, brief: BLOG_BRIEF, body,
      frontmatter: { title: 'Roach control options in Sarasota', metaTitle: 'Roach control in Sarasota', metaDescription: 'Orkin scams customers with hidden fees. Call for help.' } }))
      .rejects.toMatchObject({ code: 'BLOG_OWNER_LIST_BLOCKED', reason: 'comparison_table_failed' });
  });

  test('an incidental retailer mention the model does not list is not off-list', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { companies: [] } });
    const draft = {};
    await assertOwnerListForCommit({ draft, brief: BLOG_BRIEF, frontmatter: finalFm, body: 'Buy a pump sprayer at Home Depot before you start.' });
    expect(draft.company_extraction).toMatchObject({ ok: true, companies: [] });
    // The prompt keeps retailers presented as providers, drops incidental ones.
    expect(_internals.SYSTEM_PROMPT).toMatch(/PRESENTS as a provider, an alternative, or a comparison option/);
    expect(_internals.SYSTEM_PROMPT).toMatch(/only as a source or incidentally/);
  });

  test('scheduler lane (humanMergeFallback): only-six competitor content asks for a human merge; an off-list company is refused (Codex r6)', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { companies: ['Orkin'] } });
    const schedFm = { title: 'Choosing pest control in Sarasota', slug: '/pest-control/choosing/', meta_description: 'Compare plans.' };
    expect(await assertOwnerListForCommit({ draft: null, brief: {}, frontmatter: schedFm, body: TABLE(['What to weigh', 'Orkin', 'Waves']), humanMergeFallback: true }))
      .toMatchObject({ requiresHumanMerge: true });
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { companies: ['Bug Out'] } });
    await expect(assertOwnerListForCommit({ draft: null, brief: {}, frontmatter: schedFm, body: 'Bug Out competes with local providers.', humanMergeFallback: true }))
      .rejects.toMatchObject({ code: 'BLOG_OWNER_LIST_BLOCKED', reason: 'named_competitor_off_list', offList: ['Bug Out'] });
  });

  test('publisher-added text failing the comparison gate refuses the commit; operator-authorized prose still passes (Codex r7)', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { companies: ['Orkin'] } });
    await expect(assertOwnerListForCommit({ draft: {}, brief: BLOG_BRIEF, frontmatter: finalFm, body: 'Orkin offers plans.\n\n![Orkin scams customers with hidden fees](/images/blog/x/body-1.webp)' }))
      .rejects.toMatchObject({ code: 'BLOG_OWNER_LIST_BLOCKED', reason: 'comparison_table_failed' });
    const draft = {};
    await assertOwnerListForCommit({ draft, brief: BLOG_BRIEF, frontmatter: finalFm, body: 'Orkin offers recurring residential plans.' });
    expect(draft.competitors_approved_by_list).toEqual(['Orkin']);
  });

  test('the hero alt (and every other publisher-set frontmatter text field) goes through the final comparison gate (Codex r8)', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { companies: ['Orkin'] } });
    await expect(assertOwnerListForCommit({ draft: {}, brief: BLOG_BRIEF, body: 'Orkin offers recurring residential plans.',
      frontmatter: { ...finalFm, hero_image: { src: '/images/blog/x/hero.webp', alt: 'Orkin scams customers with hidden fees' } } }))
      .rejects.toMatchObject({ code: 'BLOG_OWNER_LIST_BLOCKED', reason: 'comparison_table_failed' });

    // An off-list company named only in the hero alt is refused too (the
    // extraction reads the same final frontmatter).
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { companies: ['Bug Out'] } });
    await expect(assertOwnerListForCommit({ draft: {}, brief: BLOG_BRIEF, body: 'Plain body about ants.',
      frontmatter: { ...finalFm, hero_image: { src: '/images/blog/x/hero.webp', alt: 'A Bug Out technician at a lanai' } } }))
      .rejects.toMatchObject({ code: 'BLOG_OWNER_LIST_BLOCKED', reason: 'named_competitor_off_list', offList: ['Bug Out'] });
    expect(dispatchWithFallback.mock.calls.at(-1)[1].text).toContain('hero_image.alt: A Bug Out technician at a lanai');

    // The curated byline credential is not scanned as a business.
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { companies: [] } });
    await expect(assertOwnerListForCommit({ draft: {}, brief: BLOG_BRIEF, body: 'Plain body about ants.',
      frontmatter: { ...finalFm, technically_reviewed_by: { name: 'Adam Benetti', credential: 'FDACS Licensed Pest Control Operator' } } })).resolves.toBeTruthy();
  });

  test('legal-name variants of an approved competitor map to its record, not off-list (Codex r7)', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { companies: ['Orkin, LLC', 'Terminix Global Holdings', 'Aptive Environmental, Inc.'] } });
    const draft = {};
    await assertOwnerListForCommit({ draft, brief: BLOG_BRIEF, frontmatter: finalFm, body: 'Orkin offers recurring residential plans.' });
    expect(draft.company_extraction.companies).toEqual(['Aptive Environmental', 'Orkin', 'Terminix']);
    expect(draft.competitors_approved_by_list).toEqual(['Aptive Environmental', 'Orkin', 'Terminix']);
  });

  test('a failed check refuses the commit', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'no_key' });
    await expect(assertOwnerListForCommit({ draft: {}, brief: BLOG_BRIEF, frontmatter: finalFm, body: 'Plain body.' }))
      .rejects.toMatchObject({ code: 'BLOG_OWNER_LIST_UNVERIFIED', retryable: true });
  });

  // #5146 r9 + r10: a human approves the DRAFT the operator reviewed, not
  // text the publisher adds afterward (a generated/reused hero or body-image
  // alt). The final comparison gate always runs; on the operator-approval
  // lane (a stored draft) the extraction runs too, and a name only
  // publisher-added text carries must be on the owner list.
  test('humanApproved still runs the final comparison gate on publisher-added text (#5146 r9)', async () => {
    // Disparagement planted ONLY in the hero alt (publisher-added, never
    // seen by the human at approval time) still blocks, even humanApproved.
    await expect(assertOwnerListForCommit({
      draft: {}, brief: BLOG_BRIEF, humanApproved: true, body: 'Orkin offers recurring residential plans.',
      frontmatter: { ...finalFm, hero_image: { src: '/images/blog/x/hero.webp', alt: 'Orkin scams customers with hidden fees' } },
    })).rejects.toMatchObject({ code: 'BLOG_OWNER_LIST_BLOCKED', reason: 'comparison_table_failed' });
    // The gate refuses before any model call.
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('humanApproved admin lane (no stored draft) skips the extraction and requires the human merge it relies on', async () => {
    const result = await assertOwnerListForCommit({
      draft: null, brief: BLOG_BRIEF, humanApproved: true, body: 'Bug Out competes with local providers.',
      frontmatter: { ...finalFm, hero_image: { src: '/images/blog/x/hero.webp', alt: 'A technician inspects a Sarasota lanai' } },
    });
    expect(result).toEqual({ extraction: null, requiresHumanMerge: true });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  // The operator-approval lane compares company INVENTORIES: the final
  // text's (first extraction call) against the approved draft's own
  // (second call) — company by company, never word by word (Codex r12).
  const companies = (...lists) => lists.forEach((list) => dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { companies: list } }));
  const heroFm = (alt) => ({ ...finalFm, hero_image: { src: '/images/blog/x/hero.webp', alt } });

  test('humanApproved operator lane: companies the approved draft names pass; one only publisher-added text names must be on the owner list (#5146 r10)', async () => {
    const orkinOnly = { frontmatter: { ...finalFm }, body: 'Orkin offers recurring residential plans.' };
    // Nothing added: the operator's own companies pass.
    companies(['Orkin'], ['Orkin']);
    await expect(assertOwnerListForCommit({ draft: { ...orkinOnly }, brief: BLOG_BRIEF, humanApproved: true, body: orkinOnly.body,
      frontmatter: heroFm('A technician inspects a Sarasota lanai') })).resolves.toMatchObject({ requiresHumanMerge: false, extraction: { ok: true } });
    // An off-list company only the hero alt names was never reviewed.
    companies(['Bug Out', 'Orkin'], ['Orkin']);
    await expect(assertOwnerListForCommit({ draft: { ...orkinOnly }, brief: BLOG_BRIEF, humanApproved: true, body: orkinOnly.body,
      frontmatter: heroFm('A Bug Out technician at a lanai') }))
      .rejects.toMatchObject({ code: 'BLOG_OWNER_LIST_BLOCKED', reason: 'unreviewed_company_name', offList: ['Bug Out'] });
    // The same company is fine when the approved draft names it.
    const withBugOut = { frontmatter: { ...finalFm }, body: 'Bug Out competes with local providers. Orkin offers recurring residential plans.' };
    companies(['Bug Out', 'Orkin'], ['Bug Out', 'Orkin']);
    await expect(assertOwnerListForCommit({ draft: { ...withBugOut }, brief: BLOG_BRIEF, humanApproved: true, body: withBugOut.body,
      frontmatter: heroFm('A Bug Out technician at a lanai') })).resolves.toMatchObject({ requiresHumanMerge: false });
    // An owner-list competitor the publisher adds is allowed unattended anyway.
    const bugOutOnly = { frontmatter: { ...finalFm }, body: 'Bug Out competes with local providers.' };
    companies(['Bug Out', 'Orkin'], ['Bug Out']);
    await expect(assertOwnerListForCommit({ draft: { ...bugOutOnly }, brief: BLOG_BRIEF, humanApproved: true, body: bugOutOnly.body,
      frontmatter: heroFm('An Orkin truck on a Sarasota street') })).resolves.toMatchObject({ requiresHumanMerge: false });
  });

  test('humanApproved operator lane: a word the approved draft used generically never vouches for a company (Codex r12)', async () => {
    // "bug out" in the approved body is a verb phrase, not the company the
    // alt later names — the approved draft's own inventory has no company.
    const generic = { frontmatter: { ...finalFm }, body: 'When ants march in, bug out and call a pro.' };
    companies(['Bug Out'], []);
    await expect(assertOwnerListForCommit({ draft: { ...generic }, brief: BLOG_BRIEF, humanApproved: true, body: generic.body,
      frontmatter: heroFm('A Bug Out technician at a lanai') }))
      .rejects.toMatchObject({ code: 'BLOG_OWNER_LIST_BLOCKED', reason: 'unreviewed_company_name', offList: ['Bug Out'] });
    // The approved draft's own check failing refuses the publish (retryable).
    companies(['Orkin']);
    dispatchWithFallback.mockResolvedValueOnce({ ok: false, reason: 'timeout' });
    await expect(assertOwnerListForCommit({ draft: { ...generic }, brief: BLOG_BRIEF, humanApproved: true, body: generic.body, frontmatter: finalFm }))
      .rejects.toMatchObject({ code: 'BLOG_OWNER_LIST_UNVERIFIED', retryable: true });
  });

  test('humanApproved operator lane: the approved inventory reads only the stored draft, never brief-derived fields the publisher adds (Codex r13)', async () => {
    // The publisher fills primary_keyword from the brief's target keyword;
    // the operator approved a draft without it.
    // (A name the deterministic gate can't see, so only the inventories decide.)
    const brief = { ...BLOG_BRIEF, target_keyword: 'Bug Out alternatives' };
    const approved = { frontmatter: { ...finalFm }, body: 'Orkin offers recurring residential plans.' };
    companies(['Bug Out', 'Orkin'], ['Orkin']);
    await expect(assertOwnerListForCommit({ draft: { ...approved }, brief, humanApproved: true, body: approved.body,
      frontmatter: { ...finalFm, primary_keyword: 'Bug Out alternatives' } }))
      .rejects.toMatchObject({ code: 'BLOG_OWNER_LIST_BLOCKED', reason: 'unreviewed_company_name', offList: ['Bug Out'] });
    // The second (approved-draft) call never saw the brief-derived keyword.
    expect(dispatchWithFallback.mock.calls[0][1].text).toContain('primary_keyword: Bug Out alternatives');
    expect(dispatchWithFallback.mock.calls[1][1].text).not.toContain('Bug Out');
  });

  test('humanApproved operator lane: a curated competitor the approved draft only LINKED counts as reviewed (#5146 r11)', async () => {
    const brief = { ...BLOG_BRIEF, voice_constraints: { operator_brief: { working_title: 'Prodigy Pest alternatives', primary_kw: 'prodigy pest alternatives' } } };
    const approved = { frontmatter: { title: 'Pest plan terms in Sarasota', slug: '/pest-control/plan-terms/', meta_description: 'Compare plans.' },
      body: 'Read the [published terms](https://prodigypest.com/plans) before you sign.' };
    // Even when the model misses it in the approved draft, its gate scan
    // detects the link.
    companies(['Prodigy Pest Solutions'], []);
    await expect(assertOwnerListForCommit({ draft: { ...approved }, brief, humanApproved: true, body: approved.body, frontmatter: approved.frontmatter }))
      .resolves.toMatchObject({ requiresHumanMerge: false });
  });

  test('humanApproved operator lane: the two inventories compare by curated company, whatever the spelling (#5146 r10)', async () => {
    const brief = { ...BLOG_BRIEF, voice_constraints: { operator_brief: { working_title: 'Prodigy Pest alternatives', primary_kw: 'prodigy pest alternatives' } } };
    const approved = { frontmatter: { title: 'Prodigy Pest alternatives in Sarasota', slug: '/pest-control/prodigy-pest-alternatives/', meta_description: 'Compare plans.' }, body: 'Prodigy Pest offers quarterly plans.' };
    companies(['Prodigy Pest'], ['Prodigy Pest Solutions']);
    await expect(assertOwnerListForCommit({ draft: { ...approved }, brief, humanApproved: true, body: approved.body, frontmatter: approved.frontmatter }))
      .resolves.toMatchObject({ requiresHumanMerge: false, extraction: { companies: ['Prodigy Pest Solutions'] } });
  });
});
