/**
 * Unit tests for content-quality-gate. Safety-critical — heavy coverage.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { evaluate, MIN_TOTAL_SCORES, minTotalScoreFor } = require('../services/content/content-quality-gate');
const {
  checkSchemaValid, checkTitleMetaSpamFree, checkSerpBriefAttached, checkGscSignalAttached,
  checkNoDuplicateIntent, checkCanonical, checkIndexable,
  checkPreviewSuccess, checkSitemapUpdated,
  checkNapConsistent, checkLocalProof, checkCtaAboveFold,
  checkServiceMenu, checkFaqFromCustomer, checkLocalBusinessServiceSchema,
  checkAnswerInFirstParagraph, checkSourceInternalLink, checkRedactionPassed,
  checkImprovementOverPrior,
  checkHubLinkPresent, checkTwoPlusCityMentions, checkFaqSectionPresent, checkVoiceMatch,
  checkTitleLengthBounds, checkMetaLengthBounds,
  checkPrimaryKeywordInTitle, checkNoDuplicateTitle,
} = require('../services/content/content-quality-gate')._internals;

// ── fixtures ────────────────────────────────────────────────────────

function brief(overrides = {}) {
  return {
    page_type: 'supporting-blog',
    city: 'Bradenton',
    service: 'pest',
    target_keyword: 'how to identify a termite swarm',
    serp_signal: { dominant_intent: 'informational' },
    gsc_signal: { impressions: 250 },
    customer_signal: null,
    human_review_required: false,
    ...overrides,
  };
}

function fullDraft(overrides = {}) {
  return {
    url: '/blog/how-to-identify-termite-swarm/',
    body: 'Termite swarmers look like flying ants but have straight antennae. In Bradenton you might see them after rain.',
    title: 'How to Identify a Termite Swarm in Bradenton',
    meta_description: 'Termite swarmers look like flying ants but have straight antennae and equal-length wings. Here is how Bradenton homeowners spot them early.',
    schema: { '@type': 'Article' },
    frontmatter: {},
    ...overrides,
  };
}

// ── hard checks ─────────────────────────────────────────────────────

describe('hard checks: schema/canonical/indexable', () => {
  test('schema_valid passes with object schema', () => {
    expect(checkSchemaValid({ schema: { '@type': 'Article' } }).ok).toBe(true);
  });
  test('schema_valid passes with JSON string', () => {
    expect(checkSchemaValid({ schema: '{"@type":"Article"}' }).ok).toBe(true);
  });
  test('schema_valid fails without schema', () => {
    expect(checkSchemaValid({}).ok).toBe(false);
  });
  test('title_meta_spam_free hard-fails stuffed title patterns', () => {
    const result = checkTitleMetaSpamFree({
      title: 'Pest Control Near Me in Anna Maria, FL | THE BEST Pest Control Anna Maria, FL | Top-Rated Exterminator Near Me',
      meta_description: 'Same-day help.',
    }, { city: 'Anna Maria', service: 'pest', target_keyword: 'pest control anna maria' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/title_contains_the_best/);
  });
  test('serp_brief_attached requires dominant_intent', () => {
    expect(checkSerpBriefAttached({}, { serp_signal: { dominant_intent: 'x' } }).ok).toBe(true);
    expect(checkSerpBriefAttached({}, { serp_signal: {} }).ok).toBe(false);
    expect(checkSerpBriefAttached({}, {}).ok).toBe(false);
  });
  test('gsc_signal_attached requires impressions', () => {
    expect(checkGscSignalAttached({}, { gsc_signal: { impressions: 1 } }).ok).toBe(true);
    expect(checkGscSignalAttached({}, { gsc_signal: {} }).ok).toBe(false);
  });
  test('gsc_signal_attached accepts competitor evidence for competitor_gap bucket', () => {
    const evidence = { bucket: 'competitor_gap', impressions: null, competitor_position: 5, search_volume: 12000, competitor_domain: 'masseyservices.com' };
    expect(checkGscSignalAttached({}, { gsc_signal: evidence }).ok).toBe(true);
    expect(checkGscSignalAttached({}, { gsc_signal: evidence }).reason).toBe('competitor_gap_evidence');
    // a competitor_gap row that lost its provenance still hard-fails
    expect(checkGscSignalAttached({}, { gsc_signal: { bucket: 'competitor_gap', impressions: null } }).ok).toBe(false);
    // numbers alone are not provenance — the auditable competitor domain is required too
    expect(checkGscSignalAttached({}, { gsc_signal: { bucket: 'competitor_gap', competitor_position: 5, search_volume: 12000 } }).ok).toBe(false);
    // the exemption is keyed on the bucket — other buckets can't ride competitor fields past the check
    expect(checkGscSignalAttached({}, { gsc_signal: { bucket: 'striking_distance', competitor_position: 5, search_volume: 100, competitor_domain: 'x.com' } }).ok).toBe(false);
  });
  test('no_duplicate_intent fails on cannibalization human_review reason', () => {
    expect(checkNoDuplicateIntent({}, { human_review_required: true, human_review_reason: 'cannibalization bucket' }).ok).toBe(false);
    expect(checkNoDuplicateIntent({}, { human_review_required: true, human_review_reason: 'first publish trust-build' }).ok).toBe(true);
    expect(checkNoDuplicateIntent({}, {}).ok).toBe(true);
  });
  test('canonical: warns when set elsewhere', () => {
    expect(checkCanonical({ url: '/a/', canonical: '/b/' }).ok).toBe(false);
    expect(checkCanonical({ url: '/a/', canonical: '/a/' }).ok).toBe(true);
  });
  test('indexable: fails on noindex robots', () => {
    expect(checkIndexable({ frontmatter: { robots: 'noindex' } }).ok).toBe(false);
    expect(checkIndexable({ frontmatter: { robots: 'index,follow' } }).ok).toBe(true);
    expect(checkIndexable({}).ok).toBe(true);
  });
  test('sitemap_updated honors context', () => {
    expect(checkSitemapUpdated({}, {}, { sitemapHasUrl: true }).ok).toBe(true);
    expect(checkSitemapUpdated({}, {}, { sitemapHasUrl: false }).ok).toBe(false);
    expect(checkSitemapUpdated({}, {}, {}).ok).toBe(true); // skipped
  });
  test('preview_success honors context', () => {
    expect(checkPreviewSuccess({}, {}, { previewBuildSuccess: true }).ok).toBe(true);
    expect(checkPreviewSuccess({}, {}, { previewBuildSuccess: false }).ok).toBe(false);
  });
});

// ── city-service checks ─────────────────────────────────────────────

describe('city-service: nap / proof / cta / menu / faq / schema', () => {
  test('NAP check requires brand + a WAVES phone (not just any phone)', () => {
    expect(checkNapConsistent({ body: 'Waves Pest Control · (941) 297-2606' }).ok).toBe(true);
    expect(checkNapConsistent({ body: 'No phone here.' }).ok).toBe(false);
    expect(checkNapConsistent({ body: 'Just (941) 297-2606' }).ok).toBe(false);
    // A stray CUSTOMER number must NOT satisfy the business-NAP requirement —
    // the pre-fix any-phone regex accepted it as "the phone".
    expect(checkNapConsistent({ body: 'Waves Pest Control · 941-555-1234' })).toEqual({ ok: false, reason: 'waves_phone_missing' });
  });
  test('local proof requires quantified/quoted/tech signal', () => {
    expect(checkLocalProof({ body: '500+ jobs in Bradenton' }).ok).toBe(true);
    expect(checkLocalProof({ body: 'generic copy only' }).ok).toBe(false);
  });
  test('CTA above fold requires action language in first 800 chars', () => {
    expect(checkCtaAboveFold({ body: 'Get a free inspection today. Then we will...' }).ok).toBe(true);
    expect(checkCtaAboveFold({ body: 'X'.repeat(900) + 'free inspection here' }).ok).toBe(false);
  });
  test('service menu requires ≥3 list items', () => {
    expect(checkServiceMenu({ body: '- pest\n- lawn\n- mosquito\n- termite' }).ok).toBe(true);
    expect(checkServiceMenu({ body: '- pest\n- lawn' }).ok).toBe(false);
  });
  test('FAQ from customer requires section heading + customer signal topic referenced', () => {
    const cs = { normalized_question: 'Does rain affect the treatment?', topic: 'rain-after-treatment' };
    expect(checkFaqFromCustomer({ body: 'FAQ\nDoes rain affect the treatment? No.' }, { customer_signal: cs }).ok).toBe(true);
    expect(checkFaqFromCustomer({ body: 'No FAQ section.' }, { customer_signal: cs }).ok).toBe(false);
  });
  test('LocalBusiness/Service schema check', () => {
    expect(checkLocalBusinessServiceSchema({ schema: { '@type': 'LocalBusiness' } }).ok).toBe(true);
    expect(checkLocalBusinessServiceSchema({ schema: { '@type': 'Article' } }).ok).toBe(false);
  });
});

// ── customer-question checks ────────────────────────────────────────

describe('customer-question: answer-in-first-paragraph / link / redaction', () => {
  test('answer in first paragraph: short + addresses question', () => {
    const draft = { body: 'Termites have straight antennae. (long article continues...)' };
    expect(checkAnswerInFirstParagraph(draft, { target_keyword: 'how to identify termites' }).ok).toBe(true);
  });
  test('fails when first paragraph too long', () => {
    const draft = { body: 'x'.repeat(700) };
    expect(checkAnswerInFirstParagraph(draft, { target_keyword: 'termites' }).ok).toBe(false);
  });
  test('source internal link required', () => {
    expect(checkSourceInternalLink({ body: 'See [more here](/termite-inspection/)' }).ok).toBe(true);
    expect(checkSourceInternalLink({ body: 'no links here' }).ok).toBe(false);
  });
  test('redaction passed: catches non-business phone + email', () => {
    expect(checkRedactionPassed({ body: 'Plain text.' }).ok).toBe(true);
    expect(checkRedactionPassed({ body: 'Email me at jane@example.com' }).ok).toBe(false);
  });
  test('redaction: allows known Waves numbers, rejects other 941 / parenthesized', () => {
    // Known Waves number — allowed.
    expect(checkRedactionPassed({ body: 'Call us at 941-318-7612.' }).ok).toBe(true);
    expect(checkRedactionPassed({ body: 'Reach Sarasota: (941) 297-2606.' }).ok).toBe(true);
    // Non-Waves 941 number — rejected (earlier code wrongly allowed any 941/863).
    expect(checkRedactionPassed({ body: 'Reach me at 941-555-9876.' }).ok).toBe(false);
    // Parenthesized customer number — earlier regex missed this entirely.
    expect(checkRedactionPassed({ body: 'My cell is (212) 555-1234.' }).ok).toBe(false);
    // A customer number sharing a Waves line's LAST SEVEN digits in another
    // area code — the pre-fix last-7 allowlist key accepted it as Waves.
    expect(checkRedactionPassed({ body: 'Call 212-318-7612 anytime.' }).ok).toBe(false);
  });
  test('redaction: Waves\' own email is page furniture, customer emails are PII', () => {
    expect(checkRedactionPassed({ body: 'Email info@wavespestcontrol.com to book.' }).ok).toBe(true);
    expect(checkRedactionPassed({ body: 'Email info@wavespestcontrol.com or karen@gmail.com.' }).ok).toBe(false);
  });
  test('redaction: customer NAMES and street ADDRESSES hard-fail (Codex round 4 — phones/emails alone left the exact gap this gate closes)', () => {
    const addr = checkRedactionPassed({ body: 'John Smith at 4867 Maple Street told us the ants were back within a week.' });
    expect(addr.ok).toBe(false);
    expect(addr.reason).toMatch(/unredacted_(name|address)_in_body/);
    const name = checkRedactionPassed({ body: 'My name is john smith and i want a quote' });
    expect(name.ok).toBe(false);
    expect(name.reason).toBe('unredacted_name_in_body');
  });
  test('redaction: Waves\' own office address is NAP furniture, never PII', () => {
    expect(checkRedactionPassed({
      body: 'Our Bradenton office at 13649 Luxe Ave #110, Bradenton, FL 34211 serves Lakewood Ranch.',
    }).ok).toBe(true);
  });
  test('redaction: staff names and normal service copy stay clean', () => {
    expect(checkRedactionPassed({
      body: 'Owner Jose Alvarado has treated 500+ homes. Termites swarm in Venice every spring; call (941) 297-3337.',
    }).ok).toBe(true);
  });
  test('redaction: office address WITHOUT the suite marker is still NAP furniture (Codex round 5)', () => {
    expect(checkRedactionPassed({
      body: 'Our office at 13649 Luxe Ave, Bradenton, FL 34211 serves the area.',
    }).ok).toBe(true);
  });
  test('redaction: LOW redactor confidence hard-fails — "no findings" proves nothing on lowercase text (Codex round 5)', () => {
    const r = checkRedactionPassed({
      body: 'john smith told our technician the ants came back after two days and he was not happy about it at all',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/pii_confidence_low|unredacted_name_in_body/);
  });
  test('redaction: Waves spoke/GBP tracking lines are business numbers, not PII (Codex round 5)', () => {
    expect(checkRedactionPassed({
      body: 'Termites swarm in Venice; call (941) 326-5011 for the Bradenton line.',
    }).ok).toBe(true);
  });
  test('redaction: CITY_TO_LOCATION service-area names are place furniture, never PII (Codex round 7)', () => {
    expect(checkRedactionPassed({
      body: 'Waves Pest Control serves Punta Gorda. Call (941) 297-5749.',
    }).ok).toBe(true);
    expect(checkRedactionPassed({
      body: 'We treat homes across Boca Grande and Sun City Center every quarter, with same-day service in Englewood.',
    }).ok).toBe(true);
  });
});

// ── refresh checks ──────────────────────────────────────────────────

describe('refresh: improvement over prior', () => {
  test('passes when new content is longer + +200 chars', () => {
    const prev = { body: 'x'.repeat(1000) };
    const draft = { body: 'x'.repeat(1500) };
    expect(checkImprovementOverPrior(draft, {}, { previousVersion: prev }).ok).toBe(true);
  });
  test('fails when lost > 20% of prior content', () => {
    const prev = { body: 'x'.repeat(1000) };
    const draft = { body: 'x'.repeat(500) };
    expect(checkImprovementOverPrior(draft, {}, { previousVersion: prev }).ok).toBe(false);
  });
  test('fails when adds less than 200 chars', () => {
    const prev = { body: 'x'.repeat(1000) };
    const draft = { body: 'x'.repeat(1050) };
    expect(checkImprovementOverPrior(draft, {}, { previousVersion: prev }).ok).toBe(false);
  });
  test('fails when no previous version', () => {
    expect(checkImprovementOverPrior({ body: 'x' }, {}, {}).ok).toBe(false);
  });
});

// ── supporting-blog checks ──────────────────────────────────────────

describe('supporting-blog: hub link / cities / faq / voice', () => {
  test('hub link present', () => {
    expect(checkHubLinkPresent({ body: 'See /pest-control-services/' }).ok).toBe(true);
    expect(checkHubLinkPresent({ body: 'no hub link' }).ok).toBe(false);
  });
  test('every SERVICE_HUB_LINKS hub satisfies the gate (termite/rodent intercept posts link where the builder steers them)', () => {
    const { SERVICE_HUB_LINKS } = require('../services/content/content-brief-builder')._internals;
    for (const hub of new Set(Object.values(SERVICE_HUB_LINKS).flat())) {
      expect(checkHubLinkPresent({ body: `Book a visit via ${hub} today.` }).ok).toBe(true);
    }
    // The C/F-cluster case the gate previously failed: termite-only hub link.
    expect(checkHubLinkPresent({ body: 'Schedule at /termite-inspection/ first.' }).ok).toBe(true);
  });
  test('two-plus city mentions', () => {
    expect(checkTwoPlusCityMentions({ body: 'Bradenton and Sarasota homes' }).ok).toBe(true);
    expect(checkTwoPlusCityMentions({ body: 'Bradenton only' }).ok).toBe(false);
  });
  test('FAQ section', () => {
    expect(checkFaqSectionPresent({ body: 'FAQ\n- Q?\n- A.' }).ok).toBe(true);
    expect(checkFaqSectionPresent({ body: 'no section' }).ok).toBe(false);
  });
  test('voice match', () => {
    const body = 'Your sandy soil and afternoon storms create perfect conditions. You should protect your home. Your yard matters. You need this. Your call.';
    expect(checkVoiceMatch({ body }).ok).toBe(true);
    expect(checkVoiceMatch({ body: 'generic corporate language' }).ok).toBe(false);
  });
});

// ── metadata checks ────────────────────────────────────────────────

describe('metadata: title / meta / keyword / no-duplicate', () => {
  test('title length 30-70 inclusive', () => {
    expect(checkTitleLengthBounds({ title: 'A' .repeat(40) }).ok).toBe(true);
    expect(checkTitleLengthBounds({ title: 'A' }).ok).toBe(false);
    expect(checkTitleLengthBounds({ title: 'A'.repeat(100) }).ok).toBe(false);
  });
  test('meta length 115-160 inclusive', () => {
    expect(checkMetaLengthBounds({ meta_description: 'M'.repeat(140) }).ok).toBe(true);
    expect(checkMetaLengthBounds({ meta_description: 'short' }).ok).toBe(false);
  });
  test('primary keyword in title', () => {
    expect(checkPrimaryKeywordInTitle({ title: 'Termite Inspection Bradenton' }, { target_keyword: 'termite inspection bradenton' }).ok).toBe(true);
    expect(checkPrimaryKeywordInTitle({ title: 'Generic Title' }, { target_keyword: 'termite inspection bradenton' }).ok).toBe(false);
  });
  test('no duplicate title', () => {
    const sibs = new Set(['pest control bradenton']);
    expect(checkNoDuplicateTitle({ title: 'Pest Control Bradenton' }, {}, { siblingTitles: sibs }).ok).toBe(false);
    expect(checkNoDuplicateTitle({ title: 'New Unique Title' }, {}, { siblingTitles: sibs }).ok).toBe(true);
  });
});

// ── full evaluate ───────────────────────────────────────────────────

describe('evaluate (full gate)', () => {
  test('strong supporting-blog draft passes (score ≥ 75)', () => {
    const r = evaluate(
      fullDraft({
        body: 'Termite swarmers have straight antennae and equal-length wings — Bradenton and Sarasota homeowners often spot them after rain. Use your eyes carefully. Your home depends on it. Your sandy soil and afternoon storms create perfect conditions. /pest-control-services/ — get help.\n\nFAQ\n- Do swarmers bite?\n- No, just look.',
      }),
      brief({ page_type: 'supporting-blog' }),
      { previewBuildSuccess: true, sitemapHasUrl: true }
    );
    // Should pass all hard checks; soft score may not hit 75 with minimal body
    // but at least zero hard failures expected.
    expect(r.hard_failures).toEqual([]);
  });
  test('missing schema → hard fail → not ok', () => {
    const draft = fullDraft({ schema: undefined });
    const r = evaluate(draft, brief({ page_type: 'supporting-blog' }));
    expect(r.hard_failures.some((f) => f.name === 'schema_valid')).toBe(true);
    expect(r.ok).toBe(false);
  });
  test('spammy title → hard fail → not ok', () => {
    const draft = fullDraft({
      title: 'Pest Control Near Me in Anna Maria, FL | THE BEST Pest Control Anna Maria, FL | Top-Rated Exterminator Near Me',
    });
    const r = evaluate(draft, brief({ city: 'Anna Maria', service: 'pest' }));
    expect(r.hard_failures.some((f) => f.name === 'title_meta_spam_free')).toBe(true);
    expect(r.ok).toBe(false);
  });
  test('city-service draft missing LocalBusiness schema → hard fail', () => {
    const r = evaluate(
      fullDraft({ schema: { '@type': 'Article' } }),
      brief({ page_type: 'city-service' })
    );
    expect(r.hard_failures.some((f) => f.name === 'localbusiness_service_schema')).toBe(true);
  });
  test('MIN_TOTAL_SCORES is per page type: 75% of own ceiling, floored at one worst-case soft miss', () => {
    // Common hard checks sum to 37; base = floor((37 + page bundle) *
    // 0.75), raised to (ceiling - largest soft weight) when the formula
    // lands at or below the bundle's hard sum — a threshold the hard
    // checks alone satisfy would let a draft miss EVERY soft check. The
    // old single global threshold (city-service-derived 54) made smaller
    // bundles unpassable: refresh maxes at 47.
    expect(MIN_TOTAL_SCORES['city-service']).toBe(60); // 75% formula (ceiling 81, hard sum 51 incl. redaction 8)
    expect(MIN_TOTAL_SCORES['customer-question']).toBe(59); // all-hard bundle
    expect(MIN_TOTAL_SCORES.refresh).toBe(47); // all-hard bundle
    expect(MIN_TOTAL_SCORES['supporting-blog']).toBe(51); // 57 - voice 6
    expect(MIN_TOTAL_SCORES.metadata).toBe(57); // 63 - keyword 6
    expect(MIN_TOTAL_SCORES.none).toBe(37); // common-only
  });
  test('every threshold demands more than its hard checks alone (no all-soft-miss pass)', () => {
    const { HARD_CHECKS, PAGE_TYPE_CHECKS } = require('../services/content/content-quality-gate')._internals;
    const commonSum = HARD_CHECKS.reduce((s, c) => s + c.weight, 0);
    for (const [pageType, checks] of Object.entries(PAGE_TYPE_CHECKS)) {
      const hardSum = commonSum + checks.filter((c) => c.isHard).reduce((s, c) => s + c.weight, 0);
      const softChecks = checks.filter((c) => !c.isHard);
      // With >= 2 soft checks the threshold must demand soft compliance
      // beyond the hard checks; a single-soft bundle's one-worst-miss
      // floor legitimately equals its hard sum (that one soft may miss).
      if (softChecks.length >= 2) {
        expect(MIN_TOTAL_SCORES[pageType]).toBeGreaterThan(hardSum);
      } else {
        expect(MIN_TOTAL_SCORES[pageType]).toBeGreaterThanOrEqual(hardSum);
      }
    }
  });
  test('minTotalScoreFor reports the common-only threshold for unknown/prototype-chain page types', () => {
    expect(minTotalScoreFor('refresh')).toBe(47);
    expect(minTotalScoreFor('some-future-type')).toBe(MIN_TOTAL_SCORES.none);
    expect(minTotalScoreFor(undefined)).toBe(MIN_TOTAL_SCORES.none);
    expect(minTotalScoreFor('constructor')).toBe(MIN_TOTAL_SCORES.none);
  });
  test('unknown page type hard-fails the gate (fail closed), even with all commons passing', () => {
    // A typo'd or legacy page_type must not bypass its real bundle's hard
    // checks by gating on commons alone (37 >= the 27 'none' threshold).
    for (const bad of ['blog', 'Refresh', 'constructor']) {
      const r = evaluate(
        fullDraft(),
        brief({ page_type: bad }),
        { previewBuildSuccess: true, sitemapHasUrl: true }
      );
      expect(r.hard_failures.some((f) => f.name === 'known_page_type' && f.reason === `unknown_page_type:${bad}`)).toBe(true);
      expect(r.ok).toBe(false);
    }
    // The explicit empty bundles stay common-only and still pass.
    const links = evaluate(fullDraft(), brief({ page_type: 'links' }), { previewBuildSuccess: true, sitemapHasUrl: true });
    expect(links.hard_failures).toEqual([]);
    expect(links.ok).toBe(true);
  });
  test('every page type\'s threshold is reachable from its own ceiling', () => {
    const { HARD_CHECKS, PAGE_TYPE_CHECKS } = require('../services/content/content-quality-gate')._internals;
    const commonSum = HARD_CHECKS.reduce((s, c) => s + c.weight, 0);
    for (const [pageType, checks] of Object.entries(PAGE_TYPE_CHECKS)) {
      const ceiling = commonSum + checks.reduce((s, c) => s + c.weight, 0);
      expect(MIN_TOTAL_SCORES[pageType]).toBeLessThanOrEqual(ceiling);
    }
  });
  test('refresh that fails improvement_over_prior hard-fails (content-gutting edits to live pages block)', () => {
    // improvement_over_prior must be HARD: a refresh that loses >20% of
    // prior content, or has no prior version to compare, must never pass
    // regardless of how the threshold math evolves.
    const lost = evaluate(
      fullDraft({ body: 'x'.repeat(700) }),
      brief({ page_type: 'refresh' }),
      { previewBuildSuccess: true, sitemapHasUrl: true, previousVersion: { body: 'x'.repeat(1000) } }
    );
    expect(lost.total_score).toBe(37);
    expect(lost.hard_failures.some((f) => f.name === 'improvement_over_prior')).toBe(true);
    expect(lost.ok).toBe(false);

    const noPrior = evaluate(
      fullDraft({ body: 'x'.repeat(1500) }),
      brief({ page_type: 'refresh' }),
      { previewBuildSuccess: true, sitemapHasUrl: true }
    );
    expect(noPrior.hard_failures.some((f) => f.name === 'improvement_over_prior')).toBe(true);
    expect(noPrior.ok).toBe(false);
  });
  test('perfect refresh draft passes its own threshold (prod 2026-06-12: 47/47 gate-failed under global 54)', () => {
    const r = evaluate(
      fullDraft({ body: 'x'.repeat(1500) }),
      brief({ page_type: 'refresh' }),
      { previewBuildSuccess: true, sitemapHasUrl: true, previousVersion: { body: 'x'.repeat(1000) } }
    );
    expect(r.hard_failures).toEqual([]);
    expect(r.total_score).toBe(47);
    expect(r.min_total_score).toBe(47);
    expect(r.ok).toBe(true);
  });
  test('supporting-blog survives one 6-point soft miss (sank under global 54: A1 scored 51)', () => {
    // Passes hub/cities/FAQ and all common checks but misses voice_match:
    // 57 - 6 = 51 >= 51. Under the old global threshold this score shape
    // failed (51 < 54) even though only one soft check missed.
    const r = evaluate(
      fullDraft({
        body: 'Termite swarmers show up after rain in Bradenton and Sarasota. See our [pest control services](/pest-control-services/) for treatment options.\n\nFAQ\n- Do swarmers bite?\n- No.',
      }),
      brief({ page_type: 'supporting-blog' }),
      { previewBuildSuccess: true, sitemapHasUrl: true }
    );
    expect(r.checks.voice_match.ok).toBe(false);
    expect(r.hard_failures).toEqual([]);
    expect(r.total_score).toBe(51);
    expect(r.min_total_score).toBe(51);
    expect(r.ok).toBe(true);
  });
  test('supporting-blog with two+ soft misses fails: hub-only (43) must not auto-publish', () => {
    // Hub link present but cities/FAQ/voice ALL miss → 37 + 6 = 43 < 51.
    // Under the formula-only threshold (42) this hub-only shape passed,
    // publishing a supporting blog with none of the local-quality
    // signals.
    const r = evaluate(
      fullDraft({
        body: 'Termites are insects. Read our [pest control services](/pest-control-services/) page.',
      }),
      brief({ page_type: 'supporting-blog' }),
      { previewBuildSuccess: true, sitemapHasUrl: true }
    );
    expect(r.hard_failures).toEqual([]);
    expect(r.total_score).toBe(43);
    expect(r.min_total_score).toBe(51);
    expect(r.ok).toBe(false);
  });
  test('supporting-blog with no hub link hard-fails even above threshold (A1 shape must block, not pass)', () => {
    // hub_link_present must be HARD: as a 6-pt soft miss this draft
    // scores 51 >= 42 and would auto-publish without the hub link the
    // writer instructions promise the gate enforces.
    const r = evaluate(
      fullDraft({
        body: 'Termite swarmers show up after rain in Bradenton and Sarasota. Your sandy soil and afternoon storms create perfect conditions. You should check your baseboards; your garage and your lanai matter too.\n\nFAQ\n- Do swarmers bite?\n- No.',
      }),
      brief({ page_type: 'supporting-blog' }),
      { previewBuildSuccess: true, sitemapHasUrl: true }
    );
    expect(r.total_score).toBe(51);
    expect(r.total_score).toBeGreaterThanOrEqual(r.min_total_score);
    expect(r.hard_failures.some((f) => f.name === 'hub_link_present')).toBe(true);
    expect(r.ok).toBe(false);
  });
  test('customer-question missing both answer-up-front and internal link hard-fails', () => {
    // Both checks must be HARD: under the original 75%-formula threshold
    // (44), commons (37) + redaction (8) = 45 passed with a page that
    // neither answers the question up front nor links anywhere internal.
    const r = evaluate(
      fullDraft({
        body: 'Many homeowners ask about this every spring.\n\nLonger detail follows here without any links at all.',
      }),
      brief({ page_type: 'customer-question' }),
      { previewBuildSuccess: true, sitemapHasUrl: true }
    );
    expect(r.total_score).toBe(45);
    expect(r.hard_failures.some((f) => f.name === 'answer_in_first_paragraph')).toBe(true);
    expect(r.hard_failures.some((f) => f.name === 'source_internal_link')).toBe(true);
    expect(r.ok).toBe(false);

    const good = evaluate(
      fullDraft({
        // Realistic capitalization density: a two-sentence all-lowercase-ish
        // body dips under the redactor's effectively-lowercase threshold and
        // trips the (correct) pii_confidence_low hard fail — real drafts are
        // article-length with headings and proper nouns.
        body: 'A termite swarm means a mature colony is nearby — here is how to identify one fast. Swarmers in Southwest Florida usually appear after warm spring rain, and Sarasota homes see them first.\n\nSee our [termite inspection](/termite-inspection/) page for next steps.',
      }),
      brief({ page_type: 'customer-question' }),
      { previewBuildSuccess: true, sitemapHasUrl: true }
    );
    expect(good.hard_failures).toEqual([]);
    expect(good.ok).toBe(true);
  });
  test('throws on missing inputs', () => {
    expect(() => evaluate(null, brief())).toThrow();
    expect(() => evaluate({ body: 'x' }, null)).toThrow();
  });
});

// ── FAQ-blocked-topic neutrality ─────────────────────────────────────
//
// Generators are instructed (via content-guardrails' exported blocklist) to
// OMIT the FAQ section on FAQ-blocked services — the publish guard P0s any
// FAQ there. The gate must not score those drafts down for correctly
// omitting it (neutral = check passes at full weight), and must fail fast
// when an FAQ slips in anyway.
describe('FAQ checks are neutral on FAQ-blocked topics', () => {
  const NO_FAQ_BODY = 'Rodents in your Bradenton attic chew wiring. Sarasota homes see the same after storms. Call a pro early.';
  const FAQ_BODY = 'Rodents chew wiring in Bradenton and Sarasota.\n\n## Frequently Asked Questions\nQ: Do rats bite? A: Sometimes.';

  test('faq_section_present passes when a blocked-topic blog correctly omits the FAQ (brief.service)', () => {
    const r = checkFaqSectionPresent({ body: NO_FAQ_BODY }, { service: 'rodent' });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('faq_blocked_service_omission_is_correct');
  });

  test('faq_section_present resolves blocked topics from frontmatter tag/category too', () => {
    expect(checkFaqSectionPresent({ body: NO_FAQ_BODY, frontmatter: { tag: 'Rodents' } }, { service: 'pest' }).ok).toBe(true);
    expect(checkFaqSectionPresent({ body: NO_FAQ_BODY, frontmatter: { category: 'termite' } }, {}).ok).toBe(true);
  });

  test('faq_section_present fails when an FAQ is present on a blocked topic', () => {
    const r = checkFaqSectionPresent({ body: FAQ_BODY }, { service: 'rodent' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('faq_present_on_faq_blocked_service');
  });

  test('faq_section_present unchanged for non-blocked topics', () => {
    expect(checkFaqSectionPresent({ body: NO_FAQ_BODY }, { service: 'pest' }).ok).toBe(false);
    expect(checkFaqSectionPresent({ body: FAQ_BODY }, { service: 'pest' }).ok).toBe(true);
  });

  test('faq_from_customer_calls (city-service) is neutral on blocked topics and fails if FAQ present', () => {
    const cs = { normalized_question: 'do rats come back after treatment' };
    expect(checkFaqFromCustomer({ body: NO_FAQ_BODY }, { service: 'rodent', customer_signal: cs }).ok).toBe(true);
    expect(checkFaqFromCustomer({ body: FAQ_BODY }, { service: 'rodent', customer_signal: cs }).ok).toBe(false);
    // Non-blocked service: original behavior intact.
    expect(checkFaqFromCustomer({ body: NO_FAQ_BODY }, { service: 'pest', customer_signal: cs }).ok).toBe(false);
  });

  test('faq_from_customer_calls resolves blocked topics from customer_signal.service when brief.service is broad', () => {
    // City-service briefs persist the broad service ('pest') while the real
    // topic lives on customer_signal.service/topic (content-brief-builder).
    const cs = { service: 'rodent', normalized_question: 'do rats come back after treatment' };
    const r = checkFaqFromCustomer({ body: NO_FAQ_BODY }, { service: 'pest', customer_signal: cs });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('faq_blocked_service_omission_is_correct');
    // FAQ present on the blocked customer_signal topic still fails.
    expect(checkFaqFromCustomer({ body: FAQ_BODY }, { service: 'pest', customer_signal: cs }).ok).toBe(false);
  });

  test('faq_from_customer_calls resolves blocked topics from customer_signal.topic too', () => {
    const cs = { topic: 'termites', normalized_question: 'are termites active in summer' };
    expect(checkFaqFromCustomer({ body: NO_FAQ_BODY }, { service: 'pest', customer_signal: cs }).ok).toBe(true);
    // Non-blocked customer_signal topic: original behavior intact.
    const open = { topic: 'ants in kitchen', normalized_question: 'how do i stop ants' };
    expect(checkFaqFromCustomer({ body: NO_FAQ_BODY }, { service: 'pest', customer_signal: open }).ok).toBe(false);
  });

  test('faq checks resolve canonical blog tags via the guardrails alias map (Roaches, Stinging Insects)', () => {
    expect(checkFaqSectionPresent({ body: NO_FAQ_BODY, frontmatter: { tag: 'Roaches' } }, { service: 'pest' }).ok).toBe(true);
    expect(checkFaqSectionPresent({ body: NO_FAQ_BODY, frontmatter: { tag: 'Stinging Insects' } }, { service: 'pest' }).ok).toBe(true);
    expect(checkFaqSectionPresent({ body: FAQ_BODY, frontmatter: { tag: 'Roaches' } }, { service: 'pest' }).ok).toBe(false);
  });

  test('evaluate() awards faq_section_present weight to a blocked-topic supporting blog without an FAQ', () => {
    const result = evaluate(
      fullDraft({
        body: 'Rodents in your Bradenton attic chew wiring — Sarasota homes see it too. Your sandy soil and afternoon storms drive them indoors. See /pest-control-services/ for help. You should act early; your wiring depends on it.',
      }),
      brief({ service: 'rodent', target_keyword: 'rodents in attic bradenton' }),
    );
    expect(result.checks.faq_section_present.ok).toBe(true);
    expect(result.checks.faq_section_present.reason).toBe('faq_blocked_service_omission_is_correct');
  });
});
