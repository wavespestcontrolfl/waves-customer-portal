const {
  MIN_AUTOMATION_CONFIDENCE,
  automationNote,
  buildAutomatedLeadDraftEstimate,
  confidenceMeetsMinimum,
  evaluateLeadEstimateAutomationReadiness,
  hasConcreteServiceInterest,
  mapServiceInterestToEstimateServices,
} = require('../services/lead-estimate-automation');

describe('lead estimate automation gate', () => {
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
});
