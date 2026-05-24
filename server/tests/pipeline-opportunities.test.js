const {
  PIPELINE_STAGES,
  buildPipelineResponse,
  normalizeOpportunities,
} = require('../services/pipeline-opportunities');

const NOW = new Date('2026-05-24T12:00:00.000Z');

function lead(overrides = {}) {
  return {
    id: 'lead-1',
    first_name: 'Jane',
    last_name: 'Smith',
    phone: '(555) 123-4567',
    email: 'jane@example.com',
    service_interest: 'Weekly pool service',
    status: 'new',
    created_at: '2026-05-20T12:00:00.000Z',
    ...overrides,
  };
}

function estimate(overrides = {}) {
  return {
    id: 'est-1',
    customer_name: 'Jane Smith',
    customer_phone: '555-123-4567',
    customer_email: 'jane@example.com',
    service_interest: 'Weekly pool service',
    status: 'draft',
    created_at: '2026-05-21T12:00:00.000Z',
    monthly_total: 420,
    ...overrides,
  };
}

describe('pipeline opportunities read model', () => {
  test('deduplicates lead estimate_id links', () => {
    const opportunities = normalizeOpportunities({
      leads: [lead({ estimate_id: 'est-1' })],
      estimates: [estimate({ id: 'est-1' })],
      now: NOW,
    });

    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]).toMatchObject({
      opportunityId: 'lead:lead-1',
      sourceType: 'lead_estimate',
      leadId: 'lead-1',
      estimateId: 'est-1',
      stage: PIPELINE_STAGES.ESTIMATE_DRAFT,
    });
  });

  test('keeps standalone estimates and flags uncertain duplicate risk', () => {
    const opportunities = normalizeOpportunities({
      leads: [lead()],
      estimates: [estimate({ id: 'est-2' })],
      now: NOW,
    });

    expect(opportunities).toHaveLength(2);
    expect(opportunities.find((o) => o.opportunityId === 'estimate:est-2')).toMatchObject({
      sourceType: 'estimate',
      isDuplicateRisk: true,
    });
  });

  test('server response filters follow-up as derived action, not stage', () => {
    const response = buildPipelineResponse({
      leads: [],
      estimates: [estimate({
        id: 'est-1',
        status: 'sent',
        sent_at: '2026-05-20T12:00:00.000Z',
      })],
      query: { stage: 'follow_up', page: 1, pageSize: 50 },
      now: NOW,
    });

    expect(response.data).toHaveLength(1);
    expect(response.data[0]).toMatchObject({
      stage: PIPELINE_STAGES.ESTIMATE_SENT,
      nextAction: 'follow_up',
      needsAction: true,
    });
    expect(response.counts.follow_up).toBe(1);
  });

  test('search finds normalized phone digits and paginates after filtering', () => {
    const response = buildPipelineResponse({
      leads: [
        lead({ id: 'lead-1', phone: '(555) 123-4567' }),
        lead({ id: 'lead-2', phone: '(941) 555-0000' }),
      ],
      estimates: [],
      query: { search: '5551234567', page: 1, pageSize: 1 },
      now: NOW,
    });

    expect(response.pagination.total).toBe(1);
    expect(response.data).toHaveLength(1);
    expect(response.data[0].leadId).toBe('lead-1');
  });
});
