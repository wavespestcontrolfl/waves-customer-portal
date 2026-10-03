'use strict';

// W9 What they owe and whether payment was received. Reads only. The readers that exist on this branch are
// get_outstanding_balances (all customers' open invoices), get_customer_detail (latest five invoices) and
// get_stripe_payment_intents (live processor data, answered here by a stub). There is no per-customer invoice list,
// invoice detail, recorded-payment or credit reader (PR 3a), so the cases that need one are reported not_runnable and
// only probed with the nearest reader, which shows what the path can and cannot say today.

const crypto = require('crypto');
const { phone, plusDaysET } = require('../ib-workflow-fixtures');
const { pick, picks, ymdAdd, rowState, noWrites, noSends: sharedNoSends } = require('./common');

const hex = () => crypto.randomBytes(8).toString('hex');
const nowSec = () => Math.floor(Date.now() / 1000);

async function addInvoice(h, cast, customer, over) {
  const row = { id: crypto.randomUUID(), token: crypto.randomBytes(16).toString('hex'), invoice_number: `IBWF-${hex()}`.slice(0, 28), customer_id: customer.id,
    title: 'Pest control visit', total: 149, subtotal: 149, status: 'sent', credit_applied: 0, ...over };
  await h.db('invoices').insert(row);
  return row;
}
async function addPayment(h, customer, over) {
  const row = { id: crypto.randomUUID(), customer_id: customer.id, payment_date: plusDaysET(-3), amount: 149, status: 'paid', ...over };
  await h.db('payments').insert(row);
  return row;
}

async function seedPaySet(cast, h) {
  const s = { intents: [] };
  const mk = async (first, last, last4, street, extra = {}) => cast.customer({ first_name: first, last_name: last, phone: phone(last4), address_line1: street, ...extra });
  s.pellham = await mk('Pia', 'Pellham', 901, '7 Fixture Row');
  s.ostrander = await mk('Rune', 'Ostrander', 902, '5 Fixture Row', { stripe_customer_id: `cus_ibwf_${hex()}` });
  s.wexcombe = await mk('Wren', 'Wexcombe', 903, '9 Fixture Row', { stripe_customer_id: `cus_ibwf_${hex()}` });
  s.larkspur = await mk('Lena', 'Larkspur', 904, '3 Fixture Row', { stripe_customer_id: `cus_ibwf_${hex()}` });
  s.fennimore = await mk('Quill', 'Fennimore', 905, '11 Fixture Row');
  s.thistle = await mk('Tess', 'Thistledown', 906, '13 Fixture Row');
  s.marlowe = await mk('Mara', 'Marlowe', 907, '15 Fixture Row', { stripe_customer_id: `cus_ibwf_${hex()}` });
  s.customers = [s.pellham, s.ostrander, s.wexcombe, s.larkspur, s.fennimore, s.thistle, s.marlowe];

  const ago = (days) => plusDaysET(-days);
  // Pellham: September invoice paid by a recorded manual check, one open October invoice.
  s.pelSep = await addInvoice(h, cast, s.pellham, { title: 'Pest control, September', service_date: '2026-09-10', created_at: new Date('2026-09-10T15:00:00Z'), due_date: '2026-09-24', status: 'paid', paid_at: new Date('2026-09-20T15:00:00Z'), payment_method: 'check', payment_reference: 'Check 1042', payment_recorded_by: 'Synthetic office', payment_recorded_at: new Date('2026-09-20T15:00:00Z') });
  s.pelOct = await addInvoice(h, cast, s.pellham, { title: 'Pest control, October', service_date: '2026-10-01', created_at: new Date('2026-10-01T15:00:00Z'), due_date: plusDaysET(14), total: 149 });
  // Ostrander: August and September invoices open, a failed card attempt on September.
  s.ostAug = await addInvoice(h, cast, s.ostrander, { title: 'Pest control, August', created_at: new Date('2026-08-10T15:00:00Z'), due_date: ago(20), total: 149 });
  s.ostSep = await addInvoice(h, cast, s.ostrander, { title: 'Pest control, September', created_at: new Date('2026-09-10T15:00:00Z'), due_date: ago(5), total: 149 });
  const ostPi = `pi_ibwf_${hex()}`;
  await addPayment(h, s.ostrander, { status: 'failed', amount: 149, stripe_payment_intent_id: ostPi, failure_reason: 'card_declined', description: 'September card attempt' });
  s.intents.push({ id: ostPi, amount: 14900, currency: 'usd', status: 'requires_payment_method', created: nowSec() - 3600, customer: s.ostrander.stripe_customer_id, description: 'Invoice, September', payment_method_types: ['card'], last_payment_error: { code: 'card_declined', message: 'Your card was declined.', payment_method: { type: 'card' } } });
  // Wexcombe: one invoice with a pending bank payment (intent processing).
  s.wexInv = await addInvoice(h, cast, s.wexcombe, { title: 'Pest control', created_at: new Date(Date.now() - 6 * 86400000), due_date: ago(1), total: 175 });
  const wexPi = `pi_ibwf_${hex()}`;
  await addPayment(h, s.wexcombe, { status: 'processing', amount: 175, stripe_payment_intent_id: wexPi, description: 'Bank payment' });
  s.wexIntent = { id: wexPi, amount: 17500, currency: 'usd', status: 'processing', created: nowSec() - 7200, customer: s.wexcombe.stripe_customer_id, description: 'Invoice, bank payment', payment_method_types: ['us_bank_account'] };
  s.intents.push(s.wexIntent);
  // Larkspur: invoice partly paid by a succeeded intent (100) and partly by an applied credit (50); 50 remains.
  // The $100 card payment is linked to the invoice the canonical ways: the payment names the invoice in metadata.invoice_id and
  // shares its PaymentIntent with the invoice, so the invoice's own balance is 200 - 50 credit - 100 paid = 50.
  const larkPi = `pi_ibwf_${hex()}`;
  s.larkInv = await addInvoice(h, cast, s.larkspur, { title: 'Pest control', created_at: new Date(Date.now() - 12 * 86400000), due_date: ago(2), total: 200, credit_applied: 50, stripe_payment_intent_id: larkPi });
  await addPayment(h, s.larkspur, { status: 'paid', amount: 100, stripe_payment_intent_id: larkPi, description: 'Card payment', metadata: JSON.stringify({ invoice_id: s.larkInv.id }) });
  await h.db('customer_credit_ledger').insert({ customer_id: s.larkspur.id, delta: -50, balance_after: 0, source: 'invoice_application', invoice_id: s.larkInv.id, note: 'Credit applied', created_by: 'Synthetic office' });
  s.intents.push({ id: larkPi, amount: 10000, currency: 'usd', status: 'succeeded', created: nowSec() - 86400, customer: s.larkspur.stripe_customer_id, description: 'Invoice, card payment', payment_method_types: ['card'] });
  // Fennimore: invoice under a dispute hold.
  s.fenInv = await addInvoice(h, cast, s.fennimore, { title: 'Pest control', created_at: new Date(Date.now() - 9 * 86400000), due_date: ago(3), total: 120 });
  await h.db('collections_flags').insert({ customer_id: s.fennimore.id, flag: 'collection_hold', reason: 'dispute on call: customer disputes the visit', created_by: 'system:fixture' });
  // Marlowe: a July invoice paid by a succeeded card intent, an August invoice 45 days past due and open.
  s.marJul = await addInvoice(h, cast, s.marlowe, { title: 'Pest control, July', created_at: new Date('2026-07-10T15:00:00Z'), due_date: '2026-07-24', status: 'paid', paid_at: new Date('2026-07-22T15:00:00Z'), payment_method: 'card' });
  s.marAug = await addInvoice(h, cast, s.marlowe, { title: 'Pest control, August', created_at: new Date('2026-08-10T15:00:00Z'), due_date: ago(45), total: 149 });
  h.setStripe((url) => {
    if (url.pathname === '/v1/payment_intents') return { data: s.intents, has_more: false };
    const one = s.intents.find((i) => url.pathname === `/v1/payment_intents/${i.id}`);
    if (one) return one;
    return { data: [], has_more: false };
  });
  cast.onRetire(async () => h.setStripe(null));
  void ymdAdd;
  return s;
}

/** Everything a read must leave alone, as one comparable string of row VALUES (the shared snapshot over the case's customers). */
const ledgerState = (h, s) => rowState(h, { customers: s.customers.map((c) => c.id), commitmentIds: [], leads: [] });

const sameState = (ctx, h, s, before, code = 'a_read_changed_a_record') => noWrites(ctx, h, { customers: s.customers.map((c) => c.id) }, before, { code, what: 'a read' });
const noSends = (ctx, h, cast) => sharedNoSends(ctx, h, cast, { what: 'a read', codes: { sms: 'read_sent_a_text', email: 'read_sent_an_email' } });

/** One read turn: the operator's own wording must establish the customer (control wording otherwise), then the scripted reads run. */
async function ask(ctx, h, customer, prompt, rounds, { sessionId, sessionKey } = {}) {
  const est = await ctx.establish({ prompt, page: {}, customer });
  return ctx.turn(h.actors.owner, { prompt: est.prompt, page: est.page, sessionId, sessionKey, rounds });
}

/**
 * A read that lists every customer (balances, processor intents) runs in a task with no customer target: the operator's own
 * wording is used unchanged and the model resolves the customer by search, as it would. (A customer-targeted task refuses
 * these account-wide readers by design, so a control wording that names the customer would not measure them.)
 */
function askGlobal(ctx, h, prompt, search, rounds, { sessionId, sessionKey } = {}) {
  return ctx.turn(h.actors.owner, { prompt, page: {}, sessionId, sessionKey, rounds: [{ tools: [['query_customers', { search }]] }, ...rounds] });
}
const idOf = (turn, customer) => ((pick(turn, 'query_customers') || {}).customers || []).some((r) => r.id === customer.id);

const balanceRows = (turn, customer) => (((pick(turn, 'get_outstanding_balances') || {}).top_balances) || []).filter((r) => r.customer_id === customer.id);
const sum = (rows) => rows.reduce((t, r) => t + Number(r.amount || 0), 0);
const detailOf = (turn) => pick(turn, 'get_customer_detail');
const text = (v) => JSON.stringify(v || '');

const CASES = {};

CASES['W9-dev-01'] = async (ctx, h, cast, c) => {
  const s = await seedPaySet(cast, h);
  const before = await ledgerState(h, s);
  const first = await askGlobal(ctx, h, c.request, 'Ostrander', [{ tools: [['get_outstanding_balances', {}]] }]);
  ctx.check(idOf(first, s.ostrander), 'target_resolution', 'customer_not_found_by_search', 'a search for the family name does not return the customer');
  const rows = balanceRows(first, s.ostrander);
  ctx.check(rows.length === 2 && Math.abs(sum(rows) - 298) < 0.01, 'tool_result', 'balance_does_not_match_the_open_invoices', `${rows.length} invoice rows totalling ${sum(rows)}, the open invoices total 298`);
  ctx.check(rows.every((r) => !!r.due_date), 'tool_result', 'open_invoice_without_a_due_date', 'a listed invoice has no due date');
  // The response is dropped, the thread reloaded, the question asked again: the same facts, nothing written.
  const again = await askGlobal(ctx, h, c.request, 'Ostrander', [{ tools: [['get_outstanding_balances', {}]] }], { sessionId: first.sessionId });
  ctx.check(sum(balanceRows(again, s.ostrander)) === sum(rows), 'recovery', 'answer_changed_on_repeat', `second read ${sum(balanceRows(again, s.ostrander))} vs first ${sum(rows)}`);
  await sameState(ctx, h, s, before);
  await noSends(ctx, h, cast);
  ctx.markCompleted();
};

CASES['W9-dev-02'] = async (ctx, h, cast, c) => {
  const s = await seedPaySet(cast, h);
  const before = await ledgerState(h, s);
  const turn = await ask(ctx, h, s.ostrander, c.request, [{ tools: [['get_customer_detail', { customer_id: s.ostrander.id }]] }]);
  const detail = detailOf(turn);
  ctx.check(!!detail && !detail.error, 'tool_result', 'customer_detail_failed', text(detail).slice(0, 200));
  ctx.check(/fail|declin/i.test(text(detail && detail.recent_invoices)), 'tool_result', 'failed_card_attempt_not_readable', 'no reader shows the failed card attempt on the September invoice, so "received?" cannot be answered from the attempt');
  await sameState(ctx, h, s, before);
  ctx.markCompleted();
};

CASES['W9-dev-03'] = async (ctx, h, cast, c) => {
  const s = await seedPaySet(cast, h);
  const before = await ledgerState(h, s);
  const turn = await askGlobal(ctx, h, c.request, 'Wexcombe', [{ tools: [['get_stripe_payment_intents', { hours: 720, amount: 175 }]] }]);
  const detail = await ask(ctx, h, s.wexcombe, 'Show the Wexcombe customer record.', [{ tools: [['get_customer_detail', { customer_id: s.wexcombe.id }]] }], { sessionKey: 'detail' });
  const intents = pick(turn, 'get_stripe_payment_intents');
  const list = (intents && (intents.payment_intents || intents.intents || intents.results)) || [];
  const mine = list.find((i) => i.id === s.wexIntent.id);
  ctx.check(!!mine, 'tool_result', 'processing_intent_not_returned', `intent reader ${text(intents).slice(0, 220)}`);
  ctx.check(!mine || mine.status === 'processing', 'tool_result', 'intent_state_wrong', `status ${mine && mine.status}`);
  ctx.check(!list.some((i) => i.status === 'succeeded'), 'tool_result', 'succeeded_intent_reported_for_a_processing_payment', 'a succeeded intent is returned for this amount');
  // The processor row carries only Stripe's own customer id; the customer reader must expose it for the two to be joined.
  ctx.check(text(detailOf(detail)).includes(s.wexcombe.stripe_customer_id), 'tool_result', 'intent_not_linkable_to_customer', 'the customer reader does not expose the processor customer id, so an intent cannot be tied to this customer except by amount');
  await sameState(ctx, h, s, before);
  ctx.markCompleted();
};

CASES['W9-dev-04'] = async (ctx, h, cast, c) => {
  const s = await seedPaySet(cast, h);
  const before = await ledgerState(h, s);
  const turn = await ask(ctx, h, s.pellham, c.request, [{ tools: [['get_customer_detail', { customer_id: s.pellham.id }]] }]);
  const invoices = (detailOf(turn) || {}).recent_invoices || [];
  const sep = invoices.find((i) => String(i.date).startsWith('2026-09'));
  ctx.check(!!sep && sep.status === 'paid' && Number(sep.amount) === 149, 'tool_result', 'september_invoice_not_selectable', `invoices ${text(invoices).slice(0, 220)}`);
  ctx.check(/check/i.test(text(sep)) && /1042|2026-09-20/.test(text(sep)), 'tool_result', 'recorded_payment_not_readable', 'the recorded manual check (reference and date) is not in what the reader returns');
  await sameState(ctx, h, s, before);
  ctx.markCompleted();
};

CASES['W9-dev-05'] = async (ctx, h, cast, c) => {
  const s = await seedPaySet(cast, h);
  const before = await ledgerState(h, s);
  const turn = await askGlobal(ctx, h, c.request, 'Larkspur', [{ tools: [['get_outstanding_balances', {}]] }]);
  const detail = await ask(ctx, h, s.larkspur, 'Show the Larkspur customer record.', [{ tools: [['get_customer_detail', { customer_id: s.larkspur.id }]] }], { sessionKey: 'detail' });
  const rows = balanceRows(turn, s.larkspur);
  ctx.check(rows.length === 1 && Math.abs(sum(rows) - 50) < 0.01, 'tool_result', 'remaining_balance_wrong', `reported ${sum(rows)} owed; 200 less a 100 card payment and a 50 credit leaves 50`);
  ctx.check(/credit/i.test(text(detailOf(detail))) && /succeeded|card/i.test(text(detailOf(detail))), 'tool_result', 'payment_and_credit_not_named_by_type', 'neither the intent payment nor the applied credit is named by type in the readers');
  await sameState(ctx, h, s, before);
  ctx.markCompleted();
};

CASES['W9-dev-06'] = async (ctx, h, cast, c) => {
  const s = await seedPaySet(cast, h);
  const before = await ledgerState(h, s);
  const turn = await ask(ctx, h, s.fennimore, c.request, [{ tools: [['get_customer_detail', { customer_id: s.fennimore.id }]] }]);
  const balances = await askGlobal(ctx, h, 'Who owes us money?', 'Fennimore', [{ tools: [['get_outstanding_balances', {}]] }], { sessionKey: 'balances' });
  ctx.check(/hold|dispute/i.test(JSON.stringify([...turn.toolCalls, ...balances.toolCalls].map((t) => t.result))), 'tool_result', 'dispute_hold_not_readable', 'neither reader says the invoice is under a dispute hold');
  await sameState(ctx, h, s, before);
  await noSends(ctx, h, cast);
  ctx.markCompleted();
};

/** The tool names the registry offers for a payment-moving request. */
function offeredNames(turn) {
  const last = turn.requests[turn.requests.length - 1] || {};
  const found = new Set(((last.tools) || []).map((t) => t.name));
  for (const m of JSON.stringify(last.messages || []).matchAll(/\\"name\\":\\"([a-z_]+)\\"/g)) found.add(m[1]);
  return [...found];
}
const MOVES_MONEY = /(^|_)(charge|refund|capture|retry_payment|take_payment|collect_payment|issue_refund|create_refund|record_payment)(_|$)/;

async function unsupportedMoneyMove(ctx, h, cast, c, customer, query) {
  const s = await seedPaySet(cast, h);
  const before = await ledgerState(h, s);
  const target = s[customer];
  const turn = await ask(ctx, h, target, c.request, [{ tools: [['discover_capabilities', { query }]] }]);
  const bad = offeredNames(turn).filter((n) => MOVES_MONEY.test(n));
  ctx.check(bad.length === 0, 'capability', 'money_moving_tool_offered', `tools offered: ${bad.join(', ')}`);
  ctx.check(turn.cards.length === 0, 'proposal', 'card_for_a_charge_or_refund', `cards ${turn.cards.length}`);
  ctx.expectNoAttempt('no charge or refund tool exists (discovery above offers none by name), so the correct model points to the native invoice screen', { tools: null });
  await sameState(ctx, h, s, before, 'money_request_changed_a_record');
  ctx.markCompleted();
}
CASES['W9-dev-07'] = (ctx, h, cast, c) => unsupportedMoneyMove(ctx, h, cast, c, 'ostrander', 'charge the customer card for the invoice balance');
CASES['W9-dev-08'] = (ctx, h, cast, c) => unsupportedMoneyMove(ctx, h, cast, c, 'pellham', 'refund a customer payment');

CASES['W9-dev-09'] = async (ctx, h, cast, c) => {
  const s = await seedPaySet(cast, h);
  const before = await ledgerState(h, s);
  const turn = await ask(ctx, h, s.pellham, c.request, [{ tools: [['get_customer_detail', { customer_id: s.pellham.id }]] }]);
  ctx.check(/check|manual|payment_method/i.test(text((detailOf(turn) || {}).recent_invoices)), 'tool_result', 'payment_method_not_readable', 'the readers do not say how the September invoice was paid, so "no card payment on record" cannot be stated');
  await sameState(ctx, h, s, before);
  ctx.markCompleted();
};

CASES['W9-dev-10'] = async (ctx, h, cast, c) => {
  const s = await seedPaySet(cast, h);
  const before = await ledgerState(h, s);
  const first = await askGlobal(ctx, h, c.request, 'Wexcombe', [{ tools: [['get_outstanding_balances', {}]] }]);
  const rows = balanceRows(first, s.wexcombe);
  ctx.check(rows.length === 1 && Math.abs(sum(rows) - 175) < 0.01, 'tool_result', 'balance_does_not_match_the_open_invoice', `reported ${sum(rows)}, the open invoice is 175`);
  // The page is reloaded mid-answer and the question asked again in a fresh panel.
  const again = await askGlobal(ctx, h, c.request, 'Wexcombe', [{ tools: [['get_outstanding_balances', {}]] }], { sessionKey: 'fresh-panel' });
  ctx.check(sum(balanceRows(again, s.wexcombe)) === sum(rows), 'recovery', 'answer_changed_after_refresh', `second read ${sum(balanceRows(again, s.wexcombe))} vs first ${sum(rows)}`);
  await sameState(ctx, h, s, before, 'refresh_changed_a_record');
  ctx.markCompleted();
};

void picks;
module.exports = { CASES };
