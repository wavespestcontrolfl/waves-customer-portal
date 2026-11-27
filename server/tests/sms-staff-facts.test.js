/**
 * Texting AI facts, step 2 (owner 2026-11-25; owner ruling 2026-09-30, price questions are explained from the estimate on file): the open
 * estimate's per-application price and the prepaid visits left and the prep guide of the customer's booked visit. The prepaid
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
  estimateFacts: { perApplication: [{ label: 'Pest Control', cents: 12500, applications: 4 }] },
  prepaidPlans: [{ label: 'Quarterly Pest Control', remaining: 3, paid: 4 }],
  ...extra,
});
const PRICE = 'Your estimate lists Pest Control at $125.00 per application, 4 applications a year.';
const LEFT = 'Your prepaid Quarterly Pest Control plan has 3 of 4 prepaid visits left.';

describe('the open estimate\'s price (payment-status contract)', () => {
  const kinds = (extra) => paymentStatus.renderPaymentStatusSentences(withFacts(extra)).filter((x) => x.kind === 'estimate_application_price').map((x) => x.text);

  test('each priced line renders one exact sentence of a known shape: the listed price and the applications a year, never a total', () => {
    expect(kinds({})).toEqual([PRICE]);
    expect(kinds({ estimateFacts: { perApplication: [{ label: 'Lawn Care', cents: 6000, applications: 1 }] } })).toEqual(['Your estimate lists Lawn Care at $60.00 per application, 1 application a year.']);
    for (const { kind, text } of paymentStatus.renderPaymentStatusSentences(withFacts())) expect(paymentStatus.SHAPES[kind].test(text)).toBe(true);
    for (const estimateFacts of [null, undefined, { perApplication: [] }]) expect(kinds({ estimateFacts })).toEqual([]);
  });

  test('a label that could split or fake a sentence, a shared label, a bad count or a bad amount renders nothing', () => {
    const line = (over) => ({ estimateFacts: { perApplication: [{ label: 'Pest Control', cents: 12500, applications: 4, ...over }] } });
    expect(kinds(line({ label: 'Pest. Your balance is $0.00' }))).toEqual([]);
    expect(kinds(line({ cents: 0 }))).toEqual([]);
    expect(kinds(line({ cents: -5 }))).toEqual([]);
    expect(kinds(line({ applications: 0 }))).toEqual([]);
    expect(kinds(line({ applications: 100 }))).toEqual([]);
    expect(kinds({ estimateFacts: { perApplication: [{ label: 'Pest Control', cents: 12500, applications: 4 }, { label: 'pest control', cents: 9000, applications: 6 }] } })).toEqual([]);
  });

  test('a price or the applications a year outside a verbatim copy are held, in any wording; so is a setup fee waiver the estimate renders no sentence for', () => {
    const sentences = paymentStatus.renderPaymentStatusSentences(withFacts());
    const check = (reply, inboundText = 'How much is the estimate?') => paymentStatus.checkPaymentStatusReply({ reply, sentences, inboundText }).ok;
    expect(check(`Happy to help. ${PRICE}`)).toBe(true);
    for (const own of ['Your estimate lists Pest Control at $130.00 per application, 4 applications a year.', 'It is about $125 a visit.',
      'You get four applications a year.', 'That is six visits per year.', 'We treat quarterly, so 4 treatments annually.', 'You get visits a year.',
      // this estimate renders no setup sentence: any claim of a waiver is held, in the rendered wording too
      'The setup fee is waived when you prepay.', 'We waive the one-time setup fee.', 'There is no enrollment fee for prepaid plans.', 'Your initial fee is free.',
      'The setup fee is waived on your estimate.', 'Your estimate has no setup fee.', 'Your estimate for Pest Control has no setup fee.', 'We can waive that for you.', 'The setup is waived.']) {
      expect({ own, ok: check(own) }).toEqual({ own, ok: false });
    }
    // an ordinary answer with none of those stays
    expect(check('Your estimate has everything we talked about.')).toBe(true);
  });

  test('a copied price answers a price question, for the service the customer named, never a payment or count question', () => {
    const two = paymentStatus.renderPaymentStatusSentences(withFacts({ estimateFacts: { perApplication: [{ label: 'Pest Control', cents: 12500, applications: 4 }, { label: 'Lawn Care', cents: 6000, applications: 6 }] } }));
    const LAWN = 'Your estimate lists Lawn Care at $60.00 per application, 6 applications a year.';
    const check = (reply, inboundText) => paymentStatus.checkPaymentStatusReply({ reply, sentences: two, inboundText }).ok;
    expect(check(PRICE, 'How much is the pest control?')).toBe(true);
    expect(check(LAWN, 'How much is the pest control?')).toBe(false);
    expect(check(LAWN, 'What does the lawn cost on the quote?')).toBe(true);
    expect(check(PRICE, 'How much is it?')).toBe(true);
    // the estimate's cadence is its application count (4 a year = quarterly), never a word in the label
    expect(check(PRICE, 'How much is quarterly pest control?')).toBe(true);
    expect(check(PRICE, 'How much is monthly pest control?')).toBe(false);
    // bi-monthly is its own cadence (6 a year), not monthly plus bi-monthly
    const SIX = 'Your estimate lists Pest Control at $90.00 per application, 6 applications a year.';
    const six = paymentStatus.renderPaymentStatusSentences(withFacts({ estimateFacts: { perApplication: [{ label: 'Pest Control', cents: 9000, applications: 6 }] } }));
    for (const q of ['How much is bi-monthly pest control?', 'How much is bimonthly pest control?']) expect(paymentStatus.checkPaymentStatusReply({ reply: SIX, sentences: six, inboundText: q }).ok).toBe(true);
    expect(paymentStatus.checkPaymentStatusReply({ reply: SIX, sentences: six, inboundText: 'How much is monthly pest control?' }).ok).toBe(false);
    // a service the alias table does not know, in any price grammar, is held for a person
    for (const q of ['How much is ant control?', 'What does ant control cost?', 'What is the price of wasp removal?']) expect({ q, ok: check(PRICE, q) }).toEqual({ q, ok: false });
    expect(check(PRICE, 'How much is the service?')).toBe(true);
    expect(check(LAWN, 'How much is monthly lawn care?')).toBe(false);
    expect(check(PRICE, 'Did you receive my payment?')).toBe(false);
    // not an invoice, balance or past-charge question unless it also names the estimate
    expect(check(PRICE, 'How much do I owe on my invoice?')).toBe(false);
    // the application line is not the setup fee, a prepay price or a total
    for (const q of ['How much is the setup fee on my estimate?', 'How much to prepay my estimate?', 'What is the total on the quote?', 'How much is the deposit for the estimate?']) expect({ q, ok: check(PRICE, q) }).toEqual({ q, ok: false });
    expect(check(PRICE, 'How much was I charged last month?')).toBe(false);
    expect(check(PRICE, 'How much is the estimate, and what do I owe on my invoice?')).toBe(true);
    expect(check(PRICE, 'How many visits do I have left?')).toBe(false);
    // a service the alias table does not know is held for a person
    expect(check(PRICE, 'How much for ant control?')).toBe(false);
  });

  test('the facts block renders it under BILLING and the PENDING ESTIMATE line points at it', () => {
    const { buildFactsBlock } = require('../services/sms-shadow-drafter');
    const block = buildFactsBlock(withFacts({ pendingEstimate: { status: 'sent' } }));
    expect(block).toContain(`  - ${PRICE}`);
    expect(paymentStatus.sentencesFromFactsBlock(block).map((x) => x.text)).toContain(PRICE);
    // the line names what a rendered sentence may now answer (owner 2026-11-26) and no longer forbids the setup fee or the prepay price
    expect(block).toMatch(/PENDING ESTIMATE: sent .*a setup fee \(or that it is waived\) or a pay-for-the-year total ONLY by copying a matching sentence from Payment status sentences word for word \(with none there, state none\)/);
    expect(block).not.toMatch(/say nothing about a setup fee/);
    // ...and that its question is answered by that sentence alone, or not at all
    expect(block).toMatch(/PENDING ESTIMATE: sent .*A question about the setup fee or about paying for the year is answered by that sentence alone, with only a greeting or thanks beside it; with no sentence that answers it, return ABSTAIN\. Never state a discount or a saving for paying up front/);
    delete process.env[GATE];
    expect(buildFactsBlock(withFacts({ pendingEstimate: { status: 'sent' } }))).not.toMatch(/Your estimate lists|copying a matching sentence/);
  });
});

// Owner 2026-11-26 ("let the AI answer everything"): the open estimate's setup fee, a waiver of it and its pay-for-the-year total are rendered
// sentences too. A rendered sentence is the ONLY wording in which either may be stated, it answers only its own question, and it answers alone.
describe('the open estimate\'s setup fee and pay-for-the-year total (payment-status contract)', () => {
  // an estimate for one service names it; one for several services names none (UNNAMED_*)
  const FEE = 'Your estimate for Pest Control lists a one-time setup fee of $99.00.';
  const FEE_PREPAY = 'Your estimate for Pest Control lists a one-time setup fee of $99.00, waived when you pay for the year up front.';
  const WAIVED = 'The setup fee is waived on your estimate for Pest Control.';
  const NO_FEE = 'Your estimate for Pest Control has no setup fee.';
  const UNNAMED_FEE = 'Your estimate lists a one-time setup fee of $99.00.';
  const UNNAMED_WAIVED = 'The setup fee is waived on your estimate.';
  const UNNAMED_NO_FEE = 'Your estimate has no setup fee.';
  const TOTAL = 'Paid up front for the year, the total on your estimate for Pest Control is $500.00, 4 applications a year.';
  const facts = (terms) => withFacts({ estimateFacts: { perApplication: [{ label: 'Pest Control', cents: 12500, applications: 4 }], terms } });
  const texts = (terms) => paymentStatus.renderPaymentStatusSentences(facts(terms)).filter((x) => /^estimate_(?:setup|no_setup|prepay)/.test(x.kind)).map((x) => x.text);
  const LISTED = { setupFee: { cents: 9900, prepayWaives: false, label: 'Pest Control' }, prepayTotal: null };
  const PREPAY = { setupFee: { cents: 9900, prepayWaives: true, label: 'Pest Control' }, prepayTotal: { label: 'Pest Control', cents: 50000, applications: 4 } };
  const ON_RECORD = { setupFee: { cents: 0, waived: true, label: 'Pest Control' }, prepayTotal: null };
  const SEVERAL = { setupFee: { cents: 0, waived: false, label: null }, prepayTotal: null };
  const checker = (terms) => {
    const sentences = paymentStatus.renderPaymentStatusSentences(facts(terms));
    return (reply, inboundText) => paymentStatus.checkPaymentStatusReply({ reply, sentences, inboundText }).ok;
  };

  test('each fact renders one exact sentence of a known shape; an unread, empty or malformed fact renders none', () => {
    expect(texts(LISTED)).toEqual([FEE]);
    expect(texts(PREPAY)).toEqual([FEE_PREPAY, TOTAL]);
    expect(texts(ON_RECORD)).toEqual([WAIVED]);
    expect(texts({ setupFee: { cents: 0, waived: false, label: 'Pest Control' }, prepayTotal: null })).toEqual([NO_FEE]);
    // no one service to name (an estimate for several services), or a label that could split or fake a sentence: the sentence names none
    expect(texts(SEVERAL)).toEqual([UNNAMED_NO_FEE]);
    expect(texts({ setupFee: { cents: 0, waived: true, label: 'Pest. Your balance is $0.00' } })).toEqual([UNNAMED_WAIVED]);
    expect(texts({ setupFee: { cents: 9900, prepayWaives: false } })).toEqual([UNNAMED_FEE]);
    expect(texts({ setupFee: null, prepayTotal: { label: 'Lawn Care', cents: 36000, applications: 1 } })).toEqual(['Paid up front for the year, the total on your estimate for Lawn Care is $360.00, 1 application a year.']);
    for (const terms of [PREPAY, LISTED, ON_RECORD, SEVERAL, { setupFee: { cents: 0, waived: true } }, { setupFee: { cents: 9900, prepayWaives: true } }]) {
      for (const { kind, text } of paymentStatus.renderPaymentStatusSentences(facts(terms))) expect(paymentStatus.SHAPES[kind].test(text)).toBe(true);
    }
    // the terms read failed (null), nothing may be stated, or the fact is not the loader's shape
    for (const terms of [null, undefined, { setupFee: null, prepayTotal: null }, { setupFee: { cents: 99.5 } }, { setupFee: { cents: -1 } }, { setupFee: { cents: '9900' } }, { setupFee: { waived: true } },
      { prepayTotal: { label: 'Pest. Your balance is $0.00', cents: 50000, applications: 4 } }, { prepayTotal: { label: 'Pest Control', cents: 0, applications: 4 } },
      { prepayTotal: { label: 'Pest Control', cents: 50000.5, applications: 4 } }, { prepayTotal: { label: 'Pest Control', cents: 50000, applications: 0 } }]) {
      expect({ terms, out: texts(terms) }).toEqual({ terms, out: [] });
    }
    // "waived" needs the loader's own true: any other value reads as no waiver, and prepay waives only on true
    expect(texts({ setupFee: { cents: 0, waived: 'yes' } })).toEqual([UNNAMED_NO_FEE]);
    expect(texts({ setupFee: { cents: 9900, prepayWaives: 1 } })).toEqual([UNNAMED_FEE]);
  });

  test('the copy answers its own question, alone or beside the other estimate sentences', () => {
    const listed = checker(LISTED);
    for (const q of ['Is there a setup fee?', 'How much is the setup fee on my estimate?', 'Do I have to pay the one-time fee?', 'Was I charged the setup fee on my quote?']) expect({ q, ok: listed(FEE, q) }).toEqual({ q, ok: true });
    expect(listed(`Hi Dana, ${FEE} Thanks for reaching out!`, 'Is there a setup fee?')).toBe(true);
    // ...for the service it names; the fee is the estimate's whatever cadence the customer names
    for (const q of ['Is there a setup fee for the pest control?', 'Is there a setup fee for the quarterly pest control?']) expect({ q, ok: listed(FEE, q) }).toEqual({ q, ok: true });
    // a sentence that names no service answers a question that names none
    expect(checker(SEVERAL)(UNNAMED_NO_FEE, 'Is there a setup fee?')).toBe(true);
    // the application line may now sit beside the sentence that answers the other charge (alone it is still held: see the price tests)
    expect(listed(`${PRICE} ${FEE}`, 'How much is it, and is there a setup fee?')).toBe(true);
    expect(listed(PRICE, 'How much is it, and is there a setup fee?')).toBe(false);
    const waived = checker(ON_RECORD);
    for (const q of ['Is the setup fee waived?', 'Did you take off the setup fee?', 'Is there still a sign-up fee on the quote?']) expect({ q, ok: waived(WAIVED, q) }).toEqual({ q, ok: true });
    const prepay = checker(PREPAY);
    for (const q of ['How much if I pay for the year up front?', 'What is the total if I prepay?', 'How much to prepay the pest control?', 'Can I pay annually? How much is that?',
      'How much is quarterly pest control paid in full for the year?', 'How much up front for the year?', 'How much is the prepay plan?', 'What is the annual price if I prepay?',
      'Is there an annual payment option, and what does it cost?']) {
      expect({ q, ok: prepay(TOTAL, q) }).toEqual({ q, ok: true });
    }
    // the fee sentence that names the prepay waiver answers a prepay question too, and all three may go together
    expect(prepay(`${TOTAL} ${FEE_PREPAY}`, 'How much if I prepay for the year?')).toBe(true);
    expect(prepay(`${PRICE} ${FEE_PREPAY} ${TOTAL}`, 'How much is it, and how much if I prepay for the year?')).toBe(true);
    expect(prepay(FEE_PREPAY, 'Is the setup fee waived if I prepay?')).toBe(true);
    // the plain fee sentence does not answer a prepay question
    expect(listed(FEE, 'How much if I prepay?')).toBe(false);
  });

  // Hostile cases, at least two per class: every one must be held.
  describe.each([
    ['a waiver the estimate does not render, in any wording', LISTED, 'Is the setup fee waived?', [
      `${FEE} It is waived if you prepay.`, `${FEE} We can take that off for you.`, FEE_PREPAY, WAIVED, NO_FEE, UNNAMED_WAIVED, UNNAMED_NO_FEE,
      'We will waive it.', 'The setup is waived.', 'We are waiving that one for you.', 'No setup fee for you!', 'There is no charge for the one-time setup fee.',
      'Setup is on us.', 'There is no fee to get started.', 'Enrollment is complimentary.', 'We will not charge you for setup.']],
    ['a fee figure that is not the rendered one', LISTED, 'How much is the setup fee?', [
      'Your estimate for Pest Control lists a one-time setup fee of $89.00.', 'The setup fee is $99.', FEE.slice(0, -1), 'Setup is ninety-nine dollars.',
      // the right figure for another service, or with the service left out, is not the rendered sentence either
      'Your estimate for Lawn Care lists a one-time setup fee of $99.00.', UNNAMED_FEE,
      `${FEE} That drops to $49.00 if you sign today.`]],
    ['a waiver on record, stretched past what the sentence says', ON_RECORD, 'Is the setup fee waived?', [
      `${WAIVED} So is your first visit.`, `${WAIVED} That applies to every plan.`, 'The setup fee is waived on your estimate for Pest Control and the first visit is free.',
      'The setup fee is waived on all of our plans.', 'The setup fee is waived on your estimate for Lawn Care.']],
    ['a pay-for-the-year total that is not the rendered one', PREPAY, 'How much if I pay for the year up front?', [
      'Paid up front for the year, the total on your estimate for Pest Control is $450.00, 4 applications a year.',
      'Paid up front for the year, the total on your estimate for Lawn Care is $500.00, 4 applications a year.',
      'Paid up front for the year, the total on your estimate for Pest Control is $500.00, 6 applications a year.',
      'It is $500 for the year if you prepay.', 'That comes to five hundred dollars for the year.']],
    ['a saving or a discount for paying up front: no sentence states one', PREPAY, 'How much if I pay for the year up front?', [
      'Prepaying saves you about ten percent.', 'You get a discount when you pay for the year up front.', 'It is cheaper if you prepay.', `${TOTAL} That is 10% off.`,
      'Paying annually takes a little off the price.', 'You save 5% if you pay up front.', 'Annual plans are a little cheaper.']],
    ['words added beside a pay-for-the-year copy', PREPAY, 'How much if I pay for the year up front?', [
      `${TOTAL} That is before tax.`, `${TOTAL} The setup fee is included.`, `${TOTAL} You can split that in two.`, `${TOTAL} We will see you Tuesday.`]],
  ])('%s', (_name, terms, inboundText, replies) => {
    test.each(replies)('held: %s', (reply) => { expect(checker(terms)(reply, inboundText)).toBe(false); });
  });

  // The detector alone, whatever the customer asked (it also decides which bodies the send-time recheck judges): a waiver, a fee denied, a
  // free setup or a saving for paying up front is a claim in any wording. The same words in ordinary talk are not.
  test.each([
    ['the waive verb', 'We will waive it.'], ['the waive verb', 'The setup is waived.'],
    ['a fee denied', 'There is no fee to get started.'], ['a fee denied', 'You pay no additional fees.'],
    ['a free setup', 'Setup is on us.'], ['a free setup', 'There is no charge for setup.'], ['a free setup', 'Enrollment is complimentary.'], ['a free setup', 'There is no setup with this plan.'],
    ['a saving for paying up front', 'You save 5% if you pay up front.'], ['a saving for paying up front', 'Annual plans are a little cheaper.'],
    ['a saving for paying up front', 'Paying annually takes a little off the price.'],
  ])('a claim, %s: %s', (_class, reply) => { expect(paymentStatus.claimsEstimateTerms(reply)).toBe(true); });
  test.each(['Feel free to text us to set up a time.', 'We can set up a free assessment for you.', 'We will come back at no charge.', 'I will have the office confirm the setup fee for you.',
    'Your annual termite inspection is due.', 'We treat up front and around the garage.', 'Your account setup is complete.',
  ])('not a claim: %s', (reply) => { expect(paymentStatus.claimsEstimateTerms(reply)).toBe(false); });

  // The question decides too, like a count question: the customer's words supply the subject, so an answer to a setup-fee or pay-for-the-year
  // question needs none of the claim words. Once the copies are removed only a greeting or thanks may remain. At least two hostile cases per class.
  describe.each([
    ['a setup-fee question answered with no claim word', 'Is there a setup fee?', ['No.', 'Nope!', 'It is free.', 'That is on us.', 'Not for you.', 'It is included.', 'Yes, there is.', 'Only for new customers.', 'Let me check on that.']],
    ['a pay-for-the-year question answered with no claim word', 'Do I get a discount if I pay for the year up front?', [
      'Yes.', 'Yes, 5% off.', 'You do!', 'Yes, you would save a little.', 'It is a little cheaper.', 'You can pay for the year up front. That saves you five percent.', 'Paying annually is the better deal.']],
    ['a pay-for-the-year question that names no price', 'Can I prepay?', ['Yes, you can!', 'Yes. It works out cheaper that way.']],
    ['another answer beside the question, with no copy', 'Is there a setup fee? Can you come Tuesday?', ['We can come Tuesday.', 'Tuesday works. Setup is quick.']],
  ])('answered by the copy alone, %s', (_name, inboundText, replies) => {
    test.each(replies)('held: %s', (reply) => { expect(checker(PREPAY)(reply, inboundText)).toBe(false); });
  });
  test.each([
    // the customer's own "I paid" beside a price word still asks, in one clause or two
    ['I paid for the year last time is it cheaper to do that again', 'Yes, a little.'],
    ['We prepaid last year. Same price this year?', 'Yes, the same.'],
    ['I paid the setup fee last time, is it waived now?', 'Yes, it is.'],
    // ...and so does a question after it, with or without a comma between them
    ['We paid monthly last year, can we pay for the year this time?', 'Yes, you can.'],
    ['We paid monthly last year can we pay for the year this time', 'Yes, you can.'],
    // a hypothetical is a question
    ['if I paid for the year up front, how much?', 'About the same.'],
    ['what if we prepaid', 'Then it is less.'],
    // the customer's own prepaid plan beside a price word still asks
    ['Is it cheaper to renew my prepaid plan?', 'Yes, a little.'],
    ['How much to add lawn care to our prepaid plan?', 'About the same as pest.'],
  ])('answered by the copy alone, held: %s', (inboundText, reply) => { expect({ reply, ok: checker(PREPAY)(reply, inboundText) }).toEqual({ reply, ok: false }); });
  test.each([
    // the copy alone, or with a greeting and thanks
    ['Is there a setup fee?', FEE_PREPAY], ['Is there a setup fee?', `Hi Dana, ${FEE_PREPAY} Thanks for reaching out!`], ['Can I prepay?', TOTAL],
    // the customer's own statement that they paid, beside another question, is no question about the fee or the year
    ['I paid for the year already, when is my next visit?', 'Your next visit is Tuesday.'],
    ['We prepaid for the year. Can you come Tuesday instead?', 'We can come Tuesday.'],
    ['We\'re prepaid for the year, can the tech call before he comes?', 'Yes, the tech can call first.'],
    ['I already paid the setup fee, when do you start?', 'Your first visit is Tuesday.'],
    ['We are paid up for the year. Do you treat for ants?', 'Yes, we treat for ants.'],
    // ...and so is their own prepaid plan or visit
    ['When is the next visit on my prepaid plan?', 'Your next visit is Tuesday.'],
    ['Can I reschedule the prepaid visit?', 'We can move your visit to Tuesday.'],
    // a setup visit is not a setup fee, and a visit question is no terms question
    ['Does rodent trapping include the setup visit?', 'Rodent trapping includes the setup visit and at least one trap check.'],
    ['Can you come Tuesday?', 'We can come Tuesday.'],
    // nothing but a greeting or thanks claims nothing
    ['Is there a setup fee?', 'Thanks for reaching out!'],
  ])('answered by the copy alone, not held: %s', (inboundText, reply) => { expect({ reply, ok: checker(PREPAY)(reply, inboundText) }).toEqual({ reply, ok: true }); });
  test('the prepay refund policy line still answers its own question, and the send boundary judges an answer to a terms question', () => {
    const policy = require('../services/sms-company-facts').moneyPolicyFacts().find((fact) => fact.startsWith('A customer who prepays'));
    expect(checker(PREPAY)(policy, 'If I prepay for the year and cancel, do I get a refund?')).toBe(true);
    const { bodyNeedsPaymentRecheck } = require('../services/sms-amount-recheck');
    expect(bodyNeedsPaymentRecheck('We can come Tuesday.', { inboundMessage: 'Is there a setup fee? Can you come Tuesday?' })).toBe(true);
    expect(bodyNeedsPaymentRecheck('Yes, you can!', { inboundMessage: 'Can I prepay?' })).toBe(true);
    expect(bodyNeedsPaymentRecheck('Your next visit is Tuesday.', { inboundMessage: 'I paid for the year already, when is my next visit?' })).toBe(false);
    expect(bodyNeedsPaymentRecheck('We can come Tuesday.', { inboundMessage: 'Can you come Tuesday?' })).toBe(false);
  });

  test.each([
    // a setup sentence against a question it does not answer
    [ON_RECORD, WAIVED, 'When is my next visit?'],
    [ON_RECORD, WAIVED, 'How much is the pest control?'],
    [ON_RECORD, WAIVED, 'Why was I charged a setup fee on my invoice?'],
    [ON_RECORD, WAIVED, 'Do I owe a setup fee?'],
    [ON_RECORD, WAIVED, 'Is there a setup fee or a deposit?'],
    [LISTED, FEE, 'Did you get my payment for the setup fee?'],
    // ...or a question about another service: one the estimate is not for, one the lists do not know, or any at all when the sentence names none
    [LISTED, FEE, 'Is there a setup fee for mosquito control?'],
    [LISTED, FEE, 'Is there a setup fee for the weed control?'],
    [ON_RECORD, WAIVED, 'Is the setup fee waived for lawn care?'],
    [SEVERAL, UNNAMED_NO_FEE, 'Is there a setup fee for pest control?'],
    // the prepay waiver is the default plan's: a cadence the sentence cannot confirm holds it
    [PREPAY, FEE_PREPAY, 'Is the setup fee waived if I prepay the monthly pest control?'],
    // the pay-for-the-year total against a question it does not answer
    [PREPAY, TOTAL, 'How much is each application?'],
    [PREPAY, TOTAL, 'How much to prepay the lawn care?'],
    [PREPAY, TOTAL, 'How much to prepay monthly pest control?'],
    [PREPAY, TOTAL, 'How much to prepay ant control?'],
    [PREPAY, TOTAL, 'I prepaid already, what do I owe?'],
    [PREPAY, TOTAL, 'How many prepaid visits do I have left?'],
    [PREPAY, TOTAL, 'How much is the deposit if I prepay?'],
    [PREPAY, TOTAL, 'What is the total on the quote?'],
    // "up front" or "in full" with no year asks what is due first, or about a bill: not the year's total
    [PREPAY, TOTAL, 'How much is due up front?'],
    [PREPAY, TOTAL, 'Can I pay in full?'],
    [PREPAY, TOTAL, 'How much is quarterly pest control paid in full?'],
    // a service or an invoice named inside the prepay phrase still decides
    [PREPAY, TOTAL, 'How much to pay for the lawn care for the year?'],
    [PREPAY, TOTAL, 'Can I pay my invoice for the year up front?'],
    // the application line against a prepay or total question the copies do not answer
    [PREPAY, PRICE, 'How much if I pay for the year up front?'],
    [PREPAY, `${PRICE} ${FEE_PREPAY}`, 'What is the total for the year?'],
    // how the customer pays changes what is charged (a credit card adds the surcharge) and no estimate sentence carries that quote:
    // a question that names a way to pay, or a charge on top of the price by any other name, is answered by none of them
    [PREPAY, TOTAL, 'What will I pay if I prepay with my credit card?'],
    [PREPAY, TOTAL, 'How much if I prepay with a check?'],
    [PREPAY, TOTAL, 'Do you take checks for the annual payment? How much is it?'],
    [PREPAY, TOTAL, 'Do you take cards? How much if I prepay?'],
    [PREPAY, TOTAL, 'How much to prepay through my bank account?'],
    [PREPAY, TOTAL, 'Is there a surcharge if I prepay?'],
    [PREPAY, TOTAL, 'Is there a processing fee if I prepay?'],
    [PREPAY, TOTAL, 'Are there any extra fees if I pay for the year up front?'],
    [PREPAY, TOTAL, 'How much to prepay on autopay?'],
    [PREPAY, TOTAL, 'Can I finance the prepay amount? How much is it?'],
    // ...a way to pay no list knows, by its grammar (a pay word, then with / using / via / by; the thing put to use)
    [PREPAY, TOTAL, 'How much if I pay for the year up front with my HSA?'],
    [PREPAY, TOTAL, 'How much to prepay by plastic?'],
    [PREPAY, TOTAL, 'If I put the year on my Chase, how much to prepay?'],
    [PREPAY, TOTAL, 'Can I use my points if I pay for the year up front? How much?'],
    [PREPAY, TOTAL, 'Does it cost extra if I prepay? How much?'],
    [LISTED, FEE, 'Is there a setup fee if I pay by debit?'],
    [LISTED, FEE, 'Can I put the setup fee on my Visa?'],
    [LISTED, FEE, 'Is there a setup fee or any other fees?'],
    [ON_RECORD, WAIVED, 'Is the setup fee waived if I pay with a card?'],
    [PREPAY, PRICE, 'How much is it per visit with a credit card?'],
    [PREPAY, PRICE, 'How much is the pest control if I pay cash?'],
    [PREPAY, PRICE, 'How much is it per application? Any hidden fees?'],
    // the total and the prepay waiver are for one year paid at once: another span, or a split of the payment, is not theirs to answer
    [PREPAY, TOTAL, 'Can I prepay for six months?'],
    [PREPAY, TOTAL, 'How much to prepay the next visit?'],
    [PREPAY, TOTAL, 'How much to prepay two years?'],
    [PREPAY, TOTAL, 'Can I pay a quarter in advance instead of the year?'],
    [PREPAY, TOTAL, 'How much per month if I pay for the year up front?'],
    [PREPAY, TOTAL, 'Can I split the annual payment in two?'],
    [PREPAY, TOTAL, 'On my estimate, can I make two payments if I pay for the year up front?'],
    [PREPAY, TOTAL, 'Can I prepay for the month?'],
    [PREPAY, TOTAL, 'How much to prepay the rest of the year?'],
    [PREPAY, TOTAL, 'How much to prepay for 18 months?'],
    [PREPAY, TOTAL, 'Can I prepay for the season?'],
    [PREPAY, TOTAL, 'How much if I prepay for 90 days?'],
    [PREPAY, TOTAL, 'How much to prepay the first one?'],
    [PREPAY, TOTAL, 'How much to prepay 6mo?'],
    [PREPAY, TOTAL, 'How much to prepay through March?'],
    [PREPAY, TOTAL, 'How much to prepay the next 2?'],
    [PREPAY, FEE_PREPAY, 'Is the setup fee waived if I prepay six months?'],
    // the setup fee and the total belong to the recurring plan: a one-time service is not theirs to answer
    [LISTED, FEE, 'Is there a setup fee for one-time pest control?'],
    [LISTED, FEE, 'Is there a setup fee if I just want a one-time?'],
    [LISTED, FEE, 'Is there a setup fee if you only come out once?'],
    [LISTED, FEE, 'Is there a setup fee for one treatment?'],
    [LISTED, FEE, 'Is there a setup fee without a contract?'],
    [ON_RECORD, WAIVED, 'Is the setup fee waived for a one-off?'],
    // what paying for the year costs is answered by the total: the prepay waiver alone would lend its own figure to that question
    [PREPAY, FEE_PREPAY, 'How much if I prepay for the year?'],
    [PREPAY, FEE_PREPAY, 'What is the cost to pay annually?'],
    [PREPAY, FEE_PREPAY, 'Can I prepay?'],
    // a question that names the fee or the prepayment but asks something else: a receipt or a charge, a refund, when, why, a request
    [PREPAY, TOTAL, 'Did my prepayment go through?'],
    [PREPAY, TOTAL, 'Has my prepayment posted?'],
    [PREPAY, TOTAL, 'Is my prepayment refundable?'],
    [LISTED, FEE, 'Did the setup fee go through?'],
    [LISTED, FEE, 'Did you charge me the setup fee?'],
    [LISTED, FEE, 'Is the setup fee refundable?'],
    [LISTED, FEE, 'When do I pay the setup fee?'],
    [LISTED, FEE, 'Is the setup fee due at the first visit?'],
    [LISTED, FEE, 'Why is there a setup fee?'],
    [LISTED, FEE, 'What is the setup fee for?'],
    [LISTED, FEE, 'Can you waive the setup fee?'],
  ])('off target: %#', (terms, reply, inboundText) => {
    expect({ reply, inboundText, ok: checker(terms)(reply, inboundText) }).toEqual({ reply, inboundText, ok: false });
  });
  test('words that are no way to pay, no extra charge and no other span keep their answer: the verb "check", a fee that is the price, twelve months, one year', () => {
    const listed = checker(LISTED);
    const prepay = checker(PREPAY);
    for (const q of ['Can you check if there is a setup fee?', 'I will check with my husband. Is there a setup fee?', 'Is the setup fee a one-time fee?', 'Is there a setup fee for the first visit?',
      'Is there a setup fee for six months of service?']) expect({ q, ok: listed(FEE, q) }).toEqual({ q, ok: true });
    for (const q of ['How much to pay for 12 months up front?', 'How much if I prepay for one year?', 'How much if I prepay for 1 year?', 'How much to prepay this year?',
      'Can you check how much it is to prepay?', 'Are all visits included if I prepay? How much?', 'How much if I pay by the year?', 'How much do I save by paying for the year up front?',
      'How much to prepay 12mo?', 'How much to prepay 1 yr?']) {
      expect({ q, ok: prepay(TOTAL, q) }).toEqual({ q, ok: true });
    }
    for (const q of ['Can you check my estimate? How much is the pest control?', 'How much is the fee per application?']) expect({ q, ok: prepay(PRICE, q) }).toEqual({ q, ok: true });
  });
  test('"one-time" or "once" said of the fee, paying once for the year, the waiver beside the total and a past-tense question about a waiver or the estimate keep their answer', () => {
    const listed = checker(LISTED);
    const prepay = checker(PREPAY);
    for (const q of ['Is the setup fee one-time?', 'Is the setup fee one time or every year?', 'Do I pay the setup fee once?', 'Is there a one-time fee?', 'Did you quote me a setup fee?',
      'Was there a setup fee on my estimate?', 'Is there a setup fee when I sign up?', 'Is there a setup fee once I sign up?', 'What is the setup fee for pest control?',
      'Does the price include a setup fee?']) {
      expect({ q, ok: listed(FEE, q) }).toEqual({ q, ok: true });
    }
    expect(checker(ON_RECORD)(WAIVED, 'Has the setup fee been waived?')).toBe(true);
    for (const q of ['How much if I pay once a year?', 'How much if I pay for the year all at once?', 'Can I just pay once for the year? How much is that?', 'How much is due if I pay for the year up front?']) {
      expect({ q, ok: prepay(TOTAL, q) }).toEqual({ q, ok: true });
    }
    expect(prepay(`${TOTAL} ${FEE_PREPAY}`, 'How much if I prepay for the year?')).toBe(true);
    for (const q of ['Is the setup fee waived if I prepay?', 'Do you waive anything if I pay for the year up front?', 'Is there a setup fee if I pay for the year up front?']) {
      expect({ q, ok: prepay(FEE_PREPAY, q) }).toEqual({ q, ok: true });
    }
  });

  // A question that names the setup fee or paying for the year is answered by one of those sentences. Another true billing sentence alone
  // (an invoice line, a receipt, a visit count) would be read as that answer, so the copies must carry a setup-fee or pay-for-the-year copy.
  describe('a terms question needs a terms copy', () => {
    const INVOICE = 'Invoice WPC-2026-0100 for $150.00 is paid.';
    const RECEIPT = 'We received your $120.00 card payment on Sep 12, 2026.';
    const check = (reply, inboundText) => paymentStatus.checkPaymentStatusReply({ reply, sentences: [PRICE, FEE_PREPAY, TOTAL, LEFT, INVOICE, RECEIPT], inboundText }).ok;
    test.each([
      ['Is there a setup fee?', INVOICE], ['Is there a setup fee?', `Hi Dana, ${INVOICE} Thanks!`], ['Is the setup fee waived?', RECEIPT],
      ['How much if I pay for the year up front?', INVOICE], ['Can I prepay?', RECEIPT], ['How much would my prepayment be?', INVOICE],
      // the prepaid count answers its own question, but lends no cover to an invoice line beside it
      ['Is there a setup fee? How many visits do I have left?', `${LEFT} ${INVOICE}`],
      // known cost: a receipt question that names the fee or the prepayment itself (no "I paid") goes to a person too
      ['Did my prepayment go through?', RECEIPT], ['Did you get my payment for the setup fee?', RECEIPT],
    ])('held: %s', (inboundText, reply) => { expect({ reply, ok: check(reply, inboundText) }).toEqual({ reply, ok: false }); });
    test.each([
      // the sentence that answers it, alone or with the application line beside it
      ['Is there a setup fee?', FEE_PREPAY], ['How much is it, and is there a setup fee?', `${PRICE} ${FEE_PREPAY}`],
      // the customer's own payment keeps its answer: "I paid" is no question about the fee or the year
      ['I already paid the setup fee, did it go through?', RECEIPT], ['I prepaid for the year, did you get it?', RECEIPT],
      // ...a count question is answered by the prepaid count alone, whatever else it names
      ['How many visits are left if I prepay?', LEFT],
      // ...and a question that names neither is judged as before
      ['Did my payment go through?', RECEIPT], ['Is my invoice paid?', INVOICE], ['How many visits do I have left on my prepaid plan?', LEFT],
    ])('not held: %s', (inboundText, reply) => { expect({ reply, ok: check(reply, inboundText) }).toEqual({ reply, ok: true }); });
  });

  test('never auto-sent: a setup, waiver or pay-for-the-year copy goes out only when a person sends it', () => {
    for (const [text, inboundText] of [[WAIVED, 'Is the setup fee waived?'], [NO_FEE, 'Is there a setup fee?'], [FEE, 'Is there a setup fee?'], [TOTAL, 'How much if I prepay?']]) {
      expect(paymentStatus.autoSendScopeBlock({ reply: `Hi Dana, ${text}`, inboundText, snapshot: { sentences: [text] } })).toBe('payment_status_not_auto_sendable');
    }
  });

  test('the facts block renders them under BILLING and reads them back', () => {
    const { buildFactsBlock } = require('../services/sms-shadow-drafter');
    const block = buildFactsBlock({ ...facts(PREPAY), pendingEstimate: { status: 'sent' } });
    for (const text of [PRICE, FEE_PREPAY, TOTAL]) expect(block).toContain(`  - ${text}`);
    expect(paymentStatus.sentencesFromFactsBlock(block).map((x) => x.text)).toEqual(expect.arrayContaining([PRICE, FEE_PREPAY, TOTAL]));
    delete process.env[GATE];
    expect(buildFactsBlock({ ...facts(PREPAY), pendingEstimate: { status: 'sent' } })).not.toMatch(/setup fee|Paid up front/);
  });
});

describe('loadEstimateFacts', () => {
  const MOCKED = ['../services/estimate-monthly-average', '../utils/estimate-claim-sql', '../services/estimate-proposal-billing', '../routes/estimate-public',
    '../services/annual-prepay-estimate-suggestion', '../services/estimate-manual-acceptance', '../services/invoice'];
  afterEach(() => { for (const m of MOCKED) jest.dontMock(m); jest.resetModules(); });
  const perApplicationAverageFor = jest.fn();
  const callSideBlockForEstimateData = jest.fn();
  const resolveLivePricing = jest.fn();
  const whatYouPayForEstimate = jest.fn();
  const whatYouPayAcceptLookups = jest.fn();
  const buildAnnualPrepayEstimateSuggestion = jest.fn();
  const annualPrepayInvoiceTotalForEstimate = jest.fn();
  const previewInvoiceTotals = jest.fn();
  // the customer's open estimates (sent or viewed, not archived): one by default
  const dbWithOpen = (rows) => () => { const q = { where: () => q, whereIn: () => q, whereNull: () => q, limit: () => q, select: async () => { if (rows instanceof Error) throw rows; return rows; } }; return q; };
  const oneOpen = dbWithOpen([{ id: 'e1' }]);
  const orThrow = (value) => async () => { if (value instanceof Error) throw value; return value; };
  // The page's answer for a new pest customer (synthetic figures): a setup fee the page shows prepay waiving, one plan line, 4 applications a year.
  const FEE_ROW = { service: 'waveguard_setup', amount: 99, label: 'WaveGuard setup', waivedWithPrepay: true };
  const BUNDLE = { frequencies: [{ key: 'quarterly' }, { key: 'bimonthly' }], firstVisitFees: [FEE_ROW] };
  const BOX = { selection: { frequency: 'quarterly', serviceCadences: null }, lines: [{ key: 'pest_control', label: 'Pest Control', perApplication: 125, applicationsPerYear: 4 }], setupFee: 99, setupWaivedWithPrepay: true, firstVisitTotal: 224 };
  // `taxed`: what the invoice module's dry run adds for this customer (0 = a residential account)
  const LOOKUPS = { monthlyBilled: false, pendingDeposit: 0 };
  const load = async (estimate, { average, offSurface = false, callBlock = null, db = oneOpen, live = { bundle: BUNDLE }, lookups = LOOKUPS, box = BOX, suggestion = { amount: 500, coverageVisitCount: 4 }, billed = 500, taxed = 0 } = {}) => {
    jest.resetModules();
    jest.doMock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
    perApplicationAverageFor.mockReset().mockImplementation(orThrow(average));
    callSideBlockForEstimateData.mockReset().mockImplementation(orThrow(callBlock));
    resolveLivePricing.mockReset().mockImplementation(orThrow(live));
    whatYouPayAcceptLookups.mockReset().mockImplementation(orThrow(lookups));
    whatYouPayForEstimate.mockReset().mockImplementation(() => { if (box instanceof Error) throw box; return box; });
    buildAnnualPrepayEstimateSuggestion.mockReset().mockImplementation(orThrow(suggestion));
    annualPrepayInvoiceTotalForEstimate.mockReset().mockImplementation(orThrow(billed));
    previewInvoiceTotals.mockReset().mockImplementation(async ({ amount }) => { if (taxed instanceof Error) throw taxed; return { subtotal: amount, tax_amount: taxed, total: Math.round((amount + taxed) * 100) / 100 }; });
    jest.doMock('../services/estimate-monthly-average', () => ({ perApplicationAverageFor }));
    jest.doMock('../utils/estimate-claim-sql', () => ({
      estimateOffCustomerSurface: jest.fn(() => { if (offSurface instanceof Error) throw offSurface; return offSurface; }),
      callSideBlockForEstimateData,
    }));
    jest.doMock('../services/estimate-proposal-billing', () => ({ resolveLivePricing }));
    jest.doMock('../routes/estimate-public', () => ({ whatYouPayForEstimate, whatYouPayAcceptLookups }));
    jest.doMock('../services/annual-prepay-estimate-suggestion', () => ({ buildAnnualPrepayEstimateSuggestion }));
    jest.doMock('../services/estimate-manual-acceptance', () => ({ annualPrepayInvoiceTotalForEstimate }));
    jest.doMock('../services/invoice', () => ({ previewInvoiceTotals }));
    return require('../services/sms-staff-facts').loadEstimateFacts(estimate, { db });
  };
  const est = { id: 'e1', customer_id: 'c1', status: 'sent', estimate_data: '{}' };
  const average = { model: { services: [{ label: 'Pest Control — 4 applications/yr', perApplication: 125, visits: 4 }, { label: 'Odd', perApplication: 0, visits: 4 }] } };
  const LINES = [{ label: 'Pest Control', cents: 12500, applications: 4 }];
  const NOTHING = { perApplication: [], terms: { setupFee: null, prepayTotal: null } };
  const terms = async (options) => (await load(est, { average, ...options })).terms;

  test('the per-application lines of the estimate page\'s own model: a clean label, the price in cents, the applications a year', async () => {
    expect((await load(est, { average })).perApplication).toEqual(LINES);
    // a failed pricing read must surface as a failure (the caller keeps it retryable), not as "nothing listed"
    expect(perApplicationAverageFor).toHaveBeenCalledWith(est, { rethrow: true });
  });

  test('no estimate, one off the customer\'s own page or one that lists nothing is a successful read of nothing; a failed read or no db is null', async () => {
    expect(await load(null, { average })).toEqual(NOTHING);
    expect(await load(est, { average, offSurface: true })).toEqual(NOTHING);
    expect(await load({ ...est, expires_at: '2020-01-01T00:00:00Z' }, { average })).toEqual(NOTHING);
    expect((await load(est, { average: null })).perApplication).toEqual([]);
    expect(await load(est, { average: new Error('boom') })).toBeNull();
    expect(await load(est, { average, offSurface: new Error('boom') })).toBeNull();
    expect(await load(est, { average, db: null })).toBeNull();
    expect(await load(est, { average, db: dbWithOpen(new Error('boom')) })).toBeNull();
    // two open estimates (two properties, two quotes for one service): which one does the customer mean? a person answers
    expect(await load(est, { average, db: dbWithOpen([{ id: 'e1' }, { id: 'e2' }]) })).toEqual(NOTHING);
    // nothing on the page, nothing read from it
    expect(resolveLivePricing).not.toHaveBeenCalled();
  });

  // Owner 2026-11-26: a call-drafted or new-home estimate renders its price like any other, while the verdict every public estimate route
  // runs still passes. Its call, lead and move rows are in the send fingerprint (billing-fingerprint.test.js).
  test('a call-drafted or new-home estimate is read under the public routes\' own call-side verdict: a block is nothing, an unread verdict is a failed read', async () => {
    const called = { ...est, estimate_data: { estimatorEngine: { callLogId: 'call-1' }, lead_id: 'lead-1', lead_linkage: 'sid' } };
    const moved = { ...est, status: 'viewed', estimate_data: { move: { moveId: 'move-1' } } };
    expect((await load(called, { average })).perApplication).toEqual(LINES);
    expect(callSideBlockForEstimateData).toHaveBeenCalledWith(oneOpen, called.estimate_data, { estimateStatus: 'sent' });
    expect((await load(moved, { average })).perApplication).toEqual(LINES);
    expect(callSideBlockForEstimateData).toHaveBeenCalledWith(oneOpen, { move: { moveId: 'move-1' } }, { estimateStatus: 'viewed' });
    // estimate_data stored as a JSON string hides those ids from the send fingerprint's SQL, which reads them by JSON path: a linked
    // estimate stored that way states nothing (no verdict read, no price read); one with no link is read as before (est itself is '{}')
    for (const estimate_data of [called.estimate_data, moved.estimate_data]) {
      callSideBlockForEstimateData.mockClear();
      expect(await load({ ...est, estimate_data: JSON.stringify(estimate_data) }, { average })).toEqual(NOTHING);
      expect(callSideBlockForEstimateData).not.toHaveBeenCalled();
      expect(perApplicationAverageFor).not.toHaveBeenCalled();
    }
    // the call is being reprocessed, its lead was repointed, the move was cancelled or now names another address: off the customer's page
    for (const callBlock of ['call_reprocessing', 'call_linkage_changed', 'call_missing', 'move_closed', 'move_address_changed']) {
      expect({ callBlock, facts: await load(called, { average, callBlock }) }).toEqual({ callBlock, facts: NOTHING });
      expect(perApplicationAverageFor).not.toHaveBeenCalled();
    }
    // the call, lead or move row could not be read: a failed read (retryable at send), never "not shown"
    for (const callBlock of ['call_verdict_unavailable', 'move_verdict_unavailable', new Error('boom')]) expect(await load(called, { average, callBlock })).toBeNull();
  });

  test('the setup fee is the page\'s own: the box and the fee row must agree to the cent, and prepay waives it only when both say so', async () => {
    expect((await terms()).setupFee).toEqual({ cents: 9900, prepayWaives: true, label: 'Pest Control' });
    // the page's own assembly of the box, over the strictly resolved live bundle, on a COPY of the row (the reconcile rewrites estimate_data)
    expect(resolveLivePricing).toHaveBeenCalledWith(est, { rethrow: true });
    expect(resolveLivePricing.mock.calls[0][0]).not.toBe(est);
    expect(whatYouPayAcceptLookups).toHaveBeenCalledWith(resolveLivePricing.mock.calls[0][0]);
    expect(whatYouPayForEstimate).toHaveBeenCalledWith(resolveLivePricing.mock.calls[0][0], {}, BUNDLE, LOOKUPS);
    expect((await terms({ box: { ...BOX, setupWaivedWithPrepay: false } })).setupFee).toEqual({ cents: 9900, prepayWaives: false, label: 'Pest Control' });
    expect((await terms({ live: { bundle: { ...BUNDLE, firstVisitFees: [{ ...FEE_ROW, waivedWithPrepay: false }] } } })).setupFee).toEqual({ cents: 9900, prepayWaives: false, label: 'Pest Control' });
    // the two readers disagree (a legacy split plan shows a fee the accept never bills, or the row carries another amount): a person answers
    for (const live of [{ bundle: { ...BUNDLE, firstVisitFees: [] } }, { bundle: { ...BUNDLE, firstVisitFees: [{ ...FEE_ROW, amount: 89 }] } }]) {
      expect(await terms({ live })).toEqual({ setupFee: null, prepayTotal: null });
    }
    expect(await terms({ box: { ...BOX, setupFee: null, setupWaivedWithPrepay: false } })).toEqual({ setupFee: null, prepayTotal: null });
  });

  test('no fee on the first bill: "waived" only from a waiver on the estimate\'s own record, in either stored shape; the gap rule is never run', async () => {
    const noFee = { live: { bundle: { ...BUNDLE, firstVisitFees: [] } }, box: { ...BOX, setupFee: null, setupWaivedWithPrepay: false, firstVisitTotal: 125 } };
    const withData = async (estimate_data) => (await load({ ...est, estimate_data }, { average, ...noFee })).terms.setupFee;
    const ONE = { label: 'Pest Control' };
    expect(await withData({})).toEqual({ cents: 0, waived: false, ...ONE });
    // an existing member adding a service pays no setup fee, and nothing was waived
    expect(await withData({ membershipSnapshot: { isExistingCustomer: true } })).toEqual({ cents: 0, waived: false, ...ONE });
    // a staff waiver, the returning-customer rule's stored answer, and the website quote's frozen zero
    expect(await withData({ operatorPriceAdjustment: { waiveSetupFee: true } })).toEqual({ cents: 0, waived: true, ...ONE });
    expect(await withData({ operatorPriceAdjustment: { waiveSetupFee: true, returningCustomerGap: { rule: 'returning_customer_gap' } } })).toEqual({ cents: 0, waived: true, ...ONE });
    expect(await withData({ setupFeeQuote: { amount: 0, waived: 'returning_customer' } })).toEqual({ cents: 0, waived: true, ...ONE });
    // a zero quote with no waiver on record is no fee, not a waiver
    expect(await withData({ setupFeeQuote: { amount: 0 } })).toEqual({ cents: 0, waived: false, ...ONE });
    // an estimate for several services (two lines in the box, or two priced lines) has no one service to name
    const pestAndLawn = { model: { services: [average.model.services[0], { label: 'Lawn Care', perApplication: 60, visits: 6 }] } };
    expect((await load(est, { average, ...noFee, box: { ...noFee.box, lines: [BOX.lines[0], { ...BOX.lines[0], key: 'lawn_care' }] } })).terms.setupFee).toEqual({ cents: 0, waived: false, label: null });
    expect((await load(est, { average: pestAndLawn, ...noFee })).terms.setupFee).toEqual({ cents: 0, waived: false, label: null });
    expect(Object.keys(require('../services/returning-setup-fee-waiver')).filter((name) => /^(?:decide|load)/.test(name)).length).toBeGreaterThan(0);
    const source = require('fs').readFileSync(require.resolve('../services/sms-staff-facts'), 'utf8');
    expect(source).not.toMatch(/decideReturningSetupFeeWaiver|loadReturningVisitHistory/);
  });

  // The #8554 P0: the first attempt stated the discounted coverage figure as the prepay bill, but the bill also carries one-time lines and
  // tax. The total is stated only when the accept lane's figure for the page's default plan equals the whole bill the operator preview computes.
  test('the pay-for-the-year total: the accept lane\'s figure for the page\'s default plan, only when it equals the whole prepay bill to the cent', async () => {
    expect((await terms()).prepayTotal).toEqual({ label: 'Pest Control', cents: 50000, applications: 4 });
    const [rows, options] = buildAnnualPrepayEstimateSuggestion.mock.calls[0];
    expect(rows).toEqual([resolveLivePricing.mock.calls[0][0]]);
    // priced on the page's bundle, for the plan the page shows by default
    expect(options).toEqual({ db: oneOpen, pricedOption: { bundle: BUNDLE, key: 'quarterly' } });
    expect(annualPrepayInvoiceTotalForEstimate).toHaveBeenCalledWith(rows[0]);
    // the invoice module's own dry run of that amount for this customer, on the caller's connection
    expect(previewInvoiceTotals).toHaveBeenCalledWith({ customerId: 'c1', amount: 500, database: oneOpen });
    // the bill carries more than the coverage line (a one-time line, commercial tax) or less (a deposit credit): no total
    for (const billed of [575, 535.5, 450, null]) {
      expect({ billed, total: (await terms({ billed })).prepayTotal }).toEqual({ billed, total: null });
      expect(previewInvoiceTotals).not.toHaveBeenCalled();
    }
    // a cent apart is not equal
    expect((await terms({ billed: 500.01 })).prepayTotal).toBeNull();
    expect((await terms({ suggestion: { amount: 392.004, coverageVisitCount: 4 }, billed: 392 })).prepayTotal).toMatchObject({ cents: 39200 });
    // an account classed commercial is taxed on the bill whatever its services are: the two figures above agree, the bill would not
    for (const taxed of [35, 0.01]) expect({ taxed, total: (await terms({ taxed })).prepayTotal }).toEqual({ taxed, total: null });
    // an estimate with no customer has no account to bill
    expect((await load({ ...est, customer_id: null }, { average })).terms.prepayTotal).toBeNull();
    expect(buildAnnualPrepayEstimateSuggestion).not.toHaveBeenCalled();
  });

  test('no total when the accept lane would not price it, when it is not the same plan, or when the estimate lists a fee prepay does not waive', async () => {
    const none = async (options) => expect({ options: JSON.stringify(options), total: (await terms(options)).prepayTotal }).toEqual({ options: JSON.stringify(options), total: null });
    // the lane's own guards (a bundle, an existing customer, a deposit, a pending reprice, a cadence it cannot read) answer blocked
    await none({ suggestion: { blocked: true, blockReason: 'estimate bundles multiple recurring services' } });
    await none({ suggestion: null });
    await none({ suggestion: { amount: 0, coverageVisitCount: 4 } });
    // another cadence than the per-application line's (the sentence names the applications a year)
    await none({ suggestion: { amount: 500, coverageVisitCount: 6 } });
    await none({ box: { ...BOX, lines: [{ ...BOX.lines[0], applicationsPerYear: 6 }] } });
    await none({ box: { ...BOX, lines: [BOX.lines[0], { ...BOX.lines[0], key: 'lawn_care' }] } });
    // a prepay bill never carries the setup fee: the page must show prepay waiving the one it lists
    await none({ box: { ...BOX, setupWaivedWithPrepay: false } });
    // a termite annual plan signs before it pays, and its bill carries the Station Setup that neither figure includes (the eligibility
    // guard exempts that row for this lane, so the two figures agree without it): the lane's own rule, gate on or an already parked accept
    const termitePlan = { result: { lineItems: [{ service: 'termite_bait', plan: 'annual_protection' }], oneTime: { items: [{ service: 'termite_bait_installation', kind: 'setup', price: 300 }] } } };
    const gates = { GATE_TERMITE_ANNUAL_PLAN: process.env.GATE_TERMITE_ANNUAL_PLAN, GATE_CANCEL_FLOW_V2: process.env.GATE_CANCEL_FLOW_V2 };
    try {
      Object.assign(process.env, { GATE_TERMITE_ANNUAL_PLAN: 'true', GATE_CANCEL_FLOW_V2: 'true' });
      expect((await load({ ...est, estimate_data: termitePlan }, { average })).terms.prepayTotal).toBeNull();
      expect(buildAnnualPrepayEstimateSuggestion).not.toHaveBeenCalled();
    } finally {
      for (const [name, value] of Object.entries(gates)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
    expect((await load({ ...est, annual_plan_activation_status: 'awaiting_signature' }, { average })).terms.prepayTotal).toBeNull();
    expect(buildAnnualPrepayEstimateSuggestion).not.toHaveBeenCalled();
    // two priced lines (or none): not one plan
    const two = { model: { services: [average.model.services[0], { label: 'Lawn Care', perApplication: 60, visits: 6 }] } };
    expect((await load(est, { average: two })).terms.prepayTotal).toBeNull();
    expect((await load(est, { average: null })).terms.prepayTotal).toBeNull();
    expect(buildAnnualPrepayEstimateSuggestion).not.toHaveBeenCalled();
  });

  test('the page shows no box, or the price is locked: neither is stated; a failed page read fails the terms alone, and the price lines stay', async () => {
    for (const options of [{ box: null }, { live: null }, { live: { bundle: null } }]) {
      expect(await load(est, { average, ...options })).toEqual({ perApplication: LINES, terms: { setupFee: null, prepayTotal: null } });
      expect(buildAnnualPrepayEstimateSuggestion).not.toHaveBeenCalled();
    }
    // (the member snapshot could not be verified, the box could not be assembled, the bill preview could not be read)
    for (const options of [{ live: new Error('membership snapshot unverified') }, { box: new Error('boom') }, { suggestion: new Error('boom') }, { billed: new Error('boom') }, { taxed: new Error('boom') }]) {
      expect(await load(est, { average, ...options })).toEqual({ perApplication: LINES, terms: null });
    }
    // the accept lane could not read what it stands on (the customer's plan, a deposit, the call behind the estimate): its block says so,
    // and that is a failed read too, never "prepay is not offered" (which keeps the setup fee: the blocked case above)
    expect(await load(est, { average, suggestion: { blocked: true, unverified: true, blockReason: 'estimate deposit state could not be verified' } }))
      .toEqual({ perApplication: LINES, terms: null });
    // the page shows no box when it cannot read the billing lane or the deposit ledger; here that is a failed read, never "not shown"
    for (const lookups of [{ monthlyBilled: null, pendingDeposit: 0 }, { monthlyBilled: false, pendingDeposit: null }, new Error('boom')]) {
      expect(await load(est, { average, lookups })).toEqual({ perApplication: LINES, terms: null });
      expect(whatYouPayForEstimate).not.toHaveBeenCalled();
    }
    // a monthly-billed plan or a paid deposit is the page's own "no box": read, and nothing to state
    expect((await load(est, { average, lookups: { monthlyBilled: true, pendingDeposit: 0 }, box: null })).terms).toEqual({ setupFee: null, prepayTotal: null });
  });
});

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
    for (const claim of ['Your plan still covers three visits.', 'The plan has four visits.', 'You still have three visits on your plan.', 'You have three services left.']) {
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
    // a balance question beside the count question does not disable the count check
    expect(ask('Three.', 'How many visits do I have left and is there a balance?')).toBe(false);
    expect(ask('Three.', 'How many visits do I have left, and how much is renewal?')).toBe(false);
    expect(paymentStatus.checkPaymentStatusReply({ reply: LEFT, sentences, inboundText: 'How many visits do I have left, and how much is renewal?' }).ok).toBe(true);
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
    expect(check(LAWN, 'How many visits do I have left on my ant plan?')).toBe(false);
    expect(check(LEFT, 'How many visits do I have left on my prepaid plan?')).toBe(true);
    expect(check(LAWN, 'How many visits for ants do I have left?')).toBe(false);
    expect(check(LAWN, 'How many more visits do I have left?')).toBe(true);
    // two services named: only a plan that names both answers ("Lawn Pest Control" is turf service, not the pest plan)
    expect(check(LEFT, 'How many Lawn Pest Control visits do I have left?')).toBe(false);
    // a named cadence must be in the plan's label: the quarterly plan's count never answers a monthly plan's question
    expect(check(LEFT, 'How many monthly pest control visits do I have left?')).toBe(false);
    expect(check(LEFT, 'How many quarterly pest control visits do I have left?')).toBe(true);
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
