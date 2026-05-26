const {
  MIN_AUTOMATION_CONFIDENCE,
  automationNote,
  confidenceMeetsMinimum,
  evaluateLeadEstimateAutomationReadiness,
  hasConcreteServiceInterest,
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
});
