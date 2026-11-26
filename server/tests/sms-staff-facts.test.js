/**
 * Texting AI facts, step 2 (owner 2026-11-25): the prepaid visits left and the prep guide of the customer's booked visit. The prepaid
 * count reaches the model ONLY as a finished sentence of the payment-status contract (a count the model writes itself is held, at draft
 * and at send); guide text only as a screened PREP GUIDE section for that one service. Opt-in: other context callers carry neither.
 */
const paymentStatus = require('../services/payment-status-contract');

const GATE = 'GATE_SMS_REAL_ANSWERS';
let priorGate;
beforeEach(() => { priorGate = process.env[GATE]; process.env[GATE] = 'true'; });
afterEach(() => { if (priorGate === undefined) delete process.env[GATE]; else process.env[GATE] = priorGate; });

const billing = { outstandingBalance: 0, recentPayments: [], hasProcessingPayment: false, recentPaymentsTruncated: false, invoiceStatuses: [], hasDepositActivity: false };
const withFacts = (extra = {}) => ({
  summary: 'X',
  billing,
  prepaidPlans: [{ label: 'Quarterly Pest Control', remaining: 3, paid: 4 }],
  ...extra,
});
const LEFT = 'Your prepaid Quarterly Pest Control plan has 3 of 4 prepaid visits left.';

describe('prepaid visits left (payment-status contract)', () => {
  test('a plan renders one exact sentence of a known shape; singular count; nothing when absent', () => {
    const sentences = paymentStatus.renderPaymentStatusSentences(withFacts());
    expect(sentences.find((s) => s.kind === 'prepaid_visits_left').text).toBe(LEFT);
    for (const { kind, text } of sentences) expect(paymentStatus.SHAPES[kind].test(text)).toBe(true);
    const one = paymentStatus.renderPaymentStatusSentences(withFacts({ prepaidPlans: [{ label: 'Lawn Care', remaining: 1, paid: 1 }] })).map((s) => s.text);
    expect(one).toContain('Your prepaid Lawn Care plan has 1 of 1 prepaid visit left.');
    for (const prepaidPlans of [null, [], undefined]) {
      expect(paymentStatus.renderPaymentStatusSentences(withFacts({ prepaidPlans })).map((s) => s.kind)).not.toContain('prepaid_visits_left');
    }
  });

  test('two series of one service (an exhausted one beside its renewal) render neither: a label cannot tell them apart', () => {
    const kinds = (prepaidPlans) => paymentStatus.renderPaymentStatusSentences(withFacts({ prepaidPlans })).map((s) => s.kind).filter((k) => k === 'prepaid_visits_left');
    expect(kinds([{ label: 'Quarterly Pest Control', remaining: 0, paid: 4 }, { label: 'quarterly pest control', remaining: 4, paid: 4 }])).toEqual([]);
    expect(kinds([{ label: 'Quarterly Pest Control', remaining: 0, paid: 4 }, { label: 'Lawn Care', remaining: 4, paid: 4 }])).toEqual(['prepaid_visits_left', 'prepaid_visits_left']);
  });

  test('a label that could split or fake a sentence, or a bad count, renders nothing', () => {
    const kinds = (prepaidPlans) => paymentStatus.renderPaymentStatusSentences(withFacts({ prepaidPlans })).map((s) => s.kind).filter((k) => k === 'prepaid_visits_left');
    expect(kinds([{ label: 'Pest. Your balance is $0.00', remaining: 1, paid: 4 }])).toEqual([]);
    expect(kinds([{ label: 'a, b', remaining: 1, paid: 4 }, { label: 'Pest', remaining: 5, paid: 4 }, { label: 'Pest', remaining: 1.5, paid: 4 }, { label: 'Pest', remaining: 0, paid: 0 }])).toEqual([]);
  });

  test('a reply holds when it states a visit count outside a verbatim copy, in any wording', () => {
    const sentences = paymentStatus.renderPaymentStatusSentences(withFacts());
    const check = (reply) => paymentStatus.checkPaymentStatusReply({ reply, sentences, inboundText: 'How many visits do I have left?' }).ok;
    expect(check(`Hi Dana, ${LEFT}`)).toBe(true);
    expect(check('Your prepaid Quarterly Pest Control plan has 2 of 4 prepaid visits left.')).toBe(false);
    // the claim detector uses the question's visit nouns: appointments count too
    expect(check('You have three appointments left.')).toBe(false);
    // an explicit coverage claim is a count claim whatever the customer asked
    for (const claim of ['Your plan still covers three visits.', 'The plan has four visits.', 'You have three services left.']) {
      expect(paymentStatus.checkPaymentStatusReply({ reply: claim, sentences, inboundText: 'When is my next visit?' }).ok).toBe(false);
    }
    for (const own of ['You have 3 visits left.', 'Three treatments remain on your plan.', 'You have two prepaid visits.', 'There are 3 left visits.',
      // short answers to the count question: no count word in the model's own words
      'You have three more visits.', 'Three more.', 'None left.', 'A couple more.', 'Three.', '3.', 'Just two!', 'Happy to help. Four', 'You have three.']) expect(check(own)).toBe(false);
    // (the question asked for the count, so even true text beside the copy is held: the copy answers alone)
    expect(check('We will see you on Tuesday.')).toBe(false);
    // the question decides: a short number to another question is not a plan count, an unknown question is judged as asking
    const other = (reply, inboundText) => paymentStatus.checkPaymentStatusReply({ reply, sentences, inboundText }).ok;
    expect(other('We will be there in two hours.', 'What time will you arrive?')).toBe(true);
    expect(other('We will see you on Tuesday.', 'When is my next visit?')).toBe(true);
    expect(other('Three more.', null)).toBe(false);
  });

  test('a count question is answered by the copy alone: nothing else, in any words', () => {
    const sentences = paymentStatus.renderPaymentStatusSentences(withFacts());
    const ask = (reply, inboundText = 'How many visits are left?') => paymentStatus.checkPaymentStatusReply({ reply, sentences, inboundText }).ok;
    const check2 = (reply, inboundText) => paymentStatus.checkPaymentStatusReply({ reply, sentences, inboundText }).ok;
    expect(ask(LEFT)).toBe(true);
    expect(ask(`Hi Dana, ${LEFT} Thanks for reaching out!`)).toBe(true);
    for (const own of ['You have three.', 'A couple left, I think.', `${LEFT} Your next visit is Tuesday.`, 'Your plan is almost used up.']) expect(ask(own)).toBe(false);
    // a package or cadence question is not a question about the customer's own count: the published answer stands
    for (const q of ['How many visits are included in the cockroach treatment?', 'How many times a year do you treat for pests?']) expect(ask('We include two visits in that package.', q)).toBe(true);
    expect(ask('Three.', 'How many appointments do I have left?')).toBe(false);
    // money or time left is not a visit count (a prepaid count must not answer it)
    expect(check2(LEFT, 'How much money is left on my prepaid plan?')).toBe(false);
    expect(ask('Two hours.', 'How many hours are left on my plan?')).toBe(true);
    expect(ask('Three.', 'How many do I have left on my prepaid plan?')).toBe(false);
    expect(ask('Four.', 'How many prepaid visits are on my plan?')).toBe(false);
    expect(ask('Three.', 'How many visits are still covered?')).toBe(false);
    // availability questions are not plan-count questions (unless the plan is named)
    expect(ask('We can move it to Friday.', 'Do you have any appointments left on Friday?')).toBe(true);
    expect(ask('Three.', 'Do I have any visits left?')).toBe(false);
    // time is excluded only when it is the thing counted
    expect(ask('Three.', 'How many visits do I have left this year?')).toBe(false);
    // an open-slot answer to an availability question is a scheduling reply, not a plan count
    expect(ask('We have two appointments left on Friday.', 'Do you have any appointments left for Friday?')).toBe(true);
    expect(ask('We can come Friday morning.', 'Do you have any appointments remaining on Friday?')).toBe(true);
    expect(ask('Three.', 'How many appointments do you have left?')).toBe(true);
    expect(ask('We have plenty of openings this week.', 'How many appointments do you have left?')).toBe(true);
    expect(ask('You have two appointments left on your prepaid plan.', 'Do you have any appointments left for Friday?')).toBe(false);
    expect(ask('Three.', 'How many are left on my plan?')).toBe(false);
    // a treatment-frequency question is not a plan-count question
    expect(ask('Bed bugs usually take two treatments.', 'How many treatments do I need for bed bugs?')).toBe(true);
    expect(ask('Three.', 'How many appointments do I have left on my prepaid plan?')).toBe(false);
    // a complaint about the last visit is not a count question
    expect(ask('I am sorry about the gate, we will make sure it is closed.', 'At the last visit you left the gate open')).toBe(true);
    // not a count question about the plan: a scheduling reply or a different quantity
    expect(ask('We can move your prepaid visit to Tuesday.', 'Can I reschedule my prepaid visit?')).toBe(true);
    expect(ask('Two hours.', 'How many hours are left before you arrive?')).toBe(true);
    // another true billing sentence does not answer a count question
    const price = { kind: 'dues_monthly', text: 'Your monthly plan price is $99.00.' };
    const mixed = [...sentences, price];
    const askMixed = (reply, inboundText) => paymentStatus.checkPaymentStatusReply({ reply, sentences: mixed, inboundText }).ok;
    expect(askMixed(price.text, 'How many visits do I have left?')).toBe(false);
    expect(askMixed(`${price.text} ${LEFT}`, 'How many visits do I have left?')).toBe(true);
    expect(askMixed(price.text, 'How much is my monthly plan?')).toBe(true);
    // asking to reschedule a prepaid visit is a scheduling question, not a count question
    expect(ask('We can come Tuesday.', 'Can I reschedule my prepaid visit?')).toBe(true);
  });

  test('a copied count answers the plan the customer named, never another plan\'s', () => {
    const sentences = paymentStatus.renderPaymentStatusSentences(withFacts({ prepaidPlans: [{ label: 'Quarterly Pest Control', remaining: 3, paid: 4 }, { label: 'Lawn Care', remaining: 1, paid: 4 }] }));
    const LAWN = 'Your prepaid Lawn Care plan has 1 of 4 prepaid visits left.';
    const check = (reply, inboundText) => paymentStatus.checkPaymentStatusReply({ reply, sentences, inboundText }).ok;
    expect(check(LEFT, 'How many pest control visits do I have left?')).toBe(true);
    expect(check(LAWN, 'How many pest control visits do I have left?')).toBe(false);
    expect(check(LAWN, 'How many lawn visits do I have left?')).toBe(true);
    expect(check(LAWN, 'How many cockroach treatments do I have left?')).toBe(false);
    // a service name the alias table does not know is held for a person, not answered with whichever plan was copied
    expect(check(LAWN, 'How many ant treatments do I have left?')).toBe(false);
    expect(check(LAWN, 'How many visits for ants do I have left?')).toBe(false);
    expect(check(LAWN, 'How many more visits do I have left?')).toBe(true);
    // two services named: only a plan that names both answers ("Lawn Pest Control" is turf service, not the pest plan)
    expect(check(LEFT, 'How many Lawn Pest Control visits do I have left?')).toBe(false);
    // a count answers a count question, never a payment or receipt question
    expect(check(LEFT, 'Did you receive my payment?')).toBe(false);
    expect(check(LEFT, 'Did you receive the payment for my prepaid plan?')).toBe(false);
    expect(check(LEFT, 'Do I still have prepaid visits on my plan?')).toBe(true);
    expect(check(LAWN, 'How many visits are left on my street?')).toBe(true);
    expect(check(`${LEFT} ${LAWN}`, 'How many pest control visits do I have left?')).toBe(false);
    // no service named: either plan's sentence may answer
    expect(check(LAWN, 'How many visits do I have left?')).toBe(true);
  });

  test('a visit-count claim is judged at the send boundary even when the customer asked nothing about money', () => {
    const { bodyNeedsPaymentRecheck, bodyNeedsBillingBoundaryCheck } = require('../services/sms-amount-recheck');
    for (const body of [LEFT, 'You have 3 visits left.']) {
      expect(bodyNeedsPaymentRecheck(body, { inboundMessage: 'When is my next visit?' })).toBe(true);
      expect(bodyNeedsBillingBoundaryCheck(body, { inboundMessage: 'When is my next visit?' })).toBe(true);
    }
    expect(bodyNeedsPaymentRecheck('We will see you Tuesday morning.', { inboundMessage: 'When is my next visit?' })).toBe(false);
  });

  test('the facts block renders it under BILLING and reads it back for a replay', () => {
    const { buildFactsBlock } = require('../services/sms-shadow-drafter');
    const block = buildFactsBlock(withFacts());
    expect(block).toContain(`  - ${LEFT}`);
    expect(paymentStatus.sentencesFromFactsBlock(block).map((s) => s.text)).toContain(LEFT);
    delete process.env[GATE];
    expect(buildFactsBlock(withFacts())).not.toContain('prepaid');
  });
});

describe('loadPrepaidPlanFacts', () => {
  afterEach(() => { jest.dontMock('../services/prepaid-series'); jest.resetModules(); });
  // a db whose scheduled_services read returns the given rows (annual-linked, stamped booster, ...)
  const dbWith = (rows) => () => { const q = { where: () => q, whereNotNull: () => q, orWhere: () => q, select: async () => rows }; return q; };
  const load = async (plans, rows, customerId = 'c1') => {
    jest.resetModules();
    jest.doMock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
    jest.doMock('../services/prepaid-series', () => ({
      ANNUAL_PREPAY_METHOD: 'annual_prepay_invoice',
      hasAnnualCoverage: (row) => !!(row.annual_prepay_term_id || row.prepaid_method === 'annual_prepay_invoice'),
      resolveSeriesParentId: (row) => row.recurring_parent_id || row.id,
      listCustomerPrepaidPlans: jest.fn(async () => { if (plans instanceof Error) throw plans; return plans; }),
    }));
    return require('../services/sms-staff-facts').loadPrepaidPlanFacts(customerId, { db: dbWith(rows) });
  };
  const plan = (over) => ({ seriesParentId: 'p1', serviceType: 'Quarterly Pest Control', remainingVisits: 3, paidVisits: 4, ...over });
  const row = (over) => ({ id: 'v1', recurring_parent_id: 'p1', service_type: 'Quarterly Pest Control', annual_prepay_term_id: null, prepaid_method: null, prepaid_amount: 50, is_recurring: true, recurring_pattern: 'quarterly', ...over });
  const LAWN = { label: 'Lawn Care', remaining: 3, paid: 4 };

  test('maps the plan rollup; a plan with an impossible count is left out', async () => {
    expect(await load([plan(), plan({ seriesParentId: 'p2', serviceType: 'Odd', remainingVisits: 9 })], [row()])).toEqual([{ label: 'Quarterly Pest Control', remaining: 3, paid: 4 }]);
  });

  test('a series an annual prepay term covers or is linked to is left out: its stamped visits are not the term\'s funded entitlement', async () => {
    const plans = [plan(), plan({ seriesParentId: 'p2', serviceType: 'Lawn Care' })];
    // one visit of series p1 is linked to an annual term; p2 is a manual prepay
    expect(await load(plans, [row({ annual_prepay_term_id: 't1' })])).toEqual([LAWN]);
    // the series parent itself carries the annual stamp
    expect(await load(plans, [row({ id: 'p2', recurring_parent_id: null, service_type: 'Lawn Care', prepaid_method: 'annual_prepay_invoice' })])).toEqual([{ label: 'Quarterly Pest Control', remaining: 3, paid: 4 }]);
  });

  test('an independently prepaid booster (no cadence, bills its own price) keeps its series out: it is not a plan visit', async () => {
    const plans = [plan(), plan({ seriesParentId: 'p2', serviceType: 'Lawn Care' })];
    expect(await load(plans, [row({ id: 'b1', is_recurring: false, recurring_pattern: null, prepaid_amount: 40 })])).toEqual([LAWN]);
    // a stamped visit that is merely not flagged recurring but has a cadence pattern is a plan visit
    expect(await load(plans, [row({ is_recurring: false })])).toHaveLength(2);
  });

  test('a label shared with another series is ambiguous: an exhausted plan beside its renewal renders nothing, an annual-linked renewal (stamped or not) included', async () => {
    const plans = [plan({ remainingVisits: 0 }), plan({ seriesParentId: 'p3', serviceType: 'Lawn Care' })];
    expect(await load([plans[0], plan({ seriesParentId: 'p2', remainingVisits: 4 })], [row({ id: 'v9', recurring_parent_id: 'p2', annual_prepay_term_id: 't1' })])).toEqual([]);
    // the renewal's visits are linked to an annual term but none is stamped yet, so it is not in the rollup at all: its label still counts
    expect(await load(plans, [row({ id: 'n1', recurring_parent_id: 'p9', annual_prepay_term_id: 't2', prepaid_amount: null })])).toEqual([LAWN]);
    expect(await load(plans, [row({ id: 'n1', recurring_parent_id: 'p9', annual_prepay_term_id: 't2', prepaid_amount: null, service_type: 'Quarterly Pest Control' })])).toEqual([LAWN]);
  });

  test('a failed read is null (an outage), never an empty plan list; no customer is null', async () => {
    expect(await load(new Error('boom'), [])).toBeNull();
    expect(await load([plan()], [], null)).toBeNull();
  });
});
