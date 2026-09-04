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
// The channel map is the shared source_type → channel table; the stamp only
// needs "paid channel / organic channel / no channel" to exercise its rules.
jest.mock('../services/ads/call-attribution', () => ({
  attributionForSourceType: (sourceType) => ({
    google_ads: { leadSource: 'google_ads', isPaid: true },
    facebook: { leadSource: 'facebook', isPaid: true },
    organic: { leadSource: 'organic', isPaid: false },
    website: { leadSource: 'website', isPaid: false },
  })[sourceType] || null,
}));
// The intake resolver — real classification is unit-tested in its own suite;
// here it only has to answer for the stored snapshot it is handed.
jest.mock('../services/lead-source-resolver', () => ({
  resolveLeadSource: jest.fn(async (a) => {
    const utm = a?.utm || {};
    if (a?.gclid || (utm.source === 'google' && utm.medium === 'cpc')) return { sourceType: 'google_ads', leadSourceDetail: a?.gclid ? 'Google Ads click (gclid)' : `google ${utm.medium} ${utm.campaign}`, isPaidClick: true };
    if (utm.source === 'facebook') return { sourceType: 'facebook', leadSourceDetail: `facebook ${utm.medium || ''}`.trim(), isPaidClick: utm.medium === 'cpc' };
    return { sourceType: 'website', leadSourceDetail: a?.referrer ? `Referrer: ${a.referrer}` : null, isPaidClick: false };
  }),
}));

const {
  bridgeLeadFunnelStage,
  bridgeLeadsFunnelStage,
  stampLeadFunnelRow,
  FUNNEL_STAGE_RANK,
  LEAD_STATUS_TO_FUNNEL_STAGE,
} = require('../services/lead-funnel-bridge');
const { etDateString } = require('../utils/datetime-et');
const { inferServiceLine } = require('../utils/service-line-infer');
const { resolveLeadSource } = require('../services/lead-source-resolver');

// Fake knex that records the WHERE chain the bridge builds. Supports the
// grouped `where((q) => q.whereIn(...).orWhereNull(...))` form; whereIn calls
// are recorded per column so the bulk form's lead_id whereIn and the stage
// predicate's funnel_stage whereIn stay distinguishable.
function makeCaptureDb({ updatedRows = 1, throwOnUpdate = false } = {}) {
  const captured = { table: null, where: null, whereInByCol: {}, whereNotIn: null, orWhereNull: null, patch: null, whereExists: null };
  const database = (table) => {
    captured.table = table;
    const q = {
      where(arg) {
        if (typeof arg === 'function') { arg(q); } else { captured.where = arg; }
        return q;
      },
      // The callback-form EXISTS subquery (`onlyIfLead`): record what the
      // sub-builder selected and filtered on.
      whereExists(fn) {
        const sub = { select: null, from: null, whereRaw: null, where: null, whereNull: null };
        const b = {
          select(v) { sub.select = v; return b; },
          from(t) { sub.from = t; return b; },
          whereRaw(s) { sub.whereRaw = s; return b; },
          where(c) { sub.where = c; return b; },
          whereNull(c) { sub.whereNull = c; return b; },
        };
        fn.call(b);
        captured.whereExists = sub;
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
  // The customer_id stamp uses handle.raw(...) — capture the SQL fragment so
  // tests can assert the COALESCE-from-lead behavior.
  database.raw = (sql) => ({ __raw: sql });
  database._captured = captured;
  return database;
}

// Would a row currently at `stage` be matched by the captured stage predicate?
// Models POSTGRES semantics: NULL never matches whereIn OR whereNotIn
// (`NULL NOT IN (...)` is unknown) — a NULL stage matches only via an
// explicit orWhereNull. This is exactly the trap the lost predicate hit.
function predicateMatches(captured, stage) {
  if (stage === null) return captured.orWhereNull === 'funnel_stage';
  const stageIn = captured.whereInByCol.funnel_stage;
  if (stageIn) return stageIn.includes(stage);
  if (captured.whereNotIn) return !captured.whereNotIn.list.includes(stage);
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
    // Every stage advance back-fills customer_id from the lead (COALESCE —
    // never overwrites an already-stamped customer) so lead-only funnel rows
    // (photo-assessment claims) become visible to the customer-keyed revenue
    // sync once the lead converts.
    expect(c.patch.customer_id.__raw).toContain('COALESCE(ad_service_attribution.customer_id');
    expect(c.patch.customer_id.__raw).toContain('SELECT l.customer_id FROM leads l WHERE l.id = ad_service_attribution.lead_id');
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
      // NULL is the defensive rank-0 stage — the collapse must catch it via
      // an explicit orWhereNull (NULL NOT IN (...) is unknown in Postgres).
      expect(predicateMatches(c, null)).toBe(true);
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
    spHandle.raw = (sql) => ({ __raw: sql });
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

  test('onlyIfLead conditions the advance IN THE SAME STATEMENT on the lead row still matching the validated identity / status / link (codex #3834 r29 P1)', async () => {
    const database = makeCaptureDb();
    const onlyIfLead = { customer_id: 'c1', phone: '9415550142', email: null, estimate_id: null, status: 'contacted' };
    const res = await bridgeLeadFunnelStage('L-root', 'won', database, { onlyIfLead });
    expect(res).toEqual({ updated: 1, stage: 'booked' });
    const c = database._captured;
    expect(c.where).toEqual({ lead_id: 'L-root' });
    expect(c.whereExists).toEqual({ select: 1, from: 'leads', whereRaw: 'leads.id = ad_service_attribution.lead_id', where: onlyIfLead, whereNull: 'deleted_at' });
    // The stage predicate is unchanged by the claim.
    expect(c.whereInByCol.funnel_stage).toEqual(['lead', 'contacted', 'estimate_sent', 'estimate_viewed', 'lost']);
  });

  test('without onlyIfLead no EXISTS clause is added', async () => {
    const database = makeCaptureDb();
    await bridgeLeadFunnelStage('L1', 'won', database);
    expect(database._captured.whereExists).toBeNull();
  });

  test('reports the row count the update touched (0 when the lead has no funnel row)', async () => {
    const database = makeCaptureDb({ updatedRows: 0 });
    const res = await bridgeLeadFunnelStage('L-none', 'won', database);
    expect(res).toEqual({ updated: 0, stage: 'booked' });
  });
});

describe('stampLeadFunnelRow — the one row a lead row\'s own intake would have stamped', () => {
  function makeStampDb({ sourceType = 'google_ads', conflict = false, throwOnInsert = false } = {}) {
    const captured = { sourceLookup: null, insert: null, onConflict: null };
    const database = (table) => {
      if (table === 'lead_sources') {
        return { where(clause) { captured.sourceLookup = clause; return { first: async () => (sourceType ? { source_type: sourceType } : null) }; } };
      }
      if (table === 'ad_service_attribution') {
        return {
          insert(row) {
            if (throwOnInsert) throw new Error('db boom');
            captured.insert = row;
            return { onConflict(col) { captured.onConflict = col; return { ignore: () => ({ returning: async () => (conflict ? [] : [{ id: 'asa-1' }]) }) }; } };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    };
    database._captured = captured;
    return database;
  }
  const stored = {
    id: 'lead-1', lead_source_id: 'ls-1', customer_id: null, service_interest: 'Lawn Care', created_at: '2026-08-30T15:00:00Z',
    // The inquiry began the evening before (ET) the row was created — the
    // original touch's date is the first contact, not the row's creation.
    first_contact_at: '2026-08-30T02:30:00Z',
    gclid: 'g-1', wbraid: null, gbraid: null, fbclid: null, fbc: null, fbp: 'fbp-1',
  };

  test('rebuilds the row from what the lead stored — its source channel, click ids, service, first-contact date — and fills only what the row lacks', async () => {
    const database = makeStampDb();
    const id = await stampLeadFunnelRow(database, stored, { customerId: 'c-9', serviceInterest: 'Pest Control' });
    expect(id).toBe('asa-1');
    expect(database._captured.sourceLookup).toEqual({ id: 'ls-1' });
    expect(database._captured.onConflict).toBe('lead_id');
    expect(database._captured.insert).toEqual(expect.objectContaining({
      lead_id: 'lead-1',
      customer_id: 'c-9',
      lead_source: 'google_ads',
      lead_source_detail: null,
      is_paid: true,
      funnel_stage: 'lead',
      gclid: 'g-1',
      fbc: null,
      fbp: 'fbp-1',
      utm_campaign: null,
      utm_term: null,
      lead_date: etDateString(new Date('2026-08-30T02:30:00Z')),
    }));
    expect(database._captured.insert.lead_date).toBe('2026-08-29');
    // The ROW's service wins over the caller's fallback.
    expect(database._captured.insert.service_line).toBe(inferServiceLine('Lawn Care'));
  });

  test("the row's own customer beats the fallback, and a stage override lands as given (the booked winner still reads 'duplicate')", async () => {
    const database = makeStampDb();
    await stampLeadFunnelRow(database, { ...stored, customer_id: 'c-own', status: 'duplicate' }, { customerId: 'c-9', funnelStage: 'booked' });
    expect(database._captured.insert).toEqual(expect.objectContaining({ customer_id: 'c-own', funnel_stage: 'booked' }));
  });

  test("without an override the row starts at the stage the lead's CURRENT status maps to — a root that already advanced is not reset to 'lead' (codex r15 P2)", async () => {
    for (const [status, stage] of [['new', 'lead'], ['contacted', 'contacted'], ['estimate_sent', 'estimate_sent'], ['estimate_viewed', 'estimate_viewed'], ['won', 'booked'], [undefined, 'lead']]) {
      const database = makeStampDb();
      await stampLeadFunnelRow(database, { ...stored, status });
      expect(database._captured.insert.funnel_stage).toBe(stage);
    }
  });

  test('paid needs BOTH a paid channel and a stored click id (fbc counts); an organic channel is never paid', async () => {
    let database = makeStampDb();
    await stampLeadFunnelRow(database, { ...stored, gclid: null });
    expect(database._captured.insert.is_paid).toBe(false);
    database = makeStampDb();
    await stampLeadFunnelRow(database, { ...stored, gclid: null, fbc: 'fb.1.1.abc' });
    expect(database._captured.insert.is_paid).toBe(true);
    database = makeStampDb({ sourceType: 'organic' });
    await stampLeadFunnelRow(database, stored);
    expect(database._captured.insert).toEqual(expect.objectContaining({ lead_source: 'organic', is_paid: false }));
  });

  test('an existing row wins (conflict → null) and a stored source with no channel, or no source at all, gets no row', async () => {
    expect(await stampLeadFunnelRow(makeStampDb({ conflict: true }), stored)).toBeNull();
    let database = makeStampDb({ sourceType: 'walk_in' });
    expect(await stampLeadFunnelRow(database, stored)).toBeNull();
    expect(database._captured.insert).toBeNull();
    database = makeStampDb();
    expect(await stampLeadFunnelRow(database, { ...stored, lead_source_id: null })).toBeNull();
    expect(database._captured.sourceLookup).toBeNull();
    expect(database._captured.insert).toBeNull();
  });

  test('a row with a stored attribution snapshot is rebuilt through the intake resolver: detail, campaign/term and paid evidence (a cpc UTM without a click id) come back as intake stamped them', async () => {
    resolveLeadSource.mockClear();
    const database = makeStampDb();
    const withSnapshot = {
      ...stored, gclid: null,
      extracted_data: { stage: 'quote_calculated', utm: { source: 'google', medium: 'cpc', campaign: 'summer-ants', term: 'ant control' }, referrer: null, landing_url: 'https://wavespestcontrol.com/quote' },
    };
    const id = await stampLeadFunnelRow(database, withSnapshot);
    expect(id).toBe('asa-1');
    expect(resolveLeadSource).toHaveBeenCalledWith({
      utm: { source: 'google', medium: 'cpc', campaign: 'summer-ants', term: 'ant control' },
      referrer: null, landing_url: 'https://wavespestcontrol.com/quote',
      gclid: null, wbraid: null, gbraid: null, fbclid: null, fbc: null, fbp: 'fbp-1',
    });
    // The snapshot beats the lead_sources fallback (no lookup at all).
    expect(database._captured.sourceLookup).toBeNull();
    expect(database._captured.insert).toEqual(expect.objectContaining({
      lead_source: 'google_ads', lead_source_detail: 'google cpc summer-ants', utm_campaign: 'summer-ants', utm_term: 'ant control', is_paid: true,
    }));
  });

  test('a snapshot that resolves to an unpaid channel is not paid, keeps its detail, and a legacy string snapshot parses too', async () => {
    const database = makeStampDb();
    await stampLeadFunnelRow(database, { ...stored, gclid: null, extracted_data: JSON.stringify({ utm: null, referrer: 'https://www.google.com/', landing_url: 'https://wavespestcontrol.com/' }) });
    expect(database._captured.insert).toEqual(expect.objectContaining({
      lead_source: 'website', lead_source_detail: 'Referrer: https://www.google.com/', utm_campaign: null, utm_term: null, is_paid: false,
    }));
    // utm_source=facebook without cpc or a click id lands in the Facebook channel but is not paid (same rule as intake).
    const organicSocial = makeStampDb();
    await stampLeadFunnelRow(organicSocial, { ...stored, gclid: null, extracted_data: { utm: { source: 'facebook', medium: 'social' }, referrer: null, landing_url: null } });
    expect(organicSocial._captured.insert).toEqual(expect.objectContaining({ lead_source: 'facebook', is_paid: false }));
  });

  test('a db failure is swallowed (null, never thrown into the conversion)', async () => {
    await expect(stampLeadFunnelRow(makeStampDb({ throwOnInsert: true }), stored)).resolves.toBeNull();
    await expect(stampLeadFunnelRow(makeStampDb(), null)).resolves.toBeNull();
  });
});
