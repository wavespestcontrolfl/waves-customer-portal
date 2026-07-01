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
}), { virtual: true });

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'uuid-1'),
}), { virtual: true });

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
