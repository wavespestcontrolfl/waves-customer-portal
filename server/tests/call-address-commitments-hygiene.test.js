'use strict';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({ id: 'alert-outage-1', suppressed: false })),
}));

const { notifyAdmin } = require('../services/notification-service');
const { statesNewAddress, canAutoRoute } = require('../services/call-triage-flags');
const { V2_DECISION_VERSION, V2_DECISION_VERSIONS } = require('../services/call-routing-gates');
const { buildExtractionPromptParts } = require('../services/prompts/call-extraction-v1');
const {
  isCompetitorOrNonWavesComplaint,
  isActiveKnownCustomerCall,
  clearSpamForActiveCustomer,
  classifyExtractionError,
  buildSanitizedExtractionErrorPayload,
  maybeAlertExtractionOutage,
} = require('../services/call-hygiene-guards');

describe('PR A2: brand fix, routing version bump, and on-file partial address restatement', () => {
  test('V1 extraction prompt uses "Waves Pest Control" and V2_DECISION_VERSION is bumped to v2-1.51.0', () => {
    const { system } = buildExtractionPromptParts('Caller: test', '+19415550100', '2026-11-28', {});
    expect(system).toContain('Waves Pest Control');
    expect(system).not.toContain('Waves Pest Control & Lawn Care');
    expect(V2_DECISION_VERSION).toBe('v2-1.51.0');
    expect(V2_DECISION_VERSIONS).toContain('v2-1.51.0');
  });

  test('house-less single-typo street in matching locality and city-matching community count as on-file restatements', () => {
    const knownMaple = {
      id: 'cust-f1',
      hasAddress: true,
      addressTrusted: true,
      isExistingCustomer: true,
      addressLine1: '1234 Maplewood Rd',
      addressCity: 'Sampletown',
      addressState: 'FL',
      addressZip: '34200',
    };
    const typoEx = {
      confidence: 0.92,
      consent: { consent_to_text: true },
      triage_flags: ['address_unverified'],
      property: { service_address: { street_line_1: 'Mapliwood Rd', city: 'Sampletown', postal_code: '34200' } },
      service_request: { primary_service_category: 'pest_general', specific_service_name: 'One-Time Pest Control Service' },
      scheduling: {
        status: 'confirmed',
        confirmed_start_at: '2026-11-29T10:00:00-05:00',
        agent_committed_booking: true,
        caller_accepted_slot: true,
      },
    };
    expect(statesNewAddress(typoEx, knownMaple)).toBe(false);
    expect(canAutoRoute(typoEx, {
      contactPhone: '+19415550199',
      failOpen: true,
      knownCustomer: knownMaple,
      addressValidation: { status: 'missing_component', inServiceArea: true },
    })).toMatchObject({ allowed: true, usesOnFileAddress: true });

    // Without caller-stated city or ZIP (or with a partial/invalid ZIP), fuzzy street typo MUST still hold
    expect(statesNewAddress({
      property: { service_address: { street_line_1: 'Mapliwood Rd' } },
    }, knownMaple)).toBe(true);
    expect(statesNewAddress({
      property: { service_address: { street_line_1: 'Mapliwood Rd', postal_code: '342' } },
    }, knownMaple)).toBe(true);
    // Different-length street name ("Maplewoods Rd" vs "Maplewood Rd") must not fuzzy-match
    expect(statesNewAddress({
      property: { service_address: { street_line_1: 'Maplewoods Rd', city: 'Sampletown' } },
    }, knownMaple)).toBe(true);

    const knownBayview = {
      id: 'cust-f2',
      hasAddress: true,
      addressTrusted: true,
      isExistingCustomer: true,
      addressLine1: '5678 Oakridge Ln',
      addressCity: 'Bayview',
      addressState: 'FL',
      addressZip: '34201',
    };
    expect(statesNewAddress({
      confidence: 0.92,
      triage_flags: ['address_unverified'],
      property: { service_address: { subdivision_or_community: 'Bayview' } },
      scheduling: { status: 'confirmed' },
    }, knownBayview)).toBe(false);

    // Different house number, unknown community, or conflicting ZIP in community still holds
    expect(statesNewAddress({
      property: { service_address: { street_line_1: '1236 Mapliwood Rd', city: 'Sampletown' } },
    }, knownMaple)).toBe(true);
    expect(statesNewAddress({
      property: { service_address: { subdivision_or_community: 'Otherville' } },
    }, knownBayview)).toBe(true);
    expect(statesNewAddress({
      property: { service_address: { subdivision_or_community: 'Bayview 99999' } },
    }, knownBayview)).toBe(true);
    expect(statesNewAddress({
      property: { service_address: { subdivision_or_community: 'FL.' } },
    }, knownBayview)).toBe(true);
  });

  test('fuzzy street matching rejects conflicting suffixes, conflicting directions, and numbered streets', () => {
    const knownRoad = {
      id: 'cust-s1',
      hasAddress: true,
      addressLine1: '100 Maplewood Rd',
      addressCity: 'Sampletown',
      addressState: 'FL',
      addressZip: '34200',
    };
    expect(statesNewAddress({
      property: { service_address: { street_line_1: 'Maplewood Drive', city: 'Sampletown' } },
    }, knownRoad)).toBe(true);

    const knownPostDir = {
      id: 'cust-s2',
      hasAddress: true,
      addressLine1: '100 Maplewood Rd S',
      addressCity: 'Sampletown',
      addressState: 'FL',
      addressZip: '34200',
    };
    expect(statesNewAddress({
      property: { service_address: { street_line_1: 'Maplewood Rd N', city: 'Sampletown' } },
    }, knownPostDir)).toBe(true);

    const knownPreDir = {
      id: 'cust-s3',
      hasAddress: true,
      addressLine1: '100 N Maplewood Rd',
      addressCity: 'Sampletown',
      addressState: 'FL',
      addressZip: '34200',
    };
    expect(statesNewAddress({
      property: { service_address: { street_line_1: 'S Maplewood Rd', city: 'Sampletown' } },
    }, knownPreDir)).toBe(true);

    const knownNumbered = {
      id: 'cust-s4',
      hasAddress: true,
      addressLine1: '200 52nd Ave',
      addressCity: 'Sampletown',
      addressState: 'FL',
      addressZip: '34200',
    };
    expect(statesNewAddress({
      property: { service_address: { street_line_1: '53rd Ave', city: 'Sampletown' } },
    }, knownNumbered)).toBe(true);
  });
});

describe('PR A2: complaint alert guard, active-customer spam guard, and outage monitoring', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('suppresses only competitor-caused complaints and keeps Waves complaints even when caller threatens to switch', () => {
    expect(isCompetitorOrNonWavesComplaint({
      meta: { call_summary: 'Caller frustrated with Terminix missing their appointment and wants to switch to Waves.' },
      sentiment_and_lead: { objections_raised: ['Terminix never showed up last week'] },
    })).toBe(true);

    // Threatening to switch TO a competitor because Waves missed an appointment stays active
    expect(isCompetitorOrNonWavesComplaint({
      meta: { call_summary: 'Technician missed the appointment again. Caller plans to switch to Orkin.' },
      sentiment_and_lead: { objections_raised: ['Missed appointment'] },
    })).toBe(false);

    // Unclear attribution or mixed Waves complaint after competitor history stays active
    expect(isCompetitorOrNonWavesComplaint({
      meta: { call_summary: 'Caller unhappy with service and mentioned Orkin.' },
      sentiment_and_lead: { objections_raised: [] },
    })).toBe(false);
    expect(isCompetitorOrNonWavesComplaint({
      meta: { call_summary: 'Caller left Orkin last year. Waves was late today.' },
      sentiment_and_lead: { objections_raised: [] },
    })).toBe(false);
    expect(isCompetitorOrNonWavesComplaint({
      meta: { call_summary: 'Orkin overcharged me. I want a refund from Waves.' },
      sentiment_and_lead: { objections_raised: ['Orkin overcharged me', 'Refund requested'] },
    })).toBe(false);
    expect(isCompetitorOrNonWavesComplaint({
      meta: { call_summary: 'Orkin overcharged the caller last year. Waves canceled today\'s appointment without notice, and the caller wants an explanation.' },
      sentiment_and_lead: { objections_raised: [] },
    })).toBe(false);
    expect(isCompetitorOrNonWavesComplaint({
      meta: { call_summary: 'Orkin overcharged the caller last year. The technician never showed up today.' },
      sentiment_and_lead: { objections_raised: [] },
    })).toBe(false);

    expect(isCompetitorOrNonWavesComplaint({
      meta: { call_summary: 'Caller complained Waves technician missed the back lanai.' },
      sentiment_and_lead: { objections_raised: ['Your tech skipped the lanai'] },
    })).toBe(false);
  });

  test('blocks spam termination only for active existing customers with matching call customer_id', () => {
    expect(isActiveKnownCustomerCall({
      knownCaller: { id: 'cust-1', isExistingCustomer: true, pipelineStage: 'active_customer' },
      knownCallerLookupFailed: false,
      call: { customer_id: 'cust-1' },
    })).toBe(true);

    expect(isActiveKnownCustomerCall({
      knownCaller: { id: 'cust-lead', isExistingCustomer: false, pipelineStage: 'new_lead' },
      call: { customer_id: 'cust-lead' },
    })).toBe(false);
    expect(isActiveKnownCustomerCall({
      knownCaller: { id: 'cust-churned', isExistingCustomer: false, pipelineStage: 'churned' },
      call: { customer_id: 'cust-churned' },
    })).toBe(false);
    expect(isActiveKnownCustomerCall({
      knownCaller: { id: 'cust-1', isExistingCustomer: true, pipelineStage: 'active_customer' },
      call: { customer_id: 'cust-other' },
    })).toBe(false);
    expect(isActiveKnownCustomerCall({
      knownCaller: { id: 'cust-1', isExistingCustomer: true, pipelineStage: 'active_customer' },
      call: { customer_id: null },
    })).toBe(false);
    expect(isActiveKnownCustomerCall({
      knownCaller: { id: 'cust-1', isExistingCustomer: true },
      knownCallerLookupFailed: true,
      call: { customer_id: 'cust-1' },
    })).toBe(false);

    const extracted = { is_spam: true };
    clearSpamForActiveCustomer({
      extracted,
      knownCaller: { id: 'cust-1', isExistingCustomer: true },
      call: { customer_id: 'cust-1' },
    });
    expect(extracted.is_spam).toBe(false);
  });

  test('classifies extraction errors to allowlisted fields only, queries recorded failure timestamps, and validates outage alert via real composeAdminAlert', async () => {
    const rawSecretErr = Object.assign(
      new Error('429 Rate limit exceeded: {"transcript":"Customer Jane secret text","key":"sk-live-secret"}'),
      { status: 429 },
    );
    expect(classifyExtractionError(rawSecretErr)).toEqual({ category: 'rate_limit', status: 429 });
    expect(classifyExtractionError(new Error('Gemini API 500: Internal server error'))).toEqual({
      category: 'provider_5xx',
      status: 500,
    });

    const payload = JSON.parse(buildSanitizedExtractionErrorPayload(
      rawSecretErr,
      new Date('2026-11-28T08:00:00Z'),
    ));
    expect(payload).toEqual({
      category: 'rate_limit',
      status: 429,
      at: '2026-11-28T08:00:00.000Z',
    });
    expect(JSON.stringify(payload)).not.toContain('sk-live-secret');
    expect(JSON.stringify(payload)).not.toContain('Customer Jane');

    const rawSqlCalls = [];
    const mockDbWithCount = (n) => jest.fn(() => {
      const chain = {
        whereRaw: jest.fn((sql, bindings) => {
          rawSqlCalls.push({ sql, bindings });
          return chain;
        }),
        count: jest.fn(() => chain),
        first: jest.fn().mockResolvedValue({ n: String(n) }),
      };
      return chain;
    });

    await maybeAlertExtractionOutage({ db: mockDbWithCount(2), err: rawSecretErr, now: new Date('2026-11-28T08:00:00Z') });
    expect(notifyAdmin).not.toHaveBeenCalled();

    const alertResult = await maybeAlertExtractionOutage({
      db: mockDbWithCount(3),
      err: rawSecretErr,
      now: new Date('2026-11-28T08:00:00Z'),
    });
    expect(rawSqlCalls.some((c) => /last_extraction_error.*at.*>=/.test(c.sql) && c.bindings?.[0] === '2026-11-28T07:00:00.000Z')).toBe(true);
    expect(alertResult).toEqual({ id: 'alert-outage-1', suppressed: false });
    expect(notifyAdmin).toHaveBeenCalledWith(
      'agents',
      'System — check call extraction failures',
      '3 calls failed extraction in the last hour.',
      expect.objectContaining({
        bell: true,
        link: '/admin/agents',
        dedupeKey: 'call-extraction-outage:60m',
        dedupeOpenOnly: true,
        metadata: expect.objectContaining({
          area: 'System',
          severity: 'needs-you',
          doneWhen: 'extraction_recovers',
          who: 'person',
          category: 'rate_limit',
          status: 429,
        }),
      }),
    );
    expect(notifyAdmin.mock.calls[0][3].detail).not.toContain('sk-live-secret');
  });
});
