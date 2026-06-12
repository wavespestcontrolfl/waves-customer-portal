/**
 * Competitor-intercept brief intake — seeder, window gating, router pinning,
 * quality-gate evidence exemptions, and archive.org snapshot fail-soft.
 *
 * The manifest (server/data/intercept-briefs-v1.json) is loaded for real so
 * the tests pin the actual operator payload (13 briefs, E1 absent); DB
 * access is mocked per existing idioms.
 */

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const db = require('../models/db');
const seeder = require('../services/content/intercept-brief-seeder');
const { route } = require('../services/content/decision-router');
const queue = require('../services/content/opportunity-queue');
const qualityInternals = require('../services/content/content-quality-gate')._internals;

const {
  scoreForBrief, serviceForBrief, dedupeKeyFor, availableAtFor, rowForBrief,
} = seeder._internals;

afterEach(() => jest.clearAllMocks());

// ── manifest + row shaping ───────────────────────────────────────────

describe('intercept manifest → opportunity rows', () => {
  const manifest = seeder.loadManifest();

  test('loads all 13 operator briefs and refuses E-cluster (door-to-door) entries', () => {
    expect(manifest.briefs).toHaveLength(13);
    expect(manifest.briefs.some((b) => String(b.id).toUpperCase().startsWith('E'))).toBe(false);
  });

  test('working titles fit under the 90-char hard publish cap', () => {
    // A1 shipped a 110-char working title; the writer trimmed it to 98,
    // which still hard-failed title-meta-spam-gate's 90-char cap and
    // terminally skipped the run (prod, 2026-06-12). The working title
    // is direction, not copy — but it must never START over the cap.
    for (const b of manifest.briefs) {
      expect(String(b.working_title).length).toBeLessThanOrEqual(90);
    }
  });

  test('scores follow the manifest priority order and clear the action floors', () => {
    const byId = Object.fromEntries(manifest.briefs.map((b) => [b.id, b]));
    expect(scoreForBrief(byId.A0)).toBe(88); // refresh — must clear the 75 non-blog floor
    expect(scoreForBrief(byId.A1)).toBe(88);
    expect(scoreForBrief(byId.B1)).toBe(86);
    expect(scoreForBrief(byId.B3)).toBe(84);
    expect(scoreForBrief(byId.C1)).toBe(82);
    expect(scoreForBrief(byId.D1)).toBe(82);
    expect(scoreForBrief(byId.F1)).toBe(82);
    for (const b of manifest.briefs) expect(scoreForBrief(b)).toBeGreaterThanOrEqual(82);
  });

  test('dedupe keys are stable and idempotent per brief id', () => {
    expect(dedupeKeyFor({ id: 'A1' })).toBe('intercept:v1:A1');
    const keys = manifest.briefs.map(dedupeKeyFor);
    expect(new Set(keys).size).toBe(13);
  });

  test('window "immediate" → available now; future windows gate availability', () => {
    expect(availableAtFor({ id: 'A1', window: 'immediate' })).toBeNull();
    const c1 = availableAtFor({ id: 'C1', window: '2026-07-01' });
    expect(c1).toBeInstanceOf(Date);
    // Midnight ET on 2026-07-01 (EDT = UTC-4).
    expect(c1.toISOString()).toBe('2026-07-01T04:00:00.000Z');
    expect(() => availableAtFor({ id: 'X', window: 'someday' })).toThrow(/unrecognized window/);
  });

  test('rows: pinned bucket, NULL city, truthful coarse service, payload in signal_metadata', () => {
    const now = new Date('2026-06-11T12:00:00Z');
    for (const brief of manifest.briefs) {
      const row = rowForBrief(brief, manifest, { now });
      expect(row.bucket).toBe('operator_intercept');
      expect(row.city).toBeNull(); // keeps the facts-sufficiency gate "not applicable"
      expect(['pest', 'lawn', 'termite']).toContain(row.service); // truthful slug-derived category
      expect(row.action_type).toBe(brief.action);
      expect(row.signal_metadata.operator_pinned).toBe(true);
      expect(row.signal_metadata.intercept_brief.id).toBe(brief.id);
      expect(row.signal_metadata.manifest_notes).toContain('archive.org snapshot');
      expect(row.signal_metadata.cta_codes.CALC).toBeTruthy();
      // expires_at always lands after the availability window opens.
      const availableMs = (row.available_at || now).getTime();
      expect(row.expires_at.getTime()).toBeGreaterThan(availableMs);
    }
  });

  test('lawn-slug briefs map to the lawn service; A0 refresh keeps its page_url', () => {
    const byId = Object.fromEntries(manifest.briefs.map((b) => [b.id, b]));
    expect(serviceForBrief(byId.B2)).toBe('lawn');
    expect(serviceForBrief(byId.D1)).toBe('lawn');
    // Termite-cluster posts are labeled truthfully — the operator FAQ
    // mandate flows through the explicit faq_required override, not a
    // service mislabel.
    expect(serviceForBrief(byId.C1)).toBe('termite');
    expect(serviceForBrief(byId.C2)).toBe('termite');
    expect(serviceForBrief(byId.F1)).toBe('termite');
    const a0 = rowForBrief(byId.A0, manifest, { now: new Date() });
    expect(a0.action_type).toBe('refresh_existing_page');
    expect(a0.page_url).toBe('https://www.wavespestcontrol.com/pest-control/in-wall-pest-control/');
  });
});

// ── seedAll idempotency ─────────────────────────────────────────────

describe('seedAll', () => {
  test('upserts every brief via ON CONFLICT (dedupe_key) DO UPDATE — re-runs cannot duplicate', async () => {
    db.raw.mockResolvedValue({ rowCount: 1 });

    const first = await seeder.seedAll({});
    const second = await seeder.seedAll({});

    expect(first.count).toBe(13);
    expect(second.count).toBe(13);
    expect(db.raw).toHaveBeenCalledTimes(26);

    const [sql, bindings] = db.raw.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO opportunity_queue/);
    expect(sql).toMatch(/ON CONFLICT \(dedupe_key\) DO UPDATE/);
    // Claimed / done / pending_review rows are never reset by a re-seed.
    expect(sql).toMatch(/status IN \('claimed', 'done', 'pending_review'\)\s+THEN opportunity_queue\.status/);
    // available_at is written and refreshed on conflict.
    expect(sql).toMatch(/available_at/);
    // Target columns follow manifest edits on re-seed too — the brief
    // builder reads opportunity.query/page_url/service for targeting.
    expect(sql).toMatch(/query = EXCLUDED\.query/);
    expect(sql).toMatch(/page_url = EXCLUDED\.page_url/);
    expect(sql).toMatch(/service = EXCLUDED\.service/);
    expect(bindings).toContain('intercept:v1:A0');

    // Same dedupe keys on both runs — idempotent by construction.
    const keysRun1 = db.raw.mock.calls.slice(0, 13).map((c) => c[1][13]);
    const keysRun2 = db.raw.mock.calls.slice(13).map((c) => c[1][13]);
    expect(keysRun1).toEqual(keysRun2);
    expect(new Set(keysRun1).size).toBe(13);
  });

  test('dry-run writes nothing', async () => {
    const result = await seeder.seedAll({ dryRun: true });
    expect(result.rows).toHaveLength(13);
    expect(db.raw).not.toHaveBeenCalled();
  });
});

// ── window gating at claim/peek ─────────────────────────────────────

function chainResolving(rows) {
  const q = {
    where: jest.fn(() => q),
    whereRaw: jest.fn(() => q),
    whereNull: jest.fn(() => q),
    orWhere: jest.fn(() => q),
    orderBy: jest.fn(() => q),
    limit: jest.fn(() => q),
    select: jest.fn(() => Promise.resolve(rows)),
    update: jest.fn(() => Promise.resolve(0)),
  };
  return q;
}

describe('availability window gating', () => {
  test('claimNext only claims rows whose available_at window has opened', async () => {
    db.mockImplementation(() => chainResolving([])); // recoverStaleClaims
    db.raw.mockResolvedValue({ rows: [] });

    await queue.claimNext({});

    const [sql] = db.raw.mock.calls[0];
    expect(sql).toMatch(/AND \(available_at IS NULL OR available_at <= now\(\)\)/);
  });

  test('peek applies the same availability window so previews match claims', async () => {
    const chain = chainResolving([]);
    db.mockImplementation(() => chain);

    await queue.peek({ limit: 5 });

    const rawClauses = chain.whereRaw.mock.calls.map((c) => c[0]);
    expect(rawClauses.some((c) => /available_at IS NULL OR available_at <= now\(\)/.test(c))).toBe(true);
  });
});

// ── decision-router operator pinning ────────────────────────────────

describe('decision-router operator pinning', () => {
  const interceptOpp = {
    id: 'opp-1',
    bucket: 'operator_intercept',
    action_type: 'new_supporting_blog',
    query: 'cancel trugreen',
    score: 84,
    signal_metadata: { operator_pinned: true, intercept_brief: { id: 'B2' } },
  };

  test('a navigational SERP profile cannot demote a pinned brief to do_not_publish', () => {
    const decision = route(interceptOpp, {
      serp_profile: { dominant_intent: 'navigational', dominant_page_type: 'home', recommended_asset_type: 'do_not_publish' },
    });
    expect(decision.action_type).toBe('new_supporting_blog');
    expect(decision.human_review_required).toBe(false);
    expect(decision.page_type).toBe('supporting-blog');
    expect(decision.final_score).toBe(84);
    expect(decision.router_notes).toMatch(/operator-pinned/);
  });

  test('profiler action recommendations and customer-demand rerouting are ignored', () => {
    const decision = route(interceptOpp, {
      serp_profile: { dominant_intent: 'informational', dominant_page_type: 'faq', recommended_asset_type: 'create_customer_question_page' },
      customer_signal: { total_count: 50, funnel_stage: 'pre-sale' },
      existing_brief_versions: 4, // even the loop guard must not park a pinned brief
    });
    expect(decision.action_type).toBe('new_supporting_blog');
    expect(decision.human_review_required).toBe(false);
  });

  test('A0 refresh action is pinned too', () => {
    const decision = route({ ...interceptOpp, action_type: 'refresh_existing_page', score: 88 }, {
      serp_profile: { dominant_intent: 'public-health', dominant_page_type: 'blog' },
    });
    expect(decision.action_type).toBe('refresh_existing_page');
    expect(decision.page_type).toBe('refresh');
    expect(decision.human_review_required).toBe(false);
  });

  test('non-pinned buckets keep the existing routing behavior', () => {
    const mined = { bucket: 'striking_distance', action_type: 'new_supporting_blog', score: 60, signal_metadata: {} };
    const decision = route(mined, {
      serp_profile: { dominant_intent: 'navigational', dominant_page_type: 'home' },
    });
    expect(decision.action_type).toBe('do_not_publish');
    expect(decision.human_review_required).toBe(true);
  });
});

// ── quality-gate evidence exemptions ────────────────────────────────

describe('content-quality-gate operator-brief evidence exemptions', () => {
  const { checkSerpBriefAttached, checkGscSignalAttached } = qualityInternals;
  const operatorBrief = {
    target_keyword: 'cancel trugreen',
    serp_signal: {},
    gsc_signal: { bucket: 'operator_intercept', impressions: null },
  };

  test('serp/gsc evidence checks pass for operator-authored briefs', () => {
    expect(checkSerpBriefAttached({}, operatorBrief)).toEqual({ ok: true, reason: 'operator_authored_brief' });
    expect(checkGscSignalAttached({}, operatorBrief)).toEqual({ ok: true, reason: 'operator_authored_brief' });
  });

  test('mined briefs still hard-fail without evidence', () => {
    const mined = { target_keyword: 'kw', serp_signal: {}, gsc_signal: { bucket: 'striking_distance', impressions: null } };
    expect(checkSerpBriefAttached({}, mined).ok).toBe(false);
    expect(checkGscSignalAttached({}, mined).ok).toBe(false);
  });
});

// ── operator FAQ mandate — narrow exception, full enforcement elsewhere ─

describe('operator FAQ mandate (termite-cluster intercept briefs)', () => {
  const contentGuardrails = require('../services/content/content-guardrails');
  const faqDraft = { body: '## Frequently Asked Questions\n### Does a bond cover old damage?\nIt depends on the bond.' };

  test('guardrails: operatorFaqException skips the FAQ_BLOCKED_SERVICE P0 (and nothing else)', () => {
    const blocked = contentGuardrails.evaluate(faqDraft, { service: 'termite' });
    expect(blocked.pass).toBe(false);
    expect(blocked.findings.some((f) => f.code === 'FAQ_BLOCKED_SERVICE')).toBe(true);

    const excepted = contentGuardrails.evaluate(faqDraft, { service: 'termite', operatorFaqException: true });
    expect(excepted.pass).toBe(true);
    expect(excepted.findings.some((f) => f.code === 'FAQ_BLOCKED_SERVICE')).toBe(false);

    // The exception is FAQ-scoped only: a hardcoded price still P0s.
    // (No calculator/estimate/depends framing near the price.)
    const priced = contentGuardrails.evaluate(
      { body: '## Frequently Asked Questions\n### Does a bond cover old damage?\nRead the bond terms first.\nOnly $89 per month for protection.' },
      { service: 'termite', operatorFaqException: true },
    );
    expect(priced.pass).toBe(false);
    expect(priced.findings.some((f) => f.code === 'HARDCODED_PRICE')).toBe(true);
  });

  test('quality gate: FAQ presence on a mandated intercept brief is scored normally, not failed', () => {
    const { checkFaqSectionPresent } = qualityInternals;
    const mandatedBrief = {
      service: 'termite',
      gsc_signal: { bucket: 'operator_intercept' },
      voice_constraints: { operator_brief: { faq_required: true } },
    };
    expect(checkFaqSectionPresent(faqDraft, mandatedBrief)).toEqual({ ok: true });
    // Without the mandate, the blocked-topic policy still fails a present FAQ.
    const minedBrief = { service: 'termite', gsc_signal: { bucket: 'decay_refresh' }, voice_constraints: {} };
    expect(checkFaqSectionPresent(faqDraft, minedBrief).ok).toBe(false);
  });

  test('seo-completion gate: faqRequired stays TRUE for mandated intercept briefs (missing FAQ still P1s)', () => {
    const { faqRequired } = require('../services/content/seo-completion-gate')._internals;
    const base = {
      service: 'termite',
      required_sections: ['FAQ block (5–7 Qs)'],
    };
    expect(faqRequired({ ...base, voice_constraints: { operator_brief: { faq_required: true } } })).toBe(true);
    expect(faqRequired(base)).toBe(false); // blocked topic without the mandate
  });
});

// ── competitor pricing framing — instruction ↔ price-guard compatibility ─

describe('competitor pricing framing rule', () => {
  test('the prescribed framing passes both price guards; a bare dollar figure still fails', () => {
    const guardrailInternals = require('../services/content/content-guardrails')._internals;
    const { detectHardcodedPrice } = require('../services/content/seo-completion-gate')._internals;

    // The example sentence from the binding instruction — must satisfy the
    // exact allowance-word window both guards share, or the manifest's
    // required dollar figures and the P0 price guard are incompatible.
    const framed = "Aptive's early-cancellation fee is $199 as of June 2026 per ConsumerAffairs, though quoted pricing varies by contract.";
    expect(guardrailInternals.priceFinding(framed)).toBeNull();
    expect(detectHardcodedPrice(framed)).toBe(false);

    const bare = 'The early-cancellation fee is $199 and the monthly cost is $49.';
    expect(guardrailInternals.priceFinding(bare)).not.toBeNull();
    expect(detectHardcodedPrice(bare)).toBe(true);
  });
});

// ── archive.org snapshots — fail-soft ───────────────────────────────

describe('snapshotSources', () => {
  test('captures via the save API and records per-URL results', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://web.archive.org/web/20260611000000/https://pestdefense.com/taexx/',
      headers: { get: (h) => (h === 'content-location' ? '/web/20260611000000/https://pestdefense.com/taexx/' : null) },
    });
    const result = await seeder.snapshotSources(['https://pestdefense.com/taexx/'], { fetchImpl });
    expect(result.attempted).toBe(1);
    expect(result.ok).toBe(1);
    expect(result.snapshots[0].snapshot_url).toBe('https://web.archive.org/web/20260611000000/https://pestdefense.com/taexx/');
    expect(fetchImpl).toHaveBeenCalledWith('https://web.archive.org/save/https://pestdefense.com/taexx/', expect.any(Object));
  });

  test('NEVER throws: fetch failures are recorded per entry', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('wayback down'));
    const result = await seeder.snapshotSources(['https://pestdefense.com/taexx/', 'https://example.com/x/'], { fetchImpl });
    expect(result.attempted).toBe(2);
    expect(result.ok).toBe(0);
    expect(result.snapshots.every((s) => s.error === 'wayback down' && s.snapshot_url === null)).toBe(true);
  });

  test('non-URL source notes (e.g. "UF/IFAS for pre-treat claims") are skipped', async () => {
    const fetchImpl = jest.fn();
    const result = await seeder.snapshotSources(['UF/IFAS for pre-treat longevity claims (cite specific IFAS pages)'], { fetchImpl });
    expect(result.attempted).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('empty/missing sources resolve cleanly', async () => {
    await expect(seeder.snapshotSources(null)).resolves.toEqual({ attempted: 0, ok: 0, snapshots: [] });
  });
});

// ── operator slug pin — machine-checked, not just prompt-binding ────

describe('operatorSlugMismatch', () => {
  const { operatorSlugMismatch } = require('../services/content/autonomous-runner')._internals;
  const briefFor = (slug) => ({ voice_constraints: { operator_brief: { slug } } });

  test('matching slugs (incl. slash/case normalization) pass', () => {
    expect(operatorSlugMismatch(briefFor('/pest-control/can-another-company-service-taexx/'), {
      frontmatter: { slug: '/pest-control/can-another-company-service-taexx/' },
    })).toBeNull();
    expect(operatorSlugMismatch(briefFor('/pest-control/x/'), {
      frontmatter: { slug: 'pest-control/X' },
    })).toBeNull();
  });

  test('a drifted or missing draft slug is reported for review parking', () => {
    expect(operatorSlugMismatch(briefFor('/pest-control/a/'), { frontmatter: { slug: '/pest-control/b/' } }))
      .toEqual({ expected_slug: '/pest-control/a/', draft_slug: '/pest-control/b/' });
    expect(operatorSlugMismatch(briefFor('/pest-control/a/'), { frontmatter: {} }))
      .toEqual({ expected_slug: '/pest-control/a/', draft_slug: null });
  });

  test('briefs without an operator slug (refresh / mined) skip the check', () => {
    expect(operatorSlugMismatch(briefFor(null), { frontmatter: { slug: '/anything/' } })).toBeNull();
    expect(operatorSlugMismatch({ voice_constraints: {} }, { frontmatter: { slug: '/anything/' } })).toBeNull();
  });
});

// ── draft-cited external URLs feed the snapshotter ──────────────────

describe('externalUrlsFromMarkdown', () => {
  test('extracts external citation links, skipping own-domain/archive links and duplicates', () => {
    const body = [
      'Per [Orkin\'s terms](https://www.orkin.com/terms/), pricing is quote-based.',
      'See our [termite page](/termite/termite-bond/) and [calculator](https://www.wavespestcontrol.com/pest-control-calculator/).',
      'Snapshot: [archived](https://web.archive.org/web/2026/https://www.orkin.com/terms/).',
      'Again [Orkin terms](https://www.orkin.com/terms/) and [IFAS](https://edis.ifas.ufl.edu/IG098).',
    ].join('\n');
    expect(seeder.externalUrlsFromMarkdown(body)).toEqual([
      'https://www.orkin.com/terms/',
      'https://edis.ifas.ufl.edu/IG098',
    ]);
  });

  test('caps the number of extracted URLs', () => {
    const body = Array.from({ length: 20 }, (_, i) => `[s${i}](https://example.com/p${i}/)`).join(' ');
    expect(seeder.externalUrlsFromMarkdown(body, { limit: 5 })).toHaveLength(5);
  });
});

// ── runner snapshot integration — fail-soft ─────────────────────────

describe('autonomous-runner._snapshotInterceptSources', () => {
  const runner = require('../services/content/autonomous-runner');

  test('non-intercept opportunities are a no-op', async () => {
    await runner._snapshotInterceptSources({ bucket: 'striking_distance' }, {}, {});
    expect(db).not.toHaveBeenCalled();
  });

  test('a seeder failure never throws into the publish path', async () => {
    jest.spyOn(seeder, 'snapshotSources').mockRejectedValueOnce(new Error('boom'));
    const opp = {
      id: 'opp-1',
      bucket: 'operator_intercept',
      signal_metadata: { intercept_brief: { sources: ['https://example.com/a/'] } },
    };
    await expect(runner._snapshotInterceptSources(opp, {}, {})).resolves.toBeUndefined();
  });

  test('snapshots land on the draft payload and the opportunity row', async () => {
    const snapshots = [{ url: 'https://example.com/a/', snapshot_url: 'https://web.archive.org/web/2026/https://example.com/a/', ok: true }];
    jest.spyOn(seeder, 'snapshotSources').mockResolvedValueOnce({ attempted: 1, ok: 1, snapshots });
    const update = jest.fn(() => Promise.resolve(1));
    const where = jest.fn(() => ({ update }));
    db.mockImplementation(() => ({ where }));

    const opp = {
      id: 'opp-1',
      bucket: 'operator_intercept',
      signal_metadata: { intercept_brief: { sources: ['https://example.com/a/'] } },
    };
    // The draft cites a live URL the manifest only described — the runner
    // must snapshot the union of manifest sources + body citations.
    const draft = { body: 'Per [Orkin terms](https://www.orkin.com/terms/), pricing is quote-based.' };
    const run = {};
    await runner._snapshotInterceptSources(opp, draft, run);

    expect(seeder.snapshotSources).toHaveBeenCalledWith([
      'https://example.com/a/',
      'https://www.orkin.com/terms/',
    ]);
    expect(draft.source_snapshots).toEqual(snapshots);
    expect(run.draft_payload).toBe(draft);
    expect(where).toHaveBeenCalledWith('id', 'opp-1');
    const persisted = JSON.parse(update.mock.calls[0][0].signal_metadata);
    expect(persisted.intercept_snapshots).toEqual(snapshots);
  });
});

// ── manifest source contract: URLs (snapshot targets) vs directives ─

describe('splitBriefSources — sources are URLs, directives are source_notes', () => {
  const { splitBriefSources } = seeder._internals;
  const logger = require('../services/logger');

  test('URLs stay in urls; existing source_notes ride through as notes, no warning', () => {
    const { urls, notes } = splitBriefSources({
      id: 'B4',
      sources: ['https://example.com/a/', 'https://example.com/b/'],
      source_notes: ['Orkin published terms/plan pages (pull + snapshot at draft)'],
    });
    expect(urls).toEqual(['https://example.com/a/', 'https://example.com/b/']);
    expect(notes).toEqual(['Orkin published terms/plan pages (pull + snapshot at draft)']);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('a non-URL string in sources is demoted to notes with a warning — never silently dropped', () => {
    const { urls, notes } = splitBriefSources({
      id: 'D1',
      sources: ['https://example.com/a/', 'county ordinance pages for blackout dates'],
      source_notes: ['UF/IFAS for agronomic claims'],
    });
    expect(urls).toEqual(['https://example.com/a/']);
    expect(notes).toEqual(['UF/IFAS for agronomic claims', 'county ordinance pages for blackout dates']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('demoted to source_notes'));
  });

  test('manifest as shipped: every brief splits to URL-only sources (snapshot-safe)', () => {
    const manifest = seeder.loadManifest();
    for (const brief of manifest.briefs) {
      const { urls } = splitBriefSources(brief);
      for (const u of urls) expect(u).toMatch(/^https?:\/\//);
    }
  });
});

describe('sourcing directives reach the writer (the snapshot step never archives a sentence)', () => {
  test('B4: source_notes flow into operator_brief + a binding SOURCING DIRECTIVES line', () => {
    const manifest = seeder.loadManifest();
    const byId = Object.fromEntries(manifest.briefs.map((b) => [b.id, b]));
    const overlay = seeder.buildOperatorOverlay({
      opportunity: { signal_metadata: { intercept_brief: byId.B4 } },
      pageType: 'supporting-blog',
    });
    const op = overlay.operator_brief;

    expect(op.source_notes.length).toBeGreaterThan(0);
    expect(op.required_sources.every((u) => /^https?:\/\//.test(u))).toBe(true);

    const joined = op.binding_instructions.join('\n');
    expect(joined).toMatch(/SOURCING DIRECTIVES \(binding\):/);
    expect(joined).toContain('Orkin published terms/plan pages');
    // The must-link REQUIRED SOURCES list never contains a directive sentence.
    const requiredLine = op.binding_instructions.find((l) => /REQUIRED SOURCES/.test(l)) || '';
    expect(requiredLine).not.toContain('Orkin published terms');
  });
});
