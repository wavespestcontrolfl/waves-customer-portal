// Disposition rules layer — every call maps to exactly one terminal
// disposition; ambiguity resolves to the lead-response flow; there is no
// review-queue member (zero-triage mission, docs/call-mining-2026-07-10.md).
const { decideDisposition, TERMINAL_DISPOSITIONS } = require('../services/call-disposition');

describe('terminal disposition enum', () => {
  test('contains no human-review member', () => {
    expect(TERMINAL_DISPOSITIONS).not.toContain('needs_human_review');
    expect(TERMINAL_DISPOSITIONS.some((d) => /review|triage|manual/.test(d))).toBe(false);
  });

  test('every rules-layer output is a member of the enum', () => {
    const cases = [
      {},
      { legacy: { is_lead: true } },
      { legacy: { is_voicemail: true } },
      { extraction: { call_nature: 'vendor_or_partner' } },
      { extraction: { call_nature: 'wrong_number' } },
      { outcome: { appointmentCreated: true } },
      { spamVerdict: { verdict: 'spam' } },
    ];
    for (const c of cases) {
      const { disposition } = decideDisposition(c);
      expect(TERMINAL_DISPOSITIONS).toContain(disposition);
    }
  });
});

describe('hard rules', () => {
  test('an actually-created appointment is always booked', () => {
    const { disposition } = decideDisposition({
      spamVerdict: { verdict: 'spam' }, // even a (mis)verdict cannot unbook reality
      outcome: { appointmentCreated: true },
    });
    expect(disposition).toBe('booked');
  });

  test('spam requires the layered classifier — extraction alone never discards', () => {
    const { disposition } = decideDisposition({
      legacy: { is_spam: true },
      extraction: { call_nature: 'spam_solicitation', spam_verdict: { is_spam_content: true } },
      spamVerdict: null, // classifier didn't run / gate off
    });
    expect(disposition).not.toBe('spam_discarded');
  });

  test('classifier spam verdict discards', () => {
    const { disposition } = decideDisposition({ spamVerdict: { verdict: 'spam' } });
    expect(disposition).toBe('spam_discarded');
  });

  test('insufficient_signals never discards', () => {
    const { disposition } = decideDisposition({ legacy: { is_spam: true }, spamVerdict: { verdict: 'insufficient_signals' } });
    expect(disposition).not.toBe('spam_discarded');
  });
});

describe('intent routing', () => {
  test('known-customer complaint escalates', () => {
    const { disposition } = decideDisposition({
      legacy: { pain_points: ['tech no-show twice, very angry'] },
      outcome: { isKnownCustomer: true },
    });
    expect(disposition).toBe('complaint_escalated');
  });

  test('cancel/reschedule intent from a known customer processes the cancellation', () => {
    const { disposition } = decideDisposition({
      extraction: { triage_flags: ['cancellation_request'] },
      outcome: { customerId: 'c-1' },
    });
    expect(disposition).toBe('cancellation_processed');
  });

  test('quote promised routes to the estimate lane', () => {
    const { disposition } = decideDisposition({ legacy: { quote_promised: true } });
    expect(disposition).toBe('estimate_send');
  });

  test('voicemail with a cancel intent is a cancellation, not a dead voicemail', () => {
    const { disposition } = decideDisposition({
      legacy: { is_voicemail: true },
      extraction: { triage_flags: ['cancellation_request'] },
      outcome: { isKnownCustomer: true },
    });
    expect(disposition).toBe('cancellation_processed');
  });

  test('voicemail lead enters the lead-response flow', () => {
    const { disposition } = decideDisposition({ legacy: { is_voicemail: true, is_lead: true } });
    expect(disposition).toBe('lead_response_flow_triggered');
  });
});

describe('v2-vs-v1 precedence (2026-09-24 call-agent audit)', () => {
  test('v2 valid: recommended_disposition wins over a v1-derived quote guess', () => {
    // v1 legacy mis-set quote_promised=true (the actual promise was a
    // callback), but v2 validated and correctly recommends the callback
    // outcome — v2 must win.
    const { disposition, reason } = decideDisposition({
      legacy: { quote_promised: true },
      extraction: { recommended_disposition: 'callback_task_created' },
    });
    expect(disposition).toBe('callback_task_created');
    expect(reason).toBe('v2_model_recommended');
  });

  test('v2 valid: recommended_disposition wins over the deterministic v2 cancel/reschedule triage_flag when it disagrees', () => {
    // The SAME v2 extraction carries reschedule_or_cancel in triage_flags
    // (would deterministically read as a cancellation) but the model's own
    // recommended_disposition says vendor_logged — recommended still wins.
    const { disposition } = decideDisposition({
      extraction: { triage_flags: ['reschedule_or_cancel'], recommended_disposition: 'vendor_logged' },
      outcome: { customerId: 'c-9' },
    });
    expect(disposition).toBe('vendor_logged');
  });

  test('v2 invalid/missing: falls back to the v1-derived rules unchanged', () => {
    // No extraction passed at all (v2_extraction_status !== 'valid') — the
    // legacy complaint signal must still drive the outcome.
    const { disposition, reason } = decideDisposition({
      legacy: { pain_points: ['refund please, this is unacceptable'] },
      extraction: null,
      outcome: { isKnownCustomer: true },
    });
    expect(disposition).toBe('complaint_escalated');
    expect(reason).toBe('complaint_from_known_customer');
  });

  test('a reschedule request is never written as cancellation_processed — via the model recommendation', () => {
    const { disposition } = decideDisposition({
      extraction: {
        scheduling: { status: 'reschedule_requested' },
        recommended_disposition: 'cancellation_processed', // a bad model guess
      },
      outcome: { customerId: 'c-2' },
    });
    expect(disposition).toBe('existing_customer_routed');
  });

  test('a reschedule request is never written as cancellation_processed — via the deterministic triage_flags path', () => {
    const { disposition } = decideDisposition({
      extraction: {
        scheduling: { status: 'reschedule_requested' },
        triage_flags: ['reschedule_or_cancel'],
      },
      outcome: { isKnownCustomer: true },
    });
    // Not a callback obligation either: the unworked-comms watcher pages
    // every callback_task_created row, and an applied move never revises it.
    expect(disposition).toBe('existing_customer_routed');
  });

  test('a genuine cancellation (not a reschedule) still processes as a cancellation', () => {
    const { disposition } = decideDisposition({
      extraction: {
        scheduling: { status: 'canceled' },
        triage_flags: ['cancellation_request'],
      },
      outcome: { isKnownCustomer: true },
    });
    expect(disposition).toBe('cancellation_processed');
  });

  test('a v1 wrong_number guess yields to a valid v2 recommendation (shadow/rollback config)', () => {
    const { disposition, reason } = decideDisposition({
      extraction: { call_nature: 'new_lead', recommended_disposition: 'estimate_send' },
      legacy: { call_type: 'wrong_number' },
      outcome: {},
    });
    expect(disposition).toBe('estimate_send');
    expect(reason).toBe('v2_model_recommended');
  });

  test('a v1 wrong_number guess stands when v2 offers no usable recommendation; v2 wrong_number is decisive', () => {
    expect(decideDisposition({ extraction: null, legacy: { call_type: 'wrong_number' }, outcome: {} }).disposition).toBe('wrong_number_closed');
    expect(decideDisposition({
      extraction: { call_nature: 'wrong_number', recommended_disposition: 'estimate_send' },
      legacy: {},
      outcome: {},
    }).disposition).toBe('wrong_number_closed');
  });

  test('a reschedule request recommended as callback_task_created routes as existing-customer scheduling', () => {
    const { disposition } = decideDisposition({
      extraction: { scheduling: { status: 'reschedule_requested' }, recommended_disposition: 'callback_task_created' },
      outcome: { customerId: 'c-3' },
    });
    expect(disposition).toBe('existing_customer_routed');
  });

  test('a known customer\'s complaint escalates even when v2 recommends a generic disposition', () => {
    const { disposition, reason } = decideDisposition({
      extraction: {
        call_nature: 'existing_customer_service',
        customer_history: { prior_complaint_mentioned: true },
        recommended_disposition: 'existing_customer_routed',
      },
      outcome: { isKnownCustomer: true },
    });
    expect(disposition).toBe('complaint_escalated');
    expect(reason).toBe('complaint_from_known_customer');
  });

  test('a call that actually produced a booking is always booked, even when v2 recommends something else', () => {
    const { disposition } = decideDisposition({
      extraction: { recommended_disposition: 'lead_response_flow_triggered' },
      outcome: { appointmentCreated: true },
    });
    expect(disposition).toBe('booked');
  });

  test('a won pest upsell that v1 nature-defaulted to existing_customer_routed instead honors v2 recommended', () => {
    const { disposition } = decideDisposition({
      legacy: { requested_service: 'pest upsell' },
      extraction: { call_nature: 'existing_customer_service', recommended_disposition: 'estimate_send' },
      outcome: { isKnownCustomer: true },
    });
    expect(disposition).toBe('estimate_send');
  });

  test('a vendor call is vendor_logged, not swept into estimate_send by a stray v1 quote flag', () => {
    const { disposition } = decideDisposition({
      legacy: { quote_promised: true },
      extraction: { call_nature: 'vendor_or_partner', recommended_disposition: 'vendor_logged' },
    });
    expect(disposition).toBe('vendor_logged');
  });
});

describe('fail-safe', () => {
  test('total ambiguity resolves to the lead-response flow, never a queue', () => {
    const { disposition, reason } = decideDisposition({});
    expect(disposition).toBe('lead_response_flow_triggered');
    expect(reason).toBe('ambiguous_fail_safe');
  });

  test('an invalid model recommendation falls back safely', () => {
    const { disposition } = decideDisposition({ extraction: { recommended_disposition: 'needs_human_review' } });
    expect(TERMINAL_DISPOSITIONS).toContain(disposition);
    expect(disposition).not.toBe('needs_human_review');
  });
});
