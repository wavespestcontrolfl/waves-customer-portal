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
  resolveWdoDeclinedCatalogFallback,
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
  { id: 'svc-lawn-ot', service_key: 'lawn_care_one_time', name: 'One-Time Lawn Care Service', short_name: 'One-Time Lawn', category: 'lawn_care', billing_type: 'one_time', pricing_type: 'fixed', base_price: '125.00', default_duration_minutes: 45, requires_follow_up: false, follow_up_interval_days: null },
  { id: 'svc-lawn-6w', service_key: 'lawn_care_6week', name: 'Every 6 Weeks Lawn Care', short_name: '6-Week Lawn', category: 'lawn_care', billing_type: 'recurring', pricing_type: 'variable', base_price: null, default_duration_minutes: 45, requires_follow_up: false, follow_up_interval_days: null },
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

  test('does NOT downgrade when caller rejects a single treatment and wants the full two-visit package', () => {
    const transcript = "Caller: I don't want just a single treatment, I need the full package.\nAgent: Great, $350 covers both visits.";
    const v2 = {
      service_request: {
        specific_service_name: 'Cockroach Treatment Service',
        price: { amount_usd: 350, stated_by: 'agent', caller_response: 'accepted' },
      },
      scheduling: { status: 'confirmed', follow_up_mentioned: true },
    };
    const svc = resolveCallBookingCatalogService({
      extracted: {
        matched_service: 'Cockroach Treatment Service',
        specific_service_name: 'Cockroach Treatment Service',
        quoted_price: 350,
        follow_up_visit_mentioned: true,
      },
      v2Extraction: v2,
      services: SERVICES,
      transcription: transcript,
    });
    expect(svc?.service_key).toBe('cockroach_control');

    const plan = resolveCallFollowUpPlan({
      catalogRow: svc,
      extracted: { follow_up_visit_mentioned: true, quoted_price: 350 },
      v2Extraction: v2,
      transcription: transcript,
      parentDate: '2026-11-28',
      parentWindowStart: '16:00',
    });
    expect(plan).toMatchObject({ scheduledDate: '2026-12-12', windowStart: '16:00' });
  });

  test('full-price $350 Cockroach mentioning "one-time treatment" OR changing back to "two visits" keeps package Visit 2', () => {
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

    // Spoken order: "No second visit, actually make that two visits" -> final choice is two visits
    expect(isDiscountedSinglePackageTreatment({
      catalogRow: SERVICES[0],
      transcription: 'Caller: No second visit, actually make that two visits.',
      v2Extraction: { scheduling: { follow_up_mentioned: false }, service_request: {} },
    })).toBe(false);

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
  test('explicit WDO refusal stays refused even when agent later asks a lender question; holds via applyCatalogSelectionGuard if Waves Assessment missing', () => {
    const transcript = 'Caller: No, we do not need an official WDO inspection.\nAgent: Does the lender require a WDO?';
    const v2 = {
      scheduling: { status: 'confirmed' },
      service_request: { specific_service_name: 'WDO Inspection Service', primary_service_category: 'wdo' },
      meta: { call_summary: 'Caller declined official FDACS WDO inspection and only wants attic rodent sanitation assessment.' },
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

    // End-to-end without Waves Assessment: resolveCallBookingCatalogService returns null, AND applyCatalogSelectionGuard STILL sets genericBookingUnbookable=true
    const servicesNoAssess = SERVICES.filter((s) => s.service_key !== 'lawn_inspection');
    const resolvedNull = resolveCallBookingCatalogService({
      extracted: { specific_service_name: 'WDO Inspection Service' },
      services: servicesNoAssess,
      v2Extraction: v2,
      transcription: transcript,
    });
    expect(resolvedNull).toBeNull();
    const noAssessGuard = applyCatalogSelectionGuard({
      callBookingCatalogRow: resolvedNull,
      bookableCallServices: servicesNoAssess,
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
    const wdoQuestion = 'Caller: Why would I need a WDO? Wait no WDO, just do the general check please.';
    expect(resolveWdoDeclinedCatalogFallback({
      callBookingCatalogRow: SERVICES.find((s) => s.service_key === 'wdo_inspection'),
      bookableCallServices: SERVICES,
      transcription: wdoQuestion,
    })).toMatchObject({ service_key: 'lawn_inspection', name: 'Waves Assessment' });

    const wdoQuestionOnly = 'Caller: Why would I need a WDO?';
    expect(hasExplicitWdoRefusal({ transcription: wdoQuestionOnly })).toBe(false);

    const svc = resolveCallBookingCatalogService({
      extracted: { specific_service_name: 'WDO Inspection Service' },
      services: SERVICES,
      transcription: transcript,
    });
    expect(svc?.service_key).toBe('wdo_inspection');
  });

  test('preserves caller-only boundary on unidentified raw diarization ("Speaker 1:"/"Speaker 2:")', () => {
    const rawDiarized = 'Speaker 1: Do you want just a one-time treatment?\nSpeaker 2: No, I want monthly service.';
    expect(hasExplicitOneTimeOnlyIntent({ transcription: rawDiarized })).toBe(false);
    const svc = resolveCallBookingCatalogService({
      extracted: { specific_service_name: 'Monthly Pest Control Service' },
      services: SERVICES,
      transcription: rawDiarized,
    });
    expect(svc?.service_key).toBe('pest_general_monthly');
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

    // Also holds when general recurring is picked for one-time-only caller and the replacement row isn't bookable
    const servicesWithoutOneTime = SERVICES.filter((s) => s.service_key !== 'one_time_pest_control');
    const missingGeneralOneTime = resolveCallBookingCatalogService({
      extracted: { specific_service_name: 'Monthly Pest Control Service' },
      services: servicesWithoutOneTime,
      transcription: transcript,
    });
    expect(missingGeneralOneTime).toBeNull();
    const missingOneTimeGuardOut = applyCatalogSelectionGuard({
      callBookingCatalogRow: missingGeneralOneTime,
      bookableCallServices: servicesWithoutOneTime,
      extracted: { specific_service_name: 'Monthly Pest Control Service' },
      transcription: transcript,
    });
    expect(missingOneTimeGuardOut.genericBookingUnbookable).toBe(true);

    // Every 6 Weeks Lawn Care (category: 'lawn_care') downgrades cleanly to lawn_care_one_time
    expect(resolveCallBookingCatalogService({
      extracted: { specific_service_name: 'Every 6 Weeks Lawn Care' },
      services: SERVICES,
      transcription: 'Caller: I do not want recurring lawn service, just a one-time lawn treatment.',
    })?.service_key).toBe('lawn_care_one_time');

    // Explicit caller refusal of Visit 2 still suppresses Visit 2 even after staff mentioned follow-up
    expect(isDiscountedSinglePackageTreatment({
      catalogRow: SERVICES[0],
      extracted: { follow_up_visit_mentioned: true },
      v2Extraction: { scheduling: { status: 'confirmed', follow_up_mentioned: true, follow_up_start_at: null } },
      transcription: 'Agent: Normally it includes a second visit in two weeks.\nCaller: No second visit, just do the one treatment.',
    })).toBe(true);
    expect(resolveCallFollowUpPlan({
      extracted: { follow_up_visit_mentioned: true },
      catalogRow: SERVICES[1],
      parentDate: '2026-11-29',
      parentWindowStart: '16:00',
      v2Extraction: { scheduling: { status: 'confirmed', follow_up_mentioned: true, follow_up_start_at: null } },
      transcription: 'Agent: Normally it includes a second visit.\nCaller: No second visit, just do the one treatment.',
    })).toBeNull();

    // Negated one-time ("I do not want a one-time treatment") never downgrades a recurring service
    expect(resolveCallBookingCatalogService({
      extracted: { specific_service_name: 'Monthly Pest Control Service' },
      services: SERVICES,
      transcription: 'Caller: I do not want a one-time treatment.',
    })?.service_key).toBe('pest_general_monthly');
  });

  test('competitor monthly service ("monthly with them") never converts One-Time Pest, while pivot or separate-sentence monthly request promotes', () => {
    const competitorTranscript = 'Agent: How can I help?\nCaller: I just signed up for, like, a monthly service with them now that I do not even need, I want the one-time ant spray.';
    const outCompetitor = processorTest.applyRecurringIntentDefault(
      { is_lead: true, matched_service: 'One-Time Pest Control Service', specific_service_name: 'One-Time Pest Control Service' },
      competitorTranscript,
      SERVICES.map((s) => s.name),
      false,
    );
    expect(outCompetitor.specific_service_name).toBe('One-Time Pest Control Service');

    const pivotTranscript = 'Caller: I already have a plan with Orkin, now I want monthly service from Waves.';
    expect(processorTest.applyRecurringIntentDefault(
      { is_lead: true, matched_service: 'One-Time Pest Control Service', specific_service_name: 'One-Time Pest Control Service' },
      pivotTranscript,
      SERVICES.map((s) => s.name),
      false,
    ).specific_service_name).toBe('Monthly Pest Control Service');

    const contrastPivotTranscript = 'Caller: I already have a plan with Orkin, but I want monthly service from Waves.';
    expect(processorTest.applyRecurringIntentDefault(
      { is_lead: true, matched_service: 'One-Time Pest Control Service', specific_service_name: 'One-Time Pest Control Service' },
      contrastPivotTranscript,
      SERVICES.map((s) => s.name),
      false,
    ).specific_service_name).toBe('Monthly Pest Control Service');

    const competitorPlanTranscript = 'Caller: I have a monthly plan with Orkin. I want one one-time treatment.';
    expect(processorTest.applyRecurringIntentDefault(
      { is_lead: true, matched_service: 'One-Time Pest Control Service', specific_service_name: 'One-Time Pest Control Service' },
      competitorPlanTranscript,
      SERVICES.map((s) => s.name),
      false,
    ).specific_service_name).toBe('One-Time Pest Control Service');

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

  test('STT decimal mishear ($2.50) recovers only on FIXED catalog rows with corroborated quote; variable-price rows stay null', () => {
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

    // $3.00 vs $250 fixed catalog price without spoken "hundred" wording must NOT fabricate $300
    expect(recoverSttDecimalCallPrice({
      quotedPrice: 3.0,
      catalogRow: SERVICES[1],
      v2Extraction: {
        ...acceptedSttV2,
        service_request: {
          ...acceptedSttV2.service_request,
          quoted_price_usd: 3.0,
          price: { amount_usd: 3.0, amount_max_usd: null, stated_by: 'agent', caller_response: 'accepted', accepted: true, evidence_quote: 'That comes to $3.00.' },
        },
      },
    })).toBeNull();

    // $2.51 vs $250 fixed catalog price without spoken "hundred" wording must NOT fabricate $251
    expect(recoverSttDecimalCallPrice({
      quotedPrice: 2.51,
      catalogRow: SERVICES[1],
      v2Extraction: {
        ...acceptedSttV2,
        service_request: {
          ...acceptedSttV2.service_request,
          quoted_price_usd: 2.51,
          price: { amount_usd: 2.51, amount_max_usd: null, stated_by: 'agent', caller_response: 'accepted', accepted: true, evidence_quote: 'That comes to $2.51.' },
        },
      },
    })).toBeNull();

    // Contradictory implicit quote evidence ("$150" vs amount_usd: 250) must NOT bill $250
    expect(implicitConfirmedAgentPrice({
      scheduling: { status: 'confirmed' },
      service_request: {
        specific_service_name: 'Bee / Wasp Nest Removal Service',
        price_is_final: true,
        price_offered_by_staff: true,
        price_accepted_by_caller: false,
        price: { amount_usd: 250, unit: 'one_time', stated_by: 'agent', caller_response: 'no_response', accepted: false, evidence_quote: 'Bee removal is $150.' },
        prices: [],
      },
    }, SERVICES[2])).toBeNull();

    // per_application unit must not stamp an implicit one-time price without caller acceptance
    expect(implicitConfirmedAgentPrice({
      scheduling: { status: 'confirmed' },
      service_request: {
        specific_service_name: 'Bee / Wasp Nest Removal Service',
        price_is_final: true,
        price_offered_by_staff: true,
        price_accepted_by_caller: false,
        price: { amount_usd: 250, unit: 'per_application', stated_by: 'agent', caller_response: 'no_response', accepted: false, evidence_quote: 'Bee removal is $250 per application.' },
        prices: [],
      },
    }, SERVICES[2])).toBeNull();

    const variableCatalogRow = { ...SERVICES[3], pricing_type: 'variable', base_price: '250.00' };
    expect(recoverSttDecimalCallPrice({ quotedPrice: 2.5, catalogRow: variableCatalogRow, v2Extraction: {
      scheduling: { status: 'confirmed' },
      service_request: {
        specific_service_name: 'WDO Inspection Service',
        quoted_price_usd: 2.5,
        price_is_final: true,
        price_offered_by_staff: true,
        price_accepted_by_caller: true,
        price: { amount_usd: 2.5, amount_max_usd: null, stated_by: 'agent', caller_response: 'accepted', accepted: true, evidence_quote: 'That comes to $2.50.' },
      },
    } })).toBeNull();
  });
});

describe('PR A1: 60-minute callback price propagation (73b3b240 -> f391c6b9)', () => {
  beforeEach(() => { lockCustomerComms.mockClear(); });

  test('matches schema enums (`pest_general`, `lawn_care`), excludes `requested`/`offered` bookings and staff siblings, requires prior-visit link for named quotes too', async () => {
    const pestVisit = {
      id: 'visit-1',
      customer_id: 'cust-1',
      service_id: 'svc-onetime',
      service_type: 'One-Time Pest Control Service',
      scheduled_date: '2026-11-29',
      status: 'confirmed',
      source_action: 'ai_call_pipeline',
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
    const staffSibling = { ...pestVisit, id: 'visit-staff', source_action: 'admin_manual' };
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

    // Named quote WITHOUT explicit prior-visit link is rejected
    selectChain.select.mockResolvedValueOnce([pestVisit]);
    expect(await propagateCallbackPriceToRecentVisit({
      conn,
      call: { id: 'call-no-link', created_at: new Date('2026-11-28T15:30:00Z') },
      procToken: 'tok-1',
      customerId: 'cust-1',
      transcription: 'Caller: How much for One-Time Pest? Agent: $199. Caller: Sounds good.',
      v2Extraction: {
        scheduling: { status: 'unscheduled' },
        service_request: {
          specific_service_name: 'One-Time Pest',
          service_intent: 'new_booking_inquiry',
          price_is_final: true,
          price_accepted_by_caller: true,
          price: { amount_usd: 199, unit: 'one_time', stated_by: 'agent', caller_response: 'accepted', accepted: true },
        },
      },
    })).toEqual({ updated: false, reason: 'no_matching_unpriced_visit' });

    // scheduling.status='requested' (failed/incomplete new booking request) is rejected
    expect(await propagateCallbackPriceToRecentVisit({
      conn,
      call: { id: 'call-req', created_at: new Date('2026-11-28T15:30:00Z') },
      procToken: 'tok-1',
      customerId: 'cust-1',
      v2Extraction: {
        scheduling: { status: 'requested' },
        service_request: {
          specific_service_name: 'One-Time Pest',
          service_intent: 'follow_up_existing_service',
          price_is_final: true,
          price_accepted_by_caller: true,
          price: { amount_usd: 199, unit: 'one_time', stated_by: 'agent', caller_response: 'accepted', accepted: true },
        },
      },
    })).toEqual({ updated: false, reason: 'booking_attempt_call' });

    // Competing staff-booked sibling makes target ambiguous!
    selectChain.select.mockResolvedValueOnce([staffSibling, pestVisit]);
    expect(await propagateCallbackPriceToRecentVisit({
      conn,
      call: { id: 'call-staff-sib', created_at: new Date('2026-11-28T15:30:00Z') },
      procToken: 'tok-1',
      customerId: 'cust-1',
      transcription: 'Caller: Confirming the price for the earlier visit is $199.',
      v2Extraction: {
        scheduling: { status: 'unscheduled' },
        service_request: {
          specific_service_name: 'One-Time Pest',
          service_intent: 'follow_up_existing_service',
          price_is_final: true,
          price_accepted_by_caller: true,
          price: { amount_usd: 199, unit: 'one_time', stated_by: 'agent', caller_response: 'accepted', accepted: true },
        },
      },
    })).toEqual({ updated: false, reason: 'ambiguous_multiple_visits' });

    // follow_up_existing_service WITHOUT explicit prior-visit wording is rejected
    selectChain.select.mockResolvedValueOnce([pestVisit]);
    expect(await propagateCallbackPriceToRecentVisit({
      conn,
      call: { id: 'call-intent-only', created_at: new Date('2026-11-28T15:30:00Z') },
      procToken: 'tok-1',
      customerId: 'cust-1',
      transcription: 'Caller: How much is an extra ant spray? Agent: $199. Caller: Great.',
      v2Extraction: {
        scheduling: { status: 'unscheduled' },
        service_request: {
          specific_service_name: 'One-Time Pest',
          service_intent: 'follow_up_existing_service',
          price_is_final: true,
          price_accepted_by_caller: true,
          price: { amount_usd: 199, unit: 'one_time', stated_by: 'agent', caller_response: 'accepted', accepted: true },
        },
      },
    })).toEqual({ updated: false, reason: 'no_matching_unpriced_visit' });

    // Explicit separation from prior visit ("separate from the price for the booked visit") is rejected
    selectChain.select.mockResolvedValueOnce([pestVisit]);
    expect(await propagateCallbackPriceToRecentVisit({
      conn,
      call: { id: 'call-separate', created_at: new Date('2026-11-28T15:30:00Z') },
      procToken: 'tok-1',
      customerId: 'cust-1',
      transcription: 'Caller: That $199 is separate from the price for the booked visit.',
      v2Extraction: {
        scheduling: { status: 'none' },
        service_request: {
          specific_service_name: 'One-Time Pest',
          price_is_final: true,
          price_accepted_by_caller: true,
          price: { amount_usd: 199, unit: 'one_time', stated_by: 'agent', caller_response: 'accepted', accepted: true },
        },
      },
    })).toEqual({ updated: false, reason: 'no_matching_unpriced_visit' });

    // Agent question about earlier visit rejected by caller asking for a separate treatment is rejected
    selectChain.select.mockResolvedValueOnce([pestVisit]);
    expect(await propagateCallbackPriceToRecentVisit({
      conn,
      call: { id: 'call-rejected-q', created_at: new Date('2026-11-28T15:30:00Z') },
      procToken: 'tok-1',
      customerId: 'cust-1',
      transcription: 'Agent: Are you calling about the price for the earlier visit?\nCaller: No. I want a separate treatment for the shed.\nAgent: That is $199.\nCaller: Sounds good.',
      v2Extraction: {
        scheduling: { status: 'none' },
        service_request: {
          service_intent: 'new_booking_inquiry',
          specific_service_name: 'One-Time Pest',
          price_is_final: true,
          price_accepted_by_caller: true,
          price: { amount_usd: 199, unit: 'one_time', stated_by: 'agent', caller_response: 'accepted', accepted: true, evidence_quote: '$199 for the shed' },
        },
      },
    })).toEqual({ updated: false, reason: 'no_matching_unpriced_visit' });

    // Shadow-only (v2DrivesRouting=false) never propagates callback price
    expect(await syncCallbackPriceIfEligible({
      appointmentResult: { service: null, dateTime: null, scheduleCreated: false, smsSent: false, skippedReason: 'v2_routing_blocked' },
      extracted: { appointment_confirmed: false },
      procToken: 'tok-1',
      customerId: 'cust-1',
      isOutbound: false,
      conn,
      call: { id: 'call-shadow', created_at: new Date('2026-11-28T15:30:00Z') },
      transcription: 'Caller: Confirming the price for the earlier visit is $199.',
      v2DrivesRouting: false,
      v2CanonicalExtraction: {
        scheduling: { status: 'none' },
        service_request: {
          specific_service_name: 'One-Time Pest',
          price_is_final: true,
          price_accepted_by_caller: true,
          price: { amount_usd: 199, unit: 'one_time', stated_by: 'agent', caller_response: 'accepted', accepted: true },
        },
      },
    })).toEqual({ updated: false, reason: 'v2_routing_disabled' });

    // Unnamed pest_general quote must NOT match a Lawn Pest Knockdown visit
    selectChain.select.mockResolvedValueOnce([{
      ...pestVisit,
      id: 'visit-lawn-pest',
      service_type: 'Lawn Pest Knockdown',
      svc_key: 'lawn_pest_knockdown',
      svc_name: 'Lawn Pest Knockdown',
      svc_category: 'lawn_care',
    }]);
    expect(await propagateCallbackPriceToRecentVisit({
      conn,
      call: { id: 'call-lawn-mismatch', created_at: new Date('2026-11-28T15:30:00Z') },
      procToken: 'tok-1',
      customerId: 'cust-1',
      transcription: 'Caller: Confirming the price for the earlier visit is $199.',
      v2Extraction: {
        scheduling: { status: 'none' },
        service_request: {
          specific_service_name: null,
          primary_service_category: 'pest_general',
          price_is_final: true,
          price_accepted_by_caller: true,
          price: { amount_usd: 199, unit: 'one_time', stated_by: 'agent', caller_response: 'accepted', accepted: true },
        },
      },
    })).toEqual({ updated: false, reason: 'no_matching_unpriced_visit' });

    // Exact matching street + city + ZIP restatement succeeds (addressCity/addressZip shape)!
    const matchingLocalityVisit = {
      ...pestVisit,
      service_address_line1: '100 Main St',
      service_address_city: 'Sarasota',
      service_address_zip: '34232',
    };
    selectChain.select.mockResolvedValueOnce([matchingLocalityVisit]);
    callLockChain.first.mockResolvedValueOnce({ id: 'call-same-locality' });
    rowLockChain.first.mockResolvedValueOnce(matchingLocalityVisit);
    expect(await propagateCallbackPriceToRecentVisit({
      conn,
      call: { id: 'call-same-locality', created_at: new Date('2026-11-28T15:30:00Z') },
      procToken: 'tok-1',
      customerId: 'cust-1',
      transcription: 'Caller: Confirming the price for the earlier visit at 100 Main St in Sarasota 34232 is $199.',
      v2Extraction: {
        scheduling: { status: 'none' },
        property: { service_address: { street_line_1: '100 Main St', city: 'Sarasota', postal_code: '34232' } },
        service_request: {
          specific_service_name: 'One-Time Pest',
          service_intent: 'follow_up_existing_service',
          price_is_final: true,
          price_accepted_by_caller: true,
          price: { amount_usd: 199, unit: 'one_time', stated_by: 'agent', caller_response: 'accepted', accepted: true },
        },
      },
    })).toEqual({ updated: true, scheduledServiceId: 'visit-1', amount: 199 });

    // Competing visit city ("Venice" vs customer's "Sarasota") rejects callback price sync!
    selectChain.select.mockResolvedValueOnce([{
      ...pestVisit,
      service_address_line1: '100 Main St',
      service_address_city: 'Sarasota',
      service_address_zip: '34232',
    }]);
    expect(await propagateCallbackPriceToRecentVisit({
      conn,
      call: { id: 'call-diff-city', created_at: new Date('2026-11-28T15:30:00Z') },
      procToken: 'tok-1',
      customerId: 'cust-1',
      transcription: 'Caller: Confirming the price for the earlier visit at 100 Main St in Venice is $199.',
      v2Extraction: {
        scheduling: { status: 'none' },
        property: { service_address: { street_line_1: '100 Main St', city: 'Venice', postal_code: '34285' } },
        service_request: {
          specific_service_name: 'One-Time Pest',
          service_intent: 'follow_up_existing_service',
          price_is_final: true,
          price_accepted_by_caller: true,
          price: { amount_usd: 199, unit: 'one_time', stated_by: 'agent', caller_response: 'accepted', accepted: true },
        },
      },
    })).toEqual({ updated: false, reason: 'no_matching_unpriced_visit' });

    // Unnamed callback with schema enum `pest_general` + explicit prior-visit linkage SUCCEEDS via canonical V2 in enforce mode!
    selectChain.select.mockResolvedValueOnce([pestVisit]);
    callLockChain.first.mockResolvedValueOnce({ id: 'call-unnamed' });
    const unnamedMatched = await syncCallbackPriceIfEligible({
      appointmentResult: { service: null, dateTime: null, scheduleCreated: false, smsSent: false, skippedReason: 'v2_routing_blocked' },
      extracted: { appointment_confirmed: false },
      procToken: 'tok-1',
      customerId: 'cust-1',
      isOutbound: false,
      conn,
      call: { id: 'call-unnamed', created_at: new Date('2026-11-28T15:30:00Z'), twilio_call_sid: 'CA999' },
      callSid: 'CA999',
      transcription: 'Caller: Confirming the price for the earlier visit is $199.',
      v2DrivesRouting: true,
      v2CanonicalExtraction: {
        scheduling: { status: 'none' },
        service_request: {
          specific_service_name: null,
          primary_service_category: 'pest_general',
          price_is_final: true,
          price_accepted_by_caller: true,
          price: { amount_usd: 199, unit: 'one_time', stated_by: 'agent', caller_response: 'accepted', accepted: true },
          prices: [],
        },
      },
    });
    expect(lockCustomerComms).toHaveBeenCalledWith(trx, 'cust-1');
    expect(unnamedMatched).toEqual({ updated: true, scheduledServiceId: 'visit-1', amount: 199 });
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({
      estimated_price: 199,
      create_invoice_on_complete: true,
      internal_notes: 'Gate #4422\nPrice confirmed on follow-up call (CA999): $199.00.',
    }));
  });

  test('extractConfirmedCallbackOneTimePrice rejects V1-only and multi-property quotes', () => {
    expect(extractConfirmedCallbackOneTimePrice(null, { quoted_price: 199 })).toBeNull();
    expect(extractConfirmedCallbackOneTimePrice({
      property: { additional_properties: [{ street: '200 Second St' }] },
      service_request: {
        price_is_final: true,
        price_accepted_by_caller: true,
        price: { amount_usd: 199, unit: 'one_time', stated_by: 'agent', caller_response: 'accepted', accepted: true },
      },
    })).toBeNull();
  });

  test('processor wires applyCatalogSelectionGuard and syncCallbackPriceIfEligible', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    expect(src).toContain('applyCatalogSelectionGuard');
    expect(src).toContain('syncCallbackPriceIfEligible');
  });
});
