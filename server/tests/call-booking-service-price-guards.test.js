'use strict';

const fs = require('fs');
const path = require('path');

const {
  resolveCallBookingCatalogService,
  resolveCallBookingPrice,
  resolveCallFollowUpPlan,
  callBookingInvoiceOnComplete,
  hasExplicitWdoRefusal,
  hasExplicitOneTimeOnlyIntent,
  isDiscountedSinglePackageTreatment,
  implicitConfirmedAgentPrice,
  recoverSttDecimalCallPrice,
  applyCatalogSelectionGuard,
} = require('../services/call-booking-catalog');

jest.mock('../utils/customer-comms-lock', () => ({
  lockCustomerComms: jest.fn().mockResolvedValue(undefined),
}));
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const {
  propagateCallbackPriceToRecentVisit,
  syncCallbackPriceIfEligible,
  extractConfirmedCallbackOneTimePrice,
} = require('../services/call-callback-price-sync');
const { _test: processorTest } = require('../services/call-recording-processor');

const SERVICES = [
  { id: 'svc-roach', service_key: 'cockroach_control', name: 'Cockroach Treatment Service', short_name: 'Cockroach', billing_type: 'one_time', pricing_type: 'fixed', base_price: '350.00', default_duration_minutes: 60, requires_follow_up: true, follow_up_interval_days: 14 },
  { id: 'svc-onetime', service_key: 'one_time_pest_control', name: 'One-Time Pest Control Service', short_name: 'One-Time Pest', billing_type: 'one_time', pricing_type: 'fixed', base_price: '250.00', default_duration_minutes: 60, requires_follow_up: false, follow_up_interval_days: null },
  { id: 'svc-bee', service_key: 'bee_wasp_removal', name: 'Bee / Wasp Nest Removal Service', short_name: 'Bee / Wasp', billing_type: 'one_time', pricing_type: 'variable', base_price: null, default_duration_minutes: 60, requires_follow_up: false, follow_up_interval_days: null },
  { id: 'svc-wdo', service_key: 'wdo_inspection', name: 'WDO Inspection Service', short_name: 'WDO', billing_type: 'one_time', pricing_type: 'variable', base_price: '250.00', default_duration_minutes: 60, requires_follow_up: false, follow_up_interval_days: null },
  { id: 'svc-assess', service_key: 'lawn_inspection', name: 'Waves Assessment', short_name: 'Assessment', billing_type: 'one_time', pricing_type: 'variable', base_price: null, default_duration_minutes: 30, requires_follow_up: false, follow_up_interval_days: null },
  { id: 'svc-rodent-insp', service_key: 'rodent_inspection', name: 'Rodent Inspection Service', short_name: 'Rodent Insp', billing_type: 'one_time', pricing_type: 'variable', base_price: null, default_duration_minutes: 60, requires_follow_up: false, follow_up_interval_days: null },
  { id: 'svc-rodent-excl', service_key: 'rodent_exclusion', name: 'Rodent Exclusion Service', short_name: 'Rodent Excl', billing_type: 'one_time', pricing_type: 'variable', base_price: null, default_duration_minutes: 60, requires_follow_up: false, follow_up_interval_days: null },
  { id: 'svc-monthly', service_key: 'pest_general_monthly', name: 'Monthly Pest Control Service', short_name: 'Monthly Pest', billing_type: 'recurring', pricing_type: 'variable', base_price: null, default_duration_minutes: 45, requires_follow_up: false, follow_up_interval_days: null },
  { id: 'svc-rodent-bait', service_key: 'rodent_bait_station_program', name: 'Rodent Bait Station Program', short_name: 'Rodent Bait', billing_type: 'recurring', pricing_type: 'variable', base_price: null, default_duration_minutes: 45, requires_follow_up: false, follow_up_interval_days: null },
  { id: 'svc-lawn-ot', service_key: 'lawn_care_one_time', name: 'One-Time Lawn Care Service', short_name: 'One-Time Lawn', billing_type: 'one_time', pricing_type: 'fixed', base_price: '125.00', default_duration_minutes: 45, requires_follow_up: false, follow_up_interval_days: null },
];

describe('PR A1: package Visit 2 & single-treatment guards (call 819d3d1f)', () => {
  const priorGate = process.env.GATE_PACKAGE_FOLLOWUP_AUTOBOOK;
  beforeEach(() => { process.env.GATE_PACKAGE_FOLLOWUP_AUTOBOOK = 'true'; });
  afterEach(() => {
    if (priorGate === undefined) delete process.env.GATE_PACKAGE_FOLLOWUP_AUTOBOOK;
    else process.env.GATE_PACKAGE_FOLLOWUP_AUTOBOOK = priorGate;
  });

  test('explicit single $200 Cockroach treatment ("no second visit") downgrades to One-Time Pest Control Service and suppresses Visit 2', () => {
    const v2 = {
      scheduling: { status: 'confirmed', follow_up_mentioned: false, follow_up_start_at: null },
      service_request: {
        specific_service_name: 'Cockroach Treatment Service',
        quoted_price_usd: 200,
        price_is_final: true,
        price_accepted_by_caller: true,
        price: { amount_usd: 200, unit: 'one_time', stated_by: 'agent', caller_response: 'accepted', accepted: true },
      },
      meta: { call_summary: 'Caller agreed to a single $200 treatment, no second visit.' },
    };
    const extracted = { specific_service_name: 'Cockroach Treatment Service', quoted_price: 200, follow_up_visit_mentioned: false };

    const svc = resolveCallBookingCatalogService({ extracted, services: SERVICES, v2Extraction: v2 });
    expect(svc?.service_key).toBe('one_time_pest_control');
    expect(resolveCallBookingPrice({ quotedPrice: 200, catalogRow: svc, v2Extraction: v2 })).toEqual({ price: 200, source: 'transcript' });
    expect(resolveCallFollowUpPlan({ extracted, catalogRow: SERVICES[0], parentDate: '2026-11-28', parentWindowStart: '16:00', v2Extraction: v2 })).toBeNull();
  });

  test('full-price $350 Cockroach mentioning "one-time treatment" WITHOUT omitting Visit 2 keeps package Visit 2', () => {
    const v2 = {
      scheduling: { status: 'confirmed', follow_up_mentioned: false },
      service_request: {
        specific_service_name: 'Cockroach Treatment Service',
        quoted_price_usd: 350,
        price_is_final: true,
        price_accepted_by_caller: true,
        price: { amount_usd: 350, unit: 'one_time', stated_by: 'agent', caller_response: 'accepted', accepted: true },
      },
      meta: { call_summary: 'Caller booked a one-time treatment for cockroaches at $350.' },
    };
    const svc = resolveCallBookingCatalogService({
      extracted: { specific_service_name: 'Cockroach Treatment Service', quoted_price: 350 },
      services: SERVICES,
      v2Extraction: v2,
    });
    expect(svc?.service_key).toBe('cockroach_control');
    expect(resolveCallFollowUpPlan({
      extracted: { quoted_price: 350 },
      catalogRow: svc,
      parentDate: '2026-11-28',
      parentWindowStart: '16:00',
      v2Extraction: v2,
    })).toEqual({ scheduledDate: '2026-12-12', windowStart: '16:00', packageOnly: true });
  });

  test('earlier staff two-visit pitch overridden by caller final single-treatment choice suppresses Visit 2', () => {
    const transcript = 'Agent: Our cockroach package is normally two visits for $350.\nCaller: Just a single treatment, no second visit.';
    expect(isDiscountedSinglePackageTreatment({
      catalogRow: SERVICES[0],
      transcription: transcript,
      v2Extraction: { scheduling: { follow_up_mentioned: false }, service_request: {} },
    })).toBe(true);
  });
});

describe('PR A1: WDO refusal & Monthly-on-one-time guards (calls adeff525, a6848284)', () => {
  test('explicit WDO refusal stays refused even when agent later asks a lender question; holds if Waves Assessment is missing', () => {
    const transcript = 'Caller: No, we do not need an official WDO inspection.\nAgent: Does the lender require a WDO?';
    const v2 = {
      scheduling: { status: 'confirmed' },
      service_request: { specific_service_name: 'WDO Inspection Service', primary_service_category: 'wdo' },
      meta: { call_summary: 'Caller declined official FDACS WDO inspection and only wants attic assessment.' },
    };
    expect(hasExplicitWdoRefusal({ v2Extraction: v2, transcription: transcript })).toBe(true);
    const svc = resolveCallBookingCatalogService({
      extracted: { specific_service_name: 'WDO Inspection Service' },
      services: SERVICES,
      v2Extraction: v2,
      transcription: transcript,
    });
    expect(svc?.service_key).toBe('lawn_inspection');
    expect(resolveCallBookingPrice({ quotedPrice: 150, catalogRow: svc, v2Extraction: v2 })).toEqual({ price: null, source: null });
    expect(callBookingInvoiceOnComplete({ price: null, catalogRow: svc })).toBe(false);

    // If Waves Assessment row is unavailable in catalog, explicit hold prevents service_id=null booking
    const noAssessGuard = applyCatalogSelectionGuard({
      callBookingCatalogRow: SERVICES[3],
      bookableCallServices: SERVICES.filter((s) => s.service_key !== 'lawn_inspection'),
      extracted: { specific_service_name: 'WDO Inspection Service' },
      v2CanonicalExtraction: v2,
      transcription: transcript,
      genericBookingUnbookable: false,
    });
    expect(noAssessGuard.callBookingCatalogRow).toBeNull();
    expect(noAssessGuard.genericBookingUnbookable).toBe(true);
  });

  test('unrelated negation before comma ("No treatment, we need the official WDO report") keeps WDO Inspection Service', () => {
    const transcript = 'Caller: No treatment, we need the official WDO report for closing.';
    expect(hasExplicitWdoRefusal({ transcription: transcript })).toBe(false);
    const svc = resolveCallBookingCatalogService({
      extracted: { specific_service_name: 'WDO Inspection Service' },
      services: SERVICES,
      transcription: transcript,
    });
    expect(svc?.service_key).toBe('wdo_inspection');
  });

  test('explicit one-time-only caller downgrades general Monthly Pest Control, but holds specialty recurring booking via genericBookingUnbookable', () => {
    const transcript = "Caller: I don't want a monthly plan, just a one-time pest treatment please.";
    expect(hasExplicitOneTimeOnlyIntent({ transcription: transcript })).toBe(true);
    const generalSvc = resolveCallBookingCatalogService({
      extracted: { specific_service_name: 'Monthly Pest Control Service' },
      services: SERVICES,
      transcription: transcript,
    });
    expect(generalSvc?.service_key).toBe('one_time_pest_control');

    const specialtyExtracted = { specific_service_name: 'Rodent Bait Station Program' };
    const specialtyTranscript = "Caller: I don't want a monthly plan, just one time.";
    const specialtyHold = resolveCallBookingCatalogService({
      extracted: specialtyExtracted,
      services: SERVICES,
      transcription: specialtyTranscript,
    });
    expect(specialtyHold).toBeNull();
    const guardOut = applyCatalogSelectionGuard({
      callBookingCatalogRow: specialtyHold,
      bookableCallServices: SERVICES,
      extracted: specialtyExtracted,
      transcription: specialtyTranscript,
      genericBookingUnbookable: false,
    });
    expect(guardOut.genericBookingUnbookable).toBe(true);
  });

  test('competitor monthly service ("monthly with them") never converts One-Time Pest, while separate-sentence monthly request still promotes', () => {
    const competitorTranscript = 'Agent: How can I help?\nCaller: I just signed up for, like, a monthly service with them now that I do not even need, I want the one-time ant spray.';
    const outCompetitor = processorTest.applyRecurringIntentDefault(
      { is_lead: true, matched_service: 'One-Time Pest Control Service', specific_service_name: 'One-Time Pest Control Service' },
      competitorTranscript,
      SERVICES.map((s) => s.name),
      false,
    );
    expect(outCompetitor.specific_service_name).toBe('One-Time Pest Control Service');

    const ownMonthlyTranscript = 'Caller: I already have ants. I want monthly service.';
    const outOwn = processorTest.applyRecurringIntentDefault(
      { is_lead: true, matched_service: 'One-Time Pest Control Service', specific_service_name: 'One-Time Pest Control Service' },
      ownMonthlyTranscript,
      SERVICES.map((s) => s.name),
      false,
    );
    expect(outOwn.specific_service_name).toBe('Monthly Pest Control Service');
  });
});

describe('PR A1: final implicit confirmed agent price & STT decimal price recovery', () => {
  test('confirmed slot + single final unhedged staff quote matching booked service bills $250 (call b15db444)', () => {
    const beeWaspV2 = {
      scheduling: { status: 'confirmed' },
      service_request: {
        specific_service_name: 'Bee / Wasp Nest Removal Service',
        quoted_price_usd: null,
        price_is_final: true,
        price_offered_by_staff: true,
        price_accepted_by_caller: false,
        price: { amount_usd: 250, unit: 'one_time', stated_by: 'agent', caller_response: 'no_response', accepted: false, evidence_quote: 'Bee removal is 250.' },
        prices: [],
      },
    };
    expect(implicitConfirmedAgentPrice(beeWaspV2, SERVICES[2])).toEqual({ status: 'agreed', amount: 250 });
    const priced = resolveCallBookingPrice({ quotedPrice: null, catalogRow: SERVICES[2], v2Extraction: beeWaspV2 });
    expect(priced).toEqual({ price: 250, source: 'transcript' });
    expect(callBookingInvoiceOnComplete({ price: priced.price, catalogRow: SERVICES[2] })).toBe(true);
  });

  test('missing service name or V2 secondary_categories / additional_properties stays unpriced', () => {
    const missingSvcV2 = {
      scheduling: { status: 'confirmed' },
      service_request: {
        specific_service_name: null,
        price_is_final: true,
        price_offered_by_staff: true,
        price: { amount_usd: 250, unit: 'one_time', stated_by: 'agent', caller_response: 'no_response', accepted: false, evidence_quote: 'It is 250.' },
      },
    };
    expect(implicitConfirmedAgentPrice(missingSvcV2, SERVICES[2])).toBeNull();

    const secondaryCatV2 = {
      scheduling: { status: 'confirmed' },
      service_request: {
        specific_service_name: 'Bee / Wasp Nest Removal Service',
        secondary_categories: ['rodent'],
        price_is_final: true,
        price_offered_by_staff: true,
        price: { amount_usd: 250, unit: 'one_time', stated_by: 'agent', caller_response: 'no_response', accepted: false, evidence_quote: 'It is 250.' },
      },
    };
    expect(implicitConfirmedAgentPrice(secondaryCatV2, SERVICES[2])).toBeNull();
  });

  test('STT decimal mishear ($2.50) recovers only when corroborated; spoken "200 dollars" without $ fails cleanly', () => {
    const acceptedSttV2 = {
      scheduling: { status: 'confirmed' },
      service_request: {
        specific_service_name: 'One-Time Pest Control Service',
        quoted_price_usd: 2.5,
        price_is_final: true,
        price_offered_by_staff: true,
        price_accepted_by_caller: true,
        price: { amount_usd: 2.5, amount_max_usd: null, stated_by: 'agent', caller_response: 'accepted', accepted: true, evidence_quote: 'That comes to $2.50.' },
        prices: [],
      },
    };
    expect(resolveCallBookingPrice({ quotedPrice: 2.5, catalogRow: SERVICES[1], v2Extraction: acceptedSttV2 })).toEqual({ price: 250, source: 'transcript' });

    const spokenConflictV2 = {
      scheduling: { status: 'confirmed' },
      service_request: {
        specific_service_name: 'One-Time Pest Control Service',
        quoted_price_usd: 2.5,
        price_is_final: true,
        price_offered_by_staff: true,
        price_accepted_by_caller: true,
        price: { amount_usd: 2.5, amount_max_usd: null, stated_by: 'agent', caller_response: 'accepted', accepted: true, evidence_quote: 'Initial is 200 dollars.' },
        prices: [],
      },
    };
    expect(recoverSttDecimalCallPrice({ quotedPrice: 2.5, catalogRow: SERVICES[1], v2Extraction: spokenConflictV2 })).toBeNull();
  });
});

describe('PR A1: 60-minute callback price propagation (73b3b240 -> f391c6b9)', () => {
  beforeEach(() => { lockCustomerComms.mockClear(); });

  test('requires single final staff-stated caller-accepted V2 one-time quote and rejects V2 multi-category/property', () => {
    expect(extractConfirmedCallbackOneTimePrice({
      service_request: {
        price_is_final: true,
        price_accepted_by_caller: true,
        price: { amount_usd: 199, unit: 'one_time', stated_by: 'agent', caller_response: 'accepted', accepted: true },
        prices: [],
      },
    })).toBe(199);

    expect(extractConfirmedCallbackOneTimePrice({
      property: { additional_properties: [{ street: '200 Second St' }] },
      service_request: {
        price_is_final: true,
        price_accepted_by_caller: true,
        price: { amount_usd: 199, unit: 'one_time', stated_by: 'agent', caller_response: 'accepted', accepted: true },
      },
    })).toBeNull();
  });

  test('handles covered-sibling ambiguity, second-property address mismatch, cross-category unnamed quote, procToken ownership loss, and v2_routing_blocked non-booking callbacks', async () => {
    const pestVisit = {
      id: 'visit-1',
      customer_id: 'cust-1',
      service_id: 'svc-onetime',
      service_type: 'One-Time Pest Control Service',
      scheduled_date: '2026-11-29',
      status: 'confirmed',
      estimated_price: null,
      is_callback: false,
      followup_included: false,
      is_recurring: false,
      recurring_parent_id: null,
      service_address_line1: '100 Main St',
      service_address_city: 'Sarasota',
      service_address_zip: '34232',
      internal_notes: 'Gate #4422',
      svc_key: 'one_time_pest_control',
      svc_name: 'One-Time Pest Control Service',
      svc_billing_type: 'one_time',
    };
    const includedSibling = { ...pestVisit, id: 'visit-inc', followup_included: true };
    const updateSpy = jest.fn().mockResolvedValue(1);
    const selectChain = {
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockReturnThis(),
      whereRaw: jest.fn().mockReturnThis(),
      orderByRaw: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue([pestVisit]),
    };
    const rowLockChain = {
      where: jest.fn().mockReturnThis(),
      forUpdate: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(pestVisit),
      update: updateSpy,
    };
    const callLockChain = {
      where: jest.fn().mockReturnThis(),
      forUpdate: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ id: 'call-ok' }),
    };
    const svcChain = {
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ id: 'svc-onetime', service_key: 'one_time_pest_control', name: 'One-Time Pest Control Service', billing_type: 'one_time' }),
      select: jest.fn().mockResolvedValue(SERVICES),
    };
    const custChain = {
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ id: 'cust-1', address_line1: '100 Main St', city: 'Sarasota', state: 'FL', zip: '34232' }),
    };
    const invoiceChain = {
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    };
    const trx = jest.fn((table) => {
      if (table === 'scheduled_services as ss') return selectChain;
      if (table === 'scheduled_services') return rowLockChain;
      if (table === 'call_log') return callLockChain;
      if (table === 'services') return svcChain;
      if (table === 'customers') return custChain;
      if (table === 'invoices') return invoiceChain;
      return rowLockChain;
    });
    const conn = { transaction: jest.fn(async (fn) => fn(trx)) };

    // Included follow-up sibling + unpriced visit -> ambiguous!
    selectChain.select.mockResolvedValueOnce([includedSibling, pestVisit]);
    const withCoveredSibling = await propagateCallbackPriceToRecentVisit({
      conn,
      call: { id: 'call-1', created_at: new Date('2026-11-28T15:30:00Z') },
      procToken: 'tok-1',
      customerId: 'cust-1',
      v2Extraction: {
        scheduling: { status: 'unscheduled' },
        service_request: {
          specific_service_name: 'One-Time Pest',
          price_is_final: true,
          price_accepted_by_caller: true,
          price: { amount_usd: 199, unit: 'one_time', stated_by: 'agent', caller_response: 'accepted', accepted: true },
        },
      },
    });
    expect(withCoveredSibling).toEqual({ updated: false, reason: 'ambiguous_multiple_visits' });

    // Unnamed rodent callback must NOT price general_pest visit even with "price for the visit"
    selectChain.select.mockResolvedValueOnce([pestVisit]);
    const crossCategory = await propagateCallbackPriceToRecentVisit({
      conn,
      call: { id: 'call-2', created_at: new Date('2026-11-28T15:30:00Z') },
      procToken: 'tok-1',
      customerId: 'cust-1',
      transcription: 'Caller: Confirming the price for that visit is $199.',
      v2Extraction: {
        scheduling: { status: 'unscheduled' },
        service_request: {
          specific_service_name: null,
          primary_service_category: 'rodent',
          price_is_final: true,
          price_accepted_by_caller: true,
          price: { amount_usd: 199, unit: 'one_time', stated_by: 'agent', caller_response: 'accepted', accepted: true },
        },
      },
    });
    expect(crossCategory).toEqual({ updated: false, reason: 'no_matching_unpriced_visit' });

    // Visit on second property (200 Oak Ave) vs callback naming primary (100 Main St) -> rejected!
    selectChain.select.mockResolvedValueOnce([{ ...pestVisit, service_address_line1: '200 Oak Ave' }]);
    const wrongProperty = await propagateCallbackPriceToRecentVisit({
      conn,
      call: { id: 'call-3', created_at: new Date('2026-11-28T15:30:00Z') },
      procToken: 'tok-1',
      customerId: 'cust-1',
      v2Extraction: {
        property: { service_address: { street_line_1: '100 Main St', city: 'Sarasota', postal_code: '34232' } },
        scheduling: { status: 'unscheduled' },
        service_request: {
          specific_service_name: 'One-Time Pest Control Service',
          price_is_final: true,
          price_accepted_by_caller: true,
          price: { amount_usd: 199, unit: 'one_time', stated_by: 'agent', caller_response: 'accepted', accepted: true },
        },
      },
    });
    expect(wrongProperty).toEqual({ updated: false, reason: 'no_matching_unpriced_visit' });

    // Superseded processor (procToken mismatch under lock) -> aborts safely!
    selectChain.select.mockResolvedValueOnce([pestVisit]);
    callLockChain.first.mockResolvedValueOnce(null);
    const lostToken = await propagateCallbackPriceToRecentVisit({
      conn,
      call: { id: 'call-4', created_at: new Date('2026-11-28T15:30:00Z') },
      procToken: 'stale-token',
      customerId: 'cust-1',
      v2Extraction: {
        scheduling: { status: 'unscheduled' },
        service_request: {
          specific_service_name: 'One-Time Pest',
          price_is_final: true,
          price_accepted_by_caller: true,
          price: { amount_usd: 199, unit: 'one_time', stated_by: 'agent', caller_response: 'accepted', accepted: true },
        },
      },
    });
    expect(lostToken).toEqual({ updated: false, reason: 'call_ownership_lost' });
    expect(updateSpy).not.toHaveBeenCalled();

    // Processor-path syncCallbackPriceIfEligible ALLOWS non-booking `v2_routing_blocked` when no appointment requested!
    selectChain.select.mockResolvedValueOnce([pestVisit]);
    callLockChain.first.mockResolvedValueOnce({ id: 'call-5' });
    const routedPriceOnly = await syncCallbackPriceIfEligible({
      appointmentResult: { service: null, dateTime: null, scheduleCreated: false, smsSent: false, skippedReason: 'v2_routing_blocked' },
      extracted: { appointment_confirmed: false },
      procToken: 'tok-1',
      customerId: 'cust-1',
      isOutbound: false,
      conn,
      call: { id: 'call-5', created_at: new Date('2026-11-28T15:30:00Z'), twilio_call_sid: 'CA999' },
      callSid: 'CA999',
      v2ApprovedExtraction: {
        scheduling: { status: 'unscheduled' },
        service_request: {
          specific_service_name: 'One-Time Pest',
          price_is_final: true,
          price_accepted_by_caller: true,
          price: { amount_usd: 199, unit: 'one_time', stated_by: 'agent', caller_response: 'accepted', accepted: true },
          prices: [],
        },
      },
    });
    expect(routedPriceOnly).toEqual({ updated: true, scheduledServiceId: 'visit-1', amount: 199 });
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({
      estimated_price: 199,
      create_invoice_on_complete: true,
      internal_notes: 'Gate #4422\nPrice confirmed on follow-up call (CA999): $199.00.',
    }));
  });

  test('processor wires applyCatalogSelectionGuard and syncCallbackPriceIfEligible', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    expect(src).toContain('applyCatalogSelectionGuard');
    expect(src).toContain('syncCallbackPriceIfEligible');
  });
});
