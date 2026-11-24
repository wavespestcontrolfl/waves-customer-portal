const {
  decorateCalls,
  _private: {
    callableCallerKey,
    currentETMonthWindow,
    leadLinkage,
    leadMatchesOwner,
    relatedLeadId,
    shapeCurrentMonthRows,
    sourceEvidence,
  },
} = require('../services/call-log-analytics');

const CALL_1 = '11111111-1111-4111-8111-111111111111';
const CALL_2 = '22222222-2222-4222-8222-222222222222';
const CALL_3 = '33333333-3333-4333-8333-333333333333';
const CALL_4 = '44444444-4444-4444-8444-444444444444';
const LEAD_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LEAD_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('call-log analytics', () => {
  test('uses Eastern calendar-month boundaries, including the UTC day before ET midnight', () => {
    const february = currentETMonthWindow(new Date('2026-03-01T04:30:00.000Z'));
    expect(february).toMatchObject({
      timezone: 'America/New_York',
      start: '2026-02-01',
      end_exclusive: '2026-03-01',
    });
    expect(february.startInstant.toISOString()).toBe('2026-02-01T05:00:00.000Z');
    expect(february.endInstant.toISOString()).toBe('2026-03-01T05:00:00.000Z');

    const march = currentETMonthWindow(new Date('2026-03-01T05:01:00.000Z'));
    expect(march.start).toBe('2026-03-01');
    expect(march.endInstant.toISOString()).toBe('2026-04-01T04:00:00.000Z');
  });

  test('normalizes callable caller identities and suppresses unknown/impossible values', () => {
    expect(callableCallerKey('(941) 555-1234')).toBe('9415551234');
    expect(callableCallerKey('+1 941 555 1234')).toBe('9415551234');
    expect(callableCallerKey('+442079460958')).toBe('+442079460958');
    expect(callableCallerKey('anonymous')).toBeNull();
    expect(callableCallerKey('+11234567890')).toBeNull();
  });

  test('attributes only dedicated line evidence and keeps shared hub/office and AI labels unknown', () => {
    const hub = sourceEvidence({
      to_phone: '+19412975749',
      _source_name: 'Main Site (wavespestcontrol.com)',
      _source_type: 'main_site',
      _source_domain: 'wavespestcontrol.com',
      metadata: { city: 'Bradenton', source: 'website' },
    });
    expect(hub).toEqual(expect.objectContaining({ kind: 'unknown', label: 'Source unknown' }));
    expect(hub.basis).toMatch(/shared by the office and website/i);

    expect(sourceEvidence({
      to_phone: '+19413187612',
      _source_name: 'Website — Bradenton (city page)',
      _source_type: 'main_site',
      _source_domain: 'wavespestcontrol.com',
    })).toEqual(expect.objectContaining({ kind: 'unknown', label: 'Source unknown' }));

    expect(sourceEvidence({
      to_phone: '+19412402066',
      _source_name: 'Main Site — North Port page',
      _source_type: 'main_site',
      _source_domain: 'wavespestcontrol.com',
    })).toEqual({
      kind: 'website',
      label: 'Website',
      detail: 'Website · wavespestcontrol.com',
      basis: 'The dialed number is currently assigned only to this website placement.',
    });

    // The website-only line (2026-11-19) is a dedicated website placement, and
    // the registry alone proves it even before its source row exists.
    expect(sourceEvidence({ to_phone: '+19412542617' }))
      .toEqual(expect.objectContaining({ kind: 'website', label: 'Website' }));
    expect(sourceEvidence({
      to_phone: '+19412542617', _source_name: 'Main Site — web-only line (wavespestcontrol.com)',
      _source_type: 'main_site', _source_domain: 'wavespestcontrol.com',
    })).toEqual(expect.objectContaining({ kind: 'website', detail: 'Website · wavespestcontrol.com' }));

    // No DB source row: the code-owned line registry still proves this is a
    // dedicated domain line, never a geography/timing guess.
    expect(sourceEvidence({ to_phone: '+19412535279' }))
      .toEqual(expect.objectContaining({ kind: 'website', label: 'Website' }));

    // A call-time stamp wins over today's registry assignment, so a number
    // that was reassigned later is not presented with false historical precision.
    expect(sourceEvidence({
      to_phone: '+19412402066',
      _source_type: 'main_site',
      _source_domain: 'wavespestcontrol.com',
      metadata: { numberType: 'gbp_tracking', location: 'GBP — Sarasota' },
    })).toEqual(expect.objectContaining({
      kind: 'google_business', detail: 'Maps listing · Sarasota',
      basis: expect.stringMatching(/When the call arrived/),
    }));

    expect(sourceEvidence({ to_phone: '+19412691697', _source_name: 'Google Ads — Pest', _source_type: 'google_ads' }))
      .toEqual(expect.objectContaining({ kind: 'google_ads', label: 'Google Ads' }));
    expect(sourceEvidence({ to_phone: '+19418775491', _source_name: 'Facebook Ads — Pest', _source_type: 'facebook' }))
      .toEqual(expect.objectContaining({ kind: 'meta_ads', label: 'Meta Ads' }));
    expect(sourceEvidence({ to_phone: '+19413521572', _source_name: 'GBP — Bradenton', _source_type: 'gbp' }))
      .toEqual(expect.objectContaining({ kind: 'google_business', label: 'Google Business Profile', detail: 'Maps listing · Bradenton' }));
    expect(sourceEvidence({ to_phone: '+19412412459', _source_name: 'Vehicle Decal', _source_type: 'vehicle' }))
      .toEqual(expect.objectContaining({ kind: 'offline', label: 'Offline' }));
    expect(sourceEvidence({ to_phone: '+18559260203', _source_name: 'AI Agent', _source_type: 'ai_agent' }))
      .toEqual(expect.objectContaining({ kind: 'unknown', label: 'Source unknown' }));
  });

  test('an accepted Google call-report match outranks shared-line ambiguity, but a proposal does not', () => {
    const sharedLine = {
      to_phone: '+19412975749',
      _source_name: 'Waves Main Line',
      _source_type: 'main_site',
      _source_domain: 'wavespestcontrol.com',
    };
    expect(sourceEvidence({
      ...sharedLine,
      google_ads_call_resource_name: 'customers/1/callViews/accepted',
      metadata: { google_ads_call_bridge: { campaignName: 'Brand' } },
    })).toEqual({
      kind: 'google_ads',
      label: 'Google Ads',
      detail: 'Matched call report',
      basis: 'Google Ads call reporting matched this call to an ad interaction.',
    });
    expect(sourceEvidence({
      ...sharedLine,
      metadata: { google_ads_call_bridge: { proposedResourceName: 'customers/1/callViews/proposal' } },
    })).toEqual(expect.objectContaining({ kind: 'unknown', label: 'Source unknown' }));
    expect(sourceEvidence({ ...sharedLine, google_ads_call_resource_name: '   ' }))
      .toEqual(expect.objectContaining({ kind: 'unknown', label: 'Source unknown' }));
  });

  test('monthly source groups preserve every call and combine identical evidence', () => {
    const window = currentETMonthWindow(new Date('2026-11-18T17:00:00.000Z'));
    const result = shapeCurrentMonthRows([
      { to_phone: '+19412691697', _source_name: 'Google Ads — Pest', _source_type: 'google_ads', count: '3' },
      { to_phone: '+19412691697', _source_name: 'Google Ads — Pest', _source_type: 'google_ads', count: 2 },
      { to_phone: '+19413521572', _source_name: 'GBP — Bradenton', _source_type: 'gbp', count: '4' },
      { to_phone: '+19412975749', _source_name: 'Waves Main Line', _source_type: 'main_site', count: '5' },
      { to_phone: '+19412975749', _source_name: 'Waves Main Line', _source_type: 'main_site', _google_ads_call_confirmed: true, count: '2' },
    ], window);

    expect(result).toMatchObject({
      timezone: 'America/New_York',
      start: '2026-11-01',
      end_exclusive: '2026-12-01',
      total: 16,
    });
    expect(result.sources.map((row) => row.count).reduce((sum, count) => sum + count, 0)).toBe(result.total);
    expect(result.sources).toEqual(expect.arrayContaining([
      { kind: 'google_ads', label: 'Google Ads', detail: 'Google Ads — Pest', count: 5 },
      { kind: 'google_business', label: 'Google Business Profile', detail: 'Maps listing · Bradenton', count: 4 },
      expect.objectContaining({ kind: 'unknown', label: 'Source unknown', count: 5 }),
      { kind: 'google_ads', label: 'Google Ads', detail: 'Matched call report', count: 2 },
    ]));
  });

  test('decorates a page with all-history caller order and deterministic lead links in set queries', async () => {
    const calls = [
      {
        id: CALL_1,
        direction: 'inbound',
        from_phone: '(941) 555-1234',
        to_phone: '+19412691697',
        metadata: JSON.stringify({ lead_id: LEAD_1 }),
        twilio_call_sid: 'CA1',
        _source_name: 'Google Ads — Pest',
        _source_type: 'google_ads',
      },
      {
        id: CALL_2,
        direction: 'inbound',
        from_phone: '+19415551234',
        to_phone: '+19412402066',
        metadata: {},
        twilio_call_sid: 'CA2',
        _source_name: 'Main Site — North Port page',
        _source_type: 'main_site',
        _source_domain: 'wavespestcontrol.com',
      },
      { id: CALL_3, direction: 'inbound', from_phone: 'anonymous', to_phone: '+19412975749', metadata: {}, twilio_call_sid: 'CA3' },
      { id: CALL_4, direction: 'outbound', from_phone: '+19412975749', to_phone: '+19415551234', metadata: {} },
    ];
    const db = fakeAnalyticsDb({
      firstCalls: [{ caller_key: '9415551234', first_call_id: CALL_1 }],
      stampedLeads: [{ id: LEAD_1, status: 'new' }],
      sidLeads: [
        { id: LEAD_2, status: 'contacted', twilio_call_sid: 'CA2' },
        { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'new', twilio_call_sid: 'CA3' },
        { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', status: 'lost', twilio_call_sid: 'CA3' },
      ],
    });

    const decorated = await decorateCalls(db, calls);
    expect(decorated.map((call) => call.caller_history)).toEqual(['first', 'returning', null, null]);
    expect(decorated[0].related_lead).toEqual({ id: LEAD_1, status: 'new' });
    expect(decorated[1].related_lead).toEqual({ id: LEAD_2, status: 'contacted' });
    expect(decorated[2].related_lead).toBeNull();
    expect(decorated[0]._source_name).toBeUndefined();
    expect(db.tables).toEqual(['call_log as h', 'leads', 'leads']);
  });

  test('a malformed explicit lead stamp fails closed instead of becoming a lead id', () => {
    expect(relatedLeadId({ metadata: { lead_id: 'not-a-uuid' } })).toBeNull();
  });

  test('lead links fail closed while reprocessing, after manual unlink, or on conflicting stamps', () => {
    expect(leadLinkage({
      processing_token: 'owned-pass', processing_status: 'processing',
      twilio_call_sid: 'CA1', metadata: { lead_id: LEAD_1 },
    })).toEqual({ kind: 'blocked', reason: 'call_unsettled' });
    expect(leadLinkage({
      processing_token: null, processing_status: 'processed', twilio_call_sid: 'CA1',
      metadata: { customer_link_override: { customer_id: null } },
    })).toEqual({ kind: 'blocked', reason: 'operator_unlinked' });
    expect(leadLinkage({
      processing_token: null, processing_status: 'processed',
      metadata: { lead_id: LEAD_1, relay_lead_id: LEAD_2 },
    })).toEqual({ kind: 'blocked', reason: 'conflicting_stamps' });
    expect(leadLinkage({
      processing_token: null, processing_status: 'processed', twilio_call_sid: 'CA-rejected',
      metadata: { no_attribution: true },
    })).toEqual({ kind: 'blocked', reason: 'no_attribution' });
  });

  test('decoration never turns a rejected call SID into a confirmed acquisition', async () => {
    const db = fakeAnalyticsDb({
      firstCalls: [],
      stampedLeads: [],
      sidLeads: [{ id: LEAD_1, status: 'new', twilio_call_sid: 'CA-rejected' }],
    });
    const [call] = await decorateCalls(db, [{
      id: CALL_1,
      direction: 'inbound',
      from_phone: '+19415551234',
      twilio_call_sid: 'CA-rejected',
      processing_token: null,
      processing_status: 'processed',
      google_ads_call_resource_name: 'customers/1/callViews/rejected-acquisition',
      metadata: { no_attribution: true },
    }]);
    expect(call.related_lead).toBeNull();
    expect(call.source_evidence).toEqual(expect.objectContaining({ kind: 'google_ads', label: 'Google Ads' }));
    expect(db.tables).toEqual(['call_log as h']);
  });

  test('settled links honor explicit customer ownership', () => {
    const linkage = leadLinkage({
      customer_id: 'customer-a', processing_token: null, processing_status: 'processed',
      metadata: { lead_id: LEAD_1, customer_link_override: { customer_id: 'customer-b' } },
    });
    expect(linkage).toMatchObject({ kind: 'stamped', leadId: LEAD_1, ownerId: 'customer-b' });
    expect(leadMatchesOwner({ id: LEAD_1, customer_id: 'customer-b' }, linkage)).toBe(true);
    expect(leadMatchesOwner({ id: LEAD_1, customer_id: 'customer-a' }, linkage)).toBe(false);
  });

  test('decoration exposes no provisional lead while a reprocess owns the call', async () => {
    const db = fakeAnalyticsDb({
      firstCalls: [],
      stampedLeads: [{ id: LEAD_1, status: 'won', customer_id: 'customer-a' }],
      sidLeads: [{ id: LEAD_2, status: 'won', customer_id: 'customer-a', twilio_call_sid: 'CA-reprocessing' }],
    });
    const [call] = await decorateCalls(db, [{
      id: CALL_1,
      direction: 'outbound',
      twilio_call_sid: 'CA-reprocessing',
      processing_token: 'worker-claim',
      processing_status: 'processing',
      metadata: { lead_id: LEAD_1 },
    }]);
    expect(call.related_lead).toBeNull();
    expect(db.tables).toEqual([]);
  });

  test('decoration suppresses a settled lead owned by a different customer', async () => {
    const db = fakeAnalyticsDb({
      firstCalls: [],
      stampedLeads: [{ id: LEAD_1, status: 'won', customer_id: 'customer-b' }],
      sidLeads: [],
    });
    const [call] = await decorateCalls(db, [{
      id: CALL_1,
      direction: 'outbound',
      customer_id: 'customer-a',
      processing_token: null,
      processing_status: 'processed',
      metadata: { lead_id: LEAD_1 },
    }]);
    expect(call.related_lead).toBeNull();
  });
});

function fakeAnalyticsDb({ firstCalls, stampedLeads, sidLeads }) {
  const tables = [];
  const db = (table) => {
    tables.push(table);
    if (table === 'call_log as h') {
      const builder = {};
      for (const method of ['where', 'modify', 'whereRaw', 'select']) builder[method] = () => builder;
      builder.groupByRaw = async () => firstCalls;
      return builder;
    }
    if (table === 'leads') {
      let key = null;
      const builder = {
        whereIn(column) { key = column; return builder; },
        whereNull() { return builder; },
        async select() { return key === 'id' ? stampedLeads : sidLeads; },
      };
      return builder;
    }
    throw new Error(`Unexpected table ${table}`);
  };
  db.raw = (sql) => sql;
  db.tables = tables;
  return db;
}
