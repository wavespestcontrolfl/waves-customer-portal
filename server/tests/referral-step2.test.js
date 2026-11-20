// Referral Step 2 pure rules (services/referral-step2.js): the near / standard member amount,
// the yearly cap boundary and the America/New_York year edge. The money paths are in referral-step2-postgres.test.js.
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const {
  step2Settings, memberCredit, etYearBounds, capReached, ruleTerms, STEP2_DEFAULTS,
} = require('../services/referral-step2');

describe('step2Settings', () => {
  test('a settings row from before the migration, or a cleared field, takes the owner numbers', () => {
    expect(step2Settings({})).toEqual(STEP2_DEFAULTS);
    expect(step2Settings({ step2_annual_credit_cap: null, step2_near_radius_miles: '' })).toEqual(STEP2_DEFAULTS);
    expect(STEP2_DEFAULTS).toEqual({
      step2_referrer_reward_cents: 2500,
      step2_near_referrer_reward_cents: 5000,
      step2_near_radius_miles: 0.5,
      step2_annual_credit_cap: 10,
    });
  });

  test('numeric strings from a decimal column are read as numbers; a negative falls back', () => {
    const s = step2Settings({ step2_near_radius_miles: '0.75', step2_annual_credit_cap: -1 });
    expect(s.step2_near_radius_miles).toBe(0.75);
    expect(s.step2_annual_credit_cap).toBe(10);
  });
});

describe('memberCredit', () => {
  // 0.01 degree of latitude is about 0.69 mile.
  const member = { latitude: '27.4990000', longitude: '-82.5700000' };
  const at = (dLat) => ({ latitude: String(27.499 + dLat), longitude: '-82.57' });

  test('a friend within half a mile is near: $50', () => {
    expect(memberCredit(member, at(0.005), {})).toEqual({ cents: 5000, reason: 'near' });
  });
  test('a friend farther than half a mile gets the standard $25', () => {
    expect(memberCredit(member, at(0.01), {})).toEqual({ cents: 2500, reason: 'standard' });
  });
  test('the radius and both amounts come from the settings', () => {
    const settings = { step2_near_radius_miles: 1, step2_near_referrer_reward_cents: 6000, step2_referrer_reward_cents: 3000 };
    expect(memberCredit(member, at(0.01), settings)).toEqual({ cents: 6000, reason: 'near' });
    expect(memberCredit(member, at(0.05), settings)).toEqual({ cents: 3000, reason: 'standard' });
  });
  test('a home with no map point is never near', () => {
    expect(memberCredit(member, { latitude: null, longitude: null }, {})).toEqual({ cents: 2500, reason: 'standard' });
    expect(memberCredit({ latitude: '27.499', longitude: null }, at(0), {})).toEqual({ cents: 2500, reason: 'standard' });
    expect(memberCredit(undefined, at(0), {})).toEqual({ cents: 2500, reason: 'standard' });
    expect(memberCredit(member, undefined, {})).toEqual({ cents: 2500, reason: 'standard' });
  });
  test('a zero latitude or longitude is a placeholder, never a pin: two (0, 0) homes are not zero miles apart', () => {
    const origin = { latitude: '0.0000000', longitude: '0.0000000' };
    expect(memberCredit(origin, origin, {})).toEqual({ cents: 2500, reason: 'standard' });
    expect(memberCredit(origin, { latitude: 0, longitude: 0 }, {})).toEqual({ cents: 2500, reason: 'standard' });
    expect(memberCredit({ latitude: 0, longitude: -82.57 }, { latitude: 0, longitude: -82.57 }, {})).toEqual({ cents: 2500, reason: 'standard' });
    expect(memberCredit({ latitude: 27.499, longitude: 0 }, { latitude: 27.499, longitude: 0 }, {})).toEqual({ cents: 2500, reason: 'standard' });
    expect(memberCredit(member, origin, {})).toEqual({ cents: 2500, reason: 'standard' });
  });
  test('the same point is near', () => {
    expect(memberCredit(member, member, {})).toEqual({ cents: 5000, reason: 'near' });
  });
});

describe('capReached', () => {
  test('9 credits this year still earns the next; 10 does not', () => {
    expect(capReached(9, {})).toBe(false);
    expect(capReached(10, {})).toBe(true);
    expect(capReached(11, {})).toBe(true);
  });
  test('the cap comes from the setting', () => {
    expect(capReached(4, { step2_annual_credit_cap: 5 })).toBe(false);
    expect(capReached(5, { step2_annual_credit_cap: 5 })).toBe(true);
  });
});

describe('etYearBounds', () => {
  test('the year runs from midnight ET January 1 (UTC-5) to the next one', () => {
    const { start, end } = etYearBounds(new Date('2026-07-04T12:00:00Z'));
    expect(start.toISOString()).toBe('2026-01-01T05:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T05:00:00.000Z');
  });
  test('7:30 PM ET December 31 is still that year, though it is already January 1 in UTC', () => {
    const { start, end } = etYearBounds(new Date('2027-01-01T00:30:00Z'));
    expect(start.toISOString()).toBe('2026-01-01T05:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T05:00:00.000Z');
  });
  test('a credit a minute before and a minute after ET midnight fall in different years', () => {
    const { start, end } = etYearBounds(new Date('2027-01-01T05:01:00Z'));
    expect(start.toISOString()).toBe('2027-01-01T05:00:00.000Z');
    const before = new Date('2027-01-01T04:59:00Z');
    expect(before >= start).toBe(false);
    expect(end.toISOString()).toBe('2028-01-01T05:00:00.000Z');
  });
});

describe('ruleTerms (what staff read before confirming a referral)', () => {
  test('the owner numbers, and the live row when the office changes them', () => {
    expect(ruleTerms({ referee_discount_cents: 2500 }).text).toBe('Member: $25, or $50 within half a mile; friend: $25 credit');
    expect(ruleTerms({
      referee_discount_cents: 2000, step2_referrer_reward_cents: 3000, step2_near_referrer_reward_cents: 6000, step2_near_radius_miles: '1.00',
    })).toMatchObject({ atCap: false, text: 'Member: $30, or $60 within 1 mile; friend: $20 credit', short: 'member $30 or $60 within 1 mile; friend $20' });
    expect(ruleTerms({ referee_discount_cents: 2550, step2_near_radius_miles: 0.75 }).text).toBe('Member: $25, or $50 within 0.75 miles; friend: $25.5 credit');
  });
  test('a member at the yearly limit gets $0, stated, and the friend credit still shows', () => {
    expect(ruleTerms({ referee_discount_cents: 2500 }, true)).toEqual({
      atCap: true, text: 'Member is at the yearly limit: $0; friend: $25 credit', short: 'member at the yearly limit: $0; friend $25',
      conditional: 'Member: $25, or $50 within half a mile, unless at the yearly limit; friend: $25 credit',
    });
  });
});
