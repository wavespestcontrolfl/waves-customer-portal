const {
  classifyEstimateSmsIntent,
  extractShortCode,
  normalizePhoneLast10,
} = require('../services/estimate-conversion-agent');

describe('estimate conversion agent shadow decisions', () => {
  const estimate = {
    id: 'estimate-1',
    customer_name: 'Paul Stratton',
    status: 'viewed',
    waveguard_tier: 'bronze',
  };

  test('detects Paul-style estimate acceptance and keeps scheduling/billing guarded', () => {
    const decision = classifyEstimateSmsIntent(
      'Ok. I think I will give your team a try. Can we look to start the week of June 8th?',
      { estimate }
    );

    expect(decision).toMatchObject({
      intent: 'accepted_estimate_by_text',
      confidence: expect.any(Number),
      suggestedMessage: expect.stringContaining('openings for that week'),
    });
    expect(decision.confidence).toBeGreaterThanOrEqual(0.9);
    expect(decision.recommendedActions).toEqual(expect.arrayContaining([
      'mark_conversion_intent',
      'mark_estimate_accepted_after_review',
      'link_lead_to_estimate',
      'propagate_waveguard_tier',
      'offer_calendar_slots_for_requested_window',
    ]));
    expect(decision.autoActionsAllowed).toEqual(expect.arrayContaining([
      'mark_conversion_intent',
      'link_lead_to_estimate',
      'set_next_follow_up',
    ]));
    expect(decision.blockedActions).toEqual(expect.arrayContaining([
      'silently_schedule_without_confirmed_slot',
      'create_subscription',
      'charge_card',
    ]));
    expect(decision.safetyFlags).toEqual(expect.arrayContaining([
      'billing_invoice_only',
      'never_create_subscription',
      'scheduling_requires_explicit_slot',
    ]));
  });

  test('answers first-visit home access without inventing a booked slot', () => {
    const decision = classifyEstimateSmsIntent(
      'I can start any time, I just do not need to have it start for a couple weeks. Do I need to be home for the 1st visit?',
      { estimate }
    );

    expect(decision.recommendedActions).toEqual(expect.arrayContaining([
      'answer_home_access_question',
      'offer_calendar_slots_for_requested_window',
    ]));
    expect(decision.suggestedMessage).toContain('do not need to be home');
    expect(decision.blockedActions).toContain('silently_schedule_without_confirmed_slot');
  });

  test('skips unrelated texts without an estimate context', () => {
    const decision = classifyEstimateSmsIntent('Thanks, have a good day', {});
    expect(decision.intent).toBeNull();
    expect(decision.recommendedActions).toEqual([]);
  });

  test('skips unrelated courtesy texts even with an estimate context', () => {
    const decision = classifyEstimateSmsIntent('Great! Thank you', { estimate });
    expect(decision.intent).toBeNull();
    expect(decision.recommendedActions).toEqual([]);
  });

  test('keeps general estimate questions but gives them a draft action', () => {
    const decision = classifyEstimateSmsIntent('How much would it be to add lawn pest control later?', { estimate });
    expect(decision.intent).toBe('estimate_question');
    expect(decision.recommendedActions).toEqual(expect.arrayContaining(['draft_estimate_question_reply']));
    expect(decision.autoActionsAllowed).toEqual(expect.arrayContaining(['draft_estimate_question_reply']));
  });

  test('extracts short-code estimate links and normalizes phones', () => {
    expect(extractShortCode('Hello Paul! Your estimate is ready: https://portal.wavespestcontrol.com/l/ek556')).toBe('ek556');
    expect(normalizePhoneLast10('+1 (941) 555-0101')).toBe('9415550101');
  });
});
