// When an estimate is accepted but the invoice pay link can't be delivered
// immediately, the send is auto-retried (processScheduledSends). The accept
// notification copy must reflect that honestly: tell the customer their link is
// on its way (not that they already have it, and not that a manual office
// follow-up is required), and tell the office a retry is queued (not that the
// invoice "was not sent automatically"). When no retry was queued (e.g. the
// invoice itself never got created) the original follow-up copy still applies.

const { buildAcceptNotificationPayload } = require('../routes/estimate-public');

const base = {
  customerName: 'Jane Homeowner',
  waveguardTier: 'Gold',
  monthlyTotal: 89,
  invoiceMode: true,
  invoicePayUrl: '/pay/tok-123',
};

describe('buildAcceptNotificationPayload — invoice delivery retry copy', () => {
  test('delivered: customer is told the link was sent, office sees no alarm', () => {
    const p = buildAcceptNotificationPayload({ ...base, invoiceLinkDelivered: true });
    expect(p.adminBody).toContain('Invoice pay link sent.');
    expect(p.customerBody).toContain('Use the invoice pay link');
    expect(p.customerBody).not.toMatch(/follow up|on its way|sending your invoice/i);
  });

  test('undelivered + retry queued: honest "on its way" customer copy + retry-queued admin copy', () => {
    const p = buildAcceptNotificationPayload({
      ...base,
      invoiceLinkDelivered: false,
      invoiceDeliveryRetryQueued: true,
    });
    expect(p.adminBody).toContain('automatic retry queued');
    expect(p.adminBody).not.toMatch(/office follow-up needed/i);
    expect(p.customerBody).toMatch(/sending your invoice pay link/i);
    // Don't claim they already have the link, and don't tell them the office
    // will manually follow up — the system is retrying.
    expect(p.customerBody).not.toContain('Use the invoice pay link');
    expect(p.customerBody).not.toMatch(/our team will follow up/i);
  });

  test('undelivered + NOT queued: original manual-follow-up copy is preserved', () => {
    const p = buildAcceptNotificationPayload({
      ...base,
      billByInvoice: true,
      invoiceLinkDelivered: false,
      invoiceDeliveryRetryQueued: false,
    });
    expect(p.adminBody).toMatch(/office follow-up needed/i);
    expect(p.customerBody).toMatch(/our team will follow up/i);
    expect(p.customerBody).not.toMatch(/sending your invoice pay link/i);
  });

  test('billByInvoice one-time, retry queued: per-visit label gets the retry copy', () => {
    const p = buildAcceptNotificationPayload({
      customerName: 'Sam Renter',
      serviceLabel: 'mosquito',
      treatAsOneTime: true,
      billByInvoice: true,
      invoiceMode: true,
      invoicePayUrl: '/pay/tok-9',
      invoiceLinkDelivered: false,
      invoiceDeliveryRetryQueued: true,
    });
    expect(p.adminBody).toContain('automatic retry queued');
    expect(p.customerBody).toMatch(/sending your invoice pay link/i);
  });

  test('annual prepay, retry queued: retry copy on the prepay branch', () => {
    const p = buildAcceptNotificationPayload({
      ...base,
      billingTerm: 'prepay_annual',
      annualPrepayAmount: 1020,
      invoiceLinkDelivered: false,
      invoiceDeliveryRetryQueued: true,
    });
    expect(p.adminBody).toContain('automatic retry queued');
    expect(p.customerBody).toMatch(/sending your invoice pay link/i);
  });

  test('payer-billed delivery failure is unaffected (its own branch, no retry copy)', () => {
    const p = buildAcceptNotificationPayload({
      ...base,
      payerBilled: true,
      invoiceLinkDelivered: false,
      invoiceDeliveryRetryQueued: true,
    });
    // Payer path owns its messaging — homeowner owes nothing, office follows up
    // with the billing contact. It must not adopt the customer pay-link retry copy.
    expect(p.customerBody).toMatch(/nothing is due from you/i);
    expect(p.customerBody).not.toMatch(/sending your invoice pay link/i);
  });
});
