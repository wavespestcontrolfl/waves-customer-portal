import { describe, expect, it } from 'vitest';
import { attachedVisitInvoice, visitInvoiceStatusNote } from './visitInvoice';

const ACCEPT_MINTED_FIRST_VISIT = {
  estimatedPrice: 115,
  checkoutInvoiceId: 'inv-1',
  checkoutInvoiceStatus: 'draft',
  checkoutInvoiceTotal: 214,
  checkoutInvoiceNumber: 'WPC-2099-0001',
  checkoutInvoiceLines: [
    { description: 'WaveGuard Membership — one-time setup fee', amount: 99 },
    { description: 'First service application', amount: 115 },
  ],
};

describe('attachedVisitInvoice', () => {
  it('returns the attached invoice summary for an accept-minted first visit', () => {
    const inv = attachedVisitInvoice(ACCEPT_MINTED_FIRST_VISIT);
    expect(inv).toMatchObject({
      id: 'inv-1',
      number: 'WPC-2099-0001',
      status: 'draft',
      total: 214,
      settled: false,
      processing: false,
      open: true,
    });
    expect(inv.lines).toHaveLength(2);
  });

  it('is null without an attached invoice or without a numeric total', () => {
    expect(attachedVisitInvoice(null)).toBeNull();
    expect(attachedVisitInvoice({ estimatedPrice: 115 })).toBeNull();
    expect(attachedVisitInvoice({ checkoutInvoiceId: 'inv-1' })).toBeNull();
    expect(attachedVisitInvoice({ checkoutInvoiceId: 'inv-1', checkoutInvoiceTotal: 'abc' })).toBeNull();
  });

  it('flags settled and processing invoices as not open', () => {
    expect(attachedVisitInvoice({ ...ACCEPT_MINTED_FIRST_VISIT, checkoutInvoiceStatus: 'paid' }))
      .toMatchObject({ settled: true, open: false });
    expect(attachedVisitInvoice({ ...ACCEPT_MINTED_FIRST_VISIT, checkoutInvoiceStatus: 'prepaid' }))
      .toMatchObject({ settled: true, open: false });
    expect(attachedVisitInvoice({ ...ACCEPT_MINTED_FIRST_VISIT, checkoutInvoiceStatus: 'processing' }))
      .toMatchObject({ processing: true, open: false });
    expect(attachedVisitInvoice({ ...ACCEPT_MINTED_FIRST_VISIT, checkoutInvoiceStatus: 'sent' }))
      .toMatchObject({ open: true });
  });

  it('treats refunded/cancelled invoices as uncollectible, never open', () => {
    for (const status of ['refunded', 'canceled', 'cancelled']) {
      expect(attachedVisitInvoice({ ...ACCEPT_MINTED_FIRST_VISIT, checkoutInvoiceStatus: status }))
        .toMatchObject({ uncollectible: true, open: false, settled: false });
    }
  });

  it('promises the amount due (total − credit_applied), never the gross', () => {
    const inv = attachedVisitInvoice({ ...ACCEPT_MINTED_FIRST_VISIT, checkoutInvoiceCreditApplied: 50 });
    expect(inv).toMatchObject({ total: 214, creditApplied: 50, amountDue: 164 });
    // No credit → amount due is the total; negative/garbage credit clamps to 0.
    expect(attachedVisitInvoice(ACCEPT_MINTED_FIRST_VISIT)).toMatchObject({ creditApplied: 0, amountDue: 214 });
    expect(attachedVisitInvoice({ ...ACCEPT_MINTED_FIRST_VISIT, checkoutInvoiceCreditApplied: -5 }))
      .toMatchObject({ creditApplied: 0, amountDue: 214 });
  });

  it('carries the prepaid-already-applied flag', () => {
    expect(attachedVisitInvoice({ ...ACCEPT_MINTED_FIRST_VISIT, checkoutInvoicePrepaidApplied: true }))
      .toMatchObject({ prepaidApplied: true });
    expect(attachedVisitInvoice(ACCEPT_MINTED_FIRST_VISIT)).toMatchObject({ prepaidApplied: false });
  });

  it('never marks a payer-billed invoice open — its AR routes to the payer', () => {
    expect(attachedVisitInvoice({ ...ACCEPT_MINTED_FIRST_VISIT, checkoutInvoicePayerBilled: true }))
      .toMatchObject({ payerBilled: true, open: false });
    expect(attachedVisitInvoice(ACCEPT_MINTED_FIRST_VISIT)).toMatchObject({ payerBilled: false, open: true });
  });

  it('drops malformed lines instead of rendering NaN rows', () => {
    const inv = attachedVisitInvoice({
      ...ACCEPT_MINTED_FIRST_VISIT,
      checkoutInvoiceLines: [
        { description: 'ok', amount: 10 },
        { description: '', amount: 5 },
        { description: 'bad', amount: 'x' },
        null,
      ],
    });
    expect(inv.lines).toEqual([{ description: 'ok', amount: 10 }]);
  });
});

describe('visitInvoiceStatusNote', () => {
  it('describes each collection state', () => {
    expect(visitInvoiceStatusNote(attachedVisitInvoice(ACCEPT_MINTED_FIRST_VISIT)))
      .toBe('Collected when the visit is completed.');
    expect(visitInvoiceStatusNote(attachedVisitInvoice({ ...ACCEPT_MINTED_FIRST_VISIT, checkoutInvoiceStatus: 'paid' })))
      .toBe('Paid — nothing to collect at this visit.');
    expect(visitInvoiceStatusNote(attachedVisitInvoice({ ...ACCEPT_MINTED_FIRST_VISIT, checkoutInvoiceStatus: 'prepaid' })))
      .toBe('Covered by account credit — nothing to collect.');
    expect(visitInvoiceStatusNote(attachedVisitInvoice({ ...ACCEPT_MINTED_FIRST_VISIT, checkoutInvoiceStatus: 'processing' })))
      .toBe('Payment processing — do not collect again.');
    expect(visitInvoiceStatusNote(attachedVisitInvoice({ ...ACCEPT_MINTED_FIRST_VISIT, checkoutInvoiceStatus: 'refunded' })))
      .toBe('Refunded — not collectible; bill via a new invoice.');
    expect(visitInvoiceStatusNote(attachedVisitInvoice({ ...ACCEPT_MINTED_FIRST_VISIT, checkoutInvoiceStatus: 'cancelled' })))
      .toBe('Canceled — not collectible; bill via a new invoice.');
  });
});
