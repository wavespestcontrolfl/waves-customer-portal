/**
 * Lead "why" filler — label rules, call-level switch evidence and the nightly
 * recompute contract. All topics and quotes are SYNTHETIC (never real
 * customer speech or names).
 */
const {
  planLeadWhy, SWITCH_REASONS, NOT_BOOKED_REASONS, PREVIOUS_COMPANIES, _test: { SWITCH_RULES, NOT_BOOKED_RULES },
} = require('../services/lead-why-fill');

const NOW = new Date('2026-11-25T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const lead = (o = {}) => ({
  status: 'contacted', created_at: daysAgo(10), previous_company: null, switch_reason: null, not_booked_reason: null, ...o,
});
const chunk = (tag, topics, o = {}) => ({ speaker: 'caller', tag, quote: 'synthetic', context: null, topics, call_log_id: 'call-1', ...o });
// A switch chunk on a call that states a relationship with the old provider.
const switchChunk = (topics, o = {}) => chunk('competitor_mention', ['previous provider', ...topics], o);
const lost = (o = {}) => lead({ status: 'lost', ...o });

describe('switch_reason labels', () => {
  test.each([
    ['moved', ['moving']],
    ['pests_came_back', ['treatment effectiveness']],
    ['no_show', ['service gap']],
    ['no_callback', ['callback']],
    ['contract', ['contract']],
    ['bundle', ['bundled services']],
    ['price_creep', ['monthly price']],
  ])('%s', (expected, topics) => {
    expect(planLeadWhy(lead(), [switchChunk(topics)]).switch_reason).toBe(expected);
  });

  test('every rule value is on the published list', () => {
    expect(SWITCH_RULES.map(([r]) => r)).toEqual(SWITCH_REASONS);
  });

  test('the most frequent label wins; a tie goes to list order', () => {
    const chunks = [switchChunk(['pricing']), switchChunk(['price increase']), switchChunk(['service gap'])];
    expect(planLeadWhy(lead(), chunks).switch_reason).toBe('price_creep');
    expect(planLeadWhy(lead(), [switchChunk(['pricing', 'service gap'])]).switch_reason).toBe('no_show');
  });

  test('shopping labels alone are no switch evidence', () => {
    const c = chunk('competitor_mention', ['comparison shopping', 'turner', 'competitor pricing']);
    expect(planLeadWhy(lead(), [c])).toEqual({});
  });

  test('a relationship label on one chunk lets a later chunk of the same call give the reason', () => {
    const chunks = [
      chunk('competitor_mention', ['previous provider', 'orkin']),
      chunk('complaint', ['missed appointment']),
    ];
    expect(planLeadWhy(lead(), chunks)).toEqual({ previous_company: 'Orkin', switch_reason: 'no_show' });
  });

  test('another call without a relationship label does not join in', () => {
    const chunks = [
      chunk('competitor_mention', ['previous provider', 'orkin']),
      chunk('complaint', ['missed appointment'], { call_log_id: 'call-2' }),
    ];
    expect(planLeadWhy(lead(), chunks)).toEqual({ previous_company: 'Orkin' });
  });

  test('a rival quoted in a shopping chunk is not the old provider or the reason', () => {
    const chunks = [
      chunk('churn_signal', ['current provider', 'service gap']),
      chunk('competitor_mention', ['orkin', 'quote comparison', 'monthly price']),
    ];
    expect(planLeadWhy(lead(), chunks)).toEqual({ switch_reason: 'no_show' });
  });

  test('agent chunks are ignored', () => {
    expect(planLeadWhy(lead(), [switchChunk(['pricing'], { speaker: 'agent' })])).toEqual({});
  });
});

describe('previous_company labels', () => {
  test('full and short company labels', () => {
    expect(planLeadWhy(lead(), [switchChunk(['turner pest control'])]).previous_company).toBe('Turner');
    expect(planLeadWhy(lead(), [switchChunk(['truly nolan'])]).previous_company).toBe('Truly Nolen');
    expect(planLeadWhy(lead(), [switchChunk(['home team'])]).previous_company).toBe('HomeTeam');
    expect(PREVIOUS_COMPANIES).toContain('Turner');
  });
  test('two rivals is ambiguous and stays unset', () => {
    expect(planLeadWhy(lead(), [switchChunk(['turner', 'orkin'])]).previous_company).toBeUndefined();
  });
  test('a rival name inside another label does not count', () => {
    expect(planLeadWhy(lead(), [switchChunk(['returner discount'])]).previous_company).toBeUndefined();
  });
});

describe('not_booked_reason labels', () => {
  test.each([
    ['spouse', ['spouse approval']],
    ['one_visit', ['one-time treatment']],
    ['no_plan', ['service commitment']],
    ['wants_a_look', ['inspection request']],
    ['price', ['affordability']],
    ['timing', ['appointment time']],
  ])('%s', (expected, topics) => {
    expect(planLeadWhy(lost(), [chunk('objection', topics)]).not_booked_reason).toBe(expected);
  });

  test('list matches the rules plus no_response', () => {
    expect(NOT_BOOKED_REASONS).toEqual([...NOT_BOOKED_RULES.map(([r]) => r), 'no_response']);
  });

  test('a price objection that names the plan is a price reason when price is said more', () => {
    const chunks = [chunk('objection', ['quarterly price', 'price']), chunk('objection', ['recurring service'])];
    expect(planLeadWhy(lost(), chunks).not_booked_reason).toBe('price');
  });

  test('only objection chunks count; a need is not a rejection', () => {
    expect(planLeadWhy(lost(), [chunk('need', ['quarterly service'])]).not_booked_reason).toBeUndefined();
  });

  test('only lost / unresponsive leads get a reason', () => {
    const c = [chunk('objection', ['price'])];
    for (const status of ['won', 'duplicate', 'disqualified', 'contacted', 'new', 'estimate_viewed']) {
      expect(planLeadWhy(lead({ status }), c).not_booked_reason).toBeUndefined();
    }
    expect(planLeadWhy(lost(), c).not_booked_reason).toBe('price');
  });

  test('a converted or booked lead gets none', () => {
    const c = [chunk('objection', ['price'])];
    expect(planLeadWhy(lost({ converted_at: daysAgo(5) }), c).not_booked_reason).toBeUndefined();
    expect(planLeadWhy(lost(), c, { booked: true }).not_booked_reason).toBeUndefined();
  });

  test('no_response only for an unresponsive lead with no other reason', () => {
    expect(planLeadWhy(lead({ status: 'unresponsive' }), []).not_booked_reason).toBe('no_response');
    expect(planLeadWhy(lead({ status: 'unresponsive' }), [chunk('objection', ['price'])]).not_booked_reason).toBe('price');
    expect(planLeadWhy(lost(), []).not_booked_reason).toBeUndefined();
  });
});

describe('the job owns the fields: nightly recompute', () => {
  const chunks = [switchChunk(['orkin', 'monthly price']), chunk('objection', ['price'])];
  test('only changed fields are in the patch; a stale value is replaced or cleared', () => {
    const l = lost({ switch_reason: 'price_creep', previous_company: 'Orkin', not_booked_reason: 'price' });
    expect(planLeadWhy(l, chunks)).toEqual({});
    expect(planLeadWhy({ ...l, switch_reason: 'contract' }, chunks)).toEqual({ switch_reason: 'price_creep' });
    expect(planLeadWhy(l, chunks, { booked: true })).toEqual({ not_booked_reason: null });
  });
  test('no_response waits while a recent linked call is still unmined', () => {
    const l = lead({ status: 'unresponsive' });
    expect(planLeadWhy(l, [], { miningPending: true })).toEqual({});
    expect(planLeadWhy({ ...l, not_booked_reason: 'no_response' }, [chunk('objection', ['price'])])).toEqual({ not_booked_reason: 'price' });
  });
  test('is idempotent', () => {
    const first = planLeadWhy(lost(), chunks);
    expect(planLeadWhy(lost(first), chunks)).toEqual({});
  });
});
