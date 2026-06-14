/**
 * Spoke blog network — Phase 2 spoke-routing wiring.
 *
 * Covers the pieces that let the autonomous content engine emit a UNIQUE,
 * spoke-targeted blog post (renders on ONE spoke, self-canonical, with a
 * branded-local hub link) instead of always the hub:
 *   - spoke-seed-seeder: curated topics → operator-pinned opportunity rows
 *   - astro-publisher: target-aware domain stamping + spoke-origin canonical
 *   - content-guardrails: narrow brand-token exemption for the hub-link anchor
 *   - content-brief-builder: target_sites threading + spoke overlay precedence
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const seeder = require('../services/content/spoke-seed-seeder');

describe('spoke-seed-seeder: manifest + rows', () => {
  test('the shipped manifest loads and validates (5 deduped Sarasota topics)', () => {
    const m = seeder.loadManifest();
    expect(m.briefs.length).toBe(5);
    const ids = m.briefs.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length); // no dup ids
    for (const b of m.briefs) {
      expect(b.slug.startsWith('/')).toBe(true);
      expect(seeder._internals.normalizeTargetSite(b.target_site)).toBe('sarasotaflpestcontrol.com');
      expect(b.hub_link).toMatch(/^https:\/\/www\.wavespestcontrol\.com\//);
    }
  });

  test('loadManifest rejects an unknown / hub target_site', () => {
    const writeManifest = (briefs) => {
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const p = path.join(os.tmpdir(), `spoke-manifest-${briefs[0].id}.json`);
      fs.writeFileSync(p, JSON.stringify({ version: '1.0', set: 'spoke-seed', briefs }));
      return p;
    };
    const base = { id: 'X1', action: 'new_supporting_blog', slug: '/pest-control/x/', city: 'Sarasota' };
    expect(() => seeder.loadManifest(writeManifest([{ ...base, target_site: 'totally-fake.com' }])))
      .toThrow(/not a known role:spoke domain/);
    expect(() => seeder.loadManifest(writeManifest([{ ...base, id: 'X2', target_site: 'wavespestcontrol.com' }])))
      .toThrow(/not a known role:spoke domain/);
    expect(() => seeder.loadManifest(writeManifest([{ ...base, id: 'X3', target_site: 'sarasotaflpestcontrol.com', slug: 'no-leading-slash' }])))
      .toThrow(/slug must be an absolute path/);
  });

  test('rowForBrief builds an operator-pinned, spoke-tagged opportunity row', () => {
    const m = seeder.loadManifest();
    const now = new Date('2026-06-14T12:00:00Z');
    const row = seeder._internals.rowForBrief(m.briefs[0], m, { now });
    expect(row.bucket).toBe('operator_intercept'); // inherits router bypass + serp/gsc exemptions
    expect(row.city).toBeNull(); // facts gate "not applicable" (locality via target_sites + outline)
    expect(row.service).toBe('pest'); // coarse service stays intact for the link/SEO gates
    expect(row.dedupe_key).toBe('spoke:v1:SAR1');
    expect(row.signal_metadata.operator_pinned).toBe(true);
    expect(row.signal_metadata.spoke_seed).toBe(true);
    expect(row.signal_metadata.target_sites).toEqual(['sarasotaflpestcontrol.com']);
    expect(row.signal_metadata.spoke_brief.id).toBe('SAR1');
    // 'immediate' window → claimable now
    expect(row.available_at).toBeNull();
    expect(row.expires_at.getTime()).toBeGreaterThan(now.getTime());
  });

  test('isSpokeSeed / targetSitesFor recognize seeded rows and ignore the hub', () => {
    const m = seeder.loadManifest();
    const row = seeder._internals.rowForBrief(m.briefs[2], m, { now: new Date('2026-06-14T12:00:00Z') });
    const opp = { id: 9, bucket: row.bucket, signal_metadata: row.signal_metadata };
    expect(seeder.isSpokeSeed(opp)).toBe(true);
    expect(seeder.targetSitesFor(opp)).toEqual(['sarasotaflpestcontrol.com']);
    expect(seeder.isSpokeSeed({ signal_metadata: { operator_pinned: true } })).toBe(false); // intercept, not spoke
    expect(seeder.targetSitesFor({ signal_metadata: { spoke_seed: true, target_sites: ['wavespestcontrol.com'] } })).toEqual([]);
  });

  test('buildSpokeOverlay injects local binding rules + branded-local hub link, no competitor framing', () => {
    const m = seeder.loadManifest();
    const row = seeder._internals.rowForBrief(m.briefs[1], m, { now: new Date('2026-06-14T12:00:00Z') });
    const opp = { id: 2, bucket: row.bucket, signal_metadata: row.signal_metadata };
    const ov = seeder.buildSpokeOverlay({
      opportunity: opp,
      pageType: 'supporting-blog',
      requiredSections: ['final CTA to relevant city/service page'],
      schemaTypes: ['Article'],
    });
    expect(ov.operator_brief.slug).toBe('/pest-control/carpenter-ants-sarasota-coastal-live-oaks/');
    expect(ov.operator_brief.target_sites).toEqual(['sarasotaflpestcontrol.com']);
    expect(ov.internal_links[0]).toBe('https://www.wavespestcontrol.com/pest-control-sarasota-fl/');
    const bind = ov.operator_brief.binding_instructions.join('\n');
    expect(bind).toMatch(/LOCAL SPECIFICITY/);
    expect(bind).toMatch(/branded-local anchor like "the Sarasota pest control team at Waves"/);
    expect(bind).toMatch(/never a relative path and never a \{\{siteUrl\}\} token/);
    expect(bind).not.toMatch(/COMPARISON DISCLAIMER|COMPETITOR PRICING/); // spoke ≠ competitor intercept
  });
});

describe('MDX {{token}} crash guard (proof-caught bug)', () => {
  test('spoke binding instructions never tell the writer to emit {{brandName}} (crashes .mdx builds)', () => {
    const m = seeder.loadManifest();
    const row = seeder._internals.rowForBrief(m.briefs[1], m, { now: new Date('2026-06-14T12:00:00Z') });
    const ov = seeder.buildSpokeOverlay({ opportunity: { signal_metadata: row.signal_metadata }, pageType: 'supporting-blog', requiredSections: [], schemaTypes: ['Article'] });
    const bind = ov.operator_brief.binding_instructions.join('\n');
    expect(bind).not.toMatch(/use the \{\{brandName\}\} token/i);
    expect(bind).toMatch(/do NOT emit ANY \{\{\.\.\.\}\} token/);
    expect(bind).toMatch(/first person/i);
  });

  test('publisher mdxBreakingToken flags un-interpolated remark tokens', () => {
    const { _internals } = require('../services/content-astro/astro-publisher');
    expect(_internals.mdxBreakingToken("browse {{brandName}}'s services")).toBe('{{brandName}}');
    expect(_internals.mdxBreakingToken('see {{ siteUrl }}/x')).toBe('{{ siteUrl }}');
    expect(_internals.mdxBreakingToken('clean Sarasota body, no tokens')).toBeNull();
    expect(_internals.mdxBreakingToken('an object literal {{a:1}} is not a token')).toBeNull();
  });
});

describe('astro-publisher: spoke domain + canonical routing', () => {
  const { _internals } = require('../services/content-astro/astro-publisher');

  test('resolveSpokeTarget: exactly one non-hub spoke routes; hub/empty/multi do not', () => {
    expect(_internals.resolveSpokeTarget({ target_sites: ['sarasotaflpestcontrol.com'] })).toBe('sarasotaflpestcontrol.com');
    expect(_internals.resolveSpokeTarget({ target_sites: [] })).toBeNull();
    expect(_internals.resolveSpokeTarget({ target_sites: ['wavespestcontrol.com'] })).toBeNull();
    expect(_internals.resolveSpokeTarget({ target_sites: ['sarasotaflpestcontrol.com', 'veniceflpestcontrol.com'] })).toBeNull();
    // falls back to the persisted operator_brief copy
    expect(_internals.resolveSpokeTarget({ voice_constraints: { operator_brief: { target_sites: ['veniceflpestcontrol.com'] } } })).toBe('veniceflpestcontrol.com');
  });

  test('blogOriginForSpoke: spoke www origin vs hub origin', () => {
    expect(_internals.blogOriginForSpoke('sarasotaflpestcontrol.com')).toBe('https://www.sarasotaflpestcontrol.com');
    expect(_internals.blogOriginForSpoke(null)).toBe('https://www.wavespestcontrol.com');
  });

  test('stampBlogDomains: spoke target stamps domains + tracking.domains; null = hub-only', () => {
    const spoke = _internals.stampBlogDomains({}, 'sarasotaflpestcontrol.com');
    expect(spoke.domains).toEqual(['sarasotaflpestcontrol.com']);
    expect(spoke.tracking.domains).toEqual(['sarasotaflpestcontrol.com']);
    const hub = _internals.stampBlogDomains({ tracking: { foo: 1 } }, null);
    expect(hub.domains).toEqual(['wavespestcontrol.com']);
    expect(hub.tracking).toEqual({ foo: 1, domains: ['wavespestcontrol.com'] }); // preserves existing tracking keys
  });

  test('syncDraftPublishTarget writes the resolved canonical + domains back onto the original draft (PR-poller reconciliation)', () => {
    // The poller reads draft_payload.frontmatter.canonical; the publisher resolves
    // the spoke canonical on a clone, so the original draft must be synced.
    const draft = { frontmatter: { canonical: 'https://www.wavespestcontrol.com/pest-control/x-sarasota/', domains: ['wavespestcontrol.com'] }, body: '...' };
    const finalFm = { canonical: 'https://www.sarasotaflpestcontrol.com/pest-control/x-sarasota/', domains: ['sarasotaflpestcontrol.com'] };
    _internals.syncDraftPublishTarget(draft, finalFm);
    expect(draft.frontmatter.canonical).toBe('https://www.sarasotaflpestcontrol.com/pest-control/x-sarasota/');
    expect(draft.frontmatter.domains).toEqual(['sarasotaflpestcontrol.com']);
    // tolerant of a draft without frontmatter (no throw)
    expect(() => _internals.syncDraftPublishTarget({}, finalFm)).not.toThrow();
  });

  test('canonical helpers honor the spoke origin (self-canonical spoke URL)', () => {
    const slug = 'pest-control/german-roaches-sarasota-condos';
    expect(_internals.canonicalUrlForSlug(slug)).toBe('https://www.wavespestcontrol.com/pest-control/german-roaches-sarasota-condos/');
    expect(_internals.canonicalUrlForSlug(slug, 'https://www.sarasotaflpestcontrol.com'))
      .toBe('https://www.sarasotaflpestcontrol.com/pest-control/german-roaches-sarasota-condos/');
    const fm = { slug: `/${slug}/`, canonical: `https://www.sarasotaflpestcontrol.com/${slug}/` };
    expect(_internals.assertCanonicalMatchesSlug(fm, slug, 'https://www.sarasotaflpestcontrol.com'))
      .toBe(`https://www.sarasotaflpestcontrol.com/${slug}/`);
  });
});

describe('content-guardrails: narrow brand-token exemption on spoke pages', () => {
  const guardrails = require('../services/content/content-guardrails');
  const spoke = ['sarasotaflpestcontrol.com'];
  const findLeak = (r) => r.findings.some((f) => f.code === 'BRAND_TOKEN_LEAK');

  test('literal hub brand INSIDE a hub-link anchor is allowed', () => {
    const body = 'When you are ready, the licensed team at [Waves Pest Control in Sarasota](https://www.wavespestcontrol.com/pest-control-sarasota-fl/) can help in your Sarasota condo.';
    expect(findLeak(guardrails.evaluate({ frontmatter: { domains: spoke }, body }, { domains: spoke }))).toBe(false);
  });

  test('bare literal hub brand (not in a hub link) still leaks P0', () => {
    const body = 'Waves Pest Control is the best choice. See [our page](https://www.wavespestcontrol.com/pest-control-sarasota-fl/).';
    const r = guardrails.evaluate({ frontmatter: { domains: spoke }, body }, { domains: spoke });
    expect(findLeak(r)).toBe(true);
    expect(r.findings.find((f) => f.code === 'BRAND_TOKEN_LEAK').severity).toBe('P0');
  });

  test('brand inside a NON-hub link anchor still leaks (exemption is hub-only)', () => {
    const body = 'See [Waves Pest Control](https://example.com/x) here in Sarasota.';
    expect(findLeak(guardrails.evaluate({ frontmatter: { domains: spoke }, body }, { domains: spoke }))).toBe(true);
  });

  test('literal brand on a hub-only page is fine (unchanged behavior)', () => {
    const body = 'Waves Pest Control treats homes across Sarasota and Bradenton.';
    expect(findLeak(guardrails.evaluate({ frontmatter: { domains: ['wavespestcontrol.com'] }, body }, { domains: ['wavespestcontrol.com'] }))).toBe(false);
  });
});

describe('Codex PR #1772 review fixes', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const NOW = new Date('2026-06-14T12:00:00Z');
  const tmpManifest = (briefs, extra = {}) => {
    const p = path.join(os.tmpdir(), `spoke-fix-${briefs[0].id}-${briefs.length}.json`);
    fs.writeFileSync(p, JSON.stringify({ version: '1.0', set: 'spoke-seed', cta_codes: {}, briefs, ...extra }));
    return p;
  };

  test('P1: checkHubLinkPresent REQUIRES the curated hub link when present (city page, not in SERVICE_HUB_LINKS)', () => {
    const { _internals: qg } = require('../services/content/content-quality-gate');
    const brief = { voice_constraints: { operator_brief: { hub_link: 'https://www.wavespestcontrol.com/pest-control-sarasota-fl/' } } };
    const body = 'the team at [Waves Pest Control in Sarasota](https://www.wavespestcontrol.com/pest-control-sarasota-fl/) can help';
    expect(qg.checkHubLinkPresent({ body }, brief).ok).toBe(true);
    expect(qg.checkHubLinkPresent({ body: 'no hub link here at all' }, brief).ok).toBe(false);
    // a GENERIC service link must NOT satisfy a curated-backlink brief (R4 fix):
    // the curated spoke→hub link is the contract and can't be skipped.
    expect(qg.checkHubLinkPresent({ body: 'see /pest-control-services/ for details' }, brief).ok).toBe(false);
    // non-curated briefs still fall back to SERVICE_HUB_LINKS (unchanged)
    expect(qg.checkHubLinkPresent({ body: 'see /pest-control-services/ for details' }, {}).ok).toBe(true);
  });

  test('P2: loadManifest rejects a FAQ-policy-blocked topic that requests an FAQ; allows it without FAQ', () => {
    const base = { action: 'new_supporting_blog', target_site: 'sarasotaflpestcontrol.com', city: 'Sarasota' };
    expect(() => seeder.loadManifest(tmpManifest([{ ...base, id: 'BB', slug: '/pest-control/bed-bugs-x-sarasota/', schema_types: ['Article', 'FAQPage'] }])))
      .toThrow(/FAQ-policy-blocked but requests an FAQ/);
    expect(() => seeder.loadManifest(tmpManifest([{ ...base, id: 'BB2', slug: '/pest-control/bed-bugs-y-sarasota/', schema_types: ['Article'] }])))
      .not.toThrow();
    // the shipped SAR1 bed-bug brief is FAQ-free → loads clean
    expect(() => seeder.loadManifest()).not.toThrow();
  });

  test('P2: buildSpokeOverlay drops the default FAQ section for a no-FAQ topic; keeps an outline FAQ', () => {
    const m = seeder.loadManifest();
    const sar1 = seeder._internals.rowForBrief(m.briefs[0], m, { now: NOW }); // bed bugs — Article only
    const ov1 = seeder.buildSpokeOverlay({
      opportunity: { signal_metadata: sar1.signal_metadata },
      pageType: 'supporting-blog',
      requiredSections: ['hub link in intro', 'FAQ section (2–3 questions)', 'final CTA to relevant city/service page'],
      schemaTypes: ['Article', 'BreadcrumbList'],
    });
    expect(ov1.required_sections.some((s) => /faq|frequently asked|common questions/i.test(s))).toBe(false);
    // the default "hub link in intro" is dropped — the binding places one hub link near the end (R4 fix)
    expect(ov1.required_sections.some((s) => /hub link/i.test(s))).toBe(false);
    expect(ov1.schema_types).not.toContain('FAQPage');

    const sar2 = seeder._internals.rowForBrief(m.briefs[1], m, { now: NOW }); // carpenter ants — FAQ in outline + schema
    const ov2 = seeder.buildSpokeOverlay({
      opportunity: { signal_metadata: sar2.signal_metadata },
      pageType: 'supporting-blog',
      requiredSections: ['FAQ section (2–3 questions)'],
      schemaTypes: ['Article', 'BreadcrumbList'],
    });
    expect(ov2.required_sections.some((s) => /faq/i.test(s))).toBe(true); // from the manifest outline
    expect(ov2.schema_types).toContain('FAQPage');
  });

  test('P2: shipped manifest CTA codes are relative on-site paths (conversion-CTA gate)', () => {
    const m = seeder.loadManifest();
    for (const v of Object.values(m.cta_codes)) {
      expect(String(v)).not.toMatch(/https?:\/\//); // no absolute hub URL
    }
    expect(m.cta_codes.QUOTE).toMatch(/\/pest-control-quote\//);
  });

  test('P2: IndexNow submit skips a spoke-host URL (host mismatch)', async () => {
    const indexNow = require('../services/seo/indexnow-submit');
    const r = await indexNow.submit('https://www.sarasotaflpestcontrol.com/pest-control/german-roaches-sarasota-condos/');
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('host_mismatch');
    expect(r.ok).toBe(true); // fail-soft, not an error
  });

  test('P1-r2: blocked topic rides on faq_blocked_topic (service stays coarse), runtime FAQ guard catches a writer FAQ', () => {
    const m = seeder.loadManifest();
    // service stays coarse so the link/SEO gates keep working...
    expect(seeder._internals.serviceForBrief(m.briefs[0])).toBe('pest');
    // ...but the blocked topic is detected separately and surfaced on the overlay
    expect(seeder._internals.blockedTopicIdFor(m.briefs[0])).toBe('bed-bug'); // SAR1
    expect(seeder._internals.blockedTopicIdFor(m.briefs[1])).toBeNull(); // SAR2 carpenter ants
    const row = seeder._internals.rowForBrief(m.briefs[0], m, { now: NOW });
    const ov = seeder.buildSpokeOverlay({ opportunity: { signal_metadata: row.signal_metadata }, pageType: 'supporting-blog', requiredSections: [], schemaTypes: ['Article'] });
    expect(ov.operator_brief.faq_blocked_topic).toBe('bed-bug');

    // content-guardrails: coarse 'pest' alone does NOT catch a writer FAQ (the gap Codex flagged)...
    const guardrails = require('../services/content/content-guardrails');
    const faqBody = 'Bed bugs in Sarasota condos.\n## Frequently Asked Questions\n### Do bed bugs bite?\nYes.';
    expect(guardrails.evaluate({ frontmatter: {}, body: faqBody }, { service: 'pest' }).findings.some((f) => f.code === 'FAQ_BLOCKED_SERVICE')).toBe(false);
    // ...but folding faq_blocked_topic into the service array does (as the runner now does)
    expect(guardrails.evaluate({ frontmatter: {}, body: faqBody }, { service: ['pest', 'bed-bug'] }).findings.some((f) => f.code === 'FAQ_BLOCKED_SERVICE')).toBe(true);
  });

  test('P1-r3: blogOriginForSpoke uses the fleet canonical origin (www per domains.json), not a bare concat', () => {
    const { _internals } = require('../services/content-astro/astro-publisher');
    const { spokeSiteOrigin } = require('../services/content-astro/spoke-sites');
    expect(spokeSiteOrigin('sarasotaflpestcontrol.com')).toBe('https://www.sarasotaflpestcontrol.com');
    expect(spokeSiteOrigin('not-a-spoke.com')).toBeNull();
    expect(_internals.blogOriginForSpoke('sarasotaflpestcontrol.com')).toBe('https://www.sarasotaflpestcontrol.com');
    expect(_internals.blogOriginForSpoke(null)).toBe('https://www.wavespestcontrol.com');
  });

  test('P1-r2: brand-token hub-anchor exemption applies to body only, NOT editable meta', () => {
    const guardrails = require('../services/content/content-guardrails');
    const spoke = ['sarasotaflpestcontrol.com'];
    const hubAnchor = '[Waves Pest Control](https://www.wavespestcontrol.com/pest-control-sarasota-fl/)';
    const leak = (r) => r.findings.some((f) => f.code === 'BRAND_TOKEN_LEAK');
    // body anchor → allowed
    expect(leak(guardrails.evaluate({ frontmatter: { domains: spoke }, body: `In Sarasota, ${hubAnchor} helps.` }, { domains: spoke }))).toBe(false);
    // same string in meta title → NOT exempt (meta isn't rendered as a link) → leak
    expect(leak(guardrails.evaluate({ frontmatter: { domains: spoke, metaTitle: hubAnchor }, body: 'Clean Sarasota body.' }, { domains: spoke }))).toBe(true);
    // a literal brand in meta_description on a spoke → leak
    expect(leak(guardrails.evaluate({ frontmatter: { domains: spoke, meta_description: 'Waves Pest Control serves Sarasota.' }, body: 'Clean body.' }, { domains: spoke }))).toBe(true);
  });
});

describe('Codex PR #1772 round 5 fixes (#2 link-planning, #4 city localization)', () => {
  test('#2: targetForRun skips post-merge link planning for a spoke-only (off-hub) canonical', () => {
    const { _internals: poller } = require('../services/content/autonomous-pr-poller');
    const mk = (canonical) => ({ action_type: 'new_supporting_blog', draft_payload: JSON.stringify({ frontmatter: { canonical } }) });
    expect(poller.targetForRun(mk('https://www.wavespestcontrol.com/pest-control/x/')).planLinks).toBe(true);
    expect(poller.targetForRun(mk('https://www.sarasotaflpestcontrol.com/pest-control/x/')).planLinks).toBe(false);
  });

  test('#4: checkTwoPlusCityMentions verifies the TARGET city for a spoke brief', () => {
    const { _internals: qg } = require('../services/content/content-quality-gate');
    const spokeBrief = { voice_constraints: { operator_brief: { city: 'Sarasota' } } };
    expect(qg.checkTwoPlusCityMentions({ body: 'Sarasota condos. In Sarasota, roaches thrive.' }, spokeBrief).ok).toBe(true);
    expect(qg.checkTwoPlusCityMentions({ body: 'Only one Sarasota mention here.' }, spokeBrief).ok).toBe(false);
    // the gap Codex flagged: other-city mentions no longer let a Sarasota spoke pass
    expect(qg.checkTwoPlusCityMentions({ body: 'Bradenton and Venice are nearby cities.' }, spokeBrief).ok).toBe(false);
    // non-spoke briefs keep the generic two-distinct-cities behavior
    expect(qg.checkTwoPlusCityMentions({ body: 'We serve Bradenton and Venice.' }, {}).ok).toBe(true);
  });
});

describe('content-brief-builder: spoke overlay precedence + target_sites threading', () => {
  const { ContentBriefBuilder } = require('../services/content/content-brief-builder');

  test('_composeBrief routes a spoke-seed opportunity through the spoke overlay and threads target_sites', () => {
    const builder = new ContentBriefBuilder();
    const m = seeder.loadManifest();
    // SAR2 (carpenter ants) keeps the coarse 'pest' service, so the house
    // service hub links still merge in alongside the curated city hub link.
    const row = seeder._internals.rowForBrief(m.briefs[1], m, { now: new Date('2026-06-14T12:00:00Z') });
    const opportunity = {
      id: 100,
      bucket: row.bucket,
      signal_metadata: row.signal_metadata,
      query: row.query,
      page_url: null,
      service: row.service,
      city: null,
    };
    const decision = { action_type: 'new_supporting_blog', page_type: 'supporting-blog', final_score: 80, score_breakdown: {}, human_review_required: false };
    const brief = builder._composeBrief({ opportunity, signals: { serp_profile: null, customer_signal: null, conversion_feedback: null }, decision, existingBriefVersions: 0 });

    expect(brief.target_sites).toEqual(['sarasotaflpestcontrol.com']);
    expect(brief.voice_constraints.operator_brief.spoke_seed).toBe(true);
    expect(brief.voice_constraints.operator_brief.slug).toBe('/pest-control/carpenter-ants-sarasota-coastal-live-oaks/');
    // the hub city link leads the required internal links, service hub link merged for the hard check
    expect(brief.internal_links_to_add).toContain('https://www.wavespestcontrol.com/pest-control-sarasota-fl/');
    expect(brief.internal_links_to_add.some((l) => l.startsWith('/pest-control'))).toBe(true);
  });
});
