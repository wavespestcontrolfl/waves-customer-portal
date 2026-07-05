/**
 * lead-funnel-bridge — funnel_stage bridging from lead status transitions.
 *
 * The bridge enforces monotonicity IN SQL: it only ever updates rows whose
 * CURRENT funnel_stage sits at a strictly lower rank than the target (or, for
 * 'lost', any non-terminal stage; plus the one sanctioned recovery — 'booked'
 * may advance FROM 'lost'). These tests capture the built query and evaluate
 * its predicate against every current stage, so "never downgrade",
 * "completed sticky", "lost collapse" and "lost recovery via booked only"
 * are checked as a full matrix — not just per happy path.
 */
const {
  bridgeLeadFunnelStage,
  bridgeLeadsFunnelStage,
  FUNNEL_STAGE_RANK,
  LEAD_STATUS_TO_FUNNEL_STAGE,
} = require('../services/lead-funnel-bridge');

// Fake knex that records the WHERE chain the bridge builds. Supports the
// grouped `where((q) => q.whereIn(...).orWhereNull(...))` form; whereIn calls
// are recorded per column so the bulk form's lead_id whereIn and the stage
// predicate's funnel_stage whereIn stay distinguishable.
function makeCaptureDb({ updatedRows = 1, throwOnUpdate = false } = {}) {
  const captured = { table: null, where: null, whereInByCol: {}, whereNotIn: null, orWhereNull: null, patch: null };
  const database = (table) => {
    captured.table = table;
    const q = {
      where(arg) {
        if (typeof arg === 'function') { arg(q); } else { captured.where = arg; }
        return q;
      },
      whereIn(col, list) { captured.whereInByCol[col] = list; return q; },
      whereNotIn(col, list) { captured.whereNotIn = { col, list }; return q; },
      orWhereNull(col) { captured.orWhereNull = col; return q; },
      update: async (patch) => {
        if (throwOnUpdate) throw new Error('db boom');
        captured.patch = patch;
        return updatedRows;
      },
    };
    return q;
  };
  database._captured = captured;
  return database;
}

// Would a row currently at `stage` be matched by the captured stage predicate?
function predicateMatches(captured, stage) {
  const stageIn = captured.whereInByCol.funnel_stage;
  if (stageIn) {
    return stageIn.includes(stage) || (stage === null && captured.orWhereNull === 'funnel_stage');
  }
  if (captured.whereNotIn) {
    return !captured.whereNotIn.list.includes(stage);
  }
  return false;
}

const ALL_STAGES = ['lead', 'contacted', 'estimate_sent', 'estimate_viewed', 'booked', 'completed', 'lost', null];

describe('status → stage mapping', () => {
  test('maps every status with funnel meaning; all closed non-won statuses collapse to lost', () => {
    expect(LEAD_STATUS_TO_FUNNEL_STAGE).toEqual({
      contacted: 'contacted',
      estimate_sent: 'estimate_sent',
      estimate_viewed: 'estimate_viewed',
      won: 'booked',
      lost: 'lost',
      // CLOSED_LEAD_STATUSES minus won — the staleness sweep parks stale
      // leads at unresponsive; funnel-wise these are all the lost bucket.
      unresponsive: 'lost',
      disqualified: 'lost',
      duplicate: 'lost',
    });
  });

  test('rank order is lead < contacted < estimate_sent < estimate_viewed < booked < completed', () => {
    const ordered = ['lead', 'contacted', 'estimate_sent', 'estimate_viewed', 'booked', 'completed'];
    for (let i = 1; i < ordered.length; i += 1) {
      expect(FUNNEL_STAGE_RANK[ordered[i]]).toBeGreaterThan(FUNNEL_STAGE_RANK[ordered[i - 1]]);
    }
    // 'lost' is deliberately NOT ranked — it is terminal-with-recovery, not an altitude.
    expect(FUNNEL_STAGE_RANK).not.toHaveProperty('lost');
  });
});

describe('bridgeLeadFunnelStage — advancing stages', () => {
  test('won advances lower stages AND recovers lost to booked (never completed/booked itself)', async () => {
    const database = makeCaptureDb();
    const res = await bridgeLeadFunnelStage('L1', 'won', database);

    expect(res).toEqual({ updated: 1, stage: 'booked' });
    const c = database._captured;
    expect(c.table).toBe('ad_service_attribution');
    expect(c.where).toEqual({ lead_id: 'L1' });
    expect(c.whereInByCol.funnel_stage).toEqual(['lead', 'contacted', 'estimate_sent', 'estimate_viewed', 'lost']);
    expect(c.patch).toMatchObject({ funnel_stage: 'booked' });
    expect(c.patch.updated_at).toBeInstanceOf(Date);
  });

  test('estimate_viewed advances from lead/contacted/estimate_sent only — never out of lost', async () => {
    const database = makeCaptureDb();
    await bridgeLeadFunnelStage('L1', 'estimate_viewed', database);
    expect(database._captured.whereInByCol.funnel_stage).toEqual(['lead', 'contacted', 'estimate_sent']);
  });

  test('contacted advances from lead only', async () => {
    const database = makeCaptureDb();
    await bridgeLeadFunnelStage('L1', 'contacted', database);
    expect(database._captured.whereInByCol.funnel_stage).toEqual(['lead']);
  });

  test('a NULL funnel_stage row still advances (defensive rank-0)', async () => {
    const database = makeCaptureDb();
    await bridgeLeadFunnelStage('L1', 'won', database);
    expect(database._captured.orWhereNull).toBe('funnel_stage');
  });

  test('full monotonicity matrix — completed is always sticky; only booked recovers lost', async () => {
    for (const [status, target] of Object.entries(LEAD_STATUS_TO_FUNNEL_STAGE)) {
      if (target === 'lost') continue; // terminal collapse asserted separately below
      const database = makeCaptureDb();
      await bridgeLeadFunnelStage('L1', status, database);
      for (const stage of ALL_STAGES) {
        const matches = predicateMatches(database._captured, stage);
        if (stage === null) {
          expect(matches).toBe(true); // NULL = rank 0
        } else if (stage === 'completed') {
          expect(matches).toBe(false); // completed sticky — always
        } else if (stage === 'lost') {
          // lost is recoverable ONLY by the positive close (won → booked)
          expect(matches).toBe(target === 'booked');
        } else {
          expect(matches).toBe(FUNNEL_STAGE_RANK[stage] < FUNNEL_STAGE_RANK[target]);
        }
      }
    }
  });
});

describe('bridgeLeadFunnelStage — lost collapse (lost / unresponsive / disqualified / duplicate)', () => {
  test.each(['lost', 'unresponsive', 'disqualified', 'duplicate'])(
    '%s collapses any intermediate stage to lost but never completed (sticky) and never re-writes lost',
    async (status) => {
      const database = makeCaptureDb();
      const res = await bridgeLeadFunnelStage('L1', status, database);

      expect(res).toEqual({ updated: 1, stage: 'lost' });
      const c = database._captured;
      expect(c.whereNotIn).toEqual({ col: 'funnel_stage', list: ['completed', 'lost'] });
      expect(c.whereInByCol.funnel_stage).toBeUndefined();
      for (const stage of ['lead', 'contacted', 'estimate_sent', 'estimate_viewed', 'booked']) {
        expect(predicateMatches(c, stage)).toBe(true);
      }
      expect(predicateMatches(c, 'completed')).toBe(false);
      expect(predicateMatches(c, 'lost')).toBe(false);
    },
  );
});

describe('bridgeLeadsFunnelStage — bulk form (IB bulk update, staleness sweep)', () => {
  test('one set-based UPDATE scoped by lead_id with the SAME stage predicate as the single form', async () => {
    const database = makeCaptureDb();
    const res = await bridgeLeadsFunnelStage(['L1', 'L2', 'L3'], 'unresponsive', database);

    expect(res).toEqual({ updated: 1, stage: 'lost' });
    const c = database._captured;
    expect(c.table).toBe('ad_service_attribution');
    expect(c.whereInByCol.lead_id).toEqual(['L1', 'L2', 'L3']);
    expect(c.whereNotIn).toEqual({ col: 'funnel_stage', list: ['completed', 'lost'] });
    expect(c.patch).toMatchObject({ funnel_stage: 'lost' });
  });

  test('bulk won recovery matches the single form (lost included in the from-set)', async () => {
    const database = makeCaptureDb();
    await bridgeLeadsFunnelStage(['L1'], 'won', database);
    expect(database._captured.whereInByCol.funnel_stage).toEqual(['lead', 'contacted', 'estimate_sent', 'estimate_viewed', 'lost']);
  });

  test('empty/nullish id lists and unmapped statuses no-op without touching the db', async () => {
    for (const [ids, status] of [[[], 'won'], [[null, undefined], 'won'], [['L1'], 'new'], [null, 'won']]) {
      const database = makeCaptureDb();
      const res = await bridgeLeadsFunnelStage(ids, status, database);
      expect(res).toEqual({ updated: 0, reason: 'no_mapping' });
      expect(database._captured.table).toBeNull();
    }
  });

  test('a db failure is swallowed', async () => {
    const database = makeCaptureDb({ throwOnUpdate: true });
    const res = await bridgeLeadsFunnelStage(['L1'], 'won', database);
    expect(res).toEqual({ updated: 0, reason: 'error' });
  });
});

describe('savepoint isolation for transactional callers', () => {
  // When the handle IS a knex transaction, the bridge must run its UPDATE in
  // a nested transaction (SAVEPOINT) — in Postgres a failed statement leaves
  // the enclosing transaction aborted even when the exception is caught, so
  // running directly on the caller's trx would doom the conversion/sweep the
  // bridge is best-effort for. The fake trx THROWS if queried directly, so
  // these tests prove the query goes through the savepoint handle only.
  function makeTrxDb({ failUpdate = false } = {}) {
    const state = { savepointUsed: false, patch: null };
    const spHandle = (table) => {
      const q = {
        where(arg) { if (typeof arg === 'function') arg(q); return q; },
        whereIn: () => q,
        whereNotIn: () => q,
        orWhereNull: () => q,
        update: async (patch) => {
          if (failUpdate) throw new Error('savepoint boom');
          state.patch = patch;
          return 1;
        },
      };
      return q;
    };
    const trx = () => { throw new Error('caller trx queried directly — bridge must use the savepoint'); };
    trx.isTransaction = true;
    trx.transaction = async (cb) => { state.savepointUsed = true; return cb(spHandle); };
    trx._state = state;
    return trx;
  }

  test('a trx handle routes the UPDATE through a savepoint (never the caller trx directly)', async () => {
    const trx = makeTrxDb();
    const res = await bridgeLeadFunnelStage('L1', 'won', trx);
    expect(res).toEqual({ updated: 1, stage: 'booked' });
    expect(trx._state.savepointUsed).toBe(true);
    expect(trx._state.patch).toMatchObject({ funnel_stage: 'booked' });
  });

  test('a bridge SQL failure inside a caller trx is contained to the savepoint (error result, caller trx untouched)', async () => {
    const trx = makeTrxDb({ failUpdate: true });
    const res = await bridgeLeadFunnelStage('L1', 'won', trx);
    expect(res).toEqual({ updated: 0, reason: 'error' });
    expect(trx._state.savepointUsed).toBe(true); // failure happened INSIDE the savepoint
  });

  test('the bulk form gets the same savepoint isolation', async () => {
    const ok = makeTrxDb();
    expect(await bridgeLeadsFunnelStage(['L1', 'L2'], 'unresponsive', ok)).toEqual({ updated: 1, stage: 'lost' });
    expect(ok._state.savepointUsed).toBe(true);

    const bad = makeTrxDb({ failUpdate: true });
    expect(await bridgeLeadsFunnelStage(['L1'], 'won', bad)).toEqual({ updated: 0, reason: 'error' });
    expect(bad._state.savepointUsed).toBe(true);
  });

  test('a plain (non-trx) handle runs directly — no savepoint machinery required', async () => {
    // makeCaptureDb has neither isTransaction nor transaction(); the existing
    // suites above all pass through this path.
    const database = makeCaptureDb();
    const res = await bridgeLeadFunnelStage('L1', 'won', database);
    expect(res).toEqual({ updated: 1, stage: 'booked' });
  });
});

describe('bridgeLeadFunnelStage — no-ops and failure containment', () => {
  test('statuses with no funnel meaning no-op without touching the db', async () => {
    for (const status of ['new', 'garbage', '', null, undefined]) {
      const database = makeCaptureDb();
      const res = await bridgeLeadFunnelStage('L1', status, database);
      expect(res).toEqual({ updated: 0, reason: 'no_mapping' });
      expect(database._captured.table).toBeNull();
    }
  });

  test('missing leadId no-ops', async () => {
    const database = makeCaptureDb();
    const res = await bridgeLeadFunnelStage(null, 'won', database);
    expect(res).toEqual({ updated: 0, reason: 'no_mapping' });
    expect(database._captured.table).toBeNull();
  });

  test('a db failure is swallowed (best-effort — never throws into the lead transition)', async () => {
    const database = makeCaptureDb({ throwOnUpdate: true });
    const res = await bridgeLeadFunnelStage('L1', 'won', database);
    expect(res).toEqual({ updated: 0, reason: 'error' });
  });

  test('reports the row count the update touched (0 when the lead has no funnel row)', async () => {
    const database = makeCaptureDb({ updatedRows: 0 });
    const res = await bridgeLeadFunnelStage('L-none', 'won', database);
    expect(res).toEqual({ updated: 0, stage: 'booked' });
  });
});
