/**
 * Citability backfill seeder (2026-09-25 owner directive, re-cut 09-29 from
 * #4845): corpus scan with the quality gate's own four signals → paced,
 * page-anchored refresh rows, plus the consumer parity checks (brief
 * sections, evidence exemption, completion check, CITABILITY MODE). The lane
 * stays gated off.
 */

jest.mock('../models/db', () => {
  const fn = jest.fn(() => {
    const query = { whereIn: () => query, where: () => query, whereRaw: () => query, first: async () => null };
    return query;
  });
  fn.raw = jest.fn(async () => ({ rowCount: 1 }));
  fn.transaction = jest.fn(async (work) => work(fn));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true), gates: {} }));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const seeder = require('../services/content/citability-backfill-seeder');

const { serviceForPost, specialtyTopicForPost, rowForPost, dedupeKeyFor, availableAtFor, BASE_SCORE } = seeder._internals;

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
  test('visible prose cannot make hidden inline attribution clear the source gap', () => {
    const result = seeder.scanPost({ url: '/pest-control/ants/', body: 'Ants trail. <!-- Per UF/IFAS, ants trail. -->' });
    expect(result.gaps).toContain('named_sources');
  });
  test('a poor post reports every applicable gap; a good one reports none', () => {
    const poor = seeder.scanPost({ url: '/termite/bait-vs-liquid/', body: POOR });
    // The title frames a choice ("Bait vs. Liquid"), so the gate applies
    // how_to_choose directly, table or not.
    expect(poor.gaps).toEqual(['named_sources', 'concrete_specifics', 'comparison', 'how_to_choose']);
    expect(poor.results.how_to_choose).toEqual({ ok: false, reason: 'no_how_to_choose_section' });
    const good = seeder.scanPost({ url: '/termite/bait-vs-liquid-good/', body: GOOD });
    expect(good.gaps).toEqual([]);
  });
  test('a legacy .md post never gets a comparison gap (no MDX components on refresh; Codex P2)', () => {
    const md = seeder.scanPost({ url: '/termite/bait-vs-liquid/', file: 'src/content/blog/termite/bait-vs-liquid.md', body: POOR });
    // A How-to-choose H2 with a list is plain markdown, so that gap still applies.
    expect(md.gaps).toEqual(['named_sources', 'concrete_specifics', 'how_to_choose']);
    expect(md.results.comparison).toEqual({ ok: true, reason: 'markdown_only_post_cannot_carry_ComparisonTable' });
    const mdx = seeder.scanPost({ url: '/termite/bait-vs-liquid/', file: 'src/content/blog/termite/bait-vs-liquid.mdx', body: POOR });
    expect(mdx.gaps).toContain('comparison');
  });
  test('a post with a good how-to-choose section but no table plans only the table', () => {
    const body = FM() + `## What homeowners see
Per UF/IFAS, subterranean termites swarm after rain when soil stays above 70 degrees for 3 days.

## How to choose between bait and liquid
- If you see mud tubes on the slab → liquid.
- If the slab is hard to drill → bait.
- If a home sale needs a WDO clearance soon → liquid.
`;
    const r = seeder.scanPost({ url: '/termite/bait-vs-liquid/', file: 'src/content/blog/termite/bait-vs-liquid.mdx', body });
    expect(r.gaps).toEqual(['comparison']);
    expect(r.results.how_to_choose).toEqual({ ok: true, reason: null });
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
    // Broad pest-control category: a specific related service wins (Codex r6 P2).
    expect(serviceForPost({ category: 'pest-control', related_services: ['rodent-control-venice-fl'] })).toBe('rodent');
    expect(serviceForPost({ category: 'pest-control', related_services: ['pest-control-venice-fl'] })).toBe('pest');
    expect(serviceForPost({ category: 'lawn-care', related_services: ['termite-control-venice-fl'] })).toBe('lawn');
  });
  test('specialtyTopicForPost tags the FAQ-blocked topic the coarse service hides', () => {
    expect(specialtyTopicForPost({ title: 'Bed Bugs in Sarasota Condos', category: 'pest-control' }, '/pest-control/bed-bugs-sarasota/')).toBe('bed-bug');
    expect(specialtyTopicForPost({ title: 'Do Mud Daubers Sting?' }, '/pest-control/mud-daubers/')).toBe('wasp');
    expect(specialtyTopicForPost({ title: 'Ghost Ants After Rain' }, '/pest-control/ghost-ants/')).toBeNull();
    const row = rowForPost({ url: '/pest-control/mud-daubers/' }, { gaps: ['named_sources'], results: {}, frontmatter: { title: 'Do Mud Daubers Sting?' }, title: 'Do Mud Daubers Sting?' }, { now: new Date('2026-09-26T12:00:00Z') });
    expect(row.signal_metadata.specialty_topic).toBe('wasp');
  });
});

describe('rowForPost / planRows — page-anchored refresh rows, paced per ET day', () => {
  const now = new Date('2026-09-25T15:00:00Z');
  test('row shape: refresh_existing_page, query NULL, city NULL, score on the 75 refresh floor, scan in signal_metadata', () => {
    const scan = seeder.scanPost({ url: '/termite/bait-vs-liquid/', body: POOR });
    const row = rowForPost({ url: '/termite/bait-vs-liquid/', file: 'src/content/blog/termite/bait-vs-liquid.mdx' }, scan, { now });
    expect(row.bucket).toBe('citability_backfill');
    expect(row.action_type).toBe('refresh_existing_page');
    expect(row.query).toBeNull();
    expect(row.city).toBeNull();
    expect(row.service).toBe('termite');
    expect(row.page_url).toBe('https://www.wavespestcontrol.com/termite/bait-vs-liquid/');
    // Exactly the floor: claimable, but never ahead of mined work (Codex r2 P2).
    expect(row.score).toBe(BASE_SCORE);
    expect(row.score).toBe(require('../services/content/scoring-config').THRESHOLDS.minScoreToAct);
    expect(row.score_breakdown).toEqual({ base: BASE_SCORE, citability_gaps: 4 });
    expect(row.signal_metadata.citability_gaps).toEqual(['named_sources', 'concrete_specifics', 'comparison', 'how_to_choose']);
    expect(row.signal_metadata.source).toBe('citability-backfill-seeder');
    expect(row.dedupe_key).toBe('citability:v1:/termite/bait-vs-liquid/');
    expect(row.available_at).toBeNull();
    expect(row.expires_at.getTime()).toBe(now.getTime() + 45 * 86400_000);
  });
  test('long URLs fit the DB dedupe limit without colliding on a shared prefix', () => {
    const prefix = `/pest-control/${'long-blog-slug-'.repeat(20)}`;
    const first = dedupeKeyFor(`${prefix}one/`);
    const second = dedupeKeyFor(`${prefix}two/`);
    expect(first).toHaveLength(200);
    expect(second).toHaveLength(200);
    expect(first).not.toBe(second);
    expect(dedupeKeyFor('/pest-control/ants/')).toBe('citability:v1:/pest-control/ants/');
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
    expect(rows.map((r) => new URL(r.page_url).pathname)).toEqual(['/termite/bait-vs-liquid/', '/pest-control/mud-daubers/']);
    expect(rows[0].available_at).toBeNull();
    expect(rows[1].available_at.toISOString()).toBe('2026-09-26T04:00:00.000Z');
    expect(seeder.planRows(corpus(), { now, minGaps: 3 }).map((r) => new URL(r.page_url).pathname)).toEqual(['/termite/bait-vs-liquid/']);
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
    expect(seeder.planRows(posts, { now, minGaps: 1 }).map((r) => new URL(r.page_url).pathname)).toEqual(['/termite/ok/']);
  });
});

describe('rescanLive — stale seeded rows are re-checked before drafting (Codex P2)', () => {
  const opp = { id: 1, bucket: 'citability_backfill', page_url: '/termite/bait-vs-liquid/' };
  test('returns the live page gaps (frontmatter + body from the publisher)', async () => {
    const publisher = { loadExistingPageBody: jest.fn().mockResolvedValue({ source_file: 'src/content/blog/termite/bait-vs-liquid.mdx', body: GOOD.slice(FM().length), frontmatter: { title: 'Termite Bait vs. Liquid Treatment in Venice', post_type: 'diagnostic' } }) };
    const r = await seeder.rescanLive(opp, { publisher });
    expect(publisher.loadExistingPageBody).toHaveBeenCalledWith('/termite/bait-vs-liquid/');
    expect(r.gaps).toEqual([]);
    // Same page before the fix → the live gaps, not the seeded ones.
    publisher.loadExistingPageBody.mockResolvedValue({ source_file: 'src/content/blog/termite/bait-vs-liquid.mdx', body: POOR.slice(FM().length), frontmatter: { title: 'Termite Bait vs. Liquid Treatment in Venice', post_type: 'diagnostic' } });
    expect((await seeder.rescanLive(opp, { publisher })).gaps).toEqual(['named_sources', 'concrete_specifics', 'comparison', 'how_to_choose']);
  });
  test.each([['mdx', 'md', false], ['md', 'mdx', true]])('a %s to %s migration uses the current file format', async (oldExtension, extension, supportsComparison) => {
    const publisher = { loadExistingPageBody: async () => ({ source_file: `src/content/blog/termite/bait-vs-liquid.${extension}`, body: POOR.slice(FM().length), frontmatter: { title: 'Termite Bait vs. Liquid Treatment in Venice', post_type: 'diagnostic' } }) };
    const r = await seeder.rescanLive({ ...opp, signal_metadata: { source_file: `src/content/blog/termite/bait-vs-liquid.${oldExtension}` } }, { publisher });
    expect(r.gaps.includes('comparison')).toBe(supportsComparison);
  });
  test('a post that turned non-indexable while queued resolves as ineligible (Codex r7 P2)', async () => {
    for (const frontmatter of [{ robots: 'noindex' }, { domains: ['some-spoke-domain.com'] }, { canonical: 'https://some-spoke-domain.com/x/' }, { canonical: '/termite/other/' }]) {
      const publisher = { loadExistingPageBody: async () => ({ body: POOR.slice(FM().length), frontmatter: { title: 'T', ...frontmatter } }) };
      expect(await seeder.rescanLive(opp, { publisher })).toEqual({ gaps: [], results: {}, ineligible: true });
    }
  });
  test('re-derives the topic from the live frontmatter (Codex P2, 2026-09-27)', async () => {
    const publisher = { loadExistingPageBody: async () => ({ source_file: 'src/content/blog/pest/ghost.mdx', body: POOR.slice(FM().length), frontmatter: { title: 'Bed Bugs After Travel', category: 'pest-control', related_services: ['bed-bug-treatment'] } }) };
    const r = await seeder.rescanLive({ ...opp, page_url: '/pest/ghost/', service: 'pest', signal_metadata: { specialty_topic: null } }, { publisher });
    expect(r).toMatchObject({ service: seeder._internals.serviceForPost({ category: 'pest-control', related_services: ['bed-bug-treatment'] }), specialty_topic: 'bed-bug' });
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
    expect(db.transaction).toHaveBeenCalledTimes(2);
    const inserts = db.raw.mock.calls.filter(([sql]) => sql.includes('INSERT INTO'));
    expect(inserts).toHaveLength(2);
    const [sql, bindings] = inserts[0];
    expect(sql).toMatch(/INSERT INTO opportunity_queue/);
    expect(sql).toMatch(/ON CONFLICT \(dedupe_key\) DO UPDATE/);
    expect(sql).toMatch(/status IN \('claimed', 'done', 'pending_review'\)/);
    expect(sql).toContain("WHERE NOT jsonb_exists(COALESCE(opportunity_queue.signal_metadata, '{}'::jsonb), 'page_edit_superseded')");
    // A done row is left untouched and uncounted on a re-run (Codex r2 P2).
    expect(sql).toMatch(/AND opportunity_queue\.status <> 'done'/);
    expect(bindings[0]).toBe('citability_backfill');
    expect(bindings[1]).toBe('refresh_existing_page');
    expect(bindings[13]).toBe('citability:v1:/termite/bait-vs-liquid/');
  });
  test.each(['pending', 'claimed', 'pending_review'])('an existing %s page edit prevents a competing seed under the shared lock', async (status) => {
    const refreshAudit = require('../services/seo/refresh-audit');
    const check = jest.spyOn(refreshAudit, 'findInflightPageEdit').mockResolvedValue({ status, dedupe_key: 'other-bucket' });
    try {
      const r = await seeder.seedAll({ corpus: corpus() });
      expect(r.count).toBe(0);
      expect(db.raw.mock.calls.every(([sql]) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
      expect(check).toHaveBeenCalledWith(db, { path: '/termite/bait-vs-liquid', targetDomain: 'wavespestcontrol.com' });
    } finally { check.mockRestore(); }
  });
  test.each(['pending', 'claimed', 'pending_review'])('normalizes a legacy %s seed without replacing its claim or scan', async (status) => {
    const refreshAudit = require('../services/seo/refresh-audit');
    const row = { id: 'existing-seed', bucket: 'citability_backfill', status, page_url: '/termite/bait-vs-liquid/', dedupe_key: 'citability:v1:/termite/bait-vs-liquid/' };
    const check = jest.spyOn(refreshAudit, 'findInflightPageEdit').mockResolvedValue(row);
    const update = jest.fn().mockResolvedValue(1);
    const where = jest.fn(() => ({ update }));
    db.mockImplementationOnce(() => ({ where }));
    try {
      const r = await seeder.seedAll({ corpus: [corpus()[0]] });
      expect(r.count).toBe(0);
      expect(where).toHaveBeenCalledWith({ id: 'existing-seed' });
      expect(update).toHaveBeenCalledWith({ page_url: 'https://www.wavespestcontrol.com/termite/bait-vs-liquid/' });
    } finally { check.mockRestore(); }
  });
});

describe('consumer parity — every seeder gap id is consumed', () => {
  const { CITABILITY_GAP_SECTIONS } = require('../services/content/content-brief-builder')._internals;
  const { REFRESH_AGENT_CONFIG } = require('../services/content/agents/refresh-agent-config');
  const { GATE_RETRY_INSTRUCTIONS } = require('../services/content/gate-retry-directives');
  const gateInternals = require('../services/content/content-quality-gate')._internals;
  const ids = seeder._internals.GAP_CHECKS.map(([id]) => id);

  test('every seeder gap id has a binding required_sections line naming its guidance code', () => {
    expect(ids).toEqual(['named_sources', 'concrete_specifics', 'comparison', 'how_to_choose']);
    expect(Object.keys(CITABILITY_GAP_SECTIONS).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(CITABILITY_GAP_SECTIONS[id]).toContain(`[CITABILITY_${id.toUpperCase()}]`);
      expect(GATE_RETRY_INSTRUCTIONS[`CITABILITY_${id.toUpperCase()}`]).toEqual(expect.any(String));
    }
    expect(CITABILITY_GAP_SECTIONS.concrete_specifics).toMatch(/never a dollar amount/);
    expect(CITABILITY_GAP_SECTIONS.named_sources).toMatch(/never invent an agency/);
  });

  test('refresh agent CITABILITY MODE is keyed on gsc_signal.citability_gaps and names every gap id', () => {
    const system = REFRESH_AGENT_CONFIG.system;
    expect(system).toMatch(/CITABILITY MODE — active when the brief's gsc_signal\.citability_gaps/);
    for (const id of ids) expect(system).toMatch(new RegExp(`^- ${id}:`, 'm'));
    expect(system).toMatch(/NO\s+padding/);
    expect(system).toMatch(/NOT a quota and NEVER a\s+dollar amount/);
    expect(system).toMatch(/NEVER invent\s+an agency, publication, program, or business/);
    expect(system).toMatch(/NEVER a raw markdown pipe\s+table/);
    expect(system).toMatch(/Never on a \.md target/);
    expect(system).toMatch(/INFORMATIONAL\s+TOPIC/);
  });

  test('every gap id has a completion evaluator in the quality gate', () => {
    for (const id of ids) {
      const r = gateInternals.checkCitabilityBackfillGapsCleared(
        { title: 'Bait or spray?', body: '## Bait or spray?\nExperts say to water deeply.' },
        { target_page_type: 'blog', gsc_signal: { bucket: 'citability_backfill', citability_gaps: [id] } },
        {},
      );
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(new RegExp(`^planned_gaps_unresolved:${id}\\(`));
    }
  });

  test('GSC evidence is waived only for a backfill brief that still carries its gap list; SERP is page-only', () => {
    const { checkGscSignalAttached, checkSerpBriefAttached } = gateInternals;
    expect(checkGscSignalAttached({}, { gsc_signal: { bucket: 'citability_backfill', citability_gaps: ['named_sources'] } }))
      .toEqual({ ok: true, reason: 'citability_backfill_scan_evidence' });
    expect(checkGscSignalAttached({}, { gsc_signal: { bucket: 'citability_backfill', citability_gaps: [] } }))
      .toEqual({ ok: false, reason: 'no_gsc_signal' });
    expect(checkGscSignalAttached({}, { gsc_signal: { bucket: 'decay_refresh', citability_gaps: ['named_sources'] } }))
      .toEqual({ ok: false, reason: 'no_gsc_signal' });
    expect(checkSerpBriefAttached({}, { target_url: '/termite/x/', target_keyword: null, gsc_signal: { bucket: 'citability_backfill', citability_gaps: ['comparison'] } }))
      .toEqual({ ok: true, reason: 'serp_skip_page_only' });
  });
});
