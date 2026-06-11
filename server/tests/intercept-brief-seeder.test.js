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
    const draft = { body: 'x' };
    const run = {};
    await runner._snapshotInterceptSources(opp, draft, run);

    expect(draft.source_snapshots).toEqual(snapshots);
    expect(run.draft_payload).toBe(draft);
    expect(where).toHaveBeenCalledWith('id', 'opp-1');
    const persisted = JSON.parse(update.mock.calls[0][0].signal_metadata);
    expect(persisted.intercept_snapshots).toEqual(snapshots);
  });
});
