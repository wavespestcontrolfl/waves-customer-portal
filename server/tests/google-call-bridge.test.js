jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  return db;
});

jest.mock('../services/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}));

jest.mock('google-ads-api', () => ({
  GoogleAdsApi: jest.fn(),
  enums: {
    CampaignStatus: {
      ENABLED: 'ENABLED',
      PAUSED: 'PAUSED',
    },
  },
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'uuid-1'),
}));

const GoogleCallBridge = require('../services/ads/google-call-bridge');
const GoogleAds = require('../services/ads/google-ads');

const {
  buildMatches,
  leadMatchPlan,
  leadTimeWindow,
  mainLine,
  normalizeGoogleCallRow,
  parseGoogleDateTime,
  phoneLast10,
  phoneVariants,
  redactedLeadMatch,
  scoreCallMatch,
  shapeCallLog,
  shouldRetryLeadAttribution,
} = GoogleCallBridge._private;

describe('Google Ads call reporting bridge', () => {
  test('normalizes Google Ads call_view rows in account Eastern time', () => {
    const call = normalizeGoogleCallRow({
      call_view: {
        resource_name: 'customers/123/callViews/abc',
        start_call_date_time: '2026-06-12 10:30:00',
        end_call_date_time: '2026-06-12 10:32:15',
        call_duration_seconds: '135',
        call_status: 'RECEIVED',
        caller_area_code: '941',
      },
      campaign: { id: 22594274874, name: 'Waves Pest Control - GBP Search' },
      ad_group: { id: 186920600384, name: 'Waves GBP Ad Group' },
    });

    expect(parseGoogleDateTime('2026-06-12 10:30:00').toISOString()).toBe('2026-06-12T14:30:00.000Z');
    expect(call).toEqual(expect.objectContaining({
      resourceName: 'customers/123/callViews/abc',
      durationSeconds: 135,
      callStatus: 'RECEIVED',
      callerAreaCode: '941',
      campaignId: '22594274874',
      adGroupId: '186920600384',
    }));
    expect(call.startAt.toISOString()).toBe('2026-06-12T14:30:00.000Z');
  });

  test('builds phone variants for matching the main 7612 line safely', () => {
    expect(mainLine()).toEqual(expect.objectContaining({
      number: '+19413187612',
      label: expect.stringContaining('Lakewood Ranch GBP'),
    }));
    expect(phoneVariants('+19413187612')).toEqual(expect.arrayContaining([
      '+19413187612',
      '19413187612',
      '9413187612',
      '(941) 318-7612',
    ]));
  });

  test('plans lead attribution by stable customer id or caller phone, not call SID', () => {
    const byCustomer = leadMatchPlan({
      customerId: 'customer-1',
      fromPhone: '+19415550100',
      createdAt: '2026-06-12T14:31:00.000Z',
      twilioCallSid: 'mutable-follow-up-sid',
    });

    expect(byCustomer).toEqual(expect.objectContaining({
      strategy: 'customer_id',
      customerId: 'customer-1',
    }));
    expect(byCustomer.callAt.toISOString()).toBe('2026-06-12T14:31:00.000Z');
    expect(byCustomer.startAt.toISOString()).toBe('2026-06-12T08:31:00.000Z');
    expect(byCustomer.endAt.toISOString()).toBe('2026-06-12T20:31:00.000Z');

    expect(phoneLast10('(941) 555-0100')).toBe('9415550100');
    expect(leadMatchPlan({
      fromPhone: '(941) 555-0100',
      createdAt: '2026-06-12T14:31:00.000Z',
      twilioCallSid: 'mutable-follow-up-sid',
    })).toEqual(expect.objectContaining({
      strategy: 'phone_last10',
      phoneLast10: '9415550100',
    }));
    expect(leadTimeWindow({ createdAt: 'not-a-date' })).toBeNull();
    expect(leadMatchPlan({ customerId: 'customer-1' })).toBeNull();
  });

  test('retries already-bridged calls until successful lead attribution is recorded', () => {
    const pendingCallLog = shapeCallLog({
      id: 'call-1',
      created_at: '2026-06-12T14:31:00.000Z',
      metadata: {
        google_ads_call_bridge: {
          resourceName: 'customers/123/callViews/match',
        },
      },
    });
    const attributedCallLog = shapeCallLog({
      id: 'call-2',
      created_at: '2026-06-12T14:31:00.000Z',
      metadata: JSON.stringify({
        google_ads_call_bridge: {
          leadMatch: { leadId: 'lead-1', strategy: 'customer_id' },
          leadAttributedAt: '2026-06-12T14:40:00.000Z',
        },
      }),
    });

    expect(pendingCallLog.googleAdsLeadMatched).toBe(false);
    expect(shouldRetryLeadAttribution({ status: 'already_bridged', callLog: pendingCallLog })).toBe(true);
    expect(attributedCallLog.googleAdsLeadMatched).toBe(true);
    expect(attributedCallLog.googleAdsLeadMatchedAt).toBe('2026-06-12T14:40:00.000Z');
    expect(shouldRetryLeadAttribution({ status: 'already_bridged', callLog: attributedCallLog })).toBe(false);
    expect(redactedLeadMatch({
      leadId: 'lead-1',
      strategy: 'phone_last10',
      phoneLast10: '9415550100',
    })).toEqual({
      leadId: 'lead-1',
      strategy: 'phone_last10',
      customerId: null,
    });
  });

  test('scores a strong Google Ads to Twilio call match', () => {
    const googleCall = normalizeGoogleCallRow({
      call_view: {
        resource_name: 'customers/123/callViews/match',
        start_call_date_time: '2026-06-12 10:30:00',
        call_duration_seconds: 121,
        call_status: 'RECEIVED',
        caller_area_code: '941',
      },
    });
    const callLog = {
      id: 'call-1',
      to_phone: '+19413187612',
      from_phone: '+19415550100',
      created_at: '2026-06-12T14:31:00.000Z',
      duration_seconds: 118,
      status: 'completed',
    };

    const score = scoreCallMatch(googleCall, callLog, '+19413187612');

    expect(score.score).toBeGreaterThanOrEqual(90);
    expect(score.reasons).toEqual(expect.arrayContaining([
      'dialed main 7612 line',
      'start time within 2 minutes',
      'duration within 15 seconds',
      'caller area code matches',
    ]));
  });

  test('does not mark weak or conflicting calls ready', () => {
    const googleCall = normalizeGoogleCallRow({
      call_view: {
        resource_name: 'customers/123/callViews/weak',
        start_call_date_time: '2026-06-12 10:30:00',
        call_duration_seconds: 120,
        call_status: 'RECEIVED',
        caller_area_code: '941',
      },
    });
    const matches = buildMatches([
      googleCall,
    ], [
      {
        id: 'call-1',
        to_phone: '+19413187612',
        from_phone: '+18135550100',
        created_at: '2026-06-12T14:49:00.000Z',
        duration_seconds: 15,
        status: 'no-answer',
      },
    ], '+19413187612');

    expect(matches[0].status).toBe('unmatched');
    expect(matches[0].confidence).toBeLessThan(70);
  });

  test('keeps close competing matches in review instead of auto-bridging', () => {
    const googleCall = normalizeGoogleCallRow({
      call_view: {
        resource_name: 'customers/123/callViews/ambiguous',
        start_call_date_time: '2026-06-12 10:30:00',
        call_duration_seconds: 120,
        call_status: 'RECEIVED',
        caller_area_code: '941',
      },
    });
    const calls = [
      {
        id: 'call-1',
        to_phone: '+19413187612',
        from_phone: '+19415550100',
        created_at: '2026-06-12T14:30:30.000Z',
        duration_seconds: 120,
        status: 'completed',
      },
      {
        id: 'call-2',
        to_phone: '+19413187612',
        from_phone: '+19415550999',
        created_at: '2026-06-12T14:31:00.000Z',
        duration_seconds: 121,
        status: 'completed',
      },
    ];

    const [match] = buildMatches([googleCall], calls, '+19413187612');

    expect(match.status).toBe('ambiguous');
    expect(match.alternatives).toHaveLength(1);
  });

  test('builds a bounded call_view query for the Google Ads API', () => {
    const query = GoogleAds._private.buildCallViewQuery(120, 999);

    expect(query).toContain('FROM call_view');
    expect(query).toContain('call_view.start_call_date_time');
    expect(query).toContain('call_view.call_duration_seconds');
    expect(query).toContain('LIMIT 500');
  });
});

describe('isBridgeTargetNumber', () => {
  test('true only for the configured Google Ads call-bridge target line', () => {
    // The bridge target is TWILIO_NUMBERS.locations.bradenton (+19413187612).
    // Callers use this to avoid pre-attributing that shared number organic.
    expect(GoogleCallBridge.isBridgeTargetNumber('+19413187612')).toBe(true);
    expect(GoogleCallBridge.isBridgeTargetNumber('9413187612')).toBe(true); // format-agnostic
    expect(GoogleCallBridge.isBridgeTargetNumber('(941) 318-7612')).toBe(true);
  });

  test('false for other city-page / spoke numbers and empties', () => {
    expect(GoogleCallBridge.isBridgeTargetNumber('+19412972817')).toBe(false); // another main_site number
    expect(GoogleCallBridge.isBridgeTargetNumber('+19412838194')).toBe(false); // a spoke number
    expect(GoogleCallBridge.isBridgeTargetNumber('')).toBe(false);
    expect(GoogleCallBridge.isBridgeTargetNumber(null)).toBe(false);
  });
});

describe('dedupeCrmCallRows (PR #3275)', () => {
  const { dedupeCrmCallRows } = GoogleCallBridge._private;
  const row = (id, leadId, leadCallSid, callSid = 'CAcall') => ({
    id, lead_id: leadId, lead_call_sid: leadCallSid, twilio_call_sid: callSid,
  });

  test('collapses the stale-stamp twin, sid-linked lead winning', () => {
    // The OR join emits the stamp-linked lead first; the sid-linked lead is
    // authoritative, so one row survives regardless of arrival order.
    const stampFirst = dedupeCrmCallRows([row('c1', 'lead-stamp', null), row('c1', 'lead-sid', 'CAcall')]);
    expect(stampFirst).toHaveLength(1);
    expect(stampFirst[0].lead_id).toBe('lead-sid');

    const sidFirst = dedupeCrmCallRows([row('c1', 'lead-sid', 'CAcall'), row('c1', 'lead-stamp', null)]);
    expect(sidFirst).toHaveLength(1);
    expect(sidFirst[0].lead_id).toBe('lead-sid');
  });

  test('KEEPS both rows when two live leads share one sid (ambiguity survives)', () => {
    // leads.twilio_call_sid has no unique index. Collapsing these would let
    // the bridge rewrite an arbitrary lead's source and leave the real one
    // unattributed; buildMatches must still see the equal-score twin and
    // mark the google call ambiguous.
    const deduped = dedupeCrmCallRows([row('c1', 'lead-a', 'CAcall'), row('c1', 'lead-b', 'CAcall')]);
    expect(deduped).toHaveLength(2);
    expect(deduped.map((r) => r.lead_id).sort()).toEqual(['lead-a', 'lead-b']);
  });

  test('a stale stamp alongside two sid-linked leads keeps only the ambiguous pair', () => {
    const deduped = dedupeCrmCallRows([
      row('c1', 'lead-stamp', null),
      row('c1', 'lead-a', 'CAcall'),
      row('c1', 'lead-b', 'CAcall'),
    ]);
    expect(deduped.map((r) => r.lead_id)).toEqual(['lead-a', 'lead-b']);
  });

  test('passes through lead-less calls and never merges distinct calls', () => {
    const deduped = dedupeCrmCallRows([row('c1', null, null), row('c2', null, null, 'CAother')]);
    expect(deduped.map((r) => r.id)).toEqual(['c1', 'c2']);
  });
});

describe('callStillAttributable — settled terminal verdicts only (PR #3303)', () => {
  const { callStillAttributable } = GoogleCallBridge._private;
  const trxFor = (row) => () => ({
    where() { return this; },
    forUpdate() { return this; },
    async first() { return row; },
  });

  test('a MID-FLIGHT call (processing_token set) is never attributable — its cleared stamp is not a settled unlink', async () => {
    expect(await callStillAttributable(trxFor({ processing_status: 'processing', processing_token: 'tok', metadata: {} }), 'c1')).toBe(false);
    // Even a nominally processed status with a live token is a reclaim in
    // progress — refuse until it settles.
    expect(await callStillAttributable(trxFor({ processing_status: 'processed', processing_token: 'tok', metadata: {} }), 'c1')).toBe(false);
  });

  test('settled rejections and the durable marker refuse; a settled clean call passes', async () => {
    expect(await callStillAttributable(trxFor({ processing_status: 'spam', processing_token: null, metadata: {} }), 'c1')).toBe(false);
    expect(await callStillAttributable(trxFor({ processing_status: 'voicemail', processing_token: null, metadata: {} }), 'c1')).toBe(false);
    expect(await callStillAttributable(trxFor({ processing_status: 'processed', processing_token: null, metadata: { no_attribution: true } }), 'c1')).toBe(false);
    expect(await callStillAttributable(trxFor(undefined), 'c1')).toBe(false);
    expect(await callStillAttributable(trxFor({ processing_status: 'processed', processing_token: null, metadata: {} }), 'c1')).toBe(true);
  });
});

describe('dedupeCrmCallRows — settled-stamp dissent (PR #3303 r5)', () => {
  const { dedupeCrmCallRows } = GoogleCallBridge._private;
  const row = (id, leadId, leadCallSid, extra = {}) => ({
    id, lead_id: leadId, lead_call_sid: leadCallSid, twilio_call_sid: 'CAcall', ...extra,
  });

  test('a SETTLED stamp targeting a DIFFERENT lead collapses to the STAMPED lead — the repoint is the processor verdict', () => {
    // Same call → both join rows carry the same call columns: a settled
    // stamp to lead-stamp while lead-sid still holds the sid residue.
    // Collapsing to the sid row would hide the repoint; keeping both
    // would read as ordinary match ambiguity FOREVER and starve the
    // transfer reconciliation — the stamped lead is the current verdict.
    const settled = { metadata: JSON.stringify({ lead_id: 'lead-stamp' }), processing_token: null, processing_status: 'processed' };
    const deduped = dedupeCrmCallRows([
      row('c1', 'lead-stamp', null, settled),
      row('c1', 'lead-sid', 'CAcall', settled),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].lead_id).toBe('lead-stamp');
  });

  test('an UNSETTLED stamp twin still collapses to the sid row — a mid-flight stamp is not a verdict', () => {
    const inflight = { metadata: JSON.stringify({ lead_id: 'lead-stamp' }), processing_token: 'tok', processing_status: 'processing' };
    const deduped = dedupeCrmCallRows([
      row('c1', 'lead-stamp', null, inflight),
      row('c1', 'lead-sid', 'CAcall', inflight),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].lead_id).toBe('lead-sid');
  });

  test('a settled stamp AGREEING with the sid lead collapses normally', () => {
    const settled = { metadata: JSON.stringify({ lead_id: 'lead-sid' }), processing_token: null, processing_status: 'processed' };
    const deduped = dedupeCrmCallRows([
      row('c1', 'lead-sid', 'CAcall', settled),
      row('c1', 'lead-sid', 'CAcall', settled),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].lead_id).toBe('lead-sid');
  });
});

describe('cleared-joined tombstone (pre-push P1 r7)', () => {
  test('a clear tombstone (leadId null, strategy retained) still enters the retry lane', () => {
    // googleAdsLeadMatched is false on the tombstone, so the call retries —
    // a future re-link attributes cleanly; the retained joined_lead
    // strategy keeps that retry on noPlanFallback so plan matching can
    // never reselect the former lead.
    const tombstoned = {
      id: 'call-1',
      noAttribution: false,
      googleAdsLeadMatched: false,
      googleAdsLeadMatchedLeadId: null,
      googleAdsLeadMatchedStrategy: 'joined_lead',
      leadId: null,
    };
    expect(shouldRetryLeadAttribution({ status: 'already_bridged', callLog: tombstoned })).toBe(true);
  });
});

describe('dedupeCrmCallRows — settled stamp beats multi-sid ambiguity (pre-push P1 r14)', () => {
  const { dedupeCrmCallRows } = GoogleCallBridge._private;
  const row = (id, leadId, leadCallSid, extra = {}) => ({
    id, lead_id: leadId, lead_call_sid: leadCallSid, twilio_call_sid: 'CAcall', ...extra,
  });

  test('two sid-sharing leads plus a settled dissenting stamp collapse to the STAMPED lead', () => {
    const settled = { metadata: JSON.stringify({ lead_id: 'lead-stamp' }), processing_token: null, processing_status: 'processed' };
    const deduped = dedupeCrmCallRows([
      row('c1', 'lead-a', 'CAcall', settled),
      row('c1', 'lead-b', 'CAcall', settled),
      row('c1', 'lead-stamp', null, settled),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].lead_id).toBe('lead-stamp');
  });

  test('two sid-sharing leads with NO settled stamp keep their ambiguity (conservative no-bridge)', () => {
    const deduped = dedupeCrmCallRows([
      row('c1', 'lead-a', 'CAcall'),
      row('c1', 'lead-b', 'CAcall'),
    ]);
    expect(deduped.map((r) => r.lead_id).sort()).toEqual(['lead-a', 'lead-b']);
  });
});

describe('soft-deleted stamp target (codex P1, PR #3303 r7)', () => {
  const { dedupeCrmCallRows, shapeCallLog } = GoogleCallBridge._private;

  test('a SETTLED stamp whose target the join could not return clears the lead columns and flags the call', () => {
    // Stamp names lead-B (soft-deleted → absent from the join); only the
    // obsolete sid lead-A came back. Collapsing to A would let the bridge
    // rewrite A's source and pull the funnel row back to it.
    const row = {
      id: 'c1',
      lead_id: 'lead-a',
      lead_call_sid: 'CAcall',
      twilio_call_sid: 'CAcall',
      processing_token: null,
      processing_status: 'processed',
      metadata: JSON.stringify({ lead_id: 'lead-b' }),
    };
    const [deduped] = dedupeCrmCallRows([row]);
    expect(deduped.lead_id).toBeNull();
    expect(deduped.stamp_target_missing).toBe(true);
    expect(shapeCallLog(deduped).stampTargetMissing).toBe(true);
    expect(shapeCallLog(deduped).leadId).toBeNull();
  });

  test('an UNSETTLED call with an absent stamp target is untouched — no verdict yet', () => {
    const row = {
      id: 'c1',
      lead_id: 'lead-a',
      lead_call_sid: 'CAcall',
      twilio_call_sid: 'CAcall',
      processing_token: 'tok',
      processing_status: 'processing',
      metadata: JSON.stringify({ lead_id: 'lead-b' }),
    };
    const [deduped] = dedupeCrmCallRows([row]);
    expect(deduped.lead_id).toBe('lead-a');
    expect(deduped.stamp_target_missing).toBeUndefined();
  });

  test('a settled stamp whose target IS in the join is not flagged', () => {
    const row = {
      id: 'c1',
      lead_id: 'lead-b',
      lead_call_sid: null,
      twilio_call_sid: 'CAcall',
      processing_token: null,
      processing_status: 'processed',
      metadata: JSON.stringify({ lead_id: 'lead-b' }),
    };
    const [deduped] = dedupeCrmCallRows([row]);
    expect(deduped.lead_id).toBe('lead-b');
    expect(deduped.stamp_target_missing).toBeUndefined();
  });
});

describe('attributeResolvedLead — sid-only ownership eligibility (codex P1, PR #3303 r7)', () => {
  const { attributeResolvedLead } = GoogleCallBridge._private;

  function makeTrx({ lead, callSettled = true }) {
    return (table) => {
      const b = {};
      for (const m of ['where', 'whereNull', 'whereNotNull', 'whereIn', 'whereRaw', 'whereExists',
        'andWhere', 'forUpdate', 'select', 'orderBy', 'limit']) {
        b[m] = jest.fn(() => b);
      }
      // The lead UPDATE resolves 0 rows: these tests assert the OWNERSHIP
      // decision, not the write, so a landed-vs-stale update is irrelevant.
      b.update = jest.fn(async () => 0);
      b.first = jest.fn(async () => {
        if (table === 'leads') return lead;
        if (table === 'call_log') {
          return callSettled
            ? { id: 'c1', processing_token: null, processing_status: 'processed', metadata: {} }
            : { id: 'c1', processing_token: 'tok', processing_status: 'processing', metadata: {} };
        }
        return null;
      });
      b.then = (res, rej) => Promise.resolve([]).then(res, rej);
      return b;
    };
  }

  test('an unavailable settled stamp target attributes NOTHING and never falls to the plan', async () => {
    const res = await attributeResolvedLead(
      { id: 'c1', stampTargetMissing: true, leadId: null },
      { id: 'src' }, new Date(), makeTrx({ lead: null }),
    );
    expect(res).toEqual({ match: null, reason: 'lead_not_live' });
  });

  test('a SID-only join owned by a DIFFERENT customer than the call is refused', async () => {
    const res = await attributeResolvedLead(
      { id: 'c1', leadId: 'lead-a', customerId: 'cust-Y', stampedLeadId: null },
      { id: 'src' }, new Date(),
      makeTrx({ lead: { id: 'lead-a', customer_id: 'cust-X' } }),
    );
    expect(res).toEqual({ match: null, reason: 'lead_owner_conflict' });
  });

  test('a STAMP-confirmed join with a different owner is still attributed — the stamp is the verdict', async () => {
    const res = await attributeResolvedLead(
      { id: 'c1', leadId: 'lead-a', customerId: 'cust-Y', stampedLeadId: 'lead-a' },
      { id: 'src' }, new Date(),
      makeTrx({ lead: { id: 'lead-a', customer_id: 'cust-X' } }),
    );
    // updateLeadAttribution's mocked update resolves falsy → stale-joined
    // path, NOT the ownership refusal.
    expect(res.reason).not.toBe('lead_owner_conflict');
  });

  test('a claimed lead on a CUSTOMER-LESS call is not a conflict (call → lead → customer progression)', async () => {
    const res = await attributeResolvedLead(
      { id: 'c1', leadId: 'lead-a', customerId: null, stampedLeadId: null },
      { id: 'src' }, new Date(),
      makeTrx({ lead: { id: 'lead-a', customer_id: 'cust-X' } }),
    );
    expect(res.reason).not.toBe('lead_owner_conflict');
  });
});

describe('whereCallStillLinked — sid arm yields to a settled dissenting stamp (codex P0, PR #3303 r8)', () => {
  const { whereCallStillLinked } = GoogleCallBridge._private;

  // Records the predicate tree the real query builder would receive, so the
  // fetch-before-repoint / apply-after-repoint shape is asserted on the
  // ACTUAL SQL fragments rather than a paraphrase.
  function recorder() {
    const node = { calls: [] };
    const handler = {
      get(_t, prop) {
        if (prop === 'calls') return node.calls;
        return (...args) => {
          const child = recorder();
          node.calls.push({ method: prop, args, child });
          for (const a of args) if (typeof a === 'function') a.call(child);
          return proxy;
        };
      },
    };
    const proxy = new Proxy(node, handler);
    return proxy;
  }

  function flatten(rec, out = []) {
    for (const c of rec.calls) {
      out.push({ method: c.method, sql: typeof c.args[0] === 'string' ? c.args[0] : null });
      flatten(c.child, out);
    }
    return out;
  }

  test('the sid arm is conditioned on the absence of a settled stamp naming another lead', () => {
    const rec = recorder();
    whereCallStillLinked(rec, 'call-1');
    const frags = flatten(rec).map((f) => f.sql).filter(Boolean);

    // Sid linkage is still an arm...
    expect(frags).toContain('call_log.twilio_call_sid = leads.twilio_call_sid');
    // ...but only when no SETTLED stamp dissents: absent stamp, agreeing
    // stamp, a live token, or a not-yet-'processed' pass all keep it.
    expect(frags).toContain("COALESCE(call_log.metadata->>'lead_id', '') = ''");
    expect(frags).toContain("call_log.metadata->>'lead_id' = leads.id::text");
    expect(frags).toContain("COALESCE(call_log.processing_status, '') <> 'processed'");
    // And the settled-stamp arm itself survives.
    const methods = flatten(rec).map((f) => f.method);
    expect(methods).toContain('orWhere');
    expect(methods).toContain('whereNull');
  });
});

describe('sidJoinAttributionElsewhere (codex P1, PR #3303 r15)', () => {
  const { sidJoinAttributionElsewhere } = GoogleCallBridge._private;
  // Minimal trx fake: the helper reads one provenanced row by source_call_id.
  const trxWith = (row) => () => ({ where: () => ({ first: async () => row }) });

  test("defers a stamp-less sid join when the call's provenanced row sits on ANOTHER lead", async () => {
    // The anonymous-repoint blind spot: call_log.customer_id NULL makes the
    // owner-conflict test unreachable, but the row on lead-B records the
    // repoint — accepting lead-A would transfer B's history back.
    const trx = trxWith({ id: 'row-1', lead_id: 'lead-B' });
    await expect(sidJoinAttributionElsewhere(trx, { id: 'call-1', leadId: 'lead-A' })).resolves.toBe(true);
  });

  test('accepts when the row is on the proposed lead, absent, or the join is stamp-confirmed', async () => {
    await expect(sidJoinAttributionElsewhere(trxWith({ id: 'row-1', lead_id: 'lead-A' }), { id: 'call-1', leadId: 'lead-A' })).resolves.toBe(false);
    await expect(sidJoinAttributionElsewhere(trxWith(undefined), { id: 'call-1', leadId: 'lead-A' })).resolves.toBe(false);
    // A stamp-confirmed join IS the processor's verdict — exempt even with
    // a row elsewhere (mirror of sidJoinOwnerConflict's exemption).
    await expect(sidJoinAttributionElsewhere(trxWith({ id: 'row-1', lead_id: 'lead-B' }), { id: 'call-1', leadId: 'lead-A', stampedLeadId: 'lead-A' })).resolves.toBe(false);
  });

  test('an ORPHANED row (lead hard-deleted, lead_id NULL) is NOT "elsewhere" — recovery must stay reachable (codex P1 r32)', async () => {
    // ad_service_attribution.lead_id is ON DELETE SET NULL; String(null)
    // read the orphan as a different lead and returned lead_owner_conflict
    // before recordCallPpcAttribution could reach
    // reconcileMovedCallAttributionRow's orphan-transfer arm.
    await expect(sidJoinAttributionElsewhere(trxWith({ id: 'row-1', lead_id: null }), { id: 'call-1', leadId: 'lead-A' })).resolves.toBe(false);
  });
});
