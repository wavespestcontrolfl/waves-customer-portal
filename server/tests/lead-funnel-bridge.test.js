/**
 * lead-funnel-bridge — funnel_stage bridging from lead status transitions.
 *
 * The bridge enforces monotonicity IN SQL: it only ever updates rows whose
 * CURRENT funnel_stage sits at a strictly lower rank than the target (or, for
 * 'lost', any non-terminal stage). These tests capture the built query and
 * evaluate its predicate against every current stage, so "never downgrade",
 * "completed sticky" and "lost terminal" are checked as a full matrix — not
 * just per happy path.
 */
const {
  bridgeLeadFunnelStage,
  FUNNEL_STAGE_RANK,
  LEAD_STATUS_TO_FUNNEL_STAGE,
} = require('../services/lead-funnel-bridge');

// Fake knex that records the WHERE chain the bridge builds. Supports the
// grouped `where((q) => q.whereIn(...).orWhereNull(...))` form.
function makeCaptureDb({ updatedRows = 1, throwOnUpdate = false } = {}) {
  const captured = { table: null, where: null, whereIn: null, whereNotIn: null, orWhereNull: null, patch: null };
  const database = (table) => {
    captured.table = table;
    const q = {
      where(arg) {
        if (typeof arg === 'function') { arg(q); } else { captured.where = arg; }
        return q;
      },
      whereIn(col, list) { captured.whereIn = { col, list }; return q; },
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

// Would a row currently at `stage` be matched by the captured predicate?
function predicateMatches(captured, stage) {
  if (captured.whereIn) {
    return captured.whereIn.list.includes(stage) || (stage === null && captured.orWhereNull === 'funnel_stage');
  }
  if (captured.whereNotIn) {
    return !captured.whereNotIn.list.includes(stage);
  }
  return false;
}

const ALL_STAGES = ['lead', 'contacted', 'estimate_sent', 'estimate_viewed', 'booked', 'completed', 'lost', null];

describe('status → stage mapping', () => {
  test('maps exactly the statuses with funnel meaning', () => {
    expect(LEAD_STATUS_TO_FUNNEL_STAGE).toEqual({
      contacted: 'contacted',
      estimate_sent: 'estimate_sent',
      estimate_viewed: 'estimate_viewed',
      won: 'booked',
      lost: 'lost',
    });
  });

  test('rank order is lead < contacted < estimate_sent < estimate_viewed < booked < completed', () => {
    const ordered = ['lead', 'contacted', 'estimate_sent', 'estimate_viewed', 'booked', 'completed'];
    for (let i = 1; i < ordered.length; i += 1) {
      expect(FUNNEL_STAGE_RANK[ordered[i]]).toBeGreaterThan(FUNNEL_STAGE_RANK[ordered[i - 1]]);
    }
    // 'lost' is deliberately NOT ranked — it is terminal, not an altitude.
    expect(FUNNEL_STAGE_RANK).not.toHaveProperty('lost');
  });
});

describe('bridgeLeadFunnelStage — advancing stages', () => {
  test('won advances only strictly-lower stages to booked (never lost/completed/booked itself)', async () => {
    const database = makeCaptureDb();
    const res = await bridgeLeadFunnelStage('L1', 'won', database);

    expect(res).toEqual({ updated: 1, stage: 'booked' });
    const c = database._captured;
    expect(c.table).toBe('ad_service_attribution');
    expect(c.where).toEqual({ lead_id: 'L1' });
    expect(c.whereIn).toEqual({ col: 'funnel_stage', list: ['lead', 'contacted', 'estimate_sent', 'estimate_viewed'] });
    expect(c.patch).toMatchObject({ funnel_stage: 'booked' });
    expect(c.patch.updated_at).toBeInstanceOf(Date);
  });

  test('estimate_viewed advances from lead/contacted/estimate_sent only', async () => {
    const database = makeCaptureDb();
    await bridgeLeadFunnelStage('L1', 'estimate_viewed', database);
    expect(database._captured.whereIn.list).toEqual(['lead', 'contacted', 'estimate_sent']);
  });

  test('contacted advances from lead only', async () => {
    const database = makeCaptureDb();
    await bridgeLeadFunnelStage('L1', 'contacted', database);
    expect(database._captured.whereIn.list).toEqual(['lead']);
  });

  test('a NULL funnel_stage row still advances (defensive rank-0)', async () => {
    const database = makeCaptureDb();
    await bridgeLeadFunnelStage('L1', 'won', database);
    expect(database._captured.orWhereNull).toBe('funnel_stage');
  });

  test('full monotonicity matrix — no target ever matches an equal/higher/terminal stage', async () => {
    for (const [status, target] of Object.entries(LEAD_STATUS_TO_FUNNEL_STAGE)) {
      if (target === 'lost') continue; // terminal collapse asserted separately below
      const database = makeCaptureDb();
      await bridgeLeadFunnelStage('L1', status, database);
      for (const stage of ALL_STAGES) {
        const matches = predicateMatches(database._captured, stage);
        if (stage === null) {
          expect(matches).toBe(true); // NULL = rank 0
        } else if (stage === 'lost' || stage === 'completed') {
          expect(matches).toBe(false); // terminal: lost never advanced, completed sticky
        } else {
          expect(matches).toBe(FUNNEL_STAGE_RANK[stage] < FUNNEL_STAGE_RANK[target]);
        }
      }
    }
  });
});

describe('bridgeLeadFunnelStage — lost', () => {
  test('lost collapses any intermediate stage but never completed (sticky) and never re-writes lost', async () => {
    const database = makeCaptureDb();
    const res = await bridgeLeadFunnelStage('L1', 'lost', database);

    expect(res).toEqual({ updated: 1, stage: 'lost' });
    const c = database._captured;
    expect(c.whereNotIn).toEqual({ col: 'funnel_stage', list: ['completed', 'lost'] });
    expect(c.whereIn).toBeNull();
    for (const stage of ['lead', 'contacted', 'estimate_sent', 'estimate_viewed', 'booked']) {
      expect(predicateMatches(c, stage)).toBe(true);
    }
    expect(predicateMatches(c, 'completed')).toBe(false);
    expect(predicateMatches(c, 'lost')).toBe(false);
  });
});

describe('bridgeLeadFunnelStage — no-ops and failure containment', () => {
  test('statuses with no funnel meaning no-op without touching the db', async () => {
    for (const status of ['new', 'unresponsive', 'duplicate', 'disqualified', 'garbage', '', null, undefined]) {
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
