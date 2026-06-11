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

    // Operator internal links are required verbatim.
    expect(brief.internal_links_to_add).toEqual(payload.internal_links);

    // Schema: operator types + house Article/BreadcrumbList.
    for (const t of payload.schema_types) expect(brief.schema_types).toContain(t);
    expect(brief.schema_types).toContain('BreadcrumbList');

    // Binding operator block rides in voice_constraints (persisted jsonb →
    // survives the get_content_brief round-trip).
    const op = brief.voice_constraints.operator_brief;
    expect(op.thesis).toBe(payload.thesis);
    expect(op.slug).toBe(payload.slug);
    expect(op.working_title).toBe(payload.working_title);
    expect(op.required_sources).toEqual(payload.sources);
    expect(op.verify_notes).toEqual(payload.verify_notes);
    expect(op.global_rules).toBe(manifest.notes);
    expect(op.secondary_kws).toEqual(payload.secondary_kws);

    // adam-augusta byline → same Adam Benetti record + body-emphasis note.
    expect(op.byline.author_frontmatter).toEqual({
      name: 'Adam Benetti',
      role: 'Founder & Lead Technician',
      fdacs_license: 'JB351547',
      years_swfl: 12,
      bio_url: '/about/authors/adam-benetti',
    });
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
    expect(brief.voice_constraints.operator_brief.id).toBe('A0');
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
