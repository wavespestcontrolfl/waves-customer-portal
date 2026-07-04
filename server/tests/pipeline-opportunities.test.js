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

  test('paginates after linked lead and estimate records are deduplicated', () => {
    const response = buildPipelineResponse({
      leads: [
        lead({ id: 'lead-1', estimate_id: 'est-1', created_at: '2026-05-20T12:00:00.000Z' }),
        lead({ id: 'lead-2', first_name: 'Alex', estimate_id: 'est-2', created_at: '2026-05-19T12:00:00.000Z' }),
      ],
      estimates: [
        estimate({ id: 'est-1', created_at: '2026-05-21T12:00:00.000Z' }),
        estimate({ id: 'est-2', customer_name: 'Alex Rivera', created_at: '2026-05-18T12:00:00.000Z' }),
      ],
      query: { stage: 'all', page: 1, pageSize: 1 },
      now: NOW,
    });

    expect(response.counts.total).toBe(2);
    expect(response.pagination).toMatchObject({
      page: 1,
      pageSize: 1,
      total: 2,
    });
    expect(response.data).toHaveLength(1);
    expect(response.data[0]).toMatchObject({
      opportunityId: 'lead:lead-1',
      sourceType: 'lead_estimate',
      leadId: 'lead-1',
      estimateId: 'est-1',
    });
  });

  test('response strips raw source records from opportunities', () => {
    const response = buildPipelineResponse({
      leads: [lead({ estimate_id: 'est-1' })],
      estimates: [estimate({ id: 'est-1' })],
      query: { stage: 'all', page: 1, pageSize: 50 },
      now: NOW,
    });

    expect(response.data).toHaveLength(1);
    expect(response.data[0]).not.toHaveProperty('rawLead');
    expect(response.data[0]).not.toHaveProperty('rawEstimate');
  });

  test('surfaces server candidate-cap metadata when response is truncated', () => {
    const response = buildPipelineResponse({
      leads: [lead({ estimate_id: 'est-1' })],
      estimates: [estimate({ id: 'est-1' })],
      query: { stage: 'all', page: 1, pageSize: 50 },
      truncated: true,
      candidateStats: {
        candidateCap: 5000,
        leadCandidates: 5001,
        estimateCandidates: 42,
        leadCandidatesReturned: 5000,
        estimateCandidatesReturned: 42,
      },
      now: NOW,
    });

    expect(response.meta).toMatchObject({
      source: 'server',
      truncated: true,
      candidateCap: 5000,
      leadCandidates: 5001,
      estimateCandidates: 42,
      leadCandidatesReturned: 5000,
      estimateCandidatesReturned: 42,
    });
  });

  test('counts are computed from search scope before the selected stage filter', () => {
    const response = buildPipelineResponse({
      leads: [
        lead({ id: 'lead-1', first_name: 'Jane', phone: '(555) 123-4567' }),
        lead({ id: 'lead-2', first_name: 'Jane', phone: '(555) 123-4567', status: 'lost' }),
        lead({ id: 'lead-3', first_name: 'Pat', phone: '(941) 555-0000' }),
      ],
      estimates: [],
      query: { search: '5551234567', stage: 'new', page: 1, pageSize: 50 },
      now: NOW,
    });

    expect(response.data).toHaveLength(1);
    expect(response.data[0].leadId).toBe('lead-1');
    expect(response.counts.total).toBe(2);
    expect(response.counts.new).toBe(1);
    expect(response.counts.lost).toBe(1);
  });

  test('source filter matches partial source labels', () => {
    const response = buildPipelineResponse({
      leads: [
        lead({ id: 'lead-1', source_name: 'Google Ads' }),
        lead({ id: 'lead-2', source_name: 'Referral' }),
      ],
      estimates: [],
      query: { source: 'google', stage: 'all', page: 1, pageSize: 50 },
      now: NOW,
    });

    expect(response.data).toHaveLength(1);
    expect(response.data[0]).toMatchObject({
      leadId: 'lead-1',
      source: 'Google Ads',
    });
  });

  test('source filter matches legacy lead_source values surfaced in the read model', () => {
    const response = buildPipelineResponse({
      leads: [
        lead({ id: 'lead-1', lead_source: 'Home Advisor' }),
        lead({ id: 'lead-2', lead_source: 'Referral' }),
      ],
      estimates: [],
      query: { source: 'advisor', stage: 'all', page: 1, pageSize: 50 },
      now: NOW,
    });

    expect(response.data).toHaveLength(1);
    expect(response.data[0]).toMatchObject({
      leadId: 'lead-1',
      source: 'Home Advisor',
    });
  });

  test('date range filters by last activity', () => {
    const response = buildPipelineResponse({
      leads: [
        lead({ id: 'lead-1', last_activity_at: '2026-05-23T12:00:00.000Z' }),
        lead({
          id: 'lead-2',
          created_at: '2026-05-01T12:00:00.000Z',
          last_activity_at: '2026-05-01T12:00:00.000Z',
        }),
      ],
      estimates: [],
      query: { dateFrom: '2026-05-20T00:00:00.000Z', stage: 'all', page: 1, pageSize: 50 },
      now: NOW,
    });

    expect(response.data).toHaveLength(1);
    expect(response.data[0].leadId).toBe('lead-1');
  });

  test('next follow-up sort orders earliest due opportunities first', () => {
    const response = buildPipelineResponse({
      leads: [
        lead({ id: 'lead-1', next_follow_up_at: '2026-05-25T12:00:00.000Z' }),
        lead({ id: 'lead-2', next_follow_up_at: '2026-05-24T13:00:00.000Z' }),
      ],
      estimates: [],
      query: { sort: 'next_follow_up', stage: 'all', page: 1, pageSize: 50 },
      now: NOW,
    });

    expect(response.data.map((opportunity) => opportunity.leadId)).toEqual(['lead-2', 'lead-1']);
  });

  test('accepted linked estimate wins over stale lost lead status', () => {
    const [opportunity] = normalizeOpportunities({
      leads: [lead({ status: 'lost', estimate_id: 'est-1' })],
      estimates: [estimate({ id: 'est-1', status: 'accepted' })],
      now: NOW,
    });

    expect(opportunity).toMatchObject({
      stage: PIPELINE_STAGES.WON,
      status: 'won',
      stageReason: 'Estimate accepted or lead marked won',
    });
  });

  test('unresponsive and duplicate leads are closed, never active new_lead', () => {
    // Regression: these closed statuses used to fall through to an ACTIVE
    // new_lead stage. The staleness sweep assigns unresponsive at scale, so
    // a swept lead must leave the active pipeline immediately.
    const opportunities = normalizeOpportunities({
      leads: [
        lead({ id: 'lead-1', status: 'unresponsive' }),
        lead({ id: 'lead-2', status: 'duplicate' }),
      ],
      estimates: [],
      now: NOW,
    });

    for (const opportunity of opportunities) {
      expect(opportunity).toMatchObject({
        stage: PIPELINE_STAGES.LOST,
        status: 'lost',
      });
    }
  });

  test('declined unlinked estimate does not collapse a separate active lead', () => {
    const opportunities = normalizeOpportunities({
      leads: [lead({ id: 'lead-1', status: 'contacted' })],
      estimates: [estimate({ id: 'est-2', status: 'declined' })],
      now: NOW,
    });

    expect(opportunities).toHaveLength(2);
    expect(opportunities.find((o) => o.opportunityId === 'lead:lead-1')).toMatchObject({
      stage: PIPELINE_STAGES.CONTACTED,
      status: 'active',
    });
    expect(opportunities.find((o) => o.opportunityId === 'estimate:est-2')).toMatchObject({
      stage: PIPELINE_STAGES.LOST,
      status: 'lost',
    });
  });

  test('duplicate risk is a derived cleanup filter', () => {
    const response = buildPipelineResponse({
      leads: [lead()],
      estimates: [estimate({ id: 'est-2' })],
      query: { stage: 'duplicate_risk', page: 1, pageSize: 50 },
      now: NOW,
    });

    expect(response.data).toHaveLength(1);
    expect(response.data[0]).toMatchObject({
      opportunityId: 'estimate:est-2',
      isDuplicateRisk: true,
    });
    expect(response.counts.duplicate_risk).toBe(1);
  });

  test('dismissed duplicate pair leaves normal pipeline but exits cleanup filter', () => {
    const response = buildPipelineResponse({
      leads: [lead()],
      estimates: [estimate({ id: 'est-2' })],
      query: { stage: 'duplicate_risk', page: 1, pageSize: 50 },
      dismissedDuplicatePairs: [{ estimate_id: 'est-2', lead_id: 'lead-1' }],
      now: NOW,
    });

    expect(response.data).toHaveLength(0);
    expect(response.counts.duplicate_risk).toBe(0);

    const allResponse = buildPipelineResponse({
      leads: [lead()],
      estimates: [estimate({ id: 'est-2' })],
      query: { stage: 'all', page: 1, pageSize: 50 },
      dismissedDuplicatePairs: [{ estimate_id: 'est-2', lead_id: 'lead-1' }],
      now: NOW,
    });

    expect(allResponse.data.find((o) => o.opportunityId === 'estimate:est-2')).toMatchObject({
      isDuplicateRisk: false,
    });
  });

  test('dismissed duplicate pair does not hide other matching leads', () => {
    const response = buildPipelineResponse({
      leads: [
        lead({ id: 'lead-1', phone: '(555) 123-4567', email: 'jane@example.com' }),
        lead({ id: 'lead-2', phone: '(555) 123-4567', email: 'other@example.com' }),
      ],
      estimates: [estimate({ id: 'est-2' })],
      query: { stage: 'duplicate_risk', page: 1, pageSize: 50 },
      dismissedDuplicatePairs: [{ estimate_id: 'est-2', lead_id: 'lead-1' }],
      now: NOW,
    });

    expect(response.data).toHaveLength(1);
    expect(response.data[0]).toMatchObject({
      opportunityId: 'estimate:est-2',
      isDuplicateRisk: true,
    });
  });
});

describe('expired estimate actions', () => {
  test('a swept-expired estimate keeps its sent stage but the action flips to Extend (Follow Up would 400)', () => {
    const opportunities = normalizeOpportunities({
      leads: [],
      estimates: [estimate({ id: 'est-exp', status: 'expired', sent_at: '2026-05-01T12:00:00.000Z' })],
      now: NOW,
    });
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]).toMatchObject({
      stage: PIPELINE_STAGES.ESTIMATE_SENT,
      nextAction: 'extend_estimate',
      nextActionLabel: 'Extend expiration',
      needsAction: true,
      isStale: true,
    });
  });

  test('a past expires_at the sweep has not stamped yet also flips the action', () => {
    const opportunities = normalizeOpportunities({
      leads: [],
      estimates: [estimate({
        id: 'est-past',
        status: 'viewed',
        viewed_at: '2026-05-10T12:00:00.000Z',
        expires_at: '2026-05-12T12:00:00.000Z',
      })],
      now: NOW,
    });
    expect(opportunities[0]).toMatchObject({
      stage: PIPELINE_STAGES.ESTIMATE_VIEWED,
      nextAction: 'extend_estimate',
      needsAction: true,
    });
  });

  test('a live sent estimate with a future expiry keeps the follow-up/wait action', () => {
    const opportunities = normalizeOpportunities({
      leads: [],
      estimates: [estimate({
        id: 'est-live',
        status: 'sent',
        sent_at: '2026-05-23T12:00:00.000Z',
        expires_at: '2026-05-30T12:00:00.000Z',
      })],
      now: NOW,
    });
    expect(opportunities[0].nextAction).not.toBe('extend_estimate');
  });

  test('accepted estimates never flip to extend even with a past expiry', () => {
    const opportunities = normalizeOpportunities({
      leads: [],
      estimates: [estimate({
        id: 'est-won',
        status: 'accepted',
        expires_at: '2026-05-12T12:00:00.000Z',
      })],
      now: NOW,
    });
    expect(opportunities[0].stage).toBe(PIPELINE_STAGES.WON);
    expect(opportunities[0].nextAction).toBe('schedule');
  });
});

describe('expired estimate actions — round-2 refinements', () => {
  const { opportunityMatchesFilter } = require('../services/pipeline-opportunities');

  test('a swept-expired row with no sent/viewed stamp (draft-derived) flips to Extend, not Send', () => {
    const opportunities = normalizeOpportunities({
      leads: [],
      estimates: [estimate({ id: 'est-exp-draft', status: 'expired' })],
      now: NOW,
    });
    expect(opportunities[0]).toMatchObject({
      stage: PIPELINE_STAGES.ESTIMATE_DRAFT,
      nextAction: 'extend_estimate',
      needsAction: true,
    });
  });

  test('extend-only rows stay out of the Follow Up filter despite needing action', () => {
    const [expired] = normalizeOpportunities({
      leads: [],
      estimates: [estimate({ id: 'est-exp2', status: 'expired', sent_at: '2026-05-01T12:00:00.000Z' })],
      now: NOW,
    });
    expect(expired.needsAction).toBe(true);
    expect(opportunityMatchesFilter(expired, 'follow_up')).toBe(false);
    const [live] = normalizeOpportunities({
      leads: [],
      estimates: [estimate({ id: 'est-live2', status: 'sent', sent_at: '2026-05-01T12:00:00.000Z', expires_at: '2026-05-30T12:00:00.000Z' })],
      now: NOW,
    });
    expect(opportunityMatchesFilter(live, 'follow_up')).toBe(true);
  });
});
