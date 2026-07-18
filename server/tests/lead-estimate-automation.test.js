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
