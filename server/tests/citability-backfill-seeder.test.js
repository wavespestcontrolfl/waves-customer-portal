/**
 * Citability backfill lane (2026-09-25): corpus scan → page-anchored
 * refresh rows → router pinning → quality-gate evidence exemption + refresh
 * nudges → brief-builder binding sections → refresh-agent CITABILITY MODE.
 */

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn(async () => ({ rowCount: 1 }));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true), gates: {} }));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const seeder = require('../services/content/citability-backfill-seeder');
const { route } = require('../services/content/decision-router');
const gate = require('../services/content/content-quality-gate');
const gateInternals = gate._internals;
const { CITABILITY_GAP_SECTIONS } = require('../services/content/content-brief-builder')._internals;
const { REFRESH_AGENT_CONFIG } = require('../services/content/agents/refresh-agent-config');

const { serviceForPost, rowForPost, dedupeKeyFor, availableAtFor, BASE_SCORE } = seeder._internals;

afterEach(() => jest.clearAllMocks());

const FM = (extra = '') => `---
title: "Termite Bait vs. Liquid Treatment in Venice"
category: "termite"
post_type: "diagnostic"
related_services:
  - "termite-control-venice-fl"
${extra}---
`;

const POOR = FM() + `## What homeowners see
Experts say termites swarm after rain. Treat early and water deeply.

## Bait or liquid?
Both work. Pick one.
`;
const GOOD = FM() + `## What homeowners see
Per UF/IFAS, subterranean termites swarm after rain when soil stays above 70 degrees for 3 days; colonies forage 100 feet out.

## Bait or liquid?
<ComparisonTable columns={["What to weigh","Bait","Liquid"]} rows={[{ label: "Time to effect", values: ["Months","Weeks"] }]} caption="Editorial checklist." />

## How to choose between bait and liquid
- If you see mud tubes on the slab → liquid.
- If the slab is hard to drill → bait.
- If a home sale needs a WDO clearance soon → liquid.
`;

function corpus() {
  return [
    { file: 'src/content/blog/termite/bait-vs-liquid.mdx', url: '/termite/bait-vs-liquid/', body: POOR },
    { file: 'src/content/blog/termite/bait-vs-liquid-good.mdx', url: '/termite/bait-vs-liquid-good/', body: GOOD },
    { file: 'src/content/blog/pest-control/mud-daubers.mdx', url: '/pest-control/mud-daubers/', body: '---\ntitle: "Do Mud Daubers Sting?"\ncategory: "pest-control"\n---\n## Short answer\nRarely. They are solitary wasps; nests go quiet after a few weeks.\n' },
    { file: 'src/content/services/pest-control.md', url: '/pest-control/', body: '---\ntitle: "Pest Control"\n---\nNo sources, no numbers.' },
  ];
}

describe('scanPost — same four heuristics as the quality gate', () => {
  test('a poor post reports every applicable gap; a good one reports none', () => {
    const poor = seeder.scanPost({ url: '/termite/bait-vs-liquid/', body: POOR });
    // how_to_choose is n/a to the gate before a table exists, but is planned
    // with the comparison gap — the table the refresh adds makes it apply (Codex P2).
    expect(poor.gaps).toEqual(['named_sources', 'concrete_specifics', 'comparison', 'how_to_choose']);
    expect(poor.results.how_to_choose).toEqual({ ok: true, reason: 'no_comparison_to_choose_from' });
    const good = seeder.scanPost({ url: '/termite/bait-vs-liquid-good/', body: GOOD });
    expect(good.gaps).toEqual([]);
  });
  test('a legacy .md post never gets a comparison gap (no MDX components on refresh; Codex P2)', () => {
    const md = seeder.scanPost({ url: '/termite/bait-vs-liquid/', file: 'src/content/blog/termite/bait-vs-liquid.md', body: POOR });
    expect(md.gaps).toEqual(['named_sources', 'concrete_specifics']);
    expect(md.results.comparison).toEqual({ ok: true, reason: 'markdown_only_post_cannot_carry_ComparisonTable' });
    const mdx = seeder.scanPost({ url: '/termite/bait-vs-liquid/', file: 'src/content/blog/termite/bait-vs-liquid.mdx', body: POOR });
    expect(mdx.gaps).toContain('comparison');
  });
  test('a post that frames no choice never gets comparison / how_to_choose gaps', () => {
    const r = seeder.scanPost(corpus()[2]);
    // "a few weeks" with no measurement → concrete_specifics (softening, not a quota).
    expect(r.gaps).toEqual(['named_sources', 'concrete_specifics']);
  });
  test('serviceForPost maps the astro category, then related_services, then pest', () => {
    expect(serviceForPost({ category: 'lawn-care' })).toBe('lawn');
    expect(serviceForPost({ category: 'seasonal', related_services: ['mosquito-control-sarasota-fl'] })).toBe('mosquito');
    expect(serviceForPost({ category: 'seasonal', related_services: ['tree-and-shrub-care-venice-fl'] })).toBe('tree-shrub');
    expect(serviceForPost({})).toBe('pest');
  });
});

describe('rowForPost / planRows — page-anchored refresh rows, paced per ET day', () => {
  const now = new Date('2026-09-25T15:00:00Z');
  test('row shape: refresh_existing_page, query NULL, city NULL, score above the 75 refresh floor, scan in signal_metadata', () => {
    const scan = seeder.scanPost({ url: '/termite/bait-vs-liquid/', body: POOR });
    const row = rowForPost({ url: '/termite/bait-vs-liquid/', file: 'src/content/blog/termite/bait-vs-liquid.mdx' }, scan, { now });
    expect(row.bucket).toBe('citability_backfill');
    expect(row.action_type).toBe('refresh_existing_page');
    expect(row.query).toBeNull();
    expect(row.city).toBeNull();
    expect(row.service).toBe('termite');
    expect(row.page_url).toBe('/termite/bait-vs-liquid/');
    expect(row.score).toBe(BASE_SCORE + 4);
    expect(row.score).toBeGreaterThan(75);
    expect(row.signal_metadata.citability_gaps).toEqual(['named_sources', 'concrete_specifics', 'comparison', 'how_to_choose']);
    expect(row.signal_metadata.source).toBe('citability-backfill-seeder');
    expect(row.dedupe_key).toBe(dedupeKeyFor('/termite/bait-vs-liquid/'));
    expect(row.available_at).toBeNull();
    expect(row.expires_at.getTime()).toBe(now.getTime() + 45 * 86400_000);
  });
  test('availableAtFor: day 0 is claimable now; later days land at midnight ET via the shared ET parser (DST-correct)', () => {
    expect(availableAtFor(now, 0)).toBeNull();
    expect(availableAtFor(now, 1).toISOString()).toBe('2026-09-26T04:00:00.000Z');
    expect(availableAtFor(now, 3).toISOString()).toBe('2026-09-28T04:00:00.000Z');
    // Fall-back day (2026-11-01): midnight ET is still EDT → 04:00Z, and the
    // day after is EST → 05:00Z. Spring-forward day (2027-03-14): midnight is
    // still EST → 05:00Z. A noon-UTC offset probe got both wrong.
    expect(availableAtFor(new Date('2026-10-31T15:00:00Z'), 1).toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(availableAtFor(new Date('2026-10-31T15:00:00Z'), 2).toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(availableAtFor(new Date('2027-03-13T15:00:00Z'), 1).toISOString()).toBe('2027-03-14T05:00:00.000Z');
    // Late-evening ET "now" still counts as that ET day (etDateString, not UTC).
    expect(availableAtFor(new Date('2026-09-26T02:30:00Z'), 1).toISOString()).toBe('2026-09-26T04:00:00.000Z');
  });
  test('planRows: blog collection only, minGaps filter, worst-first, perDay pacing, limit', () => {
    const rows = seeder.planRows(corpus(), { now, perDay: 1, minGaps: 2 });
    // services/ file excluded; GOOD post has no gaps; POOR (4 gaps) sorts before mud-daubers (2).
    expect(rows.map((r) => r.page_url)).toEqual(['/termite/bait-vs-liquid/', '/pest-control/mud-daubers/']);
    expect(rows[0].available_at).toBeNull();
    expect(rows[1].available_at.toISOString()).toBe('2026-09-26T04:00:00.000Z');
    expect(seeder.planRows(corpus(), { now, minGaps: 3 }).map((r) => r.page_url)).toEqual(['/termite/bait-vs-liquid/']);
    expect(seeder.planRows(corpus(), { now, minGaps: 1, limit: 1 })).toHaveLength(1);
  });
  test('planRows skips non-indexable posts: noindex, spoke-rendered, off-hub or mismatched canonical (Codex P2)', () => {
    const variant = (url, extra) => ({ file: `src/content/blog/termite${url}.mdx`, url: `/termite${url}/`, body: FM(extra) + POOR.slice(FM().length) });
    const posts = [
      variant('/noindex', 'robots: "noindex"\n'),
      variant('/spoke', 'domains:\n  - "some-spoke-domain.com"\n'),
      variant('/offhub', 'canonical: "https://some-spoke-domain.com/x/"\n'),
      variant('/mismatch', 'canonical: "/termite/other-post/"\n'),
      variant('/ok', ''),
    ];
    expect(seeder.planRows(posts, { now, minGaps: 1 }).map((r) => r.page_url)).toEqual(['/termite/ok/']);
  });
});

describe('rescanLive — stale seeded rows are re-checked before drafting (Codex P2)', () => {
  const opp = { id: 1, bucket: 'citability_backfill', page_url: '/termite/bait-vs-liquid/' };
  test('returns the live page gaps (frontmatter + body from the publisher)', async () => {
    const publisher = { loadExistingPageBody: jest.fn().mockResolvedValue({ body: GOOD.slice(FM().length), frontmatter: { title: 'Termite Bait vs. Liquid Treatment in Venice', post_type: 'diagnostic' } }) };
    const r = await seeder.rescanLive(opp, { publisher });
    expect(publisher.loadExistingPageBody).toHaveBeenCalledWith('/termite/bait-vs-liquid/');
    expect(r.gaps).toEqual([]);
    // Same page before the fix → the live gaps, not the seeded ones.
    publisher.loadExistingPageBody.mockResolvedValue({ body: POOR.slice(FM().length), frontmatter: { title: 'Termite Bait vs. Liquid Treatment in Venice', post_type: 'diagnostic' } });
    expect((await seeder.rescanLive(opp, { publisher })).gaps).toEqual(['named_sources', 'concrete_specifics', 'comparison', 'how_to_choose']);
  });
  test('the live re-scan honours the seeded source_file extension', async () => {
    const publisher = { loadExistingPageBody: async () => ({ body: POOR.slice(FM().length), frontmatter: { title: 'Termite Bait vs. Liquid Treatment in Venice', post_type: 'diagnostic' } }) };
    const r = await seeder.rescanLive({ ...opp, signal_metadata: { source_file: 'src/content/blog/termite/bait-vs-liquid.md' } }, { publisher });
    expect(r.gaps).toEqual(['named_sources', 'concrete_specifics']);
  });
  test('unreadable page → null (caller keeps the seeded gaps)', async () => {
    expect(await seeder.rescanLive(opp, { publisher: { loadExistingPageBody: async () => null } })).toBeNull();
    expect(await seeder.rescanLive({ ...opp, page_url: null }, { publisher: { loadExistingPageBody: jest.fn() } })).toBeNull();
  });
});

describe('seedAll — gated, idempotent upsert', () => {
  test('dry-run scans without touching the DB or the gate', async () => {
    const r = await seeder.seedAll({ dryRun: true, corpus: corpus() });
    expect(r.dryRun).toBe(true);
    expect(r.count).toBe(2);
    expect(r.summary).toEqual({ scanned: 4, eligible: 2, days: 1 });
    expect(db.raw).not.toHaveBeenCalled();
    expect(isEnabled).not.toHaveBeenCalled();
  });
  test('refuses to write while GATE_CITABILITY_BACKFILL is off', async () => {
    isEnabled.mockReturnValueOnce(false);
    await expect(seeder.seedAll({ corpus: corpus() })).rejects.toThrow(/gated off/);
    expect(db.raw).not.toHaveBeenCalled();
  });
  test('live: one ON CONFLICT upsert per eligible row, keyed on citability:v1:<page_url>', async () => {
    const r = await seeder.seedAll({ corpus: corpus(), perDay: 5 });
    expect(r.count).toBe(2);
    expect(db.raw).toHaveBeenCalledTimes(2);
    const [sql, bindings] = db.raw.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO opportunity_queue/);
    expect(sql).toMatch(/ON CONFLICT \(dedupe_key\) DO UPDATE/);
    expect(sql).toMatch(/status IN \('claimed', 'done', 'pending_review'\)/);
    expect(bindings[0]).toBe('citability_backfill');
    expect(bindings[1]).toBe('refresh_existing_page');
    expect(bindings[13]).toBe('citability:v1:/termite/bait-vs-liquid/');
  });
});

describe('decision-router — citability_backfill is page-anchored', () => {
  const opp = { id: 'o1', bucket: 'citability_backfill', action_type: 'refresh_existing_page', page_url: '/termite/bait-vs-liquid/', query: null, score: 79, signal_metadata: { citability_gaps: ['named_sources'] } };
  test('keeps refresh_existing_page + page_type refresh even when the profiler recommends a blog', () => {
    const r = route(opp, { serp_profile: { dominant_intent: 'informational', dominant_page_type: 'blog', recommended_asset_type: 'new_supporting_blog', confidence: 0.9 } });
    expect(r.action_type).toBe('refresh_existing_page');
    expect(r.page_type).toBe('refresh');
    expect(r.router_notes).toMatch(/page-anchored bucket citability_backfill/);
  });
  test('page_type stays refresh without a SERP profile', () => {
    const r = route(opp, {});
    expect(r.action_type).toBe('refresh_existing_page');
    expect(r.page_type).toBe('refresh');
  });
});

describe('content-quality-gate — backfill evidence exemption + refresh nudges', () => {
  test('GSC evidence is waived only for a backfill brief that still carries its gap list', () => {
    const { checkGscSignalAttached, isCitabilityBackfillBrief } = gateInternals;
    const withGaps = { gsc_signal: { bucket: 'citability_backfill', citability_gaps: ['named_sources'] } };
    const lostGaps = { gsc_signal: { bucket: 'citability_backfill', citability_gaps: [] } };
    const spoofed = { gsc_signal: { bucket: 'decay_refresh', citability_gaps: ['named_sources'] } };
    expect(isCitabilityBackfillBrief(withGaps)).toBe(true);
    expect(checkGscSignalAttached({}, withGaps)).toEqual({ ok: true, reason: 'citability_backfill_scan_evidence' });
    expect(checkGscSignalAttached({}, lostGaps)).toEqual({ ok: false, reason: 'no_gsc_signal' });
    expect(checkGscSignalAttached({}, spoofed)).toEqual({ ok: false, reason: 'no_gsc_signal' });
  });
  test('SERP evidence is already satisfied: a backfill brief is page-only (no target_keyword)', () => {
    const { checkSerpBriefAttached } = gateInternals;
    expect(checkSerpBriefAttached({}, { target_url: '/termite/bait-vs-liquid/', target_keyword: null, gsc_signal: { bucket: 'citability_backfill', citability_gaps: ['comparison'] } })).toEqual({ ok: true, reason: 'serp_skip_page_only' });
  });
  test('refresh bundle carries the four nudges at weight 0; threshold unchanged at 47', () => {
    const names = gateInternals.PAGE_TYPE_CHECKS.refresh.filter((c) => c.name.startsWith('citability_'));
    expect(names.map((c) => c.name)).toEqual(['citability_named_sources', 'citability_concrete_specifics', 'citability_comparison', 'citability_how_to_choose']);
    for (const c of names) { expect(c.weight).toBe(0); expect(c.isHard).toBeFalsy(); }
    expect(gate.MIN_TOTAL_SCORES.refresh).toBe(47);
    expect(gate.MIN_TOTAL_SCORES['supporting-blog']).toBe(51);
  });
  test('nudges short-circuit on a non-blog refresh target and apply on a blog target', () => {
    const draft = { title: 'Bait vs. Liquid', body: 'Experts say things. Mow tall.', frontmatter: {} };
    for (const name of ['checkCitabilityNamedSources', 'checkCitabilityConcreteSpecifics', 'checkCitabilityComparison']) {
      expect(gateInternals[name](draft, { target_page_type: 'page' })).toEqual({ ok: true, reason: 'non_blog_target' });
      expect(gateInternals[name](draft, { target_page_type: 'supporting-blog' }).ok).toBe(false);
      expect(gateInternals[name](draft, {}).ok).toBe(false);
    }
  });
});

describe('brief-builder + refresh prompt parity', () => {
  test('every seeder gap id has a binding required_sections line', () => {
    const ids = seeder._internals.GAP_CHECKS.map(([id]) => id);
    expect(ids).toEqual(['named_sources', 'concrete_specifics', 'comparison', 'how_to_choose']);
    for (const id of ids) expect(typeof CITABILITY_GAP_SECTIONS[id]).toBe('string');
    expect(CITABILITY_GAP_SECTIONS.concrete_specifics).toMatch(/never a dollar amount/);
    expect(CITABILITY_GAP_SECTIONS.named_sources).toMatch(/never invent an agency/);
  });
  test('refresh agent carries a CITABILITY MODE keyed on gsc_signal.citability_gaps that names every gap id', () => {
    const system = REFRESH_AGENT_CONFIG.system;
    expect(system).toMatch(/CITABILITY MODE — active when the brief's gsc_signal\.citability_gaps/);
    for (const [id] of seeder._internals.GAP_CHECKS) expect(system).toMatch(new RegExp(`^- ${id}:`, 'm'));
    expect(system).toMatch(/NOT a quota and NEVER a\s+dollar amount/);
    expect(system).toMatch(/NEVER invent an agency, publication, program, or\s+business/);
    expect(system).toMatch(/NEVER a raw markdown pipe table/);
  });
});
