const {
  buildFixtureDocument,
  evaluateFixture,
  evaluateFixtureDocument,
  fixtureFromDecision,
} = require('../services/agent-decision-training');

function decision(overrides = {}) {
  return {
    id: '12345678-aaaa-bbbb-cccc-123456789000',
    workflow: 'estimate_conversion_sms',
    status: 'accepted',
    human_verdict: 'accepted',
    reviewed_at: '2026-05-29T12:00:00.000Z',
    detected_intent: 'accepted_estimate_by_text',
    input_snapshot: {
      sms: { body: 'Ok. I think I will give your team a try. Can we start the week of June 8th?' },
      estimate: { id: 'estimate-1', customer_name: 'Paul Stratton', address: '19019 Cherrystone Way', status: 'viewed' },
    },
    recommended_actions: ['mark_conversion_intent', 'offer_calendar_slots_for_requested_window'],
    blocked_actions: ['silently_schedule_without_confirmed_slot', 'create_subscription', 'charge_card'],
    safety_flags: ['billing_invoice_only', 'never_create_subscription', 'scheduling_requires_explicit_slot'],
    ...overrides,
  };
}

function serviceSchedulingDecision(overrides = {}) {
  return decision({
    workflow: 'service_scheduling_sms',
    detected_intent: 'service_scheduling_window_reply',
    input_snapshot: {
      sms: { body: '9am works' },
      customer: { id: 'customer-1', name: 'Dale Brush' },
      recent_sms_thread: [
        { direction: 'outbound', body: 'What time works for you?' },
        { direction: 'inbound', body: '9am works' },
      ],
    },
    recommended_actions: [
      'draft_service_scheduling_reply',
      'check_route_availability',
      'confirm_service_window_after_review',
    ],
    blocked_actions: ['silently_schedule_without_confirmed_slot', 'create_subscription', 'charge_card'],
    safety_flags: ['existing_customer_service_thread', 'scheduling_requires_explicit_slot', 'never_create_subscription', 'never_charge_card'],
    ...overrides,
  });
}

function customerSmsTriageDecision(overrides = {}) {
  return decision({
    workflow: 'customer_sms_triage',
    detected_intent: 'customer_nudge_needs_reply',
    input_snapshot: {
      sms: { body: 'Hey Adam?' },
      customer: { id: 'customer-1', first_name: 'Jess', name: 'Jess Latika' },
    },
    recommended_actions: ['review_thread_context', 'draft_customer_reply'],
    blocked_actions: ['send_without_human_review', 'create_subscription', 'charge_card'],
    safety_flags: ['human_review_required', 'never_create_subscription', 'never_charge_card'],
    ...overrides,
  });
}

describe('agent decision training fixtures', () => {
  test('exports accepted decisions as expected classifier fixtures', () => {
    const fixture = fixtureFromDecision(decision());
    expect(fixture).toMatchObject({
      sourceDecisionId: '12345678-aaaa-bbbb-cccc-123456789000',
      workflow: 'estimate_conversion_sms',
      humanVerdict: 'accepted',
      input: {
        body: expect.stringContaining('give your team a try'),
        context: {
          estimate: { id: 'estimate-1' },
        },
      },
      expected: {
        intent: 'accepted_estimate_by_text',
        recommendedActions: expect.arrayContaining(['mark_conversion_intent']),
        blockedActions: expect.arrayContaining(['charge_card']),
      },
    });
  });

  test('exports dismissed decisions as negative examples', () => {
    const fixture = fixtureFromDecision(decision({
      human_verdict: 'dismissed',
      status: 'dismissed',
      correction_note: 'Not actually an estimate conversion.',
    }));

    expect(fixture.expected).toEqual({
      intent: null,
      recommendedActions: [],
      blockedActions: [],
      safetyFlags: [],
    });
  });

  test('redacts fixture PII by default', () => {
    const fixture = fixtureFromDecision(decision({
      input_snapshot: {
        sms: {
          body: 'Paul Stratton here, can you start at 19019 Cherrystone Way? Email paul@example.com or call 941-555-1212.',
        },
        estimate: { id: 'estimate-1', customer_name: 'Paul Stratton', address: '19019 Cherrystone Way', status: 'viewed' },
      },
    }));

    expect(fixture.input.body).toContain('[name]');
    expect(fixture.input.body).toContain('[address]');
    expect(fixture.input.body).toContain('[email]');
    expect(fixture.input.body).toContain('[phone]');
    expect(fixture.input.context.estimate.customer_name).toBe('[redacted_customer_name]');
    expect(fixture.input.context.estimate.address).toBe('[redacted_address]');
  });

  test('can build explicit non-redacted fixtures for local debugging', () => {
    const doc = buildFixtureDocument({
      workflow: 'estimate_conversion_sms',
      decisions: [decision()],
      redact: false,
    });

    expect(doc.redacted).toBe(false);
    expect(doc.cases[0].input.context.estimate.customer_name).toBe('Paul Stratton');
  });

  test('uses corrected actions when a correction exists', () => {
    const fixture = fixtureFromDecision(decision({
      human_verdict: 'corrected',
      status: 'corrected',
      corrected_actions: ['set_next_follow_up'],
    }));

    expect(fixture.expected.recommendedActions).toEqual(['set_next_follow_up']);
  });

  test('evaluates a matching Paul-style fixture successfully', () => {
    const fixture = fixtureFromDecision(decision({
      recommended_actions: [
        'mark_conversion_intent',
        'link_lead_to_estimate',
        'set_next_follow_up',
        'offer_calendar_slots_for_requested_window',
      ],
    }));
    const result = evaluateFixture(fixture);
    expect(result.ok).toBe(true);
  });

  test('evaluates documents with pass/fail counts', () => {
    const doc = buildFixtureDocument({
      workflow: 'estimate_conversion_sms',
      exportedAt: '2026-05-29T12:00:00.000Z',
      decisions: [
        decision({
          recommended_actions: [
            'mark_conversion_intent',
            'link_lead_to_estimate',
            'set_next_follow_up',
            'offer_calendar_slots_for_requested_window',
          ],
        }),
      ],
    });

    const result = evaluateFixtureDocument(doc);
    expect(result).toMatchObject({
      workflow: 'estimate_conversion_sms',
      caseCount: 1,
      passed: 1,
      failed: 0,
    });
  });

  test('evaluates service scheduling fixtures with the service scheduling classifier', () => {
    const fixture = fixtureFromDecision(serviceSchedulingDecision());
    const result = evaluateFixture(fixture);

    expect(fixture.workflow).toBe('service_scheduling_sms');
    expect(result).toMatchObject({
      ok: true,
      actual: {
        intent: 'service_scheduling_window_reply',
        recommendedActions: expect.arrayContaining(['draft_service_scheduling_reply']),
      },
    });
  });

  test('evaluates customer SMS triage fixtures with the triage classifier', () => {
    const fixture = fixtureFromDecision(customerSmsTriageDecision());
    const result = evaluateFixture(fixture);

    expect(fixture.workflow).toBe('customer_sms_triage');
    expect(result).toMatchObject({
      ok: true,
      actual: {
        intent: 'customer_nudge_needs_reply',
        recommendedActions: expect.arrayContaining(['draft_customer_reply']),
      },
    });
  });
});
