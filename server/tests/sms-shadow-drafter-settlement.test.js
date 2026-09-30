// Codex round-6 pre-push audit P1 (PR #5331): a settlement claim ("you're paid
// up") is decided from authoritative OUTSTANDING obligations, never from the
// set of prices a reply may quote (published monthly dues). Own file so the
// REAL context-aggregator.authorizedDuesCents is in play (sms-shadow-drafter
// .test.js stubs it in an earlier doMock).
const { replyQuotesUngroundedAmount } = require('../services/sms-shadow-drafter');

const monthly = (billing) => ({
  customer: { billingLane: { monthlyBilled: true, monthlyDues: { base: 98.5, surcharged: false } } },
  billing: { outstandingBalance: 0, recentPayments: [], ...billing },
});
const check = (reply, ctx) => replyQuotesUngroundedAmount(reply, ctx, { byMeaning: true });

test('the monthly dues stay quotable prices (proves the real dues set is populated)', () => {
  expect(check('Your monthly balance is $98.50.', monthly({}))).toBe(false);
});

test('a settled monthly member can be told "you\'re paid up" / "account is current"', () => {
  expect(check("You're paid up.", monthly({}))).toBe(false);
  expect(check('Your account is current.', monthly({}))).toBe(false);
});

test('real outstanding debt still rejects, from balance or from an open invoice with an amount due', () => {
  expect(check("You're paid up.", monthly({ outstandingBalance: 40 }))).toBe(true);
  expect(check("You're paid up.", monthly({ openInvoice: { amountDue: 40 } }))).toBe(true);
});

test('an open invoice with nothing due is not debt; unavailable billing still fails closed', () => {
  expect(check("You're paid up.", monthly({ openInvoice: { amountDue: 0 } }))).toBe(false);
  expect(check("You're paid up.", monthly({ unavailable: true }))).toBe(true);
});

test('missing billing context is unknowable, never an empty account: {}, no billing key, null all reject a settlement claim', () => {
  expect(check("You're paid up.", {})).toBe(true);
  expect(check('Your account is current.', {})).toBe(true);
  expect(check("You're paid up.", { customer: { billingLane: null } })).toBe(true);
  expect(check("You're paid up.", null)).toBe(true);
  expect(check("You're paid up.", { billing: null })).toBe(true);
  // a successfully loaded billing object with nothing owed still passes
  expect(check("You're paid up.", { billing: { outstandingBalance: 0, recentPayments: [] } })).toBe(false);
});
