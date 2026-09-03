const {
  MIN_AUTOMATION_CONFIDENCE,
  automationNote,
  buildAutomatedLeadDraftEstimate,
  confidenceMeetsMinimum,
  evaluateLeadEstimateAutomationReadiness,
  hasConcreteServiceInterest,
  mapServiceInterestToEstimateServices,
} = require('../services/lead-estimate-automation');
const leadWebhookRouter = require('../routes/lead-webhook');

describe('lead estimate automation gate', () => {
  const { buildLeadWebhookIntake } = leadWebhookRouter._test;

  test('defaults the automation threshold to medium confidence', () => {
    expect(MIN_AUTOMATION_CONFIDENCE).toBe('medium');
    expect(confidenceMeetsMinimum('medium')).toBe(true);
    expect(confidenceMeetsMinimum('high')).toBe(true);
    expect(confidenceMeetsMinimum('low')).toBe(false);
  });

  test('allows medium-confidence leads when phone, address, and service are present', () => {
    const readiness = evaluateLeadEstimateAutomationReadiness({
      phone: '+19415550199',
      intake: {
        serviceInterest: 'Recurring Mosquito Control',
        normalizedAddress: {
          line1: '123 Main St',
          state: 'FL',
        },
      },
    });

    expect(readiness).toMatchObject({
      status: 'ready',
      ready: true,
      confidence: 'medium',
      minimumConfidence: 'medium',
      missing: [],
      review: expect.arrayContaining(['city_or_zip_missing', 'email_missing_sms_only']),
      serviceInterest: 'Recurring Mosquito Control',
    });
  });

  test('blocks leads missing a concrete requested service', () => {
    expect(hasConcreteServiceInterest('Pest Control Consultation')).toBe(false);
    expect(hasConcreteServiceInterest('Other Services')).toBe(false);
    // The email-lead default label is a placeholder, never a service.
    expect(hasConcreteServiceInterest('General inquiry')).toBe(false);
    expect(hasConcreteServiceInterest('General question about service')).toBe(false);
    expect(hasConcreteServiceInterest('One-Time Termite Treatment')).toBe(true);

    const readiness = evaluateLeadEstimateAutomationReadiness({
      phone: '+19415550199',
      intake: {
        serviceInterest: 'Pest Control Consultation',
        normalizedAddress: {
          line1: '123 Main St',
          city: 'Venice',
          state: 'FL',
          zip: '34285',
        },
        email: 'lead@example.com',
      },
    });

    expect(readiness).toMatchObject({
      status: 'blocked',
      ready: false,
      confidence: 'low',
      missing: ['specific_service'],
    });
  });

  test('summarizes automation status for draft estimate notes', () => {
    const note = automationNote({
      status: 'blocked',
      confidence: 'low',
      minimumConfidence: 'medium',
      missing: ['street_address'],
      review: ['email_missing_sms_only'],
    });

    expect(note).toBe('Automation gate: blocked | confidence=low | minimum=medium | missing=street_address | review=email_missing_sms_only.');
  });

  test('maps ready recurring pest and lawn interest to priced estimate services', () => {
    const mapped = mapServiceInterestToEstimateServices('Recurring Pest Control + Lawn Care');
    expect(mapped).toMatchObject({
      supported: true,
      services: {
        pest: { frequency: 'quarterly' },
        lawn: { track: 'st_augustine', tier: 'enhanced' },
      },
    });
  });

  test('keeps lawn aeration and plugging out of automated estimate generation', () => {
    expect(mapServiceInterestToEstimateServices('Lawn Aeration & Plugging')).toMatchObject({
      supported: false,
      services: {},
      unsupportedReason: 'lawn_aeration_plugging_requires_manual_scope',
    });

    expect(mapServiceInterestToEstimateServices('Recurring Lawn Care + Core Plugging')).toMatchObject({
      supported: false,
      services: {},
      unsupportedReason: 'lawn_aeration_plugging_requires_manual_scope',
    });
  });

  test('generates draft estimate data for a ready lead without sending it', () => {
    const readiness = evaluateLeadEstimateAutomationReadiness({
      phone: '+19415550199',
      intake: {
        email: 'lead@example.com',
        serviceInterest: 'Recurring Mosquito Control',
        normalizedAddress: {
          line1: '123 Main St',
          city: 'Venice',
          state: 'FL',
          zip: '34285',
        },
      },
    });

    const draft = buildAutomatedLeadDraftEstimate({
      readiness,
      intake: {
        serviceInterest: 'Recurring Mosquito Control',
        fullAddress: '123 Main St, Venice, FL 34285',
      },
      body: {
        homeSqFt: 2200,
        lotSqFt: 9000,
      },
    });

    expect(draft.automation).toMatchObject({
      status: 'generated',
      generated: true,
      source: 'lead_webhook_automation',
    });
    expect(draft.monthly).toBeGreaterThan(0);
    expect(draft.annual).toBeGreaterThan(0);
    expect(draft.estimateData).toMatchObject({
      services: { mosquito: { tier: 'monthly12' } },
      quoteRequired: false,
      automation: {
        leadEstimateAutomation: readiness,
        draftEstimateAutomation: {
          status: 'generated',
          generated: true,
        },
      },
    });
    expect(draft.estimateData.engineResult.lineItems[0]).toEqual(expect.objectContaining({
      service: 'mosquito',
    }));

    // Send-time pricing-audit provenance survives compaction (codex
    // pre-push P1 ×2): the numeric cadence, program/addOns COGS inputs,
    // and the gross/net witnesses the audit normalizer consumes.
    const li = draft.estimateData.engineResult.lineItems[0];
    expect(Number(li.visitsPerYear ?? li.visits ?? li.appsPerYear)).toBeGreaterThan(0);
    expect(li).toHaveProperty('program');
    expect(li).toHaveProperty('addOns');
    expect(li).toHaveProperty('priceBeforeDiscount');
    expect(li).toHaveProperty('annualBeforeDiscount');
    expect(li).toHaveProperty('costs');
    expect(li).toHaveProperty('installation');
    expect(li).toHaveProperty('bedArea');
    // The gross witness must not be silently rewritten to the net.
    if (li.annual != null && li.annualBeforeDiscount != null) {
      expect(li.annualBeforeDiscount).toBeGreaterThanOrEqual(li.annual);
    }
  });

  test('rodent bait lead drafts keep the new-model provenance (perApplicationBilled / stations / pricingBasis) — codex #3591 r9 P0', () => {
    const readiness = evaluateLeadEstimateAutomationReadiness({
      phone: '+19415550199',
      intake: {
        email: 'lead@example.com',
        serviceInterest: 'Rodent bait station service',
        normalizedAddress: { line1: '123 Main St', city: 'Venice', state: 'FL', zip: '34285' },
      },
    });
    const draft = buildAutomatedLeadDraftEstimate({
      readiness,
      intake: { serviceInterest: 'Rodent bait station service', fullAddress: '123 Main St, Venice, FL 34285' },
      body: { homeSqFt: 2200, lotSqFt: 9000 },
    });
    expect(draft.estimateData.services).toMatchObject({ rodentBait: {} });
    const rodent = draft.estimateData.engineResult.lineItems.find((l) => l.service === 'rodent_bait');
    // Residential lines carry the marker + station allowance (the commercial
    // pricer adds pricingBasis; either signal defeats the legacy pin).
    expect(rodent).toEqual(expect.objectContaining({
      perApplicationBilled: true,
      stations: 5,
    }));
    // The persisted shape must NOT read as a pre-realignment legacy plan.
    const { rodentBaitLegacyReplaySignal } = require('../services/rodent-bait-legacy-replay');
    expect(rodentBaitLegacyReplaySignal(draft.estimateData)).toBeNull();
    // Default policy is persisted EXPLICITLY (codex #3591 r45 local P0):
    // the replay posture signal must fire for normal quotes too, or a later
    // flag flip re-prices the sent token.
    expect(rodent).toEqual(expect.objectContaining({
      tierQualifier: true, countsTowardWaveGuardTier: true,
      excludeFromPctDiscount: false, waveGuardDiscountEligible: true,
    }));
    const { rodentWaveguardPostureReplaySignal } = require('../services/rodent-bait-legacy-replay');
    expect(rodentWaveguardPostureReplaySignal(draft.estimateData)).toEqual({ tierQualifier: true, excludeFromPctDiscount: false });
    // Live policy OFF at generation is frozen into the draft (codex #3591 r23 P1).
    const constants = require('../services/pricing-engine/constants');
    const original = { tq: constants.RODENT.tierQualifier, ex: constants.RODENT.excludeFromPctDiscount };
    try {
      constants.RODENT.tierQualifier = false;
      constants.RODENT.excludeFromPctDiscount = true;
      const frozen = buildAutomatedLeadDraftEstimate({
        readiness,
        intake: { serviceInterest: 'Rodent bait station service', fullAddress: '123 Main St, Venice, FL 34285' },
        body: { homeSqFt: 2200, lotSqFt: 9000 },
      }).estimateData.engineResult.lineItems.find((l) => l.service === 'rodent_bait');
      expect(frozen).toEqual(expect.objectContaining({
        perApplicationBilled: true, tierQualifier: false, countsTowardWaveGuardTier: false,
        excludeFromPctDiscount: true, discountable: false, waveGuardDiscountEligible: false,
      }));
    } finally {
      constants.RODENT.tierQualifier = original.tq;
      constants.RODENT.excludeFromPctDiscount = original.ex;
    }
  });

  test('keeps unsupported scoped services in manual review draft state', () => {
    const readiness = evaluateLeadEstimateAutomationReadiness({
      phone: '+19415550199',
      intake: {
        email: 'lead@example.com',
        serviceInterest: 'One-Time Termite Treatment',
        normalizedAddress: {
          line1: '123 Main St',
          city: 'Venice',
          state: 'FL',
          zip: '34285',
        },
      },
    });

    const draft = buildAutomatedLeadDraftEstimate({
      readiness,
      intake: { serviceInterest: 'One-Time Termite Treatment' },
    });

    expect(draft.automation).toMatchObject({
      status: 'manual_review_required',
      generated: false,
      unsupportedReason: 'termite_treatment_requires_manual_scope',
    });
    expect(draft.monthly).toBeUndefined();
    expect(draft.estimateData.automation.draftEstimateAutomation.status).toBe('manual_review_required');
  });

  test('prices a realistic wavespestcontrol.com webhook payload into a generated draft', () => {
    const intake = buildLeadWebhookIntake({
      firstName: 'maria',
      lastName: 'garcia',
      email: 'maria@example.com',
      phone: '(941) 555-0101',
      address: '100 Wave Ave, Sarasota, FL 34236',
      service_interest: 'Mosquito Control',
      frequency: 'ongoing',
      page_url: 'https://www.wavespestcontrol.com/mosquito',
      homeSqFt: 2100,
      lotSqFt: 9500,
    });
    const readiness = evaluateLeadEstimateAutomationReadiness({
      intake,
      phone: '+19415550101',
      serviceInterest: intake.serviceInterest,
    });
    const draft = buildAutomatedLeadDraftEstimate({
      intake,
      body: { homeSqFt: 2100, lotSqFt: 9500 },
      readiness,
    });

    expect(intake.leadSource).toMatchObject({
      source: 'waves_website',
      detail: 'mosquito page',
    });
    expect(readiness).toMatchObject({
      ready: true,
      confidence: 'medium',
    });
    expect(draft.automation).toMatchObject({
      status: 'generated',
      generated: true,
    });
    expect(draft.estimateData).toMatchObject({
      services: { mosquito: { tier: 'monthly12' } },
      quoteRequired: false,
    });
    expect(draft.monthly).toBeGreaterThan(0);
  });

  test('spoke-domain termite treatment payload stays draft manual review', () => {
    const intake = buildLeadWebhookIntake({
      name: 'Terry Termite',
      email: 'terry@example.com',
      phone: '9415550102',
      address: '200 Colony Rd, Bradenton, FL 34205',
      domain: 'bradentonflpestcontrol.com',
      specific_service: 'termite_treatment',
      frequency: 'one-time',
      homeSqFt: 1800,
      lotSqFt: 7200,
    });
    const readiness = evaluateLeadEstimateAutomationReadiness({
      intake,
      phone: '+19415550102',
      serviceInterest: intake.serviceInterest,
    });
    const draft = buildAutomatedLeadDraftEstimate({
      intake,
      body: { homeSqFt: 1800, lotSqFt: 7200 },
      readiness,
    });

    expect(intake.leadSource).toMatchObject({
      source: 'domain_website',
      detail: 'bradentonflpestcontrol.com',
      area: 'Bradenton',
    });
    expect(intake.serviceInterest).toBe('One-Time Termite Treatment');
    expect(readiness.ready).toBe(true);
    expect(draft.automation).toMatchObject({
      status: 'manual_review_required',
      generated: false,
      unsupportedReason: 'termite_treatment_requires_manual_scope',
    });
    expect(draft.monthly).toBeUndefined();
  });

  test('triage service-interest changes regenerate draft pricing from the new service', () => {
    const intake = buildLeadWebhookIntake({
      name: 'Casey Change',
      email: 'casey@example.com',
      phone: '9415550105',
      address: '500 Switch Ln, Sarasota, FL 34236',
      domain: 'sarasotaflpestcontrol.com',
      service_interest: 'Pest Control',
      homeSqFt: 2000,
      lotSqFt: 8000,
    });
    const initialReadiness = evaluateLeadEstimateAutomationReadiness({
      intake,
      phone: '+19415550105',
      serviceInterest: intake.serviceInterest,
    });
    const initialDraft = buildAutomatedLeadDraftEstimate({
      intake,
      body: { homeSqFt: 2000, lotSqFt: 8000 },
      readiness: initialReadiness,
    });

    const triagedServiceInterest = 'Recurring Mosquito Control';
    const triageIntake = {
      ...intake,
      serviceInterest: triagedServiceInterest,
    };
    const triageReadiness = evaluateLeadEstimateAutomationReadiness({
      intake: triageIntake,
      phone: '+19415550105',
      serviceInterest: triagedServiceInterest,
    });
    const triageDraft = buildAutomatedLeadDraftEstimate({
      intake: triageIntake,
      body: { homeSqFt: 2000, lotSqFt: 8000 },
      readiness: triageReadiness,
    });

    expect(initialDraft.estimateData.services).toEqual({
      pest: { frequency: 'quarterly' },
    });
    expect(initialDraft.estimateData.engineResult.lineItems[0].service).toBe('pest_control');
    expect(triageDraft.estimateData.services).toEqual({
      mosquito: { tier: 'monthly12' },
    });
    expect(triageDraft.estimateData.engineResult.lineItems[0].service).toBe('mosquito');
    expect(triageDraft.monthly).not.toBe(initialDraft.monthly);
  });
});

// ── Estimator audit hardening: negation, cadence, bed-bug enum ──
describe('service-interest mapper hardening', () => {
  test('negated services are not selected: "pest, no lawn" quotes pest only', () => {
    const mapped = mapServiceInterestToEstimateServices('Pest control, no lawn');
    expect(mapped.supported).toBe(true);
    expect(mapped.services.pest).toMatchObject({ frequency: 'quarterly' });
    expect(mapped.services.lawn).toBeUndefined();
    expect(mapped.services.oneTimeLawn).toBeUndefined();
    expect(mapped.services.lawnPestControl).toBeUndefined();
  });

  test('negation stays inside its clause: "no pest, lawn care" still quotes lawn', () => {
    const mapped = mapServiceInterestToEstimateServices('No pest, lawn care');
    expect(mapped.services.pest).toBeUndefined();
    expect(mapped.services.oneTimePest).toBeUndefined();
    expect(mapped.services.lawn).toMatchObject({ track: 'st_augustine', tier: 'enhanced' });
  });

  test('a CONTRASTIVE conjunction ends the negation: "no lawn but pest control"', () => {
    const mapped = mapServiceInterestToEstimateServices('no lawn but pest control');
    expect(mapped.services.lawn).toBeUndefined();
    expect(mapped.services.pest).toMatchObject({ frequency: 'quarterly' });
  });

  test('plain "and" does NOT reset — "no lawn and mosquito" is a coordinated negated list', () => {
    const mapped = mapServiceInterestToEstimateServices('quarterly pest, no lawn and mosquito');
    expect(mapped.services.pest).toMatchObject({ frequency: 'quarterly' });
    expect(mapped.services.lawn).toBeUndefined();
    expect(mapped.services.mosquito).toBeUndefined();
    expect(mapped.services.oneTimeMosquito).toBeUndefined();
  });

  test("don't-need phrasing negates through intervening words", () => {
    const mapped = mapServiceInterestToEstimateServices("Quarterly pest — don't need any mosquito");
    expect(mapped.services.pest).toBeDefined();
    expect(mapped.services.mosquito).toBeUndefined();
    expect(mapped.services.oneTimeMosquito).toBeUndefined();
  });

  test('negation reaches to the end of its clause, however many words intervene', () => {
    const mapped = mapServiceInterestToEstimateServices(
      'I do not currently have any interest in mosquito service, just pest control please',
    );
    expect(mapped.services.pest).toBeDefined();
    expect(mapped.services.mosquito).toBeUndefined();
    expect(mapped.services.oneTimeMosquito).toBeUndefined();

    // A fully long-negated interest parks — never a wrong auto-quote.
    const parked = mapServiceInterestToEstimateServices('I do not currently have any interest in mosquito service');
    expect(parked.supported).toBe(false);
  });

  test('positive idioms "not only"/"not just" are not negations', () => {
    const both = mapServiceInterestToEstimateServices('not only pest but lawn care');
    expect(both.services.pest).toMatchObject({ frequency: 'quarterly' });
    expect(both.services.lawn).toMatchObject({ track: 'st_augustine' });

    const notJust = mapServiceInterestToEstimateServices('not just pest, lawn too');
    expect(notJust.services.pest).toBeDefined();
    expect(notJust.services.lawn).toBeDefined();
  });

  test('fully negated interest fails SAFE to manual review, never to a wrong quote', () => {
    const mapped = mapServiceInterestToEstimateServices('no pest control');
    expect(mapped.supported).toBe(false);
    expect(mapped.unsupportedReason).toBe('service_not_mapped_for_automation');
  });

  test('un-negated mentions still map exactly as before (regression)', () => {
    expect(mapServiceInterestToEstimateServices('Recurring Pest Control + Lawn Care')).toMatchObject({
      supported: true,
      services: {
        pest: { frequency: 'quarterly' },
        lawn: { track: 'st_augustine', tier: 'enhanced' },
      },
    });
  });

  test('semiannual cadence parks for manual scoping instead of silently quoting quarterly', () => {
    const mapped = mapServiceInterestToEstimateServices('Semiannual pest control');
    expect(mapped.supported).toBe(false);
    expect(mapped.unsupportedReason).toBe('semiannual_cadence_requires_manual_scope');
    // One-time-only requests are untouched by the recurring-cadence rule.
    expect(mapServiceInterestToEstimateServices('One-time pest treatment').supported).toBe(true);
  });

  test('bed bug defaults use a real pricing-engine occupancy enum', () => {
    const mapped = mapServiceInterestToEstimateServices('Bed bug treatment');
    expect(mapped.supported).toBe(true);
    expect(mapped.services.bedBug).toMatchObject({ occupancyType: 'singleFamily' });
    expect(mapped.review).toContain('bed_bug_defaults_used');
  });

  test('automated bed-bug lead now survives engine generation end to end', () => {
    const readiness = evaluateLeadEstimateAutomationReadiness({
      phone: '+19415550199',
      serviceInterest: 'Bed bug treatment',
      intake: {
        email: 'lead@example.com',
        serviceInterest: 'Bed bug treatment',
        normalizedAddress: { line1: '123 Main St', city: 'Venice', state: 'FL', zip: '34285' },
      },
    });
    const draft = buildAutomatedLeadDraftEstimate({
      intake: { serviceInterest: 'Bed bug treatment', fullAddress: '123 Main St, Venice, FL 34285' },
      body: { homeSqFt: 1800, lotSqFt: 7000 },
      readiness,
    });
    // The old occupancyType 'residential' failed the engine's assertEnum and
    // flipped every bed-bug lead to generation_failed.
    expect(draft.automation.status).not.toBe('generation_failed');
    expect(draft.automation.error).toBeUndefined();
  });
});

describe('keyed leads (C2): the draft prices the canonical product, never a label lookalike', () => {
  const readinessFor = (serviceInterest) => evaluateLeadEstimateAutomationReadiness({
    phone: '+19415550199',
    intake: { email: 'lead@example.com', serviceInterest, normalizedAddress: { line1: '123 Main St', city: 'Venice', state: 'FL', zip: '34285' } },
  });
  test('mosquito_seasonal drafts the seasonal9 tier (the label alone would have priced monthly)', () => {
    const readiness = { ...readinessFor('Seasonal Mosquito Control Service'), serviceKey: 'mosquito_seasonal', serviceKeyInstant: true };
    const draft = buildAutomatedLeadDraftEstimate({ readiness, intake: { serviceInterest: 'Seasonal Mosquito Control Service', fullAddress: '123 Main St, Venice, FL 34285' }, body: { homeSqFt: 2200, lotSqFt: 9000 } });
    expect(draft.automation).toMatchObject({ status: 'generated', generated: true });
    expect(draft.estimateData.services).toEqual({ mosquito: { tier: 'seasonal9' } });
  });
  test('flea_tick drafts the two-visit package — the only flea offer (owner ruling 2026-09-03)', () => {
    const readiness = { ...readinessFor('Flea Control Service'), serviceKey: 'flea_tick', serviceKeyInstant: true };
    const draft = buildAutomatedLeadDraftEstimate({ readiness, intake: { serviceInterest: 'Flea Control Service', fullAddress: '123 Main St, Venice, FL 34285' }, body: { homeSqFt: 2200, lotSqFt: 9000 } });
    expect(draft.estimateData.services).toEqual({ flea: {} });
    // The draft carries the legacy-mapped line shape (visits, no warranty
    // metadata) — the package identity + visit count are what the copy
    // pack and the catalog linker key off.
    const services = draft.estimateData.engineResult.lineItems.map((l) => l.service);
    expect(services).toContain('flea_package');
    expect(services).not.toContain('flea_knockdown_single');
    expect(draft.estimateData.engineResult.lineItems.find((l) => l.service === 'flea_package').visits).toBe(2);
  });
  test('a selectable key with no instant request is quote-on-request — no automated draft', () => {
    const readiness = { ...readinessFor('WDO Inspection Service'), serviceKey: 'wdo_inspection', serviceKeyInstant: false };
    const draft = buildAutomatedLeadDraftEstimate({ readiness, intake: { serviceInterest: 'WDO Inspection Service', fullAddress: '123 Main St, Venice, FL 34285' }, body: { homeSqFt: 2200, lotSqFt: 9000 } });
    expect(draft.automation.generated).toBe(false);
    expect(draft.automation.unsupportedReason).toBe('quote_on_request');
  });
  test('an instant-mapped key whose LIVE catalog verdict is not instant is quote-on-request (cadence drift / termite rental gate off)', () => {
    // termite_bait has a canonical request, but the rental gate or an admin
    // cadence edit can turn the row off instant after the map was written;
    // the draft must follow the catalog verdict, never the static map.
    const readiness = { ...readinessFor('Termite Bait Station Service'), serviceKey: 'termite_bait', serviceKeyInstant: false };
    const draft = buildAutomatedLeadDraftEstimate({ readiness, intake: { serviceInterest: 'Termite Bait Station Service', fullAddress: '123 Main St, Venice, FL 34285' }, body: { homeSqFt: 2200, lotSqFt: 9000 } });
    expect(draft.automation.generated).toBe(false);
    expect(draft.automation.unsupportedReason).toBe('quote_on_request');
    expect(draft.estimateData.services).toBeUndefined();
  });
  test('a submitted key that could not be verified parks — never falls back to label inference', () => {
    // publicSelectableService returned null (catalog read failed / not
    // selectable): the label alone would have drafted mosquito as monthly.
    const readiness = { ...readinessFor('Seasonal Mosquito Control Service'), serviceKey: null, serviceKeyInstant: null, serviceKeyUnverified: true };
    const draft = buildAutomatedLeadDraftEstimate({ readiness, intake: { serviceInterest: 'Seasonal Mosquito Control Service', fullAddress: '123 Main St, Venice, FL 34285' }, body: { homeSqFt: 2200, lotSqFt: 9000 } });
    expect(draft.automation.generated).toBe(false);
    expect(draft.automation.status).toBe('manual_review_required');
    expect(draft.automation.unsupportedReason).toBe('quote_on_request');
    expect(draft.automation.services).toEqual({});
  });
  test('a keyed lead with NO live verdict fails closed to quote-on-request', () => {
    const readiness = { ...readinessFor('Seasonal Mosquito Control Service'), serviceKey: 'mosquito_seasonal' };
    const draft = buildAutomatedLeadDraftEstimate({ readiness, intake: { serviceInterest: 'Seasonal Mosquito Control Service', fullAddress: '123 Main St, Venice, FL 34285' }, body: { homeSqFt: 2200, lotSqFt: 9000 } });
    expect(draft.automation.generated).toBe(false);
    expect(draft.automation.unsupportedReason).toBe('quote_on_request');
  });
});
