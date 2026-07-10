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
