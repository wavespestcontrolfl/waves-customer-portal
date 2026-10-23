// customers.property_sqft is the LAWN mirror; the public quote used to write the HOUSE size into it (owner
// 2026-10-23). The repair clears a value only when it is proven to be the house and no lawn writer has set a size.
const { classify, homeSqFtFromEstimate, parseArgs } = require('../scripts/repair-house-sqft-in-lawn-mirror');

const ADDR = { address_line1: '100 Main St', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34205' };
const quoteEstimate = (homeSqFt, over = {}) => ({ id: 'e1', status: 'draft', source: 'quote_wizard', property_id: 'p1', address: '100 Main St, Bradenton, FL 34205', estimate_data: { engineRequest: { profile: { homeSqFt, estimatedTurfSf: 2900, turfSource: 'vision' } } }, ...over });

describe('homeSqFtFromEstimate', () => {
  test('reads every carrier the quote and the engine write, as a JSON string or an object', () => {
    expect(homeSqFtFromEstimate(JSON.stringify({ engineRequest: { profile: { homeSqFt: 2614 } } }))).toEqual([{ field: 'engineRequest.profile.homeSqFt', value: 2614 }]);
    expect(homeSqFtFromEstimate({ intake: { squareFootage: '2289' }, inputs: { homeSqFt: 2289 } })).toEqual([
      { field: 'inputs.homeSqFt', value: 2289 }, { field: 'intake.squareFootage', value: 2289 },
    ]);
    expect(homeSqFtFromEstimate(null)).toEqual([]);
    expect(homeSqFtFromEstimate('not json')).toEqual([]);
  });
});

describe('classify', () => {
  const base = { customer: { id: 'c1', property_sqft: 2614, lead_source: 'website_quote', ...ADDR }, turf: { lawn_sqft: null }, primary: { id: 'p1', property_sqft: 2614, service_area_measurements: null, ...ADDR }, estimates: [quoteEstimate(2614)] };

  test('house value proven by the estimate, no lawn anywhere → house_in_lawn_mirror (primary cleared with it)', () => {
    expect(classify(base)).toEqual({ class: 'house_in_lawn_mirror', houseField: 'engineRequest.profile.homeSqFt', estimateId: 'e1', propertySqft: 2614, primaryMatches: true });
    // The primary holds a different number: only the customer row is cleared.
    expect(classify({ ...base, primary: { ...base.primary, property_sqft: 3000 } }).primaryMatches).toBe(false);
    // No primary row yet: the quote's address still ties the estimate to the customer's own address.
    expect(classify({ ...base, primary: null, estimates: [quoteEstimate(2614, { property_id: null })] })).toMatchObject({ class: 'house_in_lawn_mirror', primaryMatches: false });
  });

  test('only a quote-wizard estimate for the customer\'s own primary can prove the house (codex #6520 r1 P1)', () => {
    // Same number, but the estimate came from another flow: a legacy lawn mirror with a coincidental home size stays.
    expect(classify({ ...base, estimates: [quoteEstimate(2614, { source: 'admin_tool' })] }).class).toBe('unproven');
    // Quote estimate for ANOTHER property (linked elsewhere, or a different address).
    expect(classify({ ...base, estimates: [quoteEstimate(2614, { property_id: 'p9' })] }).class).toBe('unproven');
    expect(classify({ ...base, estimates: [quoteEstimate(2614, { property_id: null, address: '9 Other Rd, Bradenton, FL 34205' })] }).class).toBe('unproven');
    // No customer-row marker is consulted: the old route kept an existing lead_source and copied attribution text
    // into lead_source_detail, so an existing customer quoted later still qualifies on the estimate alone (r2 P1).
    expect(classify({ ...base, customer: { ...base.customer, lead_source: 'referral', lead_source_detail: 'Landing: /lawn' } }).class).toBe('house_in_lawn_mirror');
  });

  test('the quote\'s own lead row proves the house when the estimate upsert failed after the customer update (codex #6520 r2 P2)', () => {
    const lead = (homeSqFt, over = {}) => ({ id: 'l1', lead_type: 'quote_wizard', extracted_data: JSON.stringify({ stage: 'quote_calculated', homeSqFt }), ...over });
    expect(classify({ ...base, estimates: [], leads: [lead(2614)] })).toMatchObject({ class: 'house_in_lawn_mirror', houseField: 'lead.extracted_data.homeSqFt', leadId: 'l1' });
    expect(classify({ ...base, estimates: [], leads: [lead(2614, { extracted_data: { homeSqFt: 2614 } })] }).class).toBe('house_in_lawn_mirror');
    expect(classify({ ...base, estimates: [], leads: [lead(1900)] }).class).toBe('unproven');
    expect(classify({ ...base, estimates: [], leads: [lead(2614, { lead_type: 'call' })] }).class).toBe('unproven');
    // The estimate is consulted first; a lead never outranks a lawn write.
    expect(classify({ ...base, turf: { lawn_sqft: 3000 }, estimates: [], leads: [lead(2614)] }).class).toBe('has_turf_lawn');
  });

  test('a real lawn size is never cleared: turf lawn_sqft, a reviewed lawn, or a value no estimate explains', () => {
    expect(classify({ ...base, turf: { lawn_sqft: 2614 } }).class).toBe('has_turf_lawn');
    expect(classify({ ...base, primary: { ...base.primary, service_area_measurements: { areas: { lawn: { sqft: 2614 } } } } }).class).toBe('has_reviewed_lawn');
    expect(classify({ ...base, primary: { ...base.primary, service_area_measurements: JSON.stringify({ areas: { lawn: { sqft: 4800 } } }) } }).class).toBe('has_reviewed_lawn');
    expect(classify({ ...base, estimates: [quoteEstimate(1900)] }).class).toBe('unproven');
    expect(classify({ ...base, estimates: [] }).class).toBe('unproven');
    expect(classify({ ...base, customer: { id: 'c1', property_sqft: null } }).class).toBe('no_property_sqft');
  });

  test('the quote default (2,000) counts only when the estimate records it as the home size', () => {
    expect(classify({ ...base, customer: { ...base.customer, property_sqft: 2000 }, estimates: [quoteEstimate(2000)] }).class).toBe('house_in_lawn_mirror');
    expect(classify({ ...base, customer: { ...base.customer, property_sqft: 2000 }, estimates: [quoteEstimate(2614)] }).class).toBe('unproven');
  });
});

describe('parseArgs', () => {
  test('--out is required; --apply needs the explicit database confirmation', () => {
    expect(() => parseArgs([])).toThrow(/--out/);
    expect(() => parseArgs(['--apply', '--out', 'x.csv'])).toThrow(/i-am-sure/);
    expect(parseArgs(['--out', 'x.csv', '--only', 'c1'])).toEqual({ apply: false, sure: false, out: 'x.csv', only: 'c1' });
    expect(parseArgs(['--apply', '--i-am-sure-this-is-the-intended-database', '--out', 'y.csv']).apply).toBe(true);
    expect(() => parseArgs(['--out', 'x.csv', '--bogus'])).toThrow(/unknown argument/);
  });
});
