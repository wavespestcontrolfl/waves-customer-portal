/**
 * Category-seed backlog (lawn / tree-shrub hub blog) — owner rulings 2026-07-27.
 *
 * Covers the pieces that let the autonomous content engine work a curated
 * lawn/tree-shrub topic backlog through the existing chain:
 *   - category-seed-seeder: manifest validation → operator-pinned rows
 *   - drip pacing: available_at windows + 45-day expiry
 *   - content-brief-builder: category overlay precedence (never the
 *     competitor-comparison overlay, never the spoke overlay)
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');

const seeder = require('../services/content/category-seed-seeder');

function writeManifest(briefs, extra = {}) {
  const p = path.join(os.tmpdir(), `catseed-manifest-${briefs[0]?.id || 'empty'}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({ version: 1, set: 'catseed-test', briefs, ...extra }));
  return p;
}

const VALID_BRIEF = {
  id: 'X1',
  action: 'new_supporting_blog',
  slug: '/lawn-care/test-topic-sarasota-fl/',
  working_title: 'Test Topic',
  primary_kw: 'test topic sarasota',
  window: '2026-08-03',
  byline: 'adam-augusta',
  thesis: 'A test thesis.',
  outline: ['Section one', 'Section two'],
  sources: ['https://edis.ifas.ufl.edu/', 'Verify against UF/IFAS.'],
  verify_notes: ['Verify everything.'],
};

describe('category-seed-seeder: shipped manifest', () => {
  test('the shipped manifest loads and validates (24 lawn + 8 tree-shrub)', () => {
    const m = seeder.loadManifest();
    expect(m.briefs.length).toBe(32);
    const ids = m.briefs.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    const services = m.briefs.map((b) => seeder._internals.serviceForBrief(b));
    expect(services.filter((s) => s === 'lawn').length).toBe(24);
    expect(services.filter((s) => s === 'tree-shrub').length).toBe(8);
    for (const b of m.briefs) {
      expect(b.action).toBe('new_supporting_blog');
      expect(b.sources.length).toBeGreaterThan(0);
      expect(b.verify_notes.length).toBeGreaterThan(0);
      expect(b.window).toMatch(/^\d{4}-\d{2}-\d{2}$/); // every brief dripped, none immediate
    }
  });

  test('every shipped window is unique — ~2/week drip, never a same-day pile-up', () => {
    const m = seeder.loadManifest();
    const windows = m.briefs.map((b) => b.window);
    expect(new Set(windows).size).toBe(windows.length);
  });
});

describe('category-seed-seeder: manifest validation', () => {
  test('rejects a non-lawn/tree-shrub slug and a non-blog action', () => {
    expect(() => seeder.loadManifest(writeManifest([{ ...VALID_BRIEF, slug: '/pest-control/nope/' }])))
      .toThrow(/slug must start with \/lawn-care\/ or \/tree-shrub\//);
    expect(() => seeder.loadManifest(writeManifest([{ ...VALID_BRIEF, action: 'refresh_existing_page' }])))
      .toThrow(/action must be new_supporting_blog/);
  });

  test('rejects missing sources / verify_notes (truth-rule grounding is mandatory)', () => {
    expect(() => seeder.loadManifest(writeManifest([{ ...VALID_BRIEF, sources: [] }])))
      .toThrow(/sources are required/);
    expect(() => seeder.loadManifest(writeManifest([{ ...VALID_BRIEF, verify_notes: [] }])))
      .toThrow(/verify_notes are required/);
  });

  test('rejects duplicate ids, duplicate slugs, unknown bylines, malformed windows', () => {
    expect(() => seeder.loadManifest(writeManifest([VALID_BRIEF, { ...VALID_BRIEF }])))
      .toThrow(/duplicate id/);
    expect(() => seeder.loadManifest(writeManifest([VALID_BRIEF, { ...VALID_BRIEF, id: 'X2' }])))
      .toThrow(/duplicate slug/);
    expect(() => seeder.loadManifest(writeManifest([{ ...VALID_BRIEF, byline: 'nobody' }])))
      .toThrow(/unknown byline/);
    expect(() => seeder.loadManifest(writeManifest([{ ...VALID_BRIEF, window: 'August 3' }])))
      .toThrow(/unrecognized window/);
  });

  test('rejects an FAQ request on an FAQ-blocked pest topic (guards manifest drift)', () => {
    const drifted = {
      ...VALID_BRIEF,
      slug: '/lawn-care/termites-in-lawn/',
      working_title: 'Termites in the Lawn',
      schema_types: ['Article', 'FAQPage'],
    };
    expect(() => seeder.loadManifest(writeManifest([drifted])))
      .toThrow(/FAQ-policy-blocked/);
  });
});

describe('category-seed-seeder: rows', () => {
  test('rowForBrief builds an operator-pinned, category-tagged HUB row', () => {
    const m = seeder.loadManifest();
    const now = new Date('2026-07-28T12:00:00Z');
    const row = seeder._internals.rowForBrief(m.briefs[0], m, { now });
    expect(row.bucket).toBe('operator_intercept'); // inherits router pin + serp/gsc exemptions + runner skipSerp
    expect(row.city).toBeNull(); // facts gate "not applicable" — locality rides the outline
    expect(['lawn', 'tree-shrub']).toContain(row.service);
    expect(row.score).toBe(seeder._internals.DEFAULT_SCORE);
    expect(row.dedupe_key).toBe(`catseed:v1:${m.briefs[0].id}`);
    expect(row.signal_metadata.operator_pinned).toBe(true);
    expect(row.signal_metadata.category_seed).toBe(true);
    // Hub-only by construction: no spoke flags, no target_sites.
    expect(row.signal_metadata.spoke_seed).toBeUndefined();
    expect(row.signal_metadata.target_sites).toBeUndefined();
    expect(row.signal_metadata.category_brief.id).toBe(m.briefs[0].id);
  });

  test('windows become midnight-ET available_at with expiry 45 days after activation', () => {
    const m = seeder.loadManifest();
    const now = new Date('2026-07-28T12:00:00Z');
    const brief = m.briefs.find((b) => b.window === '2026-11-19');
    const row = seeder._internals.rowForBrief(brief, m, { now });
    expect(row.available_at).toBeInstanceOf(Date);
    expect(row.available_at.getTime()).toBeGreaterThan(now.getTime());
    expect(row.expires_at.getTime() - row.available_at.getTime()).toBe(45 * 86400_000);
    expect(row.status).toBe('pending');
  });

  test('a spoke-seed row is NOT a category seed and vice versa', () => {
    const spokeRow = { signal_metadata: { operator_pinned: true, spoke_seed: true } };
    const catRow = { signal_metadata: { operator_pinned: true, category_seed: true } };
    expect(seeder.isCategorySeed(spokeRow)).toBe(false);
    expect(seeder.isCategorySeed(catRow)).toBe(true);
    const spokeSeeder = require('../services/content/spoke-seed-seeder');
    expect(spokeSeeder.isSpokeSeed(catRow)).toBe(false);
  });
});

describe('category-seed-seeder: overlay', () => {
  function overlayFor(brief, { requiredSections = [], schemaTypes = [] } = {}) {
    const m = seeder.loadManifest();
    const payload = brief || m.briefs[0];
    const opportunity = seeder._internals.rowForBrief(payload, m, { now: new Date('2026-07-28T12:00:00Z') });
    return seeder.buildCategoryOverlay({ opportunity, pageType: 'supporting-blog', requiredSections, schemaTypes });
  }

  test('outline becomes the required-sections plan; schema gains Article + BreadcrumbList', () => {
    const m = seeder.loadManifest();
    const brief = m.briefs[0];
    const overlay = overlayFor(brief, { requiredSections: ['intro', 'faq section'] });
    for (const section of brief.outline) expect(overlay.required_sections).toContain(section);
    expect(overlay.schema_types).toContain('Article');
    expect(overlay.schema_types).toContain('BreadcrumbList');
    expect(overlay.operator_brief.category_seed).toBe(true);
    expect(overlay.operator_brief.slug).toBe(brief.slug);
  });

  test('binding instructions carry the informational-lane rule, verify notes, and relative CTAs', () => {
    const overlay = overlayFor();
    const joined = overlay.operator_brief.binding_instructions.join('\n');
    expect(joined).toMatch(/no near-me or transactional phrasing/i);
    expect(joined).toMatch(/VERIFY BEFORE WRITING/);
    expect(joined).toMatch(/RELATIVE on-site path/);
    expect(joined).toMatch(/pest-control-calculator/);
  });

  test('sources split: URLs become required_sources, directives become source_notes', () => {
    const overlay = overlayFor();
    expect(overlay.operator_brief.required_sources.every((s) => /^https?:\/\//.test(s))).toBe(true);
    expect(overlay.operator_brief.source_notes.length).toBeGreaterThan(0);
    expect(overlay.operator_brief.source_notes.every((s) => !/^https?:\/\//.test(s))).toBe(true);
  });

  test('returns null for a non-category-seed opportunity', () => {
    expect(seeder.buildCategoryOverlay({ opportunity: { signal_metadata: { spoke_seed: true } }, pageType: 'supporting-blog' })).toBeNull();
  });
});

describe('content-brief-builder: overlay precedence', () => {
  test('a category seed never routes to the spoke or intercept overlay', () => {
    // The dispatch in content-brief-builder is: spoke → category → intercept.
    // A category seed shares the operator_intercept bucket (so
    // isOperatorIntercept() is true), which without the category branch would
    // wrongly apply the competitor-comparison overlay.
    const interceptSeeder = require('../services/content/intercept-brief-seeder');
    const m = seeder.loadManifest();
    const row = seeder._internals.rowForBrief(m.briefs[0], m, { now: new Date('2026-07-28T12:00:00Z') });
    expect(interceptSeeder.isOperatorIntercept(row)).toBe(true); // shares the pinned bucket
    expect(seeder.isCategorySeed(row)).toBe(true); // …but the builder branches here first
    // The intercept overlay keys on intercept_brief and returns null for us —
    // belt and suspenders on top of the dispatch order.
    expect(interceptSeeder.buildOperatorOverlay({ opportunity: row, pageType: 'supporting-blog' })).toBeNull();
    const src = fs.readFileSync(path.join(__dirname, '../services/content/content-brief-builder.js'), 'utf8');
    const spokeIdx = src.indexOf('spokeSeeder.isSpokeSeed(opportunity)\n      ? spokeSeeder.buildSpokeOverlay');
    const catIdx = src.indexOf('categorySeeder.isCategorySeed(opportunity)');
    const interceptIdx = src.indexOf('!spokeOverlay && !categoryOverlay && interceptSeeder.isOperatorIntercept(opportunity)');
    expect(spokeIdx).toBeGreaterThan(-1);
    expect(catIdx).toBeGreaterThan(spokeIdx);
    expect(interceptIdx).toBeGreaterThan(catIdx);
  });
});

describe('shipped-manifest content rules', () => {
  test('tree-shrub briefs all carry the no-service-scope-claims verify note', () => {
    const m = seeder.loadManifest();
    const ts = m.briefs.filter((b) => seeder._internals.serviceForBrief(b) === 'tree-shrub');
    for (const b of ts) {
      const joined = b.verify_notes.join(' ');
      expect(joined).toMatch(/facts bank is unverified|no claims about our service/i);
    }
  });

  test('no fertilizer-application topic activates inside the Jun 1 – Sep 30 restricted season', () => {
    // Content ABOUT the restricted season is fine any time; briefs that direct
    // N/P application timing (the October fertilization brief) must activate
    // on/after Oct 1.
    const m = seeder.loadManifest();
    const fertBriefs = m.briefs.filter((b) => /fertiliz/i.test(`${b.slug} ${b.working_title}`));
    expect(fertBriefs.length).toBeGreaterThan(0);
    for (const b of fertBriefs) {
      const [, month, day] = b.window.split('-').map(Number);
      const inBlackout = (month > 6 || (month === 6 && day >= 1)) && (month < 10);
      expect(inBlackout).toBe(false);
    }
  });

  test('list-shaped briefs carry the citable-listicle architecture in their outlines', () => {
    const m = seeder.loadManifest();
    const listicles = m.briefs.filter((b) => /^\d+ /.test(b.working_title));
    expect(listicles.length).toBeGreaterThanOrEqual(3);
    for (const b of listicles) {
      const joined = b.outline.join(' ');
      expect(joined).toMatch(/quick answer/i);
      expect(joined).toMatch(/how we chose/i);
      expect(joined).toMatch(/last updated/i);
    }
  });
});
