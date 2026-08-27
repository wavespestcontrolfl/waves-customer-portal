/**
 * Operator-intercept brief injection — content-brief-builder must hand the
 * seeded operator payload to the writer agent VERBATIM (thesis, outline,
 * required sources, verify notes, internal links, byline, CTA directives,
 * global rules), and agent-dispatcher.buildInputPayload must surface it as
 * binding in the session-opening message.
 */

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/content/opportunity-queue', () => ({
  getById: jest.fn(),
  peek: jest.fn(),
  // intercept-brief-seeder destructures _internals.maxClaimAttempts at load —
  // omitting it makes the whole suite fail to require (TypeError), not skip.
  _internals: { maxClaimAttempts: jest.fn(() => 5) },
}));

const db = require('../models/db');
const queue = require('../services/content/opportunity-queue');
const seeder = require('../services/content/intercept-brief-seeder');
const briefBuilder = require('../services/content/content-brief-builder');
const { buildInputPayload } = require('../services/content/agents/agent-dispatcher')._internals;

const manifest = seeder.loadManifest();
const byId = Object.fromEntries(manifest.briefs.map((b) => [b.id, b]));

function opportunityFor(briefId, overrides = {}) {
  const row = seeder._internals.rowForBrief(byId[briefId], manifest, { now: new Date('2026-06-11T12:00:00Z') });
  return { id: `opp-${briefId}`, ...row, ...overrides };
}

beforeEach(() => {
  // _countExistingBriefs: db('content_briefs').where().count().first()
  const chain = {
    where: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    select: jest.fn(() => Promise.resolve([])),
    count: jest.fn(() => chain),
    first: jest.fn(() => Promise.resolve({ c: 0 })),
  };
  db.mockImplementation(() => chain);
});
afterEach(() => jest.clearAllMocks());

describe('content-brief-builder operator-intercept injection', () => {
  test('B2 (cancel TruGreen): seeded payload reaches the brief verbatim and binding', async () => {
    queue.getById.mockResolvedValue(opportunityFor('B2'));

    const brief = await briefBuilder.compose('opp-B2', { persist: false, skipSerp: true });
    const payload = byId.B2;

    // Action / page type pinned, no review parking.
    expect(brief.action_type).toBe('new_supporting_blog');
    expect(brief.page_type).toBe('supporting-blog');
    expect(brief.human_review_required).toBe(false);
    expect(brief.router_notes).toMatch(/operator-pinned/);

    // Outline IS the content plan (verbatim, leading the required sections),
    // with the house structural sections appended after it.
    expect(brief.required_sections.slice(0, payload.outline.length)).toEqual(payload.outline);
    expect(brief.required_sections).toContain('hub link in intro');
    // The operator FAQ spec wins — no duplicate standard FAQ requirement.
    const faqSections = brief.required_sections.filter((s) => /faq/i.test(s));
    expect(faqSections).toHaveLength(1);
    expect(faqSections[0]).toBe('FAQ block');

    // Operator internal links lead the list verbatim, with the standard
    // service-hub links merged after them (hub_link_present support).
    expect(brief.internal_links_to_add.slice(0, payload.internal_links.length)).toEqual(payload.internal_links);
    // This asserted '/lawn-care/' until 2026-07-29, when a live fetch showed that
    // route 404s (no bare lawn hub page exists — only city-scoped ones). The
    // blackout guide below survives because THIS operator payload lists it
    // verbatim, not because lawn mandates it: SERVICE_HUB_LINKS.lawn is now empty
    // (a county-specific guide is the wrong required link for every lawn topic),
    // so lawn satisfies hub_link_present via its city-service page instead.
    expect(brief.internal_links_to_add).toContain('/lawn-care/fertilizer-blackout-manatee-county/');
    expect(brief.internal_links_to_add).not.toContain('/lawn-care/');

    // Schema: operator types + house Article/BreadcrumbList.
    for (const t of payload.schema_types) expect(brief.schema_types).toContain(t);
    expect(brief.schema_types).toContain('BreadcrumbList');

    // Binding operator block rides in voice_constraints (persisted jsonb →
    // survives the get_content_brief round-trip).
    const op = brief.voice_constraints.operator_brief;
    expect(op.thesis).toBe(payload.thesis);
    expect(op.slug).toBe(payload.slug);
    expect(op.working_title).toBe(payload.working_title);
    // Manifest source contract (intercept-brief-seeder.splitBriefSources):
    // `sources` carries http(s) URLs ONLY — the archive.org snapshot step
    // consumes them — and any non-URL operator directive seeded there is
    // DEMOTED to source_notes (warned, never dropped) so it still reaches
    // the writer verbatim as a binding instruction. B2 seeds one such
    // directive deliberately, pinning the demotion.
    const urlSources = payload.sources.filter((s) => /^https?:\/\//i.test(s));
    const straySources = payload.sources.filter((s) => !/^https?:\/\//i.test(s));
    expect(straySources.length).toBeGreaterThan(0); // fixture exercises the demotion
    expect(op.required_sources).toEqual(urlSources);
    expect(op.source_notes).toEqual(expect.arrayContaining(straySources));
    expect(op.verify_notes).toEqual(payload.verify_notes);
    expect(op.global_rules).toBe(manifest.notes);
    expect(op.secondary_kws).toEqual(payload.secondary_kws);

    // adam-augusta byline → same Adam Benetti record + body-emphasis note.
    // Whitelisted author fields only — never years_*/tenure (fabricated
    // claim; company founded 2024).
    expect(op.byline.author_frontmatter).toEqual({
      name: 'Adam Benetti',
      role: 'Founder & Lead Technician',
      fdacs_license: 'JB351547',
      bio_url: '/about/authors/adam-benetti',
    });
    expect(Object.keys(op.byline.author_frontmatter).some((k) => /^years_|tenure/i.test(k))).toBe(false);
    expect(op.byline.emphasis).toMatch(/Augusta National/);

    // CTA codes resolve to the manifest descriptions.
    expect(op.cta_directives).toEqual([
      `CALC: ${manifest.cta_codes.CALC}`,
      `QUOTE: ${manifest.cta_codes.QUOTE}`,
    ]);

    // Binding instructions cover sources, verify notes, links, byline, rules.
    const joined = op.binding_instructions.join('\n');
    expect(joined).toMatch(/BINDING/);
    expect(joined).toContain(payload.thesis);
    expect(joined).toContain('https://legalclarity.org/how-to-cancel-trugreen-phone-mail-or-online/');
    expect(joined).toMatch(/VERIFY BEFORE WRITING .*NY AG release/);
    expect(joined).toContain('/lawn-care/fertilizer-blackout-manatee-county/');
    expect(joined).toMatch(/GLOBAL RULES/);
    expect(joined).toMatch(/comparison disclaimer/i);

    // Facts machinery stays out of the way: no city anchor → no facts pack.
    expect(brief.facts_pack).toBeNull();
    expect(brief.city).toBeNull();
  });

  test('FAQ requirement survives for termite-cluster briefs via the explicit operator mandate', async () => {
    queue.getById.mockResolvedValue(opportunityFor('C1'));
    const brief = await briefBuilder.compose('opp-C1', { persist: false, skipSerp: true });
    // Truthful service label — NOT mislabeled to dodge the FAQ-blocked guard.
    expect(brief.service).toBe('termite');
    // The operator outline (incl. its FAQ block) is the content plan, and
    // the explicit faq_required mandate rides on the brief for the
    // guardrail / quality-gate / SEO-gate exceptions.
    expect(brief.required_sections.some((s) => /faq/i.test(s))).toBe(true);
    expect(brief.schema_types).toContain('FAQPage');
    expect(brief.voice_constraints.operator_brief.faq_required).toBe(true);
  });

  test('A0 refresh: target page + operator outline, refresh template preserved', async () => {
    queue.getById.mockResolvedValue(opportunityFor('A0'));
    const brief = await briefBuilder.compose('opp-A0', { persist: false, skipSerp: true });
    expect(brief.action_type).toBe('refresh_existing_page');
    expect(brief.page_type).toBe('refresh');
    expect(brief.target_url).toBe('https://www.wavespestcontrol.com/pest-control/in-wall-pest-control/');
    expect(brief.required_sections.slice(0, byId.A0.outline.length)).toEqual(byId.A0.outline);
    expect(brief.required_sections).toContain('preserve existing slug');
    expect(brief.internal_links_to_add).toEqual([]);
    const op = brief.voice_constraints.operator_brief;
    expect(op.id).toBe('A0');
    // publishRefresh freezes live schema — the brief must NOT require new
    // schema_types on a refresh (the runner would accept schema that never
    // lands on the page). The operator's schema request routes to the human
    // reviewer instead.
    expect(brief.schema_types).toEqual([]);
    expect(op.refresh_schema_note).toMatch(/freezes live schema/);
    const joined = op.binding_instructions.join('\n');
    expect(joined).toMatch(/SCHEMA \(refresh limitation\)/);
    expect(joined).toMatch(/notes_for_reviewer/);
  });

  test('A0/A1: the operator brief text authorizes "HomeTeam Pest Defense" so a table-less draft naming it routes to review, not comparison_table_failed', async () => {
    // Regression: both A-cluster briefs said bare "HomeTeam's ...", which is
    // deliberately NOT a competitor-facts alias, so the comparison gate's
    // operator authorization never matched and every run hard-blocked on
    // COMPARISON_COMPETITOR_IN_PROSE (06-13 → 08-26). The gate reads the
    // runner's operatorBriefTextForComparisonGate() fields — thesis/outline
    // must carry the allowlisted canonical name.
    const gate = require('../services/content/comparison-table-gate');
    const { operatorBriefTextForComparisonGate, OPERATOR_INTERCEPT_BUCKET } = require('../services/content/autonomous-runner')._internals;
    const draft = {
      frontmatter: { title: 'Your New Lakewood Ranch Home Came With Taexx: What It Misses', description: 'What the in-wall system covers and what it does not.' },
      body: 'Service is usually a Saturday. HomeTeam Pest Defense states in its FAQ that the key "is not commercially available" ([source](https://pestdefense.com/taexx/)).',
    };
    for (const id of ['A0', 'A1']) {
      queue.getById.mockResolvedValue(opportunityFor(id));
      const brief = await briefBuilder.compose(`opp-${id}`, { persist: false, skipSerp: true });
      const operatorBriefText = operatorBriefTextForComparisonGate({ bucket: OPERATOR_INTERCEPT_BUCKET }, brief);
      const result = gate.evaluate(draft, { namedCompetitorEnabled: true, operatorBriefText });
      expect(result.findings.map((f) => f.code)).toEqual([]);
      expect(result.pass).toBe(true);
      expect(result.requiresHumanReview).toBe(true);
      // The writer must not reach for a <ComparisonTable> on these posts —
      // any column naming the vendor/system fails closed.
      expect(brief.voice_constraints.operator_brief.verify_notes.join('\n')).toMatch(/Do NOT emit a <ComparisonTable>/);
    }
  });

  test('every intercept brief carries the price-guard framing rule for sourced competitor dollar figures', async () => {
    queue.getById.mockResolvedValue(opportunityFor('B3')); // brief whose outline mandates dollar figures
    const brief = await briefBuilder.compose('opp-B3', { persist: false, skipSerp: true });
    const joined = brief.voice_constraints.operator_brief.binding_instructions.join('\n');
    expect(joined).toMatch(/COMPETITOR PRICING FRAMING/);
    expect(joined).toMatch(/"quote", "range", "pricing varies", "depends", or "estimate"/);
  });

  test('non-intercept opportunities are completely untouched by the overlay', async () => {
    queue.getById.mockResolvedValue({
      id: 'opp-mined',
      bucket: 'seasonal_rising',
      action_type: 'new_supporting_blog',
      query: 'mosquitoes after rain',
      service: 'mosquito',
      city: null,
      score: 52,
      signal_metadata: { impressions: 120 },
    });
    const brief = await briefBuilder.compose('opp-mined', { persist: false, skipSerp: true });
    expect(brief.voice_constraints.operator_brief).toBeUndefined();
    expect(brief.required_sections).toContain('FAQ section (2–3 questions)');
  });
});

describe('agent-dispatcher.buildInputPayload operator binding', () => {
  test('operator_brief is surfaced in the opening message and flagged binding', async () => {
    queue.getById.mockResolvedValue(opportunityFor('A2'));
    const brief = await briefBuilder.compose('opp-A2', { persist: false, skipSerp: true });
    brief.opportunity_id = 'opp-A2';

    const payload = buildInputPayload(brief);
    expect(payload.instruction).toMatch(/OPERATOR-AUTHORED intercept brief/);
    expect(payload.instruction).toMatch(/BINDING/);
    expect(payload.brief_summary.operator_brief.id).toBe('A2');
    expect(payload.brief_summary.operator_brief.required_sources).toEqual(byId.A2.sources);
  });

  test('voice_constraints round-tripped as a JSON string (DB read) still surfaces operator_brief', () => {
    const payload = buildInputPayload({
      opportunity_id: 'opp-x',
      action_type: 'new_supporting_blog',
      voice_constraints: JSON.stringify({ tone: 't', operator_brief: { id: 'B1', binding_instructions: [] } }),
    });
    expect(payload.brief_summary.operator_brief.id).toBe('B1');
    expect(payload.instruction).toMatch(/OPERATOR-AUTHORED/);
  });

  test('mined briefs keep the original instruction (no operator framing)', () => {
    const payload = buildInputPayload({
      opportunity_id: 'opp-y',
      action_type: 'new_supporting_blog',
      voice_constraints: { tone: 't' },
    });
    expect(payload.brief_summary.operator_brief).toBeNull();
    expect(payload.instruction).not.toMatch(/OPERATOR-AUTHORED/);
  });
});
