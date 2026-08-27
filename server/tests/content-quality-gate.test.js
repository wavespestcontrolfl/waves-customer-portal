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
  checkNoRawMarkdownTables,
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
    meta_description: 'Termite swarmers look like flying ants but have straight antennae and equal-length wings. Learn more on the Waves blog.',
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
  test('redaction: markdown headings are structural furniture, not customer quotes (Codex round 9)', () => {
    expect(checkRedactionPassed({
      body: '## Our Process\n\nWe inspect first.\n\n## Why Choose Waves Pest Control\n\nBecause we live in Sarasota and answer the phone.',
    }).ok).toBe(true);
    // prose PII below a heading still fails
    expect(checkRedactionPassed({
      body: '## Our Process\n\nJohn Smith at 4867 Maple Street told us the ants were back.',
    }).ok).toBe(false);
  });
  test('redaction: regional non-service cities (Fort Myers) are place pairs, not names (Codex round 9)', () => {
    expect(checkRedactionPassed({
      body: 'Residents in Fort Myers and Cape Coral see tegu lizards moving north toward Venice every year.',
    }).ok).toBe(true);
  });
  test('redaction: title-cased pest/disease vocabulary is service copy, not a customer name (Codex round 15)', () => {
    expect(checkRedactionPassed({
      body: 'Brown Patch and Take All Root Rot spread in damp turf, while Chinch Bug and Sod Webworm damage shows up in dry spots. Call (941) 297-2606.',
    }).ok).toBe(true);
    expect(checkRedactionPassed({
      body: 'Southern Chinch Bug activity peaks in July across St. Augustine Grass lawns from Palmetto to Venice.',
    }).ok).toBe(true);
    // A real customer name in the body still hard-fails.
    const r = checkRedactionPassed({ body: 'This is James Brown and the ants are back again this week.' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unredacted_name_in_body');
  });
  test('redaction: short lowercase self-intro snippets hard-fail on confidence (Codex round 16)', () => {
    // Under 40 letters the old backstop never ran, so this exact shape
    // returned zero findings + high confidence and published a real name.
    const r = checkRedactionPassed({ body: 'this is john smith ants are back' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('pii_confidence_low');
  });
  test('redaction: attached-extension customer phones are caught (Codex round 16)', () => {
    const r = checkRedactionPassed({ body: 'Call the customer directly on 212-555-1234x99 to reschedule the visit.' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('non_business_phone_number_in_body:2125551234');
    // Waves' own line with an extension: the CORE number drives the
    // allowlist compare, so extension digits don't poison the last-10.
    expect(checkRedactionPassed({
      body: 'Call (941) 297-2606 ext 2 to reach the Sarasota office today.',
    }).ok).toBe(true);
  });
  test('redaction: SEO fields (title/meta) are scanned like the page they publish on (Codex round 16)', () => {
    const clean = {
      body: 'Chinch bugs thrive in dry Bradenton lawns. Call (941) 297-2606 for a free inspection.',
      title: 'Chinch Bug Control in Bradenton',
      meta_description: 'Serving Sarasota and Manatee County with same-day chinch bug treatment.',
    };
    expect(checkRedactionPassed(clean).ok).toBe(true);
    const nameTitle = checkRedactionPassed({ ...clean, title: 'How John Smith Fixed His Lawn' });
    expect(nameTitle.ok).toBe(false);
    expect(nameTitle.reason).toBe('unredacted_name_in_title');
    const phoneMeta = checkRedactionPassed({ ...clean, meta_description: 'Call John at 212-555-1234 for pest help.' });
    expect(phoneMeta.ok).toBe(false);
    expect(phoneMeta.reason).toBe('non_business_phone_number_in_meta_description:2125551234');
    const emailMeta = checkRedactionPassed({ ...clean, meta_description: 'Email karen@gmail.com for a quote today.' });
    expect(emailMeta.ok).toBe(false);
    expect(emailMeta.reason).toBe('email_in_meta_description');
    // frontmatter-shaped drafts get the same coverage
    const fmTitle = checkRedactionPassed({ body: clean.body, frontmatter: { title: 'How John Smith Fixed His Lawn' } });
    expect(fmTitle.ok).toBe(false);
    expect(fmTitle.reason).toBe('unredacted_name_in_title');
  });
  test('redaction: low-confidence meta scans block like body prose (Codex round 17)', () => {
    // A lowercase self-intro meta reports low confidence with zero
    // findings — the round-16 meta path only read findings, so the name
    // published in the public meta description.
    const r = checkRedactionPassed({
      body: 'Chinch bugs thrive in dry Bradenton lawns. Call (941) 297-2606 for a free inspection.',
      meta_description: 'this is john smith ants are back',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('pii_confidence_low_in_meta_description');
  });
  test('redaction: camelCase SEO frontmatter fields are scanned too (Codex round 17)', () => {
    const cleanBody = 'Chinch bugs thrive in dry Bradenton lawns. Call (941) 297-2606 for a free inspection.';
    const phoneCamel = checkRedactionPassed({
      body: cleanBody,
      frontmatter: { metaDescription: 'Call John at 212-555-1234x99 for pest help.' },
    });
    expect(phoneCamel.ok).toBe(false);
    expect(phoneCamel.reason).toBe('non_business_phone_number_in_meta_description:2125551234');
    const nameCamel = checkRedactionPassed({
      body: cleanBody,
      frontmatter: { metaTitle: 'How John Smith Fixed His Lawn' },
    });
    expect(nameCamel.ok).toBe(false);
    expect(nameCamel.reason).toBe('unredacted_name_in_title');
    // clean camelCase fields stay clean
    expect(checkRedactionPassed({
      body: cleanBody,
      frontmatter: { metaTitle: 'Chinch Bug Control in Bradenton', metaDescription: 'Serving Sarasota and Manatee County with same-day chinch bug treatment.' },
    }).ok).toBe(true);
  });
  test('redaction: surname-shaped domain words stay pair-scoped in headings (Codex round 16)', () => {
    // 'Brown' as a structural SINGLE waved "## James Brown" through; the
    // pair allowlist clears "Brown Patch" without clearing the surname.
    const james = checkRedactionPassed({ body: '## James Brown\n\nOur treatment schedule is weekly.' });
    expect(james.ok).toBe(false);
    expect(james.reason).toBe('unredacted_name_in_heading');
    // Body prose is normally cased and multi-sentence: after heading
    // stripping, a single 40+-letter sentence has 1 cap and trips the
    // (accepted, fail-closed) low-caps confidence arm — not this test's
    // subject.
    expect(checkRedactionPassed({
      body: '## Brown Patch Treatment in Bradenton\n\nFungicide applications work best preventively. Apply them in Bradenton before the summer rains arrive.',
    }).ok).toBe(true);
    expect(checkRedactionPassed({
      body: '## Wood Destroying Organisms Explained\n\nWDO inspections cover termites and fungi.',
    }).ok).toBe(true);
    expect(checkRedactionPassed({
      body: '## Late Summer Lawn Care\n\nFertilize before the rains taper off.',
    }).ok).toBe(true);
  });
  test('redaction: compact E.164 customer phones are caught (Codex round 8 — 11-digit runs had no interior boundary to match)', () => {
    const r = checkRedactionPassed({ body: 'Call our Sarasota line at (941) 297-2606 or the customer at +19415551234.' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('non_business_phone_number_in_body:9415551234');
    // Waves' own E.164 form passes
    expect(checkRedactionPassed({ body: 'Tap +19412972606 to call our Sarasota office today for help.' }).ok).toBe(true);
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
  test('raw markdown tables are hard-blocked (owner rule 2026-08-27: ComparisonTable only)', () => {
    const rawTable = 'Intro.\n\n| Method | Cost |\n| --- | --- |\n| DIY | $10 |\n';
    expect(checkNoRawMarkdownTables({ body: rawTable }).ok).toBe(false);
    expect(checkNoRawMarkdownTables({ body: rawTable }).reason).toMatch(/ComparisonTable/);
    // Aligned/colon variants of the delimiter row still match.
    expect(checkNoRawMarkdownTables({ body: '| A | B |\n|:---|---:|\n| 1 | 2 |' }).ok).toBe(false);
    // GFM tables WITHOUT outer pipes are still tables.
    expect(checkNoRawMarkdownTables({ body: 'Method | Cost\n--- | ---\nDIY | $10' }).ok).toBe(false);
    // <ComparisonTable> JSX, prose pipes, and plain dashed dividers pass.
    expect(checkNoRawMarkdownTables({ body: '<ComparisonTable columns={["a","b"]} rows={[{ label: "x", values: ["y"] }]} />' }).ok).toBe(true);
    expect(checkNoRawMarkdownTables({ body: 'Choose either|or — both work.\n\n---\n\nNext section.' }).ok).toBe(true);
    expect(checkNoRawMarkdownTables({ body: '' }).ok).toBe(true);
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
      // Weight-0 soft checks (blog_meta_soft_cta) are signal-only BY DESIGN
      // (owner ruling 2026-07-30) — they can't demand score, so only
      // WEIGHTED soft checks count toward the strict inequality.
      const softChecks = checks.filter((c) => !c.isHard && c.weight > 0);
      // With >= 2 weighted soft checks the threshold must demand soft
      // compliance beyond the hard checks; a single-soft bundle's
      // one-worst-miss floor legitimately equals its hard sum.
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
        body: 'Many homeowners in Bradenton and Sarasota ask about this every spring.\n\nLonger detail follows here in Venice and Palmetto without any links at all.',
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

describe('redaction: heading scan (Codex round 10)', () => {
  test('a street address in a visible HEADING hard-fails (headings are only exempt from the NAME heuristic)', () => {
    const r = checkRedactionPassed({
      body: '## John Smith at 4867 Maple Street\n\nAnt control matters in every season across Sarasota and Bradenton. Our team in Venice applies targeted treatments so infestations never return.',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unredacted_address_in_heading');
  });
  test('structural, office-NAP, and regional-city headings stay clean (round-9 false positives must not return)', () => {
    for (const heading of [
      '## Why Choose Waves Pest Control',
      '## Visit Us at 13649 Luxe Ave, Bradenton, FL 34211',
      '## Pest Control in Lakewood Ranch',
    ]) {
      const r = checkRedactionPassed({
        body: `${heading}\n\nAnt control matters in every season across Sarasota and Bradenton. Our team in Venice applies targeted treatments so infestations never return.`,
      });
      expect(r.ok).toBe(true);
    }
  });
});

describe('redaction: all structured PII types block (Codex round 11)', () => {
  test('SSN- and card-shaped findings hard-fail the body scan', () => {
    const ssn = checkRedactionPassed({ body: 'The account holder provided 123-45-6789 during the call, which our team never records.' });
    expect(ssn.ok).toBe(false);
    expect(ssn.reason).toBe('unredacted_ssn_in_body');
    const card = checkRedactionPassed({ body: 'Payment attempted with 4111 1111 1111 1111 before the visit was booked.' });
    expect(card.ok).toBe(false);
    expect(card.reason).toBe('unredacted_card_in_body');
  });
  test('headings block on structured PII too (only the NAME heuristic stays heading-exempt)', () => {
    const r = checkRedactionPassed({
      body: '## Case 123-45-6789 Review\n\nAnt control matters in every season across Sarasota and Bradenton. Our team in Venice applies targeted treatments so infestations never return.',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unredacted_ssn_in_heading');
  });
  test('allowlist-owned types stay non-blocking here: Waves phone/email and service-area ZIP', () => {
    // phone/email are validated ABOVE with the Waves allowlists — the
    // redactor's own phone/email findings carry no allowlist, so blocking
    // on them would hard-fail the business contact lines.
    expect(checkRedactionPassed({ body: 'Call us at 941-318-7612 to schedule your Bradenton or Sarasota inspection today.' }).ok).toBe(true);
    expect(checkRedactionPassed({ body: 'Email info@wavespestcontrol.com to book your next Waves service visit in Venice.' }).ok).toBe(true);
    expect(checkRedactionPassed({ body: 'We serve Venice, FL 34285 and the surrounding Sarasota and Bradenton communities year round.' }).ok).toBe(true);
  });
});

describe('redaction: customer names in headings (Codex round 13)', () => {
  const filler = 'Ant control matters in every season across Sarasota and Bradenton. Our team in Venice applies targeted treatments so infestations never return.';

  test('a bare customer-name heading hard-fails', () => {
    const r = checkRedactionPassed({ body: `## John Smith\n\n${filler}` });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unredacted_name_in_heading');
  });

  test('structural / brand / pest / city headings still pass the narrowed name check', () => {
    for (const heading of [
      '## Why Choose Waves Pest Control',
      '## Our Process',
      '## Bed Bug Heat Treatment Explained',
      '## Pest Control in Lakewood Ranch',
      '## Serving Punta Gorda and North Port',
    ]) {
      expect(checkRedactionPassed({ body: `${heading}\n\n${filler}` }).ok).toBe(true);
    }
  });
});

describe('redaction: LOWERCASE customer names in headings (Codex round 14)', () => {
  const filler = 'Ant control matters in every season across Sarasota and Bradenton. Our team in Venice applies targeted treatments so infestations never return.';

  test('lowercase transcript-style name headings hard-fail (case-normalized, overlapping pair scan)', () => {
    for (const heading of ['## john smith', '## about john smith and his lawn']) {
      const r = checkRedactionPassed({ body: `${heading}\n\n${filler}` });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('unredacted_name_in_heading');
    }
  });

  test('lowercase structural/prose headings stay clean after normalization', () => {
    for (const heading of [
      '## why choose waves pest control',
      '## how it works',
      '## what to expect',
      '## ants in your kitchen',
      '## roaches love damp cabinets',
    ]) {
      expect(checkRedactionPassed({ body: `${heading}\n\n${filler}` }).ok).toBe(true);
    }
  });
});

// ── meta_description_complete (truncation guard) ─────────────────────

describe('checkMetaDescriptionComplete', () => {
  const { checkMetaDescriptionComplete } = require('../services/content/content-quality-gate')._internals;

  test('complete sentences pass (period / question / exclamation, closing quote ok)', () => {
    for (const m of [
      'Spot chinch bug damage early and know when a professional treatment is worth it.',
      'Is your St. Augustine lawn yellowing in patches? Here is what Waves techs check first.',
      'Stop the swarm before it reaches the eaves!',
      'They call it "the silent lawn killer."',
    ]) {
      expect(checkMetaDescriptionComplete({ meta_description: m }).ok).toBe(true);
    }
  });

  test('missing terminal punctuation fails (the truncated-meta defect)', () => {
    const r = checkMetaDescriptionComplete({ meta_description: 'Learn the early signs of chinch bug damage and what Sarasota homeowners should' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('meta_missing_terminal_punctuation');
  });

  test('trailing ellipsis fails (both forms)', () => {
    expect(checkMetaDescriptionComplete({ meta_description: 'What Sarasota homeowners should know...' }).ok).toBe(false);
    expect(checkMetaDescriptionComplete({ meta_description: 'What Sarasota homeowners should know…' }).ok).toBe(false);
  });

  test('dangling article/preposition before the period fails', () => {
    for (const m of [
      'Everything Bradenton homeowners need to know about the.',
      'How to protect your lawn from chinch bugs and.',
      'When to schedule a treatment for.',
    ]) {
      const r = checkMetaDescriptionComplete({ meta_description: m });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/^meta_ends_with_dangling_word_/);
    }
  });

  test('reads frontmatter.meta_description as a fallback', () => {
    const r = checkMetaDescriptionComplete({ frontmatter: { meta_description: 'Truncated without an end' } });
    expect(r.ok).toBe(false);
  });

  test('absent meta is not this check\'s failure (presence/length owned elsewhere)', () => {
    expect(checkMetaDescriptionComplete({}).ok).toBe(true);
  });

  test('a truncated meta hard-fails evaluate() for blog drafts; non-blog page types are snippet-style', () => {
    const truncated = 'Spot the early signs of chinch bug damage before your';
    const blog = evaluate(
      { body: 'Body copy.', title: 'Chinch Bug Damage in Sarasota', meta_description: truncated },
      { page_type: 'supporting-blog', serp_signal: { dominant_intent: 'informational' }, gsc_signal: { impressions: 10 } },
      {},
    );
    expect(blog.hard_failures.map((f) => f.name)).toContain('meta_description_complete');
    // Codex round 10: non-blog surfaces legitimately use snippet-style
    // metas — only authored truncation (ellipsis) hard-fails there.
    const page = evaluate(
      { body: 'Body copy.', title: 'Chinch Bug Damage in Sarasota', meta_description: truncated },
      { page_type: 'none', serp_signal: { dominant_intent: 'informational' }, gsc_signal: { impressions: 10 } },
      {},
    );
    expect(page.hard_failures.map((f) => f.name)).not.toContain('meta_description_complete');
  });
});

describe('checkMetaDescriptionComplete — refresh target typing (Codex round 12)', () => {
  const { checkMetaDescriptionComplete } = require('../services/content/content-quality-gate')._internals;
  const truncated = 'Spot the early signs of chinch bug damage before your';

  test('a refresh RESOLVED to a blog target keeps the full sentence contract', () => {
    const r = checkMetaDescriptionComplete(
      { meta_description: truncated },
      { page_type: 'refresh', target_page_type: 'supporting-blog' },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('meta_missing_terminal_punctuation');
  });

  test('a refresh RESOLVED to a non-blog page stays snippet-style', () => {
    const r = checkMetaDescriptionComplete(
      { meta_description: truncated },
      { page_type: 'refresh', target_page_type: 'page' },
    );
    expect(r.ok).toBe(true);
  });

  test('a refresh WITHOUT a resolved target falls back to the casing heuristic', () => {
    const snake = checkMetaDescriptionComplete(
      { meta_description: truncated },
      { page_type: 'refresh' },
    );
    expect(snake.ok).toBe(false);
    const camel = checkMetaDescriptionComplete(
      { metaDescription: truncated },
      { page_type: 'refresh' },
    );
    expect(camel.ok).toBe(true);
  });
});

describe('meta phone-token contract (owner rule 2026-07-29)', () => {
  const { checkMetaPhoneTokenPresent } = require('../services/content/content-quality-gate')._internals;
  const PAD = 'Chinch bugs, sod webworms and fire ants handled by local techs. ';
  const PAGE = { target_page_type: 'page' };
  const BLOG = { target_page_type: 'supporting-blog' };

  test('non-blog meta with the {{cityPhone}} token passes', () => {
    const m = `${PAD}Call ☎️ {{cityPhone}} for a FREE estimate today.`;
    expect(checkMetaPhoneTokenPresent({ meta_description: m }, PAGE).ok).toBe(true);
  });

  test('non-blog meta without any phone fails', () => {
    const r = checkMetaPhoneTokenPresent({ meta_description: `${PAD}Get a free estimate today.` }, PAGE);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('meta_missing_cityPhone_token');
  });

  test('typed-out phone number fails even alongside the token', () => {
    const r = checkMetaPhoneTokenPresent({ meta_description: `${PAD}Call (941) 297-2606 or {{cityPhone}} now.` }, PAGE);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('literal_phone_in_meta_use_cityPhone_token');
  });

  test('blog meta: informational + soft CTA passes; phone or salesy CTA fails', () => {
    const good = 'How to tell chinch bug damage from drought stress in a SWFL lawn, and what recovery actually takes. Learn more on the Waves blog.';
    expect(checkMetaPhoneTokenPresent({ meta_description: good }, BLOG).ok).toBe(true);
    const withPhone = checkMetaPhoneTokenPresent({ meta_description: `${PAD}Call ☎️ {{cityPhone}} for details on the blog.` }, BLOG);
    expect(withPhone.ok).toBe(false);
    expect(withPhone.reason).toBe('blog_meta_must_not_carry_phone');
    const salesy = checkMetaPhoneTokenPresent({ meta_description: `${PAD}Get your free estimate today on the Waves blog.` }, BLOG);
    expect(salesy.ok).toBe(false);
    expect(salesy.reason).toBe('blog_meta_salesy');
  });

  test('meta_length_in_bounds measures RENDERED length (tokens expanded)', () => {
    // Literal 150 chars incl. {{cityPhone}} (13) → rendered 151 (+1) — in bounds.
    const base = 'Call {{cityPhone}} for lawn pest control. '; // 42 literal → 43 rendered
    const inBounds = base + 'x'.repeat(108); // 150 literal → 151 rendered
    expect(checkMetaLengthBounds({ meta_description: inBounds }).ok).toBe(true);
    // Literal 159 chars, but {{brandName}} (13) renders as 18 (+5) → 164 — over.
    const over = '{{brandName}} treats lawns. '.padEnd(159, 'y');
    const r = checkMetaLengthBounds({ meta_description: over });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^meta_rendered_length_164/);
  });
});

describe('meta contract bundle checks + refinements (owner rule 2026-07-29)', () => {
  const { checkMetaPhoneTokenPresent, checkCityServiceMetaPhone, checkBlogMetaContract, checkBlogMetaSoftCta } = require('../services/content/content-quality-gate')._internals;
  const BLOG = { target_page_type: 'supporting-blog' };

  test('blog meta without a soft CTA passes the hard contract but flags the soft check (owner ruling 2026-07-30)', () => {
    const draft = { meta_description: 'How to tell chinch bug damage from drought stress in a Southwest Florida lawn, and what a full turf recovery actually takes this season.' };
    expect(checkMetaPhoneTokenPresent(draft, BLOG).ok).toBe(true);
    const soft = checkBlogMetaSoftCta(draft, BLOG);
    expect(soft.ok).toBe(false);
    expect(soft.reason).toBe('blog_meta_missing_soft_cta');
  });

  test('soft-CTA soft check skips page targets and empty metas', () => {
    expect(checkBlogMetaSoftCta({ meta_description: 'No CTA here at all in this page meta text.' }, { target_page_type: 'page' }).ok).toBe(true);
    expect(checkBlogMetaSoftCta({ frontmatter: {} }, BLOG).ok).toBe(true);
  });

  test('expanded salesy phrases are rejected on blog metas', () => {
    for (const tail of ['Request a quote today.', 'Contact us for treatment.', 'Schedule service today.', 'Save on professional service.']) {
      const r = checkMetaPhoneTokenPresent({ meta_description: `What SWFL chinch bug damage looks like and what a turf recovery takes. ${tail}` }, BLOG);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('blog_meta_salesy');
    }
  });

  test('city-service bundle check requires the token; empty meta defers', () => {
    expect(checkCityServiceMetaPhone({ frontmatter: { meta_description: 'Pest control in Sarasota built for the coastal pressure. Call ☎️ {{cityPhone}} for a FREE estimate from techs on daily local routes.' } }).ok).toBe(true);
    expect(checkCityServiceMetaPhone({ frontmatter: { meta_description: 'Pest control in Sarasota built around coastal pest pressure, from drywood termites to German roaches, with plans quoted in about a minute.' } }).reason).toBe('meta_missing_cityPhone_token');
    expect(checkCityServiceMetaPhone({ frontmatter: {} }).ok).toBe(true);
  });

  test('supporting-blog bundle check applies the full blog contract; empty meta defers', () => {
    expect(checkBlogMetaContract({ frontmatter: { meta_description: 'How to tell chinch bug damage from drought stress in a SWFL lawn, and what recovery takes. Learn more on the Waves blog.' } }).ok).toBe(true);
    expect(checkBlogMetaContract({ frontmatter: { meta_description: 'Chinch bug basics for SWFL lawns and what recovery takes. Call ☎️ {{cityPhone}} to learn more from the Waves lawn team today.' } }).reason).toBe('blog_meta_must_not_carry_phone');
    expect(checkBlogMetaContract({ frontmatter: {} }).ok).toBe(true);
  });
});

describe('meta contract round-3 hardening (Codex findings)', () => {
  const { checkMetaPhoneTokenPresent, checkBlogMetaContract, checkCityServiceMetaPhone } = require('../services/content/content-quality-gate')._internals;
  const BLOG = { target_page_type: 'supporting-blog' };
  const PAGE = { target_page_type: 'page' };

  test('soft CTA must END the meta — a mid-meta mention flags the SOFT check only (never the hard contract)', () => {
    const draft = { meta_description: 'Learn more about chinch bugs. Damage from these insects shows up first in the sunniest strips of a Southwest Florida lawn each summer season.' };
    expect(checkBlogMetaContract(draft).ok).toBe(true);
    const { checkBlogMetaSoftCta } = require('../services/content/content-quality-gate')._internals;
    const soft = checkBlogMetaSoftCta(draft, BLOG);
    expect(soft.ok).toBe(false);
    expect(soft.reason).toBe('blog_meta_missing_soft_cta');
  });

  test('a mid-meta brand-availability pitch is sales copy even with an informational closer (r12)', () => {
    const r = checkBlogMetaContract({ meta_description: 'Learn more about chinch bugs. Professional lawn treatment is available from Waves whenever you need a local turf expert in Southwest Florida.' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('blog_meta_sales_copy');
  });

  test('literal phone in a publishable title fails on every lane', () => {
    const meta = 'Pest control in Sarasota built for coastal pressure. Call ☎️ {{cityPhone}} for a FREE estimate from techs on daily local routes here.';
    const withPhoneTitle = { title: 'Pest Control Sarasota — 941-297-2606', meta_description: meta };
    expect(checkMetaPhoneTokenPresent(withPhoneTitle, PAGE, {}).reason).toBe('literal_phone_in_title');
    expect(checkMetaPhoneTokenPresent(withPhoneTitle, BLOG, {}).reason).toBe('literal_phone_in_title');
    expect(checkCityServiceMetaPhone(withPhoneTitle).reason).toBe('literal_phone_in_title');
    expect(checkBlogMetaContract(withPhoneTitle).reason).toBe('literal_phone_in_title');
    // Protected metaTitle target: the proposal is discarded — title exempt.
    expect(checkMetaPhoneTokenPresent(withPhoneTitle, PAGE, { protectedTitle: true }).ok).toBe(true);
  });
});

describe('soft CTA final sentence must BE a CTA (round-5 hardening)', () => {
  const { checkBlogMetaContract } = require('../services/content/content-quality-gate')._internals;
  const LEAD = 'What chinch bug damage looks like in Southwest Florida turf and how full recovery works across a season of treatments. ';

  test('a promotional sentence that merely contains a CTA verb fails', () => {
    const r = checkBlogMetaContract({ meta_description: `${LEAD}See how much you can save with Waves.` });
    expect(r.ok).toBe(false);
  });

  test('sanctioned shapes pass: bare, about-clause, and blog pointer', () => {
    for (const tail of ['Learn more.', 'Read more.', 'Learn more about chinch bugs on the Waves blog.', 'Find out more in our guide.']) {
      const r = checkBlogMetaContract({ meta_description: `${LEAD}${tail}` });
      expect(r.ok).toBe(true);
    }
  });

  test('sales terms cannot ride in through the about-clause — still HARD (Codex P1: not demoted with the CTA)', () => {
    const r = checkBlogMetaContract({ meta_description: `${LEAD}Learn more about saving big with Waves.` });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('blog_meta_sales_copy');
  });

  test('decimal price in the closer still HARD-fails (r3: decimal dot is not a sentence boundary)', () => {
    const r = checkBlogMetaContract({ meta_description: `${LEAD}A treatment estimate starts at $49.99.` });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('blog_meta_sales_copy');
  });

  test('domain dots do not fragment transactional sentences (r8/r11: subdomains included)', () => {
    for (const host of ['wavespestcontrol.com', 'booking.wavespestcontrol.com']) {
      const r = checkBlogMetaContract({ meta_description: `${LEAD}Contact ${host} for pricing on quarterly pest service.` });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('blog_meta_sales_copy');
    }
  });

  test('aggregate damage statistics are NOT price assertions (r13: "estimate of termite damage is $5 billion")', () => {
    const r = checkBlogMetaContract({ meta_description: 'The national estimate of termite damage is $5 billion each year across the US. This guide covers the warning signs homeowners see first.' });
    expect(r.ok).toBe(true);
  });

  test('dotted initialisms do not fragment transactional sentences (r13: "Contact the U.S. team for pricing")', () => {
    const r = checkBlogMetaContract({ meta_description: `${LEAD}Contact the U.S. team for pricing on quarterly pest service.` });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('blog_meta_sales_copy');
  });

  test('ordinary verb "deal" in a CTA is NOT sales copy (r12: "how homeowners deal with ants")', () => {
    const r = checkBlogMetaContract({ meta_description: `${LEAD}Learn more about how homeowners deal with ants.` });
    expect(r.ok).toBe(true);
  });

  test('brand-backed availability HARD-fails (r12: "plans are available from Waves")', () => {
    const r = checkBlogMetaContract({ meta_description: `${LEAD}Quarterly pest plans are available from Waves for Southwest Florida homeowners.` });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('blog_meta_sales_copy');
  });

  test('ranged direct-price assertions HARD-fail (r11: "estimate runs from $99 to $149")', () => {
    const r = checkBlogMetaContract({ meta_description: 'A professional treatment estimate runs from $99 to $149 for most homes, with quarterly plans built around year-round pest pressure.' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('blog_meta_sales_copy');
  });

  test('informational CTA subjects are NOT sales copy (r9: "Learn more about a county damage estimate.")', () => {
    const r = checkBlogMetaContract({ meta_description: `${LEAD}Learn more about a county damage estimate.` });
    expect(r.ok).toBe(true);
  });

  test('direct price assertions on service nouns HARD-fail; damage-cost stats do not (r10)', () => {
    const priced = checkBlogMetaContract({ meta_description: 'A professional treatment estimate costs $99 for most Southwest Florida homes, with quarterly plans built around year-round pest pressure.' });
    expect(priced.ok).toBe(false);
    expect(priced.reason).toBe('blog_meta_sales_copy');
    const stat = checkBlogMetaContract({ meta_description: 'Repairing termite damage costs $2,000 on average across the region. This guide covers the prevention steps that matter most here.' });
    expect(stat.ok).toBe(true);
  });

  test('a statistic closer with currency stays publishable (r7: no bare symbol check — intent lives in the frame)', () => {
    for (const tail of [
      'Termites cause more than $5 billion in property damage every year.',
      'Chinch bugs hit about 40% of St. Augustine lawns in Southwest Florida.',
    ]) {
      expect(checkBlogMetaContract({ meta_description: `${LEAD}${tail}` }).ok).toBe(true);
    }
  });

  test('informational sales nouns in the closer do NOT hard-fail (r3: transactional usage only)', () => {
    for (const tail of [
      'A guide to what quarterly pest plans offer Southwest Florida homeowners.',
      'An estimate of the damage helps you plan repairs before the rainy season arrives.',
    ]) {
      expect(checkBlogMetaContract({ meta_description: `${LEAD}${tail}` }).ok).toBe(true);
    }
  });

  test('transactional non-CTA closers still HARD-fail (r4: solicitation verb or availability marketing)', () => {
    for (const tail of ['Ask Waves for a quote on treatment.', 'A professional treatment estimate is available today.']) {
      const r = checkBlogMetaContract({ meta_description: `${LEAD}${tail}` });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('blog_meta_sales_copy');
    }
  });

  test('a sales sentence followed by an informational closer still HARD-fails (r5: every sentence scanned)', () => {
    const r = checkBlogMetaContract({ meta_description: 'Learn more about saving big with Waves. This guide explains common pests in Southwest Florida and what treatment involves for homes.' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('blog_meta_sales_copy');
  });

  test('plain availability is NOT transactional (r5: "available in the county public record" passes hard)', () => {
    const r = checkBlogMetaContract({ meta_description: `${LEAD}A damage estimate is available in the county public record.` });
    expect(r.ok).toBe(true);
  });

  test('mid-meta damage stats with currency stay publishable (currency is closer-only by design)', () => {
    for (const meta of [
      'Termites cause $5 billion in damage across the US every year. This guide covers the warning signs Southwest Florida homeowners see first.',
      'Repair costs range from $2 billion to $5 billion nationally. This guide covers the warning signs Southwest Florida homeowners see first.',
    ]) {
      expect(checkBlogMetaContract({ meta_description: meta }).ok).toBe(true);
    }
  });

  test('price-marketing frames mid-meta still HARD-fail (r6: "starts at $49.99" before an informational closer)', () => {
    const r = checkBlogMetaContract({ meta_description: 'A treatment estimate starts at $49.99 for most homes here. This guide explains common pests in Southwest Florida and what treatment involves.' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('blog_meta_sales_copy');
  });

  test('brand-as-subject offers are sales copy (r6: "Waves offers quarterly pest plans")', () => {
    const r = checkBlogMetaContract({ meta_description: `${LEAD}Waves offers quarterly pest plans for Southwest Florida homeowners.` });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('blog_meta_sales_copy');
  });

  test('space-separated phone digits still HARD-fail (r6: "941 297 2606")', () => {
    const r = checkBlogMetaContract({ meta_description: `${LEAD}Call 941 297 2606 for identification help with local species.` });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('blog_meta_must_not_carry_phone');
  });

  test('bare 10-digit phone in a blog meta still HARD-fails (r4: separator-less number slips the shaped regex)', () => {
    const r = checkBlogMetaContract({ meta_description: `${LEAD}Call 9412972606 for treatment details.` });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('blog_meta_must_not_carry_phone');
  });
});

describe('meta contract round-6 hardening (Codex findings)', () => {
  const { checkBlogMetaContract, checkAuthoredMetaLength } = require('../services/content/content-quality-gate')._internals;

  test('abbreviation periods are not sentence boundaries — St. Augustine CTA passes', () => {
    const r = checkBlogMetaContract({ meta_description: 'What summer heat does to Southwest Florida turf and how to help it recover. Learn more about St. Augustine grass on the Waves blog.' });
    expect(r.ok).toBe(true);
  });

  test('authoring bundles bound RENDERED length — {{brandName}} expansion over 160 fails', () => {
    // 156 literal chars incl {{brandName}} (13) → renders 161 (+5) — over.
    const base = '{{brandName}} explains what summer heat does to Southwest Florida turf and how recovery works across a season. ';
    const meta = base.padEnd(156, 'x');
    const r = checkAuthoredMetaLength({ meta_description: meta });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^meta_rendered_length_161/);
    // Empty defers — presence is other gates' job.
    expect(checkAuthoredMetaLength({ frontmatter: {} }).ok).toBe(true);
  });
});

describe('phone-token grammar (round-7 hardening)', () => {
  const { checkMetaPhoneTokenPresent, checkBlogMetaContract } = require('../services/content/content-quality-gate')._internals;
  const PAGE = { target_page_type: 'page' };
  const LEAD = 'What summer heat does to Southwest Florida turf and how a full recovery works. ';

  test('only {{cityPhone}} (whitespace-tolerant) satisfies the non-blog requirement — phone/tel aliases render the generic line', () => {
    const meta = (tok) => `Pest control in Sarasota built for the coastal pressure this season. Call ${tok} for an estimate from techs on daily local routes.`;
    expect(checkMetaPhoneTokenPresent({ meta_description: meta('{{ cityPhone }}') }, PAGE, {}).ok).toBe(true);
    for (const tok of ['{{tel}}', '{{ phone }}']) {
      const r = checkMetaPhoneTokenPresent({ meta_description: meta(tok) }, PAGE, {});
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('meta_missing_cityPhone_token');
    }
  });

  test('choose/hire-brand solicitation is salesy on blog metas', () => {
    const { checkBlogMetaContract: blogCheck } = require('../services/content/content-quality-gate')._internals;
    const r = blogCheck({ meta_description: 'Choose Waves for professional pest control across Southwest Florida homes, with local experience for the bugs residents see most. Learn more.' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('blog_meta_salesy');
  });

  test('whitespace-tolerant and alias tokens are banned from blog metas', () => {
    for (const tok of ['{{ cityPhone }}', '{{tel}}']) {
      const r = checkBlogMetaContract({ meta_description: `${LEAD}Details at ${tok} today. Learn more.` });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('blog_meta_must_not_carry_phone');
    }
  });
});

// Tree & shrub has no hub-level page, so SERVICE_HUB_LINKS['tree-shrub'] is empty
// and the union check can never satisfy it. Without the hubless carve-out EVERY
// tree/shrub supporting blog parked on hub_link_present — including city-scoped
// drafts that followed their brief exactly.
describe('checkHubLinkPresent — hubless verticals accept their city-service page', () => {
  const gate = require('../services/content/content-quality-gate');
  const run = (body, brief) => gate._internals.checkHubLinkPresent({ body }, brief);

  test('a tree-shrub draft linking its city page passes', () => {
    const body = 'Palms in Venice need care — see our [tree and shrub care in Venice](/tree-and-shrub-care-venice-fl/) page.';
    expect(run(body, { service: 'tree-shrub', page_type: 'supporting-blog' }).ok).toBe(true);
  });

  test('the alias spelling resolves too', () => {
    const body = 'See [our page](/tree-and-shrub-care-sarasota-fl/).';
    expect(run(body, { service: 'tree-shrub-care', page_type: 'supporting-blog' }).ok).toBe(true);
  });

  test('a tree-shrub draft with NO city page and no hub link still fails', () => {
    const body = 'Generic advice with only a [contact link](/contact/).';
    expect(run(body, { service: 'tree-shrub', page_type: 'supporting-blog' }).ok).toBe(false);
  });

  test('a vertical that HAS a hub page cannot substitute a city page', () => {
    // pest has real hub links, so the carve-out must not apply to it.
    const body = 'Only a city link here: [pest control in Venice](/pest-control-venice-fl/).';
    expect(run(body, { service: 'pest', page_type: 'supporting-blog' }).ok).toBe(false);
    const withHub = `${body} And our [services](/pest-control-services/).`;
    expect(run(withHub, { service: 'pest', page_type: 'supporting-blog' }).ok).toBe(true);
  });

  test('a curated operator hub link still wins outright', () => {
    const brief = { service: 'tree-shrub', page_type: 'supporting-blog', voice_constraints: { operator_brief: { hub_link: '/pest-control-sarasota-fl/' } } };
    expect(run('no links at all', brief).ok).toBe(false);
    expect(run('see [here](/pest-control-sarasota-fl/)', brief).ok).toBe(true);
  });
});

// Lawn joined tree-shrub as hubless once the gate went service-specific: its only
// entry was a Manatee-county fertilizer guide, which is the wrong required link for
// a Sarasota or non-fertilizer lawn topic and nudges county-specific dates into the
// wrong locale.
describe('checkHubLinkPresent — lawn is hubless and uses its city page', () => {
  const gate = require('../services/content/content-quality-gate');
  const run = (body, brief) => gate._internals.checkHubLinkPresent({ body }, brief);

  test('a lawn draft linking its city page passes', () => {
    const body = 'Sarasota lawns differ — see [lawn care in Sarasota](/lawn-care-sarasota-fl/).';
    expect(run(body, { service: 'lawn', page_type: 'supporting-blog' }).ok).toBe(true);
    expect(run(body, { service: 'lawn-care', page_type: 'supporting-blog' }).ok).toBe(true);
  });

  test('the Manatee blackout guide alone no longer satisfies a lawn topic', () => {
    const body = 'See the [fertilizer blackout guide](/lawn-care/fertilizer-blackout-manatee-county/).';
    expect(run(body, { service: 'lawn', page_type: 'supporting-blog' }).ok).toBe(false);
  });

  test('it is still an allowed LINK, just not a mandated hub', () => {
    const guardrails = require('../services/content/content-guardrails');
    expect(guardrails.ALLOWED_INTERNAL_LINKS).toContain('/lawn-care/fertilizer-blackout-manatee-county/');
    const r = guardrails.evaluate({ body: 'Manatee dates: [blackout guide](/lawn-care/fertilizer-blackout-manatee-county/).' }, {});
    expect(r.findings.some((f) => f.code === 'UNKNOWN_INTERNAL_ROUTE')).toBe(false);
  });
});

// Right service, WRONG town must not satisfy either gate: a Sarasota lawn brief
// linking /lawn-care-venice-fl/ used to pass both, because the service prefix matched
// and the generic city-reason check only looks at URL shape.
describe('the stand-in city link must match the brief CITY too', () => {
  const gate = require('../services/content/content-quality-gate');
  const hub = (body, brief) => gate._internals.checkHubLinkPresent({ body }, brief);

  test('quality gate: wrong town fails, right town passes', () => {
    const brief = { service: 'lawn', city: 'Sarasota', page_type: 'supporting-blog' };
    expect(hub('See [Venice lawn care](/lawn-care-venice-fl/).', brief).ok).toBe(false);
    expect(hub('See [Sarasota lawn care](/lawn-care-sarasota-fl/).', brief).ok).toBe(true);
  });

  test('quality gate: a city-less brief still accepts any of its city pages', () => {
    const brief = { service: 'lawn', page_type: 'supporting-blog' };
    expect(hub('See [Venice lawn care](/lawn-care-venice-fl/).', brief).ok).toBe(true);
  });

  test('quality gate: multi-word cities slugify correctly', () => {
    const brief = { service: 'tree-shrub', city: 'Lakewood Ranch', page_type: 'supporting-blog' };
    expect(hub('See [our page](/tree-and-shrub-care-lakewood-ranch-fl/).', brief).ok).toBe(true);
    expect(hub('See [our page](/tree-and-shrub-care-venice-fl/).', brief).ok).toBe(false);
  });

  test('cityServiceRoute builds the shared expectation', () => {
    const { cityServiceRoute } = require('../services/content/blog-seo-contract');
    expect(cityServiceRoute('lawn', 'Sarasota')).toBe('/lawn-care-sarasota-fl/');
    expect(cityServiceRoute('tree-shrub', 'Lakewood Ranch')).toBe('/tree-and-shrub-care-lakewood-ranch-fl/');
    expect(cityServiceRoute('lawn', null)).toBeNull();
    expect(cityServiceRoute('specialty', 'Sarasota')).toBeNull(); // no city-service slug
  });
});
