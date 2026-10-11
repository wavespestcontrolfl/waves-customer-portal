/**
 * The Intelligence Bar's one effects plan for send_invoice / charge_invoice
 * (invoice-action-effects.js): every post-commit effect, from the handlers' own
 * predicates, with the card wording, one pinned digest, and a source contract that
 * fails when a handler gains a side-effect call the plan does not name.
 * Sources are mocked; synthetic ids only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice-issued-closeout', () => ({ issuedCloseoutTarget: jest.fn(async () => null) }));
jest.mock('../services/lead-estimate-link', () => ({ invoiceSentConversionTargets: jest.fn(async () => ({ leadIds: [] })) }));
jest.mock('../services/invoice-followups', () => ({
  planFollowupSequence: jest.fn(async () => ({ arms: true, state: 'active', cadence: [3, 7, 14, 30] })),
  stopOnPaymentVerdict: jest.fn(() => ({ stops: false, thankYou: false })),
  activePaymentPlan: jest.fn(async () => null),
}));
jest.mock('../services/review-request', () => ({
  completionNotes: jest.fn(async () => ({})),
  paidInvoiceReviewSkip: jest.fn(() => 'not_completion_invoice'),
}));
jest.mock('../services/project-report-hold', () => ({ heldReportsForInvoice: jest.fn(async () => []) }));

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const { issuedCloseoutTarget } = require('../services/invoice-issued-closeout');
const LeadLink = require('../services/lead-estimate-link');
const Followups = require('../services/invoice-followups');
const Reviews = require('../services/review-request');
const ReportHold = require('../services/project-report-hold');
const effects = require('../services/intelligence-bar/invoice-action-effects');

const LEAD = '11111111-2222-4333-8444-555555555555';
const invoice = (overrides = {}) => ({
  id: 'inv-1', customer_id: 'cust-1', status: 'draft', sent_at: null, sms_sent_at: null, payer_id: null,
  service_record_id: null, visit_completion_packet_id: null, annual_prepay_term_id: null, ...overrides,
});
const customer = { id: 'cust-1', phone: '9415550100' };
const byKey = (plan, key) => plan.effects.find((e) => e.key === key);

beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation(() => ({ where: () => ({ first: async () => null }) }));
  issuedCloseoutTarget.mockResolvedValue(null);
  LeadLink.invoiceSentConversionTargets.mockResolvedValue({ leadIds: [] });
  Followups.planFollowupSequence.mockResolvedValue({ arms: true, state: 'active', cadence: [3, 7, 14, 30] });
  Followups.stopOnPaymentVerdict.mockReturnValue({ stops: false, thankYou: false });
  Followups.activePaymentPlan.mockResolvedValue(null);
  Reviews.completionNotes.mockResolvedValue({});
  Reviews.paidInvoiceReviewSkip.mockReturnValue('not_completion_invoice');
  ReportHold.heldReportsForInvoice.mockResolvedValue([]);
});

describe('planSendEffects', () => {
  test('a first send lists delivery, closeout, lead, reminders, review and credit, each from the handler\'s own predicate', async () => {
    issuedCloseoutTarget.mockResolvedValue({ visitId: 'visit-1', serviceType: 'Pest', date: '2099-01-02', resuming: false });
    LeadLink.invoiceSentConversionTargets.mockResolvedValue({ leadIds: [LEAD] });
    const plan = await effects.planSendEffects(invoice(), customer, {});
    expect(plan.effects.map((e) => e.key)).toEqual(['delivery', 'closeout', 'lead_conversion', 'followups', 'review', 'credit']);
    expect(byKey(plan, 'delivery')).toMatchObject({ state: 'first', line: 'Not sent before.' });
    expect(issuedCloseoutTarget).toHaveBeenCalledWith(expect.objectContaining({ id: 'inv-1' }), { trigger: 'sent' });
    expect(byKey(plan, 'closeout').line).toMatch(/^Sending this invoice also completes the linked visit/);
    // The lead is named by a masked id (first 8 characters), and the resolver is the lead module's own.
    expect(LeadLink.invoiceSentConversionTargets).toHaveBeenCalledWith('cust-1', expect.anything());
    expect(byKey(plan, 'lead_conversion')).toMatchObject({ applies: true, line: 'Sending this invoice also marks lead 11111111 won' });
    expect(JSON.stringify(plan.effects.map((e) => e.line))).not.toContain(LEAD);
    // The reminders follow the invoice as it will stand after the delivery ('sent'), with the cadence and the suppression state.
    expect(Followups.planFollowupSequence).toHaveBeenCalledWith(expect.objectContaining({ id: 'inv-1', status: 'sent' }), expect.anything(), customer);
    expect(byKey(plan, 'followups').line).toBe('Sending this invoice also arms billing reminders on Day 3, 7, 14, 30 unless Auto Pay or a payment plan suppresses them (currently: reminders will run)');
    // The bar takes no review decision, so the handler's own rule says no review request.
    expect(byKey(plan, 'review')).toMatchObject({ applies: false, line: 'No review request is sent.' });
    expect(byKey(plan, 'credit')).toMatchObject({ applies: false, state: 'skipped' });
  });

  test('a resend converts no lead and says it sends again; Auto Pay and a payment plan show as the reminder state', async () => {
    const plan = await effects.planSendEffects(invoice({ status: 'sent', sent_at: new Date('2098-12-01T15:00:00Z') }), customer, {});
    expect(byKey(plan, 'delivery')).toMatchObject({ state: 'resend' });
    expect(byKey(plan, 'delivery').line).toMatch(/^Already sent on 2098-12-01/);
    expect(LeadLink.invoiceSentConversionTargets).not.toHaveBeenCalled();
    expect(byKey(plan, 'lead_conversion')).toMatchObject({ applies: false, line: null });
    for (const [state, text] of [['autopay_hold', 'held: the customer is on Auto Pay'], ['payment_plan', 'none: the invoice has an active payment plan'], ['existing:stopped', 'the invoice already has a reminder sequence (stopped); it is left as it is']]) {
      Followups.planFollowupSequence.mockResolvedValue({ arms: state === 'autopay_hold', state, cadence: [3, 7, 14, 30] });
      expect(byKey(await effects.planSendEffects(invoice(), customer, {}), 'followups').line).toContain(`(currently: ${text})`);
    }
  });

  test('a review decision of true would say it enrolls the customer in review outreach', async () => {
    const plan = await effects.planSendEffects(invoice(), customer, { requestReview: true });
    expect(byKey(plan, 'review')).toMatchObject({ applies: true, line: 'Sending this invoice also enrolls the customer in review outreach' });
  });

  test('the digest changes when any effect\'s fact changes, and not otherwise', async () => {
    const base = await effects.planSendEffects(invoice(), customer, {});
    expect((await effects.planSendEffects(invoice(), customer, {})).digest).toBe(base.digest);
    LeadLink.invoiceSentConversionTargets.mockResolvedValue({ leadIds: [LEAD] });
    const withLead = await effects.planSendEffects(invoice(), customer, {});
    expect(withLead.digest).not.toBe(base.digest);
    LeadLink.invoiceSentConversionTargets.mockResolvedValue({ leadIds: [] });
    Followups.planFollowupSequence.mockResolvedValue({ arms: true, state: 'autopay_hold', cadence: [3, 7, 14, 30] });
    expect((await effects.planSendEffects(invoice(), customer, {})).digest).not.toBe(base.digest);
    Followups.planFollowupSequence.mockResolvedValue({ arms: true, state: 'active', cadence: [3, 10, 17, 30, 60, 90] });
    // The cadence is shown on the card, not pinned: a ladder switch changes the sentence, not the facts.
    expect((await effects.planSendEffects(invoice(), customer, {})).digest).toBe(base.digest);
  });

  test('a source that cannot be read throws, so the card refuses instead of showing the effect as absent', async () => {
    issuedCloseoutTarget.mockRejectedValue(new Error('read failed'));
    await expect(effects.planSendEffects(invoice(), customer, {})).rejects.toThrow('read failed');
  });
});

describe('planChargeEffects', () => {
  test('a paid invoice lists credit, closeout, review, reminders, plan, term, held report, receipt and the admin bell', async () => {
    issuedCloseoutTarget.mockResolvedValue({ visitId: 'visit-1', serviceType: 'Pest', date: '2099-01-02', resuming: true });
    const plan = await effects.planChargeEffects(invoice({ service_record_id: 'rec-1', annual_prepay_term_id: 'term-1' }), customer, { creditCents: 2500 });
    expect(plan.effects.map((e) => e.key)).toEqual(['credit', 'closeout', 'review', 'followup_stop', 'payment_plan', 'annual_prepay', 'held_report', 'receipt', 'admin_notice']);
    expect(byKey(plan, 'credit').line).toBe('$25.00 of account credit is applied first');
    expect(issuedCloseoutTarget).toHaveBeenCalledWith(expect.objectContaining({ id: 'inv-1' }), { trigger: 'paid' });
    expect(byKey(plan, 'closeout').line).toMatch(/^Once the charge is paid, the payment also finishes a closeout already started/);
    expect(byKey(plan, 'annual_prepay')).toMatchObject({ applies: true });
    expect(byKey(plan, 'receipt').line).toMatch(/payment receipt/);
  });

  test('review outreach follows the webhook\'s own test (enrollForPaidInvoice): the completion record\'s notes, the closeout\'s new record, and a packet', async () => {
    Reviews.paidInvoiceReviewSkip.mockReturnValue(null);
    Reviews.completionNotes.mockResolvedValue({ requestReview: true });
    let plan = await effects.planChargeEffects(invoice({ service_record_id: 'rec-1' }), customer, {});
    expect(Reviews.completionNotes).toHaveBeenCalledWith('rec-1');
    expect(Reviews.paidInvoiceReviewSkip).toHaveBeenCalledWith({ customer_id: 'cust-1', service_record_id: 'rec-1' }, { requestReview: true });
    expect(byKey(plan, 'review')).toMatchObject({ applies: true, state: 'enrolls' });
    expect(byKey(plan, 'review').line).toMatch(/^Once the charge is paid, the payment also enrolls the customer in review outreach/);
    // The record the closeout creates is the one the review step then reads.
    Reviews.paidInvoiceReviewSkip.mockClear();
    issuedCloseoutTarget.mockResolvedValue({ visitId: 'visit-1', serviceType: 'Pest', date: '2099-01-02', resuming: false });
    await effects.planChargeEffects(invoice(), customer, {});
    expect(Reviews.paidInvoiceReviewSkip).toHaveBeenCalledWith({ customer_id: 'cust-1', service_record_id: 'from_closeout' }, {});
    // Opted out: no review effect.
    Reviews.paidInvoiceReviewSkip.mockReturnValue('completion_opted_out');
    plan = await effects.planChargeEffects(invoice({ service_record_id: 'rec-1' }), customer, {});
    expect(byKey(plan, 'review')).toMatchObject({ applies: false, state: 'skip:completion_opted_out', line: null });
    // A visit completion packet decides itself: disclosed as "may".
    plan = await effects.planChargeEffects(invoice({ visit_completion_packet_id: 'pkt-1' }), customer, {});
    expect(byKey(plan, 'review').line).toMatch(/may also enroll the customer in review outreach \(the visit completion packet decides\)/);
  });

  test('billing reminders stop (with a thank-you text only for a customer with a phone), a payment plan completes, a held report releases', async () => {
    db.mockImplementation(() => ({ where: () => ({ first: async () => ({ status: 'active', touches_sent: 2 }) }) }));
    Followups.stopOnPaymentVerdict.mockReturnValue({ stops: true, thankYou: true });
    Followups.activePaymentPlan.mockResolvedValue({ id: 'plan-1' });
    ReportHold.heldReportsForInvoice.mockResolvedValue(['aaaaaaaa-0000-4000-8000-000000000000']);
    let plan = await effects.planChargeEffects(invoice(), customer, {});
    expect(byKey(plan, 'followup_stop').line).toBe('Once the charge is paid, the payment also stops the billing reminders for this invoice and texts the customer a thank-you (a reminder was already sent)');
    expect(byKey(plan, 'payment_plan').line).toMatch(/completes the active payment plan/);
    expect(byKey(plan, 'held_report').line).toBe('Once the charge is paid, the payment also releases the held service report (project aaaaaaaa) to the customer');
    plan = await effects.planChargeEffects(invoice(), { id: 'cust-1', phone: null }, {});
    expect(byKey(plan, 'followup_stop').line).toBe('Once the charge is paid, the payment also stops the billing reminders for this invoice');
  });

  test('the digest pins every effect: credit, closeout, review, reminders, plan, held report', async () => {
    const base = (await effects.planChargeEffects(invoice(), customer, {})).digest;
    const changes = [
      () => effects.planChargeEffects(invoice(), customer, { creditCents: 100 }),
      () => { issuedCloseoutTarget.mockResolvedValue({ visitId: 'v', serviceType: 'x', date: 'd', resuming: false }); return effects.planChargeEffects(invoice(), customer, {}); },
      () => { issuedCloseoutTarget.mockResolvedValue(null); Reviews.paidInvoiceReviewSkip.mockReturnValue(null); return effects.planChargeEffects(invoice({ service_record_id: 'r' }), customer, {}); },
      () => { Reviews.paidInvoiceReviewSkip.mockReturnValue('not_completion_invoice'); Followups.activePaymentPlan.mockResolvedValue({ id: 'p' }); return effects.planChargeEffects(invoice(), customer, {}); },
      () => { Followups.activePaymentPlan.mockResolvedValue(null); ReportHold.heldReportsForInvoice.mockResolvedValue(['x']); return effects.planChargeEffects(invoice(), customer, {}); },
    ];
    for (const change of changes) expect((await change()).digest).not.toBe(base);
  });
});

// ── source contract: the handlers' side-effect calls are all named in the plan ──

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
// Code only: line and block comments out, so a name in prose is not a call.
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
// Names of the calls that can change something outside the handler: send / schedule / enroll / close / stop /
// sync / complete / enqueue / notify / reset / mirror / record / convert / apply / reverse / requeue / resolve / post.
const SIDE_EFFECT_CALL = /\b((?:convert|schedule|closeOut|enroll|stop|sync|complete|enqueue|notify|reset|mirror|record|autoApply|reverse|requeue|resolve|post|void|restore|release)[A-Za-z]*)\(/g;
const callsIn = (text) => [...new Set([...code(text).matchAll(SIDE_EFFECT_CALL)].map((m) => m[1]))].sort();
const invoiceSource = read('../services/invoice.js');
const webhookSource = read('../routes/stripe-webhook.js');
const slice = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));

describe('source contract', () => {
  test('every side-effect call in the Send handler\'s post-delivery block is named by the send plan (an effect, or the reason it cannot apply)', () => {
    const block = slice(invoiceSource, 'ownedDeliveryFinalized = finalized !== 0;', 'const holdLegs = [sms, email].filter(');
    const calls = callsIn(block);
    expect(calls.length).toBeGreaterThan(4);
    const unnamed = calls.filter((name) => !(name in effects.SEND_CALL_COVERAGE));
    expect(unnamed).toEqual([]);
  });

  test('every side-effect call in payment_intent.succeeded (handler and its paid-invoice steps) is named by the charge plan', () => {
    const handler = slice(webhookSource, 'async function handlePaymentIntentSucceeded(', 'async function resetAchFailureStateForSucceededIntent(');
    const steps = slice(webhookSource, 'async function closeOutVisitAfterPaidInvoice(', 'async function notifyPaymentSuccess(');
    const calls = callsIn(handler + steps);
    expect(calls).toEqual(expect.arrayContaining(['closeOutVisitAfterPaidInvoice', 'scheduleReviewAfterPaidInvoice', 'stopOnPayment', 'enqueueReceiptDelivery', 'completeActivePlansForInvoice']));
    const unnamed = calls.filter((name) => !(name in effects.CHARGE_CALL_COVERAGE) && name !== 'closeOutVisitForIssuedInvoice' && !/^enrollForPaidInvoice$/.test(name));
    expect(unnamed).toEqual([]);
  });

  test('the coverage tables point at real effects, and each non-applying call states why', () => {
    const sendKeys = new Set(['delivery', 'closeout', 'lead_conversion', 'followups', 'review', 'credit']);
    const chargeKeys = new Set(['credit', 'closeout', 'review', 'followup_stop', 'payment_plan', 'annual_prepay', 'held_report', 'receipt', 'admin_notice']);
    for (const [table, keys] of [[effects.SEND_CALL_COVERAGE, sendKeys], [effects.CHARGE_CALL_COVERAGE, chargeKeys]]) {
      for (const [name, entry] of Object.entries(table)) {
        if (entry.effect) expect([name, keys.has(entry.effect)]).toEqual([name, true]);
        else expect([name, String(entry.why || '').length > 10]).toEqual([name, true]);
      }
    }
  });

  test('the handlers call the shared predicates the plan uses (a copy would drift)', () => {
    expect(code(invoiceSource)).toMatch(/leadConversionApplies\(\{ customerId, priorStatus, priorDelivered \}\)/);
    expect(code(invoiceSource)).toMatch(/priorDelivered: priorDeliveredForLeadConversion\(claim\.invoice\)/);
    const followups = code(read('../services/invoice-followups.js'));
    expect(followups).toMatch(/if \(followupArmBlock\(preview\)\) return null;/);
    expect(followups).toMatch(/if \(followupArmBlock\(invoice\)\) return null;/);
    expect(followups).toMatch(/if \(!stopOnPaymentVerdict\(seq\)\.stops\) return;/);
    expect(code(read('../services/review-request.js'))).toMatch(/const skipped = paidInvoiceReviewSkip\(invoice, notes\);/);
    expect(code(read('../services/lead-estimate-link.js'))).toMatch(/const resolved = await resolveConversionLeads\(database, \{/);
  });
});
