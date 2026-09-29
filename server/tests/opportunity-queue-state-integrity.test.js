/**
 * Queue/state-integrity lane of the blog-engine audit:
 *
 *   - the miner's ON CONFLICT upsert must keep 'skipped' STICKY (operator
 *     dismissals and closed-PR skips came back every morning and burned a
 *     runner dispatch) while still reviving 'expired' rows (a re-mined
 *     signal is a fresh opportunity),
 *   - claimNext enforces a lifetime claim budget (attempt_count) so a
 *     permanently failing top-scored row stops being re-claimed daily, and
 *     sweepExhaustedAttempts converts exhausted pendings to a VISIBLE
 *     skipped/attempts_exhausted,
 *   - recoverStaleClaims must NOT bounce a named-competitor APPROVAL claim
 *     back to pending (the publish may already exist externally) — that
 *     state belongs to the runner's janitor, which parks both records at
 *     'named_competitor_publish_interrupted' for human reconciliation.
 */

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn();
  // claimNext runs its lock + claim in one transaction; the trx is the db.
  fn.transaction = jest.fn((cb) => cb(fn));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const queue = require('../services/content/opportunity-queue');

function chain(overrides = {}) {
  const q = {
    _filters: [],
    where: jest.fn(function (...args) { q._filters.push(args); return q; }),
    whereRaw: jest.fn(function (...args) { q._filters.push(['raw', ...args]); return q; }),
    update: jest.fn(() => Promise.resolve(overrides.updateResult ?? 0)),
    ...overrides,
  };
  return q;
}

function rawCallContaining(fragment) {
  return db.raw.mock.calls.find(([sql]) => String(sql).includes(fragment));
}

afterEach(() => {
  jest.clearAllMocks();
  delete process.env.AUTONOMOUS_OPP_MAX_ATTEMPTS;
});

describe('miner upsert: skipped is sticky, expired revives', () => {
  const miner = require('../services/seo/gsc-opportunity-miner');
  const competitorMiner = require('../services/seo/competitor-gap-miner');

  test('the status CASE preserves skipped alongside claimed/done/pending_review — and NOT expired', async () => {
    db.raw.mockResolvedValue({ rowCount: 1 });
    await miner.persistAll([{
      bucket: 'seasonal_rising', action_type: 'new_supporting_blog',
      query: 'termite swarm season', page_url: null, service: 'termite', city: null,
      score: 80, score_breakdown: {}, signal_metadata: {}, dedupe_key: 'k1',
    }]);

    const [sql] = db.raw.mock.calls[0];
    // Frozen statuses now skip the conflict-update ENTIRELY (DO UPDATE ...
    // WHERE) rather than being preserved field-by-field in a status CASE —
    // skipped stays just as sticky, and identity/score/metadata can no
    // longer be rewritten beneath a claimed worker or a processed record.
    const guard = sql.match(/DO UPDATE[\s\S]*WHERE opportunity_queue\.status NOT IN \(([^)]+)\)/);
    expect(guard).toBeTruthy();
    expect(guard[1]).toContain("'skipped'");
    expect(guard[1]).toContain("'claimed'");
    expect(guard[1]).toContain("'done'");
    expect(guard[1]).toContain("'pending_review'");
    // expired must revive to pending on a fresh mine of the same signal
    expect(guard[1]).not.toContain("'expired'");
    expect(sql).toMatch(/status = 'pending'/);
    // ...and a revived row clears its automatic retirement reason — a
    // lingering family_* skip_reason on a pending row reads as false
    // provenance on operator/audit surfaces (Codex r12 P2).
    expect(sql).toMatch(/skip_reason = NULL/);
  });

  test('the metadata refresh preserves both bounded runner retry markers across the morning mine', async () => {
    db.raw.mockResolvedValue({ rowCount: 1 });
    await miner.persistAll([{
      bucket: 'seasonal_rising', action_type: 'new_supporting_blog',
      query: 'termite swarm season', page_url: null, service: 'termite', city: null,
      score: 80, score_breakdown: {}, signal_metadata: {}, dedupe_key: 'k1',
    }]);

    const [sql] = db.raw.mock.calls[0];
    // The 7:30 ET mine runs BEFORE the 9AM engine; a wholesale
    // signal_metadata replace here would erase the runner's one-shot
    // gate_retry marker and turn the single feedback-informed redraft into
    // repeated blind first attempts.
    expect(sql).toContain("jsonb_exists(COALESCE(opportunity_queue.signal_metadata, '{}'::jsonb), 'gate_retry')");
    expect(sql).toContain("jsonb_build_object('gate_retry', opportunity_queue.signal_metadata->'gate_retry')");
    expect(sql).toContain("jsonb_exists(COALESCE(opportunity_queue.signal_metadata, '{}'::jsonb), 'infrastructure_retry')");
    expect(sql).toContain("jsonb_build_object('infrastructure_retry', opportunity_queue.signal_metadata->'infrastructure_retry')");
  });

  test('the unattended competitor re-mine preserves both bounded runner retry markers', async () => {
    db.raw.mockResolvedValue({ rowCount: 1 });
    await competitorMiner.persistAll([{
      bucket: 'competitor_gap', action_type: 'new_supporting_blog',
      query: 'termite swarm season', page_url: null, service: 'termite', city: null,
      score: 80, score_breakdown: {}, signal_metadata: {}, dedupe_key: 'competitor:k1',
    }]);

    const [sql] = db.raw.mock.calls[0];
    expect(sql).toContain("jsonb_exists(COALESCE(opportunity_queue.signal_metadata, '{}'::jsonb), 'gate_retry')");
    expect(sql).toContain("jsonb_build_object('gate_retry', opportunity_queue.signal_metadata->'gate_retry')");
    expect(sql).toContain("jsonb_exists(COALESCE(opportunity_queue.signal_metadata, '{}'::jsonb), 'infrastructure_retry')");
    expect(sql).toContain("jsonb_build_object('infrastructure_retry', opportunity_queue.signal_metadata->'infrastructure_retry')");
  });

  test('the intercept SEEDER deliberately keeps revive-on-reseed (operator signal)', async () => {
    // Contrast case: seedAll's CASE must NOT include 'skipped' — an operator
    // re-running the seed script is an explicit "run these".
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../services/content/intercept-brief-seeder'), 'utf8');
    const caseMatch = src.match(/status = CASE WHEN opportunity_queue\.status IN \(([^)]+)\)/);
    expect(caseMatch).toBeTruthy();
    expect(caseMatch[1]).not.toContain("'skipped'");
  });
});

describe('claimNext lifetime attempt budget', () => {
  test('the claim increments attempt_count and filters exhausted rows (default budget 5)', async () => {
    db.mockImplementation(() => chain());
    db.raw.mockResolvedValue({ rows: [] });

    await queue.claimNext({});

    const [sql, bindings] = rawCallContaining('attempt_count = CASE');
    expect(sql).toMatch(/attempt_count = CASE WHEN status = 'pending_review' THEN 1 ELSE attempt_count \+ 1 END/);
    expect(sql).toMatch(/attempt_count < \?::int/);
    expect(bindings[1]).toBe(5);
  });

  test('AUTONOMOUS_OPP_MAX_ATTEMPTS tunes the budget', async () => {
    process.env.AUTONOMOUS_OPP_MAX_ATTEMPTS = '3';
    db.mockImplementation(() => chain());
    db.raw.mockResolvedValue({ rows: [] });

    await queue.claimNext({});

    const [, bindings] = rawCallContaining('attempt_count = CASE');
    expect(bindings[1]).toBe(3);
  });

  test('sweepExhaustedAttempts skips blogs and preserves review for other lanes', async () => {
    const q = chain({ updateResult: 2 });
    db.mockImplementation(() => q);

    const swept = await queue.sweepExhaustedAttempts();

    expect(swept).toBe(2);
    expect(q.whereRaw).toHaveBeenCalledWith(expect.stringContaining("status = 'pending' AND attempt_count >= ?"), [5]);
    expect(q.whereRaw).toHaveBeenCalledWith(expect.stringContaining('NOT EXISTS'), [5]);
    expect(db.raw).toHaveBeenCalledWith(expect.stringMatching(/CASE WHEN COALESCE[\s\S]+THEN 'skipped' ELSE 'pending_review' END/));
    expect(db.raw).toHaveBeenCalledWith("CASE WHEN status = 'pending_review' THEN COALESCE(skip_reason, 'legacy_review_retired') ELSE 'attempts_exhausted' END");

  });
});

describe('recoverStaleClaims vs named-competitor approval claims', () => {
  test('stale recovery excludes named_competitor_publishing with a NULL-safe predicate', async () => {
    const q = chain({ updateResult: 0 });
    db.mockImplementation(() => q);

    await queue.recoverStaleClaims();

    const rawClause = q._filters.find(([kind, sql]) => kind === 'raw' && String(sql).includes('named_competitor_publishing'));
    expect(rawClause).toBeDefined();
    // IS DISTINCT FROM, not <>: runner claims carry NULL skip_reason and
    // NULL <> 'x' is NULL — a plain inequality would silently exclude every
    // normal claim from recovery.
    expect(rawClause[1]).toMatch(/skip_reason IS DISTINCT FROM 'named_competitor_publishing'/);
  });

  test('stale superseded claims preserve a current-claim PR park and otherwise retire explicitly', async () => {
    const supersededUpdates = [];
    const ordinaryUpdates = [];
    db.raw.mockImplementation((sql, bindings = []) => ({ __raw: sql, bindings }));
    const supersededQ = chain({ update: jest.fn((patch) => { supersededUpdates.push(patch); return Promise.resolve(1); }) });
    const ordinaryQ = chain({ update: jest.fn((patch) => { ordinaryUpdates.push(patch); return Promise.resolve(0); }) });
    db.mockImplementationOnce(() => supersededQ).mockImplementationOnce(() => ordinaryQ);

    await expect(queue.recoverStaleClaims()).resolves.toBe(1);

    expect(supersededUpdates[0].claimed_at).toBeNull();
    expect(supersededUpdates[0].status.__raw).toMatch(/current-claim|queue_claim_id IS NOT DISTINCT FROM opportunity_queue\.claim_id|THEN 'pending_review' ELSE 'skipped'/);
    expect(supersededUpdates[0].skip_reason.__raw).toContain("r.skip_reason IN ('astro_pr_pending_merge', 'metadata_pr_pending_merge')");
    expect(supersededUpdates[0].skip_reason.bindings).toEqual(['superseded_by_ordinary_page_edit']);
    expect(supersededUpdates[0].completed_at.__raw).toMatch(/THEN NULL ELSE \?::timestamptz/);
    expect(ordinaryQ._filters).toEqual(expect.arrayContaining([
      ['raw', expect.stringContaining("jsonb_exists(COALESCE(signal_metadata, '{}'::jsonb), ?)"), ['page_edit_superseded']],
    ]));
    expect(ordinaryUpdates[0]).toMatchObject({ claimed_at: null });
    expect(ordinaryUpdates[0].status.__raw).toMatch(/THEN 'pending_review' ELSE 'pending' END/);
  });

  test('a stale claim whose own run recorded an unreconciled refresh write parks instead of re-pending or retiring', async () => {
    const supersededUpdates = [];
    const ordinaryUpdates = [];
    db.raw.mockImplementation((sql, bindings = []) => ({ __raw: sql, bindings }));
    const supersededQ = chain({ update: jest.fn((patch) => { supersededUpdates.push(patch); return Promise.resolve(0); }) });
    const ordinaryQ = chain({ update: jest.fn((patch) => { ordinaryUpdates.push(patch); return Promise.resolve(1); }) });
    db.mockImplementationOnce(() => supersededQ).mockImplementationOnce(() => ordinaryQ);

    await queue.recoverStaleClaims();

    const evidence = /r\.queue_claim_id IS NOT DISTINCT FROM opportunity_queue\.claim_id[\s\S]+r\.skip_reason = 'refresh_publish_unreconciled'/;
    expect(ordinaryUpdates[0].status.__raw).toMatch(evidence);
    expect(ordinaryUpdates[0].skip_reason.__raw).toMatch(/THEN 'refresh_publish_unreconciled' ELSE skip_reason END/);
    // Superseded rows keep the hold too rather than being retired as skipped.
    expect(supersededUpdates[0].status.__raw).toMatch(evidence);
    expect(supersededUpdates[0].skip_reason.__raw).toMatch(/CASE WHEN [\s\S]+ THEN 'refresh_publish_unreconciled' END/);
    expect(supersededUpdates[0].completed_at.__raw).toMatch(evidence);
  });
});

describe('named-competitor publish janitor (autonomous-runner)', () => {
  function loadRunnerWithJanitorDb({ lockAcquired = true, stuckOppIds = ['opp1'] } = {}) {
    jest.resetModules();
    const updates = [];
    const selects = [];
    const lockQueries = [];
    jest.doMock('../models/db', () => {
      const fn = jest.fn((table) => {
        const q = {
          _table: table, _filters: [],
          where: jest.fn(function (...args) { q._filters.push(args); return q; }),
          whereIn: jest.fn(function (col, vals) { q._filters.push(['whereIn', col, vals]); return q; }),
          select: jest.fn(() => {
            selects.push({ table, filters: q._filters.slice() });
            return Promise.resolve(stuckOppIds.map((id) => ({ id })));
          }),
          update: jest.fn((u) => { updates.push({ table, filters: q._filters.slice(), updates: u }); return Promise.resolve(1); }),
        };
        return q;
      });
      fn.raw = jest.fn((sql, b) => ({ __raw: sql, bindings: b }));
      fn.client = {
        acquireConnection: jest.fn(async () => ({
          query: jest.fn(async (sql) => {
            lockQueries.push(sql);
            if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: lockAcquired }] };
            return { rows: [] };
          }),
        })),
        releaseConnection: jest.fn(async () => {}),
      };
      return fn;
    });
    const runner = require('../services/content/autonomous-runner');
    return { runner, updates, selects, lockQueries };
  }

  test('parks stuck runs + claimed opportunities at named_competitor_publish_interrupted — never a claimable state', async () => {
    const { runner, updates, selects, lockQueries } = loadRunnerWithJanitorDb({ lockAcquired: true });

    const res = await runner.recoverStuckNamedCompetitorPublishes({ staleMinutes: 60 });

    expect(res).toEqual({ runs: 1, opps: 1, review_runs: 1 });
    const runUpdate = updates.find((u) => u.table === 'autonomous_runs');
    expect(runUpdate.filters).toEqual(expect.arrayContaining([
      ['outcome', 'publishing_named_competitor'],
      ['updated_at', '<', expect.any(Date)],
    ]));
    expect(runUpdate.updates.outcome).toBe('completed_pending_review');
    expect(runUpdate.updates.skip_reason).toBe('named_competitor_publish_interrupted');

    // The stuck-opportunity set is SELECTED (under the engine lock) with the
    // stale-claim filters, then parked by id — the ids drive the
    // review-stage run parking below.
    const oppSelect = selects.find((s) => s.table === 'opportunity_queue');
    expect(oppSelect.filters).toEqual(expect.arrayContaining([
      [{ status: 'claimed', skip_reason: 'named_competitor_publishing' }],
      ['claimed_at', '<', expect.any(Date)],
    ]));
    const oppUpdate = updates.find((u) => u.table === 'opportunity_queue');
    expect(oppUpdate.filters).toEqual(expect.arrayContaining([
      ['whereIn', 'id', ['opp1']],
    ]));
    // pending_review + a reason the approval path does NOT accept: the item
    // surfaces for a human but can't be blindly re-published or re-drafted.
    expect(oppUpdate.updates.status).toBe('pending_review');
    expect(oppUpdate.updates.skip_reason).toBe('named_competitor_publish_interrupted');
    // the sweep ran under the engine lock and released it after
    expect(lockQueries.some((s) => /pg_try_advisory_lock/.test(s))).toBe(true);
    expect(lockQueries.some((s) => /pg_advisory_unlock/.test(s))).toBe(true);
  });

  test('still-approvable runs of parked opportunities are parked too (Codex round 2 — a pre-run-flip crash left a live approve button that 409s)', async () => {
    const { runner, updates } = loadRunnerWithJanitorDb({ lockAcquired: true });

    await runner.recoverStuckNamedCompetitorPublishes({ staleMinutes: 60 });

    // Crash window: _approveNamedCompetitorLocked claimed the opportunity
    // but died before flipping the run to publishing_named_competitor — the
    // run stays at completed_pending_review/named_competitor_review, and
    // the review model derives can_approve from the run alone. Flipping the
    // skip_reason hides the approve action; outcome stays pending_review so
    // requeue/dismiss remain available for reconciliation.
    const reviewUpdate = updates.filter((u) => u.table === 'autonomous_runs')[1];
    expect(reviewUpdate).toBeDefined();
    expect(reviewUpdate.filters).toEqual(expect.arrayContaining([
      ['whereIn', 'opportunity_id', ['opp1']],
      ['outcome', 'completed_pending_review'],
      // both approve-and-publish kinds (affiliate_review joined 2026-08-31)
      ['whereIn', 'skip_reason', ['named_competitor_review', 'affiliate_review']],
    ]));
    expect(reviewUpdate.updates.skip_reason).toBe('named_competitor_publish_interrupted');
    expect(reviewUpdate.updates.outcome).toBeUndefined();
  });

  test('a HELD engine lock means an approval is still alive: the janitor parks nothing (Codex round 1)', async () => {
    const { runner, updates } = loadRunnerWithJanitorDb({ lockAcquired: false });

    const res = await runner.recoverStuckNamedCompetitorPublishes({ staleMinutes: 60 });

    expect(res).toEqual({ runs: 0, opps: 0, skipped: 'engine_locked' });
    expect(updates).toHaveLength(0);
  });
});

describe('resurrection paths reset the lifetime claim budget (Codex round 1)', () => {
  test('both seeders and the refresh-audit upsert reset attempt_count when reviving skipped/expired rows; the cron miners never revive skipped', () => {
    const fs = require('fs');
    const resetSrc = [
      '../services/content/intercept-brief-seeder',
      '../services/content/spoke-seed-seeder',
      '../services/seo/refresh-audit',
    ];
    for (const mod of resetSrc) {
      const src = fs.readFileSync(require.resolve(mod), 'utf8');
      expect(src).toMatch(/attempt_count = CASE WHEN opportunity_queue\.status IN \('skipped', 'expired'\)\s*\n\s*THEN 0/);
      // Codex round 2: a row can be pending WITH an exhausted count (the
      // window between the claim that hit the budget and the daily sweep
      // that flips it to skipped) — the operator resurrection must reset
      // that too, or the enqueue reports queued while claimNext/peek
      // refuse the row. The ceiling is the SHARED maxClaimAttempts(),
      // never a private copy.
      expect(src).toMatch(/WHEN opportunity_queue\.status = 'pending'\s*\n\s*AND opportunity_queue\.attempt_count >= \?\s*\n\s*THEN 0/);
      expect(src).toMatch(/maxClaimAttempts\(\)/);
    }
    // The unattended miners keep 'skipped' sticky instead — a cron must not
    // overturn a dismissal or an attempts_exhausted sweep. The GSC miner
    // enforces this with a DO UPDATE ... WHERE guard (frozen rows skip the
    // update entirely); the competitor miner still uses the status CASE.
    const gscSrc = fs.readFileSync(require.resolve('../services/seo/gsc-opportunity-miner'), 'utf8');
    expect(gscSrc).toMatch(/status NOT IN \('claimed', 'done', 'pending_review', 'skipped'\)/);
    const compSrc = fs.readFileSync(require.resolve('../services/seo/competitor-gap-miner'), 'utf8');
    expect(compSrc).toMatch(/status IN \('claimed', 'done', 'pending_review', 'skipped'\)/);
  });

  test('refresh-audit in-flight check does not early-return on exhausted pending rows (Codex round 4 — the reset was unreachable)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../services/seo/refresh-audit'), 'utf8');
    // The duplicate check returned { queued: false } for ANY pending row
    // for the page, so the exhausted-count reset in the upsert never ran —
    // the admin saw the stale state and the row stayed unclaimable until
    // the daily sweep. Exhausted pendings must fall through to the upsert.
    expect(src).toMatch(/where\('status', '<>', 'pending'\)\.orWhere\('attempt_count', '<', maxClaimAttempts\(\)\)/);
  });

  test('peek applies the same attempt budget as claimNext (catch-up/preview parity)', async () => {
    const q = {
      _filters: [],
      where: jest.fn(function (...args) { q._filters.push(args); return q; }),
      whereNot: jest.fn(function (...args) { q._filters.push(['not', ...args]); return q; }),
      whereRaw: jest.fn(function (...args) { q._filters.push(['raw', ...args]); return q; }),
      orderBy: jest.fn(() => q),
      limit: jest.fn(() => q),
      select: jest.fn(() => Promise.resolve([])),
    };
    db.mockImplementation(() => q);

    await queue.peek({});

    expect(q._filters).toEqual(expect.arrayContaining([
      ['raw', "(attempt_count < ?::int OR status = 'pending_review')", [5]],
    ]));
  });
});

describe('listicle_family lane fence (kill-switch contract)', () => {
  // With either lane gate off, family rows must be unclaimable — they sit
  // pending and age out via expireStale rather than drafting plain blogs
  // (brief overlay off) or publishing listicles after the kill switch.
  // Gates are dev-open, so the off state is simulated via spy;
  // listicleFamilyLaneOpen re-destructures isEnabled on every call, which
  // is what makes the spy visible to the lazy require. The gates module is
  // required INSIDE each test: an earlier test calls jest.resetModules(),
  // so a describe-scope reference would be a stale instance the queue's
  // lazy require never consults.
  const peekChain = () => {
    const q = {
      _filters: [],
      where: jest.fn(function (...args) { q._filters.push(args); return q; }),
      whereNot: jest.fn(function (...args) { q._filters.push(['not', ...args]); return q; }),
      whereRaw: jest.fn(function (...args) { q._filters.push(['raw', ...args]); return q; }),
      orderBy: jest.fn(() => q),
      limit: jest.fn(() => q),
      select: jest.fn(() => Promise.resolve([])),
    };
    return q;
  };

  test('claimNext excludes listicle_family rows while either lane gate is off', async () => {
    const gates = require('../config/feature-gates');
    const spy = jest.spyOn(gates, 'isEnabled').mockReturnValue(false);
    try {
      db.mockImplementation(() => chain());
      db.raw.mockResolvedValue({ rows: [] });

      await queue.claimNext({});

      const [sql] = rawCallContaining("UPDATE opportunity_queue");
      expect(sql).toContain(`AND bucket <> 'listicle_family'`);
    } finally {
      spy.mockRestore();
    }
  });

  test('with both gates on, claimNext does not fence the bucket', async () => {
    db.mockImplementation(() => chain());
    db.raw.mockResolvedValue({ rows: [] });

    await queue.claimNext({}); // dev-open gates: lane open

    const [sql] = rawCallContaining("UPDATE opportunity_queue");
    expect(sql).not.toContain(`bucket <> 'listicle_family'`);
  });

  test('peek mirrors the fence (previews show exactly what the runner could claim)', async () => {
    const gates = require('../config/feature-gates');
    const spy = jest.spyOn(gates, 'isEnabled').mockReturnValue(false);
    try {
      const q = peekChain();
      db.mockImplementation(() => q);

      await queue.peek({});

      expect(q._filters).toEqual(expect.arrayContaining([
        ['not', 'bucket', 'listicle_family'],
      ]));
    } finally {
      spy.mockRestore();
    }
  });

  test('the fence fails CLOSED — unreadable gates shut the lane', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../services/content/opportunity-queue'), 'utf8');
    expect(src).toMatch(/isEnabled\('listicleFamilyMining'\) === true && isEnabled\('listicleBriefs'\) === true/);
    expect(src).toMatch(/function listicleFamilyLaneOpen\(\) \{[\s\S]*?catch \(_\) \{\s*return false;/);
  });
});

describe('citability_backfill lane fence (kill-switch contract, 2026-09-25)', () => {
  // The seeder's gate check fences WRITES only; this fence makes
  // GATE_CITABILITY_BACKFILL a real stop switch for rows already queued
  // (Sonnet fallback P1 on edd0f96d32): while the gate is off, backfill
  // rows are unclaimable and age out. Same mechanics as the listicle
  // fence above (spy on isEnabled, gates required inside each test).
  const peekChain = () => {
    const q = {
      _filters: [],
      where: jest.fn(function (...args) { q._filters.push(args); return q; }),
      whereNot: jest.fn(function (...args) { q._filters.push(['not', ...args]); return q; }),
      whereRaw: jest.fn(function (...args) { q._filters.push(['raw', ...args]); return q; }),
      orderBy: jest.fn(() => q),
      limit: jest.fn(() => q),
      select: jest.fn(() => Promise.resolve([])),
    };
    return q;
  };

  test('claimNext excludes citability_backfill rows while the gate is off', async () => {
    const gates = require('../config/feature-gates');
    const spy = jest.spyOn(gates, 'isEnabled').mockImplementation((g) => g !== 'citabilityBackfill');
    try {
      db.mockImplementation(() => chain());
      db.raw.mockResolvedValue({ rows: [] });

      await queue.claimNext({});

      const [sql] = rawCallContaining("UPDATE opportunity_queue");
      expect(sql).toContain(`AND bucket <> 'citability_backfill'`);
      // Only THIS lane is fenced — the listicle gates were left on.
      expect(sql).not.toContain(`bucket <> 'listicle_family'`);
    } finally {
      spy.mockRestore();
    }
  });

  test('with the gate on, claimNext does not fence the bucket', async () => {
    db.mockImplementation(() => chain());
    db.raw.mockResolvedValue({ rows: [] });

    await queue.claimNext({}); // dev-open gates: lane open

    const [sql] = rawCallContaining("UPDATE opportunity_queue");
    expect(sql).not.toContain(`bucket <> 'citability_backfill'`);
    expect(sql).toContain("jsonb_exists(COALESCE(signal_metadata, '{}'::jsonb), 'page_edit_superseded')");
  });

  test('peek mirrors the fence', async () => {
    const gates = require('../config/feature-gates');
    const spy = jest.spyOn(gates, 'isEnabled').mockImplementation((g) => g !== 'citabilityBackfill');
    try {
      const q = peekChain();
      db.mockImplementation(() => q);

      await queue.peek({});

      expect(q._filters).toEqual(expect.arrayContaining([
        ['not', 'bucket', 'citability_backfill'],
      ]));
      expect(q._filters).not.toEqual(expect.arrayContaining([
        ['not', 'bucket', 'listicle_family'],
      ]));
    } finally {
      spy.mockRestore();
    }
  });

  test('the fence fails CLOSED — an unreadable gate shuts the lane', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../services/content/opportunity-queue'), 'utf8');
    expect(src).toMatch(/isEnabled\('citabilityBackfill'\) === true/);
    expect(src).toMatch(/function citabilityBackfillLaneOpen\(\) \{[\s\S]*?catch \(_\) \{\s*return false;/);
    const { citabilityBackfillLaneOpen } = require('../services/content/opportunity-queue')._internals;
    expect(typeof citabilityBackfillLaneOpen).toBe('function');
  });
});

describe('citability page ownership after a gate-off ordinary refresh', () => {
  test('retires pending work and durably marks claimed/review evidence for resumed claim/publish/merge fences', async () => {
    const rows = [
      { id: 'pending', bucket: 'citability_backfill', status: 'pending', page_url: '/blog/termite-guide/?seed=1', signal_metadata: { evidence: 'pending' } },
      { id: 'claimed', bucket: 'citability_backfill', status: 'claimed', page_url: 'https://www.wavespestcontrol.com/blog/termite-guide/', signal_metadata: { evidence: 'claimed' } },
      { id: 'review', bucket: 'citability_backfill', status: 'pending_review', page_url: 'https://wavespestcontrol.com/blog/termite-guide#faq', signal_metadata: { evidence: 'review' } },
      { id: 'review-open', bucket: 'citability_backfill', status: 'pending_review', claim_id: 'claim-open', page_url: 'https://wavespestcontrol.com/blog/termite-guide#open', signal_metadata: { evidence: 'open-pr' } },
      { id: 'review-retiring', bucket: 'citability_backfill', status: 'pending_review', page_url: 'https://wavespestcontrol.com/blog/termite-guide#retiring', signal_metadata: { evidence: 'retired-pr-pending-bookkeeping' } },
      { id: 'review-historical', bucket: 'citability_backfill', status: 'pending_review', claim_id: 'claim-new', page_url: 'https://wavespestcontrol.com/blog/termite-guide#historical', signal_metadata: { evidence: 'old-claim-pr' } },
      { id: 'spoke', bucket: 'citability_backfill', status: 'pending', page_url: 'https://sarasota.wavespestcontrol.com/blog/termite-guide/', signal_metadata: {} },
      // An audit insert failed after a PR may have opened: no PR evidence on
      // record, but the hold must survive for a person to reconcile.
      { id: 'review-hold', bucket: 'citability_backfill', status: 'pending_review', skip_reason: 'astro_pr_audit_failed', page_url: 'https://wavespestcontrol.com/blog/termite-guide#hold', signal_metadata: { evidence: 'unconfirmed-write' } },
    ];
    const trx = jest.fn((table) => {
      let id = null;
      const q = {
        where: jest.fn((a, b) => { if (a === 'id' || a === 'opportunity_id') id = b; return q; }),
        whereIn: jest.fn(() => q),
        whereNotNull: jest.fn(() => q),
        whereNull: jest.fn(() => q),
        whereRaw: jest.fn(() => q),
        forUpdate: jest.fn(() => q),
        select: jest.fn(async () => rows),
        first: jest.fn(async () => {
          if (table !== 'autonomous_runs') return undefined;
          if (id === 'review-open') {
            return q.where.mock.calls.some((call) => call[0] === 'queue_claim_id' && call[1] === 'claim-open')
              ? { id: 'run-review-open' } : undefined;
          }
          if (id === 'review-retiring') return { id: `run-${id}` };
          if (id === 'review-historical'
            && !q.where.mock.calls.some((call) => call[0] === 'queue_claim_id' && call[1] === 'claim-new')) return { id: 'run-old-claim' };
          return undefined;
        }),
        update: jest.fn(async (patch) => {
          Object.assign(rows.find((row) => row.id === id), patch);
          return 1;
        }),
      };
      return q;
    });
    const internals = require('../services/content/opportunity-queue')._internals;

    const count = await internals.supersedeCitabilityBackfillsForPage(trx, {
      pageUrl: 'https://wavespestcontrol.com/blog/termite-guide/',
      ordinaryDedupeKey: 'refresh-audit:ordinary',
      now: new Date('2026-09-26T16:00:00Z'),
    });

    expect(count).toBe(7);
    expect(rows.find((row) => row.id === 'review-hold')).toMatchObject({ status: 'pending_review', skip_reason: 'astro_pr_audit_failed' });
    expect(internals.pageEditSuperseded(rows.find((row) => row.id === 'review-hold'))).toBe(true);
    expect(rows.find((row) => row.id === 'pending')).toMatchObject({
      status: 'skipped', skip_reason: 'superseded_by_ordinary_page_edit',
    });
    expect(rows.find((row) => row.id === 'claimed').status).toBe('claimed');
    expect(rows.find((row) => row.id === 'review')).toMatchObject({
      status: 'skipped', skip_reason: 'superseded_by_ordinary_page_edit',
    });
    expect(rows.find((row) => row.id === 'review-open').status).toBe('pending_review');
    // A prior close/branch-retirement step may already have stamped
    // astro_pr_retired_at. The still-parked run remains authoritative until
    // the poller atomically retires the queue row and run bookkeeping.
    expect(rows.find((row) => row.id === 'review-retiring').status).toBe('pending_review');
    expect(rows.find((row) => row.id === 'review-historical')).toMatchObject({
      status: 'skipped', skip_reason: 'superseded_by_ordinary_page_edit',
    });
    expect(internals.pageEditSuperseded(rows.find((row) => row.id === 'claimed'))).toBe(true);
    expect(internals.pageEditSuperseded(rows.find((row) => row.id === 'review'))).toBe(true);
    expect(internals.pageEditSuperseded(rows.find((row) => row.id === 'spoke'))).toBe(false);
    expect(JSON.parse(rows.find((row) => row.id === 'claimed').signal_metadata)).toMatchObject({
      evidence: 'claimed',
      page_edit_superseded: { ordinary_dedupe_key: 'refresh-audit:ordinary' },
    });
    const selectQuery = trx.mock.results[0].value;
    expect(selectQuery.whereRaw).toHaveBeenNthCalledWith(1, expect.stringContaining(":.*$"), ['wavespestcontrol.com']);
    expect(selectQuery.whereRaw).toHaveBeenNthCalledWith(2, expect.stringMatching(/COALESCE\(NULLIF[\s\S]*chr\(35\)/), ['/blog/termite-guide']);
    const retiringQuery = trx.mock.results.find((result) => result.value.first
      && result.value.where.mock.calls.some((call) => call[0] === 'opportunity_id' && call[1] === 'review-retiring')).value;
    expect(retiringQuery.where).toHaveBeenCalledWith('outcome', 'completed_pending_review');
    expect(retiringQuery.whereIn).toHaveBeenCalledWith('skip_reason', ['astro_pr_pending_merge', 'metadata_pr_pending_merge']);
    expect(retiringQuery.whereNull).not.toHaveBeenCalledWith('astro_pr_retired_at');
    const openQuery = trx.mock.results.find((result) => result.value.first
      && result.value.where.mock.calls.some((call) => call[0] === 'opportunity_id' && call[1] === 'review-open')).value;
    expect(openQuery.where).toHaveBeenCalledWith('queue_claim_id', 'claim-open');
    const historicalQuery = trx.mock.results.find((result) => result.value.first
      && result.value.where.mock.calls.some((call) => call[0] === 'opportunity_id' && call[1] === 'review-historical')).value;
    expect(historicalQuery.where).toHaveBeenCalledWith('queue_claim_id', 'claim-new');
  });
});

describe('aeo_question_gap lane fence (kill-switch contract)', () => {
  // GATE_AEO_QUESTION_GAP_MINING is the no-redeploy kill switch: gate off
  // must make already-queued question rows unclaimable too (they stay
  // pending, so re-enabling resumes them). Real env gate, read at call time.
  const OLD = process.env.GATE_AEO_QUESTION_GAP_MINING;
  afterEach(() => {
    if (OLD === undefined) delete process.env.GATE_AEO_QUESTION_GAP_MINING; else process.env.GATE_AEO_QUESTION_GAP_MINING = OLD;
  });
  const peekChain = () => {
    const q = {
      _filters: [],
      where: jest.fn(function (...args) { q._filters.push(args); return q; }),
      whereNot: jest.fn(function (...args) { q._filters.push(['not', ...args]); return q; }),
      whereRaw: jest.fn(function (...args) { q._filters.push(['raw', ...args]); return q; }),
      orderBy: jest.fn(() => q),
      limit: jest.fn(() => q),
      select: jest.fn(() => Promise.resolve([])),
    };
    return q;
  };

  test('gate off: a pending question row is neither claimed nor peeked', async () => {
    delete process.env.GATE_AEO_QUESTION_GAP_MINING;
    db.mockImplementation(() => chain());
    db.raw.mockResolvedValue({ rows: [] });
    await queue.claimNext({});
    expect(db.raw.mock.calls.find(([s]) => /UPDATE opportunity_queue/.test(s))[0]).toContain(`AND bucket <> 'aeo_question_gap'`);
    const q = peekChain();
    db.mockImplementation(() => q);
    await queue.peek({});
    expect(q._filters).toEqual(expect.arrayContaining([['not', 'bucket', 'aeo_question_gap']]));
  });

  test('claimNext and peek both carry the question route fence (real-Postgres proof: aeo-question-claim-fence-postgres)', async () => {
    process.env.GATE_AEO_QUESTION_GAP_MINING = 'true';
    db.mockImplementation(() => chain());
    db.raw.mockResolvedValue({ rows: [] });
    await queue.claimNext({});
    const [sql] = db.raw.mock.calls.find(([s]) => /UPDATE opportunity_queue/.test(s));
    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM opportunity_queue route_fence/);
    expect(sql).toMatch(/route_fence\.bucket = 'aeo_question_gap' OR opportunity_queue\.bucket = 'aeo_question_gap'/);
    expect(sql).toContain("intercept_brief'->>'slug'");
    const q = peekChain();
    db.mockImplementation(() => q);
    await queue.peek({});
    expect(q._filters.some((f) => f[0] === 'raw' && /route_fence/.test(f[1]))).toBe(true);
  });

  test('gate on: question rows are claimable and peekable', async () => {
    process.env.GATE_AEO_QUESTION_GAP_MINING = 'true';
    db.mockImplementation(() => chain());
    db.raw.mockResolvedValue({ rows: [] });
    await queue.claimNext({});
    expect(db.raw.mock.calls.find(([s]) => /UPDATE opportunity_queue/.test(s))[0]).not.toContain(`AND bucket <> 'aeo_question_gap'`);
    const q = peekChain();
    db.mockImplementation(() => q);
    await queue.peek({});
    expect(q._filters).not.toEqual(expect.arrayContaining([['not', 'bucket', 'aeo_question_gap']]));
  });
});

describe('defer() — cap/gate-retry deferral back to pending (exceptions-only review queue)', () => {
  test('claim-guarded update: pending, future available_at, cleared skip_reason, extended expires_at', async () => {
    const q = chain({ updateResult: 1 });
    db.mockImplementation(() => q);
    const when = new Date('2026-07-20T04:00:00Z');

    const ok = await queue.defer('opp_defer', when, { claimToken: 'tok' });

    expect(ok).toBe(true);
    expect(q._filters).toEqual(expect.arrayContaining([
      ['id', 'opp_defer'],
      ['status', 'claimed'],
      ['claimed_at', 'tok'],
    ]));
    const patch = q.update.mock.calls[0][0];
    expect(patch).toHaveProperty('status');
    expect(patch.claimed_at).toBeNull();
    // 'pending' rows must look pending — the deferral reason lives on the
    // autonomous_runs row, not the queue row.
    expect(patch).toHaveProperty('skip_reason');
    expect(patch.available_at).toBe(when);
    // expires_at must be pushed past the defer horizon or expireStale()
    // expires the row before it ever becomes claimable again.
    expect(db.raw).toHaveBeenCalledWith(expect.stringContaining('GREATEST(COALESCE(expires_at'), expect.any(Array));
    // A deferral is not a failure: the attempt claimNext consumed must be
    // refunded, or repeated cap-window deferrals exhaust the lifetime
    // attempt budget and land in attempts_exhausted review.
    expect(db.raw).toHaveBeenCalledWith('GREATEST(attempt_count - 1, 0)');
    expect(db.raw).toHaveBeenCalledWith(
      expect.stringContaining("THEN 'skipped' ELSE 'pending'"),
    );
    expect(db.raw).toHaveBeenCalledWith(
      expect.stringContaining("jsonb_exists(COALESCE(signal_metadata, '{}'::jsonb), 'page_edit_superseded')"),
      ['superseded_by_ordinary_page_edit'],
    );
  });

  test('requires a claimToken and a real Date', async () => {
    await expect(queue.defer('opp_defer', new Date('2026-07-20T04:00:00Z'), {})).rejects.toThrow('claimToken');
    await expect(queue.defer('opp_defer', 'monday', { claimToken: 'tok' })).rejects.toThrow('availableAt');
  });
});

describe('release() — superseded citability claims cannot return to pending', () => {
  test('keeps the claim-token CAS and selects a terminal marker disposition atomically', async () => {
    const q = chain({ updateResult: 1 });
    db.mockImplementation(() => q);

    await expect(queue.release('opp_release', { claimToken: 'tok' })).resolves.toBe(true);

    expect(q._filters).toEqual(expect.arrayContaining([
      ['id', 'opp_release'], ['status', 'claimed'], ['claimed_at', 'tok'],
    ]));
    const patch = q.update.mock.calls[0][0];
    expect(patch).toHaveProperty('status');
    expect(patch).toHaveProperty('skip_reason');
    expect(patch).toHaveProperty('completed_at');
    expect(db.raw).toHaveBeenCalledWith(expect.stringContaining("THEN 'skipped' ELSE 'pending'"));
    expect(db.raw).toHaveBeenCalledWith(
      expect.stringContaining("jsonb_exists(COALESCE(signal_metadata, '{}'::jsonb), 'page_edit_superseded')"),
      ['superseded_by_ordinary_page_edit'],
    );
  });
});
