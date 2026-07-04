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

afterEach(() => {
  jest.clearAllMocks();
  delete process.env.AUTONOMOUS_OPP_MAX_ATTEMPTS;
});

describe('miner upsert: skipped is sticky, expired revives', () => {
  const miner = require('../services/seo/gsc-opportunity-miner');

  test('the status CASE preserves skipped alongside claimed/done/pending_review — and NOT expired', async () => {
    db.raw.mockResolvedValue({ rowCount: 1 });
    await miner.persistAll([{
      bucket: 'seasonal_rising', action_type: 'new_supporting_blog',
      query: 'termite swarm season', page_url: null, service: 'termite', city: null,
      score: 80, score_breakdown: {}, signal_metadata: {}, dedupe_key: 'k1',
    }]);

    const [sql] = db.raw.mock.calls[0];
    const caseMatch = sql.match(/status IN \(([^)]+)\)/);
    expect(caseMatch).toBeTruthy();
    expect(caseMatch[1]).toContain("'skipped'");
    expect(caseMatch[1]).toContain("'claimed'");
    expect(caseMatch[1]).toContain("'done'");
    expect(caseMatch[1]).toContain("'pending_review'");
    // expired must revive to pending on a fresh mine of the same signal
    expect(caseMatch[1]).not.toContain("'expired'");
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

    const [sql, bindings] = db.raw.mock.calls[0];
    expect(sql).toMatch(/attempt_count = attempt_count \+ 1/);
    expect(sql).toMatch(/attempt_count < \?::int/);
    expect(bindings[1]).toBe(5);
  });

  test('AUTONOMOUS_OPP_MAX_ATTEMPTS tunes the budget', async () => {
    process.env.AUTONOMOUS_OPP_MAX_ATTEMPTS = '3';
    db.mockImplementation(() => chain());
    db.raw.mockResolvedValue({ rows: [] });

    await queue.claimNext({});

    const [, bindings] = db.raw.mock.calls[0];
    expect(bindings[1]).toBe(3);
  });

  test('sweepExhaustedAttempts converts exhausted pendings to visible skipped/attempts_exhausted', async () => {
    const q = chain({ updateResult: 2 });
    db.mockImplementation(() => q);

    const swept = await queue.sweepExhaustedAttempts();

    expect(swept).toBe(2);
    expect(q._filters).toEqual(expect.arrayContaining([
      ['status', 'pending'],
      ['attempt_count', '>=', 5],
    ]));
    expect(q.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'skipped',
      skip_reason: 'attempts_exhausted',
    }));
  });
});

describe('recoverStaleClaims vs named-competitor approval claims', () => {
  test('stale recovery excludes named_competitor_publishing with a NULL-safe predicate', async () => {
    const q = chain({ updateResult: 0 });
    db.mockImplementation(() => q);

    await queue.recoverStaleClaims();

    const rawClause = q._filters.find(([kind]) => kind === 'raw');
    expect(rawClause).toBeDefined();
    // IS DISTINCT FROM, not <>: runner claims carry NULL skip_reason and
    // NULL <> 'x' is NULL — a plain inequality would silently exclude every
    // normal claim from recovery.
    expect(rawClause[1]).toMatch(/skip_reason IS DISTINCT FROM 'named_competitor_publishing'/);
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
      ['skip_reason', 'named_competitor_review'],
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
    // overturn a dismissal or an attempts_exhausted sweep.
    for (const mod of ['../services/seo/gsc-opportunity-miner', '../services/seo/competitor-gap-miner']) {
      const src = fs.readFileSync(require.resolve(mod), 'utf8');
      expect(src).toMatch(/status IN \('claimed', 'done', 'pending_review', 'skipped'\)/);
    }
  });

  test('peek applies the same attempt budget as claimNext (catch-up/preview parity)', async () => {
    const q = {
      _filters: [],
      where: jest.fn(function (...args) { q._filters.push(args); return q; }),
      whereRaw: jest.fn(function (...args) { q._filters.push(['raw', ...args]); return q; }),
      orderBy: jest.fn(() => q),
      limit: jest.fn(() => q),
      select: jest.fn(() => Promise.resolve([])),
    };
    db.mockImplementation(() => q);

    await queue.peek({});

    expect(q._filters).toEqual(expect.arrayContaining([
      ['attempt_count', '<', 5],
    ]));
  });
});
