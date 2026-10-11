/**
 * The predicates the Intelligence Bar's effects plan shares with the handlers (PR #6117 round 4):
 * each was extracted from inline handler code and is called by BOTH the handler and the plan, so a
 * change to the rule moves the card with it. Pure rules are tested directly; the follow-up plan is
 * tested against a stand-in database. Synthetic ids only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/autopay-eligibility', () => ({ customerOnAutopay: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({}));
jest.mock('../services/stripe', () => ({}));

const { customerOnAutopay } = require('../services/autopay-eligibility');
const Followups = require('../services/invoice-followups');
const Reviews = require('../services/review-request');
const Invoice = require('../services/invoice');
const LeadLink = require('../services/lead-estimate-link');

// A stand-in for the plan's reads: invoice_followup_sequences / payment_plans / customers.
function fakeDb({ sequence = null, plan = null, customer = { id: 'cust-1' } } = {}) {
  const rows = { invoice_followup_sequences: sequence, payment_plans: plan, customers: customer };
  return (table) => {
    const q = { where: () => q, first: async () => rows[table] };
    return q;
  };
}
const invoice = (overrides = {}) => ({ id: 'inv-1', customer_id: 'cust-1', status: 'sent', payer_id: null, scheduled_send_error: null, ...overrides });

describe('invoice-followups planFollowupSequence (scheduleForInvoice\'s own predicates)', () => {
  beforeEach(() => { jest.clearAllMocks(); customerOnAutopay.mockResolvedValue(false); });

  test('a delivered invoice with no sequence, no plan and no Auto Pay arms active reminders on the cadence', async () => {
    const plan = await Followups.planFollowupSequence(invoice(), fakeDb());
    expect(plan).toMatchObject({ arms: true, state: 'active' });
    expect(plan.cadence).toEqual(Followups.followupSteps().map((step) => step.daysAfterSend));
  });

  test('Auto Pay holds them; an unreadable Auto Pay check is stated, not guessed', async () => {
    customerOnAutopay.mockResolvedValue(true);
    await expect(Followups.planFollowupSequence(invoice(), fakeDb())).resolves.toMatchObject({ arms: true, state: 'autopay_hold' });
    customerOnAutopay.mockRejectedValue(new Error('payment_methods unreadable'));
    await expect(Followups.planFollowupSequence(invoice(), fakeDb())).resolves.toMatchObject({ state: 'autopay_unreadable' });
    // The same fail-closed read scheduleForInvoice uses for an adoption.
    expect(customerOnAutopay).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ failClosed: true }));
  });

  test('an active payment plan, a payer-billed invoice, a draft or terminal status, and an existing sequence arm nothing new', async () => {
    await expect(Followups.planFollowupSequence(invoice(), fakeDb({ plan: { id: 'p' } }))).resolves.toMatchObject({ arms: false, state: 'payment_plan' });
    await expect(Followups.planFollowupSequence(invoice({ payer_id: 'payer-1' }), fakeDb())).resolves.toMatchObject({ arms: false, state: 'payer_billed' });
    await expect(Followups.planFollowupSequence(invoice({ status: 'draft' }), fakeDb())).resolves.toMatchObject({ arms: false, state: 'not_schedulable' });
    await expect(Followups.planFollowupSequence(invoice({ status: 'paid' }), fakeDb())).resolves.toMatchObject({ arms: false, state: 'not_schedulable' });
    await expect(Followups.planFollowupSequence(invoice(), fakeDb({ sequence: { status: 'active' } }))).resolves.toMatchObject({ arms: false, state: 'existing:active' });
  });

  test('a sequence a void stopped is re-armed by the resend; an admin\'s own stop is not', async () => {
    await expect(Followups.planFollowupSequence(invoice(), fakeDb({ sequence: { status: 'stopped', stopped_reason: 'invoice_voided', stopped_by_admin_id: null } })))
      .resolves.toMatchObject({ arms: true, state: 'rearm' });
    await expect(Followups.planFollowupSequence(invoice(), fakeDb({ sequence: { status: 'stopped', stopped_reason: 'invoice_voided', stopped_by_admin_id: 'admin-1' } })))
      .resolves.toMatchObject({ arms: false, state: 'existing:stopped' });
  });

  test('followupArmBlock and stopOnPaymentVerdict are the rules the handlers apply', () => {
    expect(Followups.followupArmBlock(invoice())).toBeNull();
    expect(Followups.followupArmBlock(invoice({ status: 'void' }))).toBe('not_schedulable');
    expect(Followups.followupArmBlock(invoice({ payer_id: 'p' }))).toBe('payer_billed');
    expect(Followups.stopOnPaymentVerdict(null)).toEqual({ stops: false, thankYou: false });
    expect(Followups.stopOnPaymentVerdict({ status: 'completed', touches_sent: 3 }).stops).toBe(false);
    expect(Followups.stopOnPaymentVerdict({ status: 'stopped', touches_sent: 3 }).stops).toBe(false);
    expect(Followups.stopOnPaymentVerdict({ status: 'active', touches_sent: 0 })).toEqual({ stops: true, thankYou: false });
    expect(Followups.stopOnPaymentVerdict({ status: 'paused', touches_sent: 2 }).stops).toBe(true);
  });
});

describe('review-request paidInvoiceReviewSkip (enrollForPaidInvoice\'s own test)', () => {
  test('a completion invoice enrolls unless the completion opted out or the visit did not complete', () => {
    const completion = { customer_id: 'cust-1', service_record_id: 'rec-1' };
    expect(Reviews.paidInvoiceReviewSkip(completion, {})).toBeNull();
    expect(Reviews.paidInvoiceReviewSkip(completion, { requestReview: true, visitOutcome: 'completed' })).toBeNull();
    expect(Reviews.paidInvoiceReviewSkip(completion, { requestReview: false })).toBe('completion_opted_out');
    expect(Reviews.paidInvoiceReviewSkip(completion, { visitOutcome: 'no_access' })).toBe('visit_outcome');
    expect(Reviews.paidInvoiceReviewSkip({ customer_id: 'cust-1', service_record_id: null }, {})).toBe('not_completion_invoice');
    expect(Reviews.paidInvoiceReviewSkip({ customer_id: null, service_record_id: 'rec-1' }, {})).toBe('not_completion_invoice');
  });
});

describe('invoice leadConversionApplies (convertLeadOnInvoiceSent\'s own test)', () => {
  test('only a first delivery from draft / scheduled / sending, for a customer, with no earlier delivery stamp', () => {
    for (const priorStatus of ['draft', 'scheduled', 'sending']) expect(Invoice.leadConversionApplies({ customerId: 'c', priorStatus })).toBe(true);
    for (const priorStatus of ['sent', 'viewed', 'overdue', 'paid']) expect(Invoice.leadConversionApplies({ customerId: 'c', priorStatus })).toBe(false);
    expect(Invoice.leadConversionApplies({ customerId: null, priorStatus: 'draft' })).toBe(false);
    expect(Invoice.leadConversionApplies({ customerId: 'c', priorStatus: 'draft', priorDelivered: true })).toBe(false);
  });

  test('a delivery stamp means delivered before; the summary text\'s own stamp on a carried invoice does not', () => {
    const { SUMMARY_TEXT_CARRIED_ERROR } = require('../services/invoice-helpers');
    expect(Invoice.priorDeliveredForLeadConversion({ sent_at: new Date() })).toBe(true);
    expect(Invoice.priorDeliveredForLeadConversion({ sms_sent_at: new Date(), scheduled_send_error: null })).toBe(true);
    expect(Invoice.priorDeliveredForLeadConversion({ sms_sent_at: new Date(), scheduled_send_error: `${SUMMARY_TEXT_CARRIED_ERROR} carried` })).toBe(false);
    expect(Invoice.priorDeliveredForLeadConversion({})).toBe(false);
  });
});

describe('lead-estimate-link invoiceSentConversionTargets (read-only, same resolver as the conversion)', () => {
  test('no customer, or a read that fails, names no lead', async () => {
    await expect(LeadLink.invoiceSentConversionTargets(null)).resolves.toEqual({ reason: 'no_customer', leadIds: [] });
    await expect(LeadLink.invoiceSentConversionTargets('cust-1', () => { throw new Error('db down'); })).resolves.toEqual({ reason: 'error', leadIds: [] });
  });
});
