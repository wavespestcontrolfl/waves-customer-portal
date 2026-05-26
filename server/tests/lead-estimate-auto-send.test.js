const {
  DEFAULT_ALLOWED_REVIEW_REASONS,
  leadEstimateAutoSendConfigFromEnv,
  leadEstimateAutoSendEligibility,
  mergeAutoSendMetadata,
} = require('../services/lead-estimate-auto-send');

function generatedEstimate(overrides = {}) {
  const now = new Date('2026-05-26T12:00:00.000Z');
  return {
    id: 'estimate-1',
    source: 'lead_webhook',
    status: 'draft',
    customer_phone: '+19415550101',
    customer_email: 'lead@example.com',
    created_at: new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
    estimate_data: {
      automation: {
        leadEstimateAutomation: {
          status: 'ready',
          confidence: 'medium',
          minimumConfidence: 'medium',
          review: ['property_measurements_defaulted'],
          missing: [],
        },
        draftEstimateAutomation: {
          status: 'generated',
          generated: true,
          quoteRequired: false,
          review: ['property_measurements_defaulted'],
        },
      },
    },
    ...overrides,
  };
}

describe('lead estimate auto-send policy', () => {
  test('production config defaults to five minute delay, ten-row limit, and conservative review allowlist', () => {
    expect(leadEstimateAutoSendConfigFromEnv({})).toEqual({
      delayMinutes: 5,
      limit: 10,
      allowedReviewReasons: DEFAULT_ALLOWED_REVIEW_REASONS,
      sendMethod: 'both',
    });

    expect(leadEstimateAutoSendConfigFromEnv({
      LEAD_ESTIMATE_AUTO_SEND_DELAY_MINUTES: '12',
      LEAD_ESTIMATE_AUTO_SEND_LIMIT: '3',
      LEAD_ESTIMATE_AUTO_SEND_ALLOWED_REVIEW_REASONS: 'property_measurements_defaulted,email_missing_sms_only',
      LEAD_ESTIMATE_AUTO_SEND_METHOD: 'sms',
    })).toEqual({
      delayMinutes: 12,
      limit: 3,
      allowedReviewReasons: ['property_measurements_defaulted', 'email_missing_sms_only'],
      sendMethod: 'sms',
    });
  });

  test('allows generated draft lead estimates after delay when only allowed review reasons are present', () => {
    const now = new Date('2026-05-26T12:00:00.000Z');

    expect(leadEstimateAutoSendEligibility(generatedEstimate(), {
      now,
      delayMinutes: 5,
      allowedReviewReasons: ['property_measurements_defaulted'],
    })).toEqual({ eligible: true, reason: null });
  });

  test('blocks manual-review, premature, and disallowed-review estimates', () => {
    const now = new Date('2026-05-26T12:00:00.000Z');

    expect(leadEstimateAutoSendEligibility(generatedEstimate({
      estimate_data: {
        automation: {
          draftEstimateAutomation: {
            status: 'manual_review_required',
            generated: false,
          },
        },
      },
    }), { now })).toMatchObject({
      eligible: false,
      reason: 'not_generated',
    });

    expect(leadEstimateAutoSendEligibility(generatedEstimate({
      created_at: new Date(now.getTime() - 2 * 60 * 1000).toISOString(),
    }), { now, delayMinutes: 5 })).toMatchObject({
      eligible: false,
      reason: 'delay_not_elapsed',
    });

    expect(leadEstimateAutoSendEligibility(generatedEstimate({
      estimate_data: {
        automation: {
          leadEstimateAutomation: {
            status: 'ready',
            confidence: 'medium',
            review: ['city_or_zip_missing'],
          },
          draftEstimateAutomation: {
            status: 'generated',
            generated: true,
            review: ['city_or_zip_missing'],
          },
        },
      },
    }), {
      now,
      allowedReviewReasons: ['property_measurements_defaulted'],
    })).toMatchObject({
      eligible: false,
      reason: 'disallowed_review_reasons',
      review: ['city_or_zip_missing'],
    });
  });

  test('preserves automation data when adding auto-send metadata', () => {
    const next = mergeAutoSendMetadata(generatedEstimate().estimate_data, {
      claimedAt: '2026-05-26T12:05:00.000Z',
      sendMethod: 'both',
    });

    expect(next.automation.leadEstimateAutomation.confidence).toBe('medium');
    expect(next.automation.draftEstimateAutomation.status).toBe('generated');
    expect(next.automation.autoSend).toEqual({
      claimedAt: '2026-05-26T12:05:00.000Z',
      sendMethod: 'both',
    });
  });
});
