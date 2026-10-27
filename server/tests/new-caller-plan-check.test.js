// D8 bell first (services/booking/new-caller-plan-check.js): when the call that a
// visit booked by address links to agreed a plan price, the check bell shows the
// plan the call agreed and which of the six checks pass; nothing sets a price.
// The failing cases are the misreads the past-call test found (2026-10-25).
// Fixtures fictitious.
const { loadPlanCheck, planCheckDetail, planCheckRecord, _private: { planCheck } } = require('../services/booking/new-caller-plan-check');

const QUARTERLY = { id: 'svc-q', service_key: 'pest_general_quarterly', name: 'Quarterly Pest Control Service', billing_type: 'recurring', frequency: 'quarterly', visits_per_year: 4 };
const MONTHLY = { id: 'svc-m', service_key: 'pest_general_monthly', name: 'Monthly Pest Control Service', billing_type: 'recurring', frequency: 'monthly', visits_per_year: 12 };
const ONE_TIME = { id: 'svc-o', service_key: 'flea_tick', name: 'Flea Control Service', billing_type: 'one_time', frequency: null, visits_per_year: null };
const ASSESSMENT = { id: 'svc-a', service_key: 'lawn_inspection', name: 'Waves Assessment', billing_type: 'one_time', frequency: null, visits_per_year: null };
const VISIT = { id: 'v-1', service_id: 'svc-q', service_type: 'Quarterly Pest Control Service' };

const price = (amount, unit, extra = {}) => ({
  amount_usd: amount, amount_max_usd: null, unit, accepted: true, caller_response: 'accepted', stated_by: 'agent', prepay_term: null, evidence_quote: null, ...extra,
});
const extraction = (prices, request = {}) => ({
  service_request: {
    specific_service_name: 'Quarterly Pest Control Service',
    price_offered_by_staff: true,
    price_accepted_by_caller: true,
    price_is_final: true,
    quote_promised: false,
    prices,
    price: prices[0] || null,
    ...request,
  },
});
const check = (ext, over = {}) => planCheck({ extraction: ext, visit: VISIT, bookedService: QUARTERLY, namedService: QUARTERLY, setupFee: 99, ...over });

describe('which linked visits get a plan check', () => {
  test('none when the call agreed no price, the first visit is a Waves Assessment, or a one-time job has its own price', () => {
    expect(check(extraction([price(107, 'per_application', { accepted: false, caller_response: 'declined' })]))).toBeNull();
    expect(check(extraction([price(107, 'per_application')]), { bookedService: ASSESSMENT })).toBeNull();
    expect(check(extraction([price(107, 'per_application')]), { bookedService: null, visit: { ...VISIT, service_id: null, service_type: 'Waves Assessment' } })).toBeNull();
    expect(check(extraction([price(150, 'one_time')]), { bookedService: ONE_TIME })).toBeNull();
    expect(check(extraction([price(150, 'per_application')]), { bookedService: ONE_TIME })).toBeNull();
  });

  test('a one-time job with a price a quarter is a plan to check, and its schedule does not match', () => {
    expect(check(extraction([price(110, 'per_quarter')]), { bookedService: ONE_TIME })).toMatchObject({ yearly: 440, perVisit: null, failed: ['same_schedule'] });
  });
});

describe('the plan the call agreed', () => {
  test('a quarterly plan said two ways that agree: price per visit, yearly total, prepay, the setup fee and the words, all six checks pass', () => {
    const plan = check(extraction([
      price(107, 'per_application', { prepay_term: 'none', evidence_quote: 'it would be 107   every three months' }),
      price(428, 'per_year', { evidence_quote: 'so 428 for the year' }),
      price(99, 'one_time', { evidence_quote: 'plus the 99 setup' }),
    ]));

    expect(plan).toMatchObject({
      service: 'Quarterly Pest Control Service', perVisit: 107, yearly: 428, prepay: 'none',
      setupFee: { amount: 99, said: 'accepted' }, failed: [], allPass: true,
      quotes: ['it would be 107 every three months', 'so 428 for the year', 'plus the 99 setup'],
    });
    expect(planCheckDetail(plan)).toBe([
      'Plan from the call: Quarterly Pest Control Service, $107.00 a visit, $428.00 a year. Prepay: pays per visit. $99 setup fee: said and accepted.',
      '  Said on the call: "it would be 107 every three months"; "so 428 for the year"; "plus the 99 setup"',
      '  Checks: all six pass.',
      '  The plan is not set up. Set it up by hand, as today.',
    ].join('\n'));
    expect(planCheckRecord(plan)).toEqual({ all_pass: true, failed: [], per_visit: 107, yearly: 428, prepay: 'none', setup_fee_said: 'accepted' });
  });

  test('a yearly price on annual prepay gives the price per visit from the booked service\'s visits', () => {
    const plan = check(extraction([price(400, 'per_year', { prepay_term: 'annual' })]));
    expect(plan).toMatchObject({ perVisit: 100, yearly: 400, prepay: 'annual', setupFee: { said: 'not_said' }, allPass: true });
  });

  test('a price with no plan unit has no yearly total, and the bell says so', () => {
    const plan = check(extraction([price(110, 'unknown')]));
    expect(plan).toMatchObject({ perVisit: null, yearly: null, failed: ['one_yearly_total'], allPass: false });
    expect(planCheckDetail(plan)).toContain('Plan from the call: Quarterly Pest Control Service, $110.00, no yearly total.');
    expect(planCheckDetail(plan)).toContain('Checks not passed: every accepted plan price gives the same yearly total.');
  });

  test('the setup fee counts as said only at the fee\'s own amount', () => {
    expect(check(extraction([price(107, 'per_application'), price(99, 'one_time', { accepted: false, caller_response: 'not_at_issue' })])).setupFee)
      .toEqual({ amount: 99, said: 'not_accepted' });
    expect(check(extraction([price(107, 'per_application'), price(79, 'one_time')])).setupFee).toEqual({ amount: 99, said: 'not_said' });
    const fee79 = check(extraction([price(107, 'per_application'), price(79, 'one_time')]), { setupFee: 79 });
    expect(fee79.setupFee).toEqual({ amount: 79, said: 'accepted' });
    expect(planCheckDetail(fee79)).toContain('$79 setup fee: said and accepted.');
  });
});

describe('the past-call misreads each fail a check', () => {
  const failedOf = (ext, over) => check(ext, over).failed;

  test('"$75 every three months, $300 a year" read as $75 a month: the yearly totals differ', () => {
    expect(failedOf(extraction([price(75, 'per_month'), price(300, 'per_year')]))).toEqual(['one_yearly_total']);
  });

  test('a range, a later price, or a promised estimate is not a final price', () => {
    expect(failedOf(extraction([price(90, 'per_quarter', { amount_max_usd: 100 })]))).toEqual(['final_price']);
    expect(failedOf(extraction([price(206, 'per_application')], { price_is_final: false }))).toEqual(['final_price']);
    expect(failedOf(extraction([price(110, 'per_quarter')], { quote_promised: true }))).toEqual(['final_price']);
  });

  test('a price the caller read from the website, or one the caller never accepted, fails the staff and caller check', () => {
    expect(failedOf(extraction([price(99, 'per_quarter')], { price_offered_by_staff: false }))).toEqual(['staff_offered_caller_accepted']);
    expect(failedOf(extraction([price(107, 'per_application')], { price_accepted_by_caller: null }))).toEqual(['staff_offered_caller_accepted']);
  });

  test('the service the call names must have the booked visit\'s schedule', () => {
    expect(failedOf(extraction([price(107, 'per_application')]), { namedService: MONTHLY })).toEqual(['same_schedule']);
    expect(failedOf(extraction([price(107, 'per_application')]), { namedService: null })).toEqual(['same_schedule']);
  });

  test('every failed check is named in the bell', () => {
    const plan = check(extraction([price(75, 'per_month'), price(300, 'per_year')], { quote_promised: true }), { namedService: MONTHLY });
    expect(planCheckDetail(plan)).toContain('Checks not passed: it was the last price said, not a range, and no estimate was promised; '
      + 'every accepted plan price gives the same yearly total; the service the call names has the same schedule as the booked visit.');
  });
});

describe('loadPlanCheck', () => {
  function servicesConn(rows) {
    const conn = jest.fn(() => ({ where: () => ({ select: async () => rows }) }));
    return conn;
  }

  test('reads nothing when the call agreed no price', async () => {
    const conn = servicesConn([]);
    await expect(loadPlanCheck(conn, VISIT, { service_request: { prices: [] } })).resolves.toBeNull();
    await expect(loadPlanCheck(conn, VISIT, null)).resolves.toBeNull();
    expect(conn).not.toHaveBeenCalled();
  });

  test('finds the booked service by the visit and the named one by the call reader\'s catalog name, with the converter\'s setup fee', async () => {
    const conn = servicesConn([MONTHLY, QUARTERLY]);
    const plan = await loadPlanCheck(conn, VISIT, extraction([price(107, 'per_application')], { specific_service_name: 'quarterly pest control service' }));
    expect(conn).toHaveBeenCalledTimes(1);
    expect(conn).toHaveBeenCalledWith('services');
    expect(plan).toMatchObject({ service: 'Quarterly Pest Control Service', yearly: 428, setupFee: { amount: require('../services/estimate-converter').WAVEGUARD_SETUP_FEE }, allPass: true });
  });
});
