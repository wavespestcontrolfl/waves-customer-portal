/**
 * Lead "why" filler — rule table + never-overwrite contract.
 * All quotes are SYNTHETIC (never real customer speech or names).
 */
const {
  planLeadWhy, SWITCH_REASONS, NOT_BOOKED_REASONS, PREVIOUS_COMPANIES, _test: { SWITCH_RULES, NOT_BOOKED_RULES },
} = require('../services/lead-why-fill');

const NOW = new Date('2026-11-25T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const lead = (o = {}) => ({
  status: 'contacted', created_at: daysAgo(10), previous_company: null, switch_reason: null, not_booked_reason: null, ...o,
});
const chunk = (tag, quote, o = {}) => ({ speaker: 'caller', tag, quote, context: null, topics: [], ...o });
const switchChunk = (quote, o = {}) => chunk('competitor_mention', quote, o);

describe('switch_reason rules', () => {
  test.each([
    ['moved', 'We just moved into a new house and the old company will not come out here'],
    ['pests_came_back', 'The ants came back two weeks after every treatment'],
    ['no_show', 'They never came on the day they promised'],
    ['no_callback', 'Nobody answers and they never return my calls'],
    ['contract', 'I did not like being locked in to a long contract'],
    ['bundle', 'I want lawn and pest with one company'],
    ['price_creep', 'They raised the price again this year'],
  ])('%s', (expected, quote) => {
    expect(planLeadWhy(lead(), [switchChunk(quote)], NOW).switch_reason).toBe(expected);
  });

  test('every rule outputs a value on the published list, and every list value has a rule', () => {
    expect(SWITCH_RULES.map(([r]) => r)).toEqual(SWITCH_REASONS);
    expect(SWITCH_REASONS).toEqual(['moved', 'pests_came_back', 'no_show', 'no_callback', 'contract', 'bundle', 'price_creep']);
  });

  test('a specific complaint beats the broad price theme', () => {
    const q = 'The bugs came back and the price went up too';
    expect(planLeadWhy(lead(), [switchChunk(q)], NOW).switch_reason).toBe('pests_came_back');
  });

  test('agent speech and non-provider chunks are ignored', () => {
    expect(planLeadWhy(lead(), [switchChunk('they raised the price', { speaker: 'agent' })], NOW).switch_reason).toBeUndefined();
    expect(planLeadWhy(lead(), [chunk('praise', 'they raised the price')], NOW).switch_reason).toBeUndefined();
    // complaint about us, not a prior provider
    expect(planLeadWhy(lead(), [chunk('complaint', 'the quote price is too high')], NOW).switch_reason).toBeUndefined();
  });

  test('a complaint about a prior provider counts', () => {
    const c = chunk('complaint', 'my current provider keeps missing appointments', { topics: ['current provider'] });
    expect(planLeadWhy(lead(), [c], NOW).switch_reason).toBe('no_show');
  });
});

describe('previous_company', () => {
  test('names one rival from the fixed list, any case', () => {
    expect(planLeadWhy(lead(), [switchChunk('I have been with ORKIN for years')], NOW).previous_company).toBe('Orkin');
    expect(planLeadWhy(lead(), [switchChunk('our old company', { topics: ['Tru Green'] })], NOW).previous_company).toBe('TruGreen');
    expect(PREVIOUS_COMPANIES).toContain('Turner');
  });
  test('two different rivals is ambiguous and stays NULL', () => {
    expect(planLeadWhy(lead(), [switchChunk('Orkin quoted me, but I am leaving Terminix')], NOW).previous_company).toBeUndefined();
  });
  test('a bare word is not a rival', () => {
    expect(planLeadWhy(lead(), [switchChunk('an arrow on the sign pointed to the house')], NOW).previous_company).toBeUndefined();
  });
});

describe('not_booked_reason rules', () => {
  test.each([
    ['spouse', 'I need to talk to my husband first'],
    ['one_visit', 'I only want a one-time treatment'],
    ['no_plan', 'I do not want to commit to a recurring plan'],
    ['wants_a_look', 'Can someone come out and look at it before we decide'],
    ['price', 'That is too much for us right now'],
    ['timing', 'We are out of town, maybe next month'],
  ])('%s', (expected, quote) => {
    expect(planLeadWhy(lead(), [chunk('objection', quote)], NOW).not_booked_reason).toBe(expected);
  });

  test('list matches the rules plus no_response', () => {
    expect(NOT_BOOKED_REASONS).toEqual([...NOT_BOOKED_RULES.map(([r]) => r), 'no_response']);
    expect(NOT_BOOKED_REASONS).toEqual(['spouse', 'one_visit', 'no_plan', 'wants_a_look', 'price', 'timing', 'no_response']);
  });

  test('no_response only for an unresponsive lead with no other reason', () => {
    expect(planLeadWhy(lead({ status: 'unresponsive' }), [], NOW).not_booked_reason).toBe('no_response');
    expect(planLeadWhy(lead({ status: 'contacted' }), [], NOW).not_booked_reason).toBeUndefined();
    expect(planLeadWhy(lead({ status: 'unresponsive' }), [chunk('objection', 'too expensive')], NOW).not_booked_reason).toBe('price');
  });

  test('won, duplicate, disqualified leads and young open leads get nothing', () => {
    const c = [chunk('objection', 'too expensive')];
    for (const status of ['won', 'duplicate', 'disqualified']) {
      expect(planLeadWhy(lead({ status }), c, NOW).not_booked_reason).toBeUndefined();
    }
    expect(planLeadWhy(lead({ status: 'new', created_at: daysAgo(1) }), c, NOW).not_booked_reason).toBeUndefined();
    expect(planLeadWhy(lead({ status: 'lost', created_at: daysAgo(1) }), c, NOW).not_booked_reason).toBe('price');
  });

  test('reads caller speech only', () => {
    expect(planLeadWhy(lead(), [chunk('objection', 'too expensive', { speaker: 'agent' })], NOW).not_booked_reason).toBeUndefined();
  });
});

describe('never overwrite an office-set value', () => {
  const chunks = [switchChunk('Orkin raised the price on us'), chunk('objection', 'too expensive')];
  test('set fields are absent from the patch; empty ones are filled', () => {
    const l = lead({ switch_reason: 'contract', previous_company: 'Hughes', not_booked_reason: 'spouse' });
    expect(planLeadWhy(l, chunks, NOW)).toEqual({});
    const partial = planLeadWhy(lead({ switch_reason: 'contract' }), chunks, NOW);
    expect(partial).toEqual({ previous_company: 'Orkin', not_booked_reason: 'price' });
  });
  test('a blank string counts as empty, a real value never does', () => {
    expect(planLeadWhy(lead({ switch_reason: '  ' }), chunks, NOW).switch_reason).toBe('price_creep');
    expect(planLeadWhy(lead({ status: 'unresponsive', not_booked_reason: 'timing' }), [], NOW)).toEqual({});
  });
  test('is idempotent: re-planning on a filled lead returns nothing', () => {
    const first = planLeadWhy(lead(), chunks, NOW);
    expect(planLeadWhy(lead(first), chunks, NOW)).toEqual({});
  });
});
