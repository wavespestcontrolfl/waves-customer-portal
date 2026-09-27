// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MobileCheckoutSheet from './MobileCheckoutSheet';

vi.mock('./MobileServicePickerSheet', () => ({ default: () => null }));
vi.mock('./MobileItemDiscountPickerSheet', () => ({ default: () => null }));
vi.mock('../../hooks/useCustomerCards', () => ({
  // null = unknown → the card-on-file note renders nothing.
  useCustomerCards: () => ({ cards: null }),
  chargeableCardOnFile: () => null,
  cardOnFileTitle: () => '',
  isCardExpired: () => false,
}));
// None of these tests add a discount — stub the gate confirmed-off so the
// added stacking wiring stays inert here (its own behavior is covered by
// MobileCheckoutSheet.discount-stack.test.jsx).
vi.mock('../../hooks/useDiscountStacking', () => ({
  useDiscountStackingState: () => ({ enabled: false, known: true, retry: vi.fn() }),
}));

afterEach(cleanup);

const BASE_SERVICE = {
  id: 'svc-1',
  serviceType: 'Quarterly Pest Control',
  serviceTypeDisplay: 'Quarterly Pest Control',
  waveguardTier: 'Bronze',
  estimatedPrice: 115,
  windowStart: '11:00:00',
  estimatedDuration: 60,
};

const ATTACHED_INVOICE_FIELDS = {
  checkoutInvoiceId: 'inv-1',
  checkoutInvoiceStatus: 'draft',
  checkoutInvoiceTotal: 214,
  checkoutInvoiceNumber: 'WPC-2099-0001',
  checkoutInvoiceLines: [
    { description: 'WaveGuard Membership — one-time setup fee', amount: 99 },
    { description: 'First service application', amount: 115 },
  ],
};

describe('MobileCheckoutSheet attached-invoice preview', () => {
  it('previews the attached invoice total and lines, not the per-application price', () => {
    render(
      <MobileCheckoutSheet
        service={{ ...BASE_SERVICE, ...ATTACHED_INVOICE_FIELDS }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Charge $214.00' })).toBeInTheDocument();
    expect(screen.getByText('WaveGuard Membership — one-time setup fee')).toBeInTheDocument();
    expect(screen.getByText('$99.00')).toBeInTheDocument();
    expect(screen.getByText('First service application')).toBeInTheDocument();
    expect(screen.getByText('$115.00')).toBeInTheDocument();
    expect(screen.getByText(/Invoice on file · WPC-2099-0001/)).toBeInTheDocument();
    // The mint endpoint reuses the invoice and ignores extras — the pickers
    // must not be offered.
    expect(screen.queryByRole('button', { name: 'Add Service' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Item or Discount' })).not.toBeInTheDocument();
    expect(screen.getByText(/Charging collects this invoice as-is/)).toBeInTheDocument();
  });

  it('keeps the per-application preview and add buttons when no invoice is attached', () => {
    render(<MobileCheckoutSheet service={BASE_SERVICE} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Charge $115.00' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Service' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Item or Discount' })).toBeInTheDocument();
    expect(screen.queryByText(/Invoice on file/)).not.toBeInTheDocument();
  });

  it('falls back to the standard preview when the attached invoice is already settled', () => {
    render(
      <MobileCheckoutSheet
        service={{ ...BASE_SERVICE, ...ATTACHED_INVOICE_FIELDS, checkoutInvoiceStatus: 'paid' }}
        onClose={() => {}}
      />,
    );
    // The server's Charge-now reuse path reports settled invoices as
    // alreadyPaid; the preview stays on the visit price and the add buttons
    // remain (they still apply if the office voids/replaces the invoice).
    expect(screen.getByRole('button', { name: 'Charge $115.00' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Service' })).toBeInTheDocument();
  });

  it('applies prepaid credit against the attached invoice total', () => {
    render(
      <MobileCheckoutSheet
        service={{ ...BASE_SERVICE, ...ATTACHED_INVOICE_FIELDS, prepaidAmount: 100 }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Charge $114.00' })).toBeInTheDocument();
    expect(screen.getByText('Prepaid credit')).toBeInTheDocument();
  });

  it('does not net the prepayment twice when the invoice already consumed it', () => {
    render(
      <MobileCheckoutSheet
        service={{
          ...BASE_SERVICE,
          ...ATTACHED_INVOICE_FIELDS,
          prepaidAmount: 100,
          checkoutInvoicePrepaidApplied: true,
        }}
        onClose={() => {}}
      />,
    );
    // Server already reduced the invoice total by the prepayment — the
    // preview charges the invoice's amount due as-is.
    expect(screen.getByRole('button', { name: 'Charge $214.00' })).toBeInTheDocument();
    expect(screen.queryByText('Prepaid credit')).not.toBeInTheDocument();
    expect(screen.getByText('Recorded prepayment already applied to this invoice.')).toBeInTheDocument();
  });

  it('charges the amount due when account credit is applied to the invoice', () => {
    render(
      <MobileCheckoutSheet
        service={{ ...BASE_SERVICE, ...ATTACHED_INVOICE_FIELDS, checkoutInvoiceCreditApplied: 50 }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Charge $164.00' })).toBeInTheDocument();
    expect(screen.getByText('Account credit applied')).toBeInTheDocument();
    expect(screen.getByText('−$50.00')).toBeInTheDocument();
  });

  it('falls back to the standard flow for a refunded attached invoice', () => {
    render(
      <MobileCheckoutSheet
        service={{ ...BASE_SERVICE, ...ATTACHED_INVOICE_FIELDS, checkoutInvoiceStatus: 'refunded' }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Charge $115.00' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Service' })).toBeInTheDocument();
  });

  it('never presents a payer-billed visit\'s attached invoice as collectible', () => {
    render(
      <MobileCheckoutSheet
        service={{
          ...BASE_SERVICE,
          ...ATTACHED_INVOICE_FIELDS,
          billedToPayer: { id: 'payer-1', name: 'HOA Management' },
        }}
        onClose={() => {}}
      />,
    );
    // The Charge-now endpoint refuses in-person collection for payer-billed
    // visits — the sheet must not promise the attached invoice.
    expect(screen.queryByText(/Invoice on file/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Charging collects this invoice as-is/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Charge $115.00' })).toBeInTheDocument();
  });

  it('suppresses the branch when the INVOICE itself is payer-billed', () => {
    render(
      <MobileCheckoutSheet
        service={{ ...BASE_SERVICE, ...ATTACHED_INVOICE_FIELDS, checkoutInvoicePayerBilled: true }}
        onClose={() => {}}
      />,
    );
    // The reuse endpoint refuses an invoice carrying payer_id even when the
    // visit currently resolves self-pay.
    expect(screen.queryByText(/Invoice on file/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Charge $115.00' })).toBeInTheDocument();
  });

  it('keeps the invoice preview for an INACTIVE per-job payer (raw payerId, no resolved payer)', () => {
    render(
      <MobileCheckoutSheet
        service={{ ...BASE_SERVICE, ...ATTACHED_INVOICE_FIELDS, payerId: 'payer-inactive' }}
        onClose={() => {}}
      />,
    );
    // Inactive payers resolve self-pay server-side (billedToPayer null) and
    // the mint endpoint reuses this collectible invoice — the preview must
    // match what the charge actually collects.
    expect(screen.getByRole('button', { name: 'Charge $214.00' })).toBeInTheDocument();
    expect(screen.getByText(/Invoice on file · WPC-2099-0001/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Service' })).not.toBeInTheDocument();
  });

  it('blocks charging outright while the attached invoice is processing', () => {
    render(
      <MobileCheckoutSheet
        service={{ ...BASE_SERVICE, ...ATTACHED_INVOICE_FIELDS, checkoutInvoiceStatus: 'processing' }}
        onClose={() => {}}
      />,
    );
    const button = screen.getByRole('button', { name: 'Payment processing — nothing to collect' });
    expect(button).toBeDisabled();
    // The invoice context still shows, but no tender or edit affordances.
    expect(screen.getByText(/Invoice on file · WPC-2099-0001/)).toBeInTheDocument();
    expect(screen.getByText(/already processing — do not collect again/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Service' })).not.toBeInTheDocument();
  });
});

describe('MobileCheckoutSheet money lines', () => {
  it('renders the base service price with cents, matching the total', () => {
    render(
      <MobileCheckoutSheet
        service={{ ...BASE_SERVICE, estimatedPrice: 112.5 }}
        onClose={() => {}}
      />,
    );
    // The base row and the total both carry cents now (the row used to say $113).
    expect(screen.getAllByText('$112.50').length).toBeGreaterThan(0);
    expect(screen.queryByText('$113')).not.toBeInTheDocument();
  });
});

describe('MobileCheckoutSheet unpriced-visit billingLane.prediction fallback', () => {
  // Codex pre-push P1: this sheet stacks extras on top of the base visit,
  // so it reads `grossAmount` (the fee BEFORE the recorded prepayment was
  // netted out) and applies its OWN prepaid-credit math against that gross
  // figure exactly once — never the already-net `amount` the other three
  // schedule surfaces use directly, which would net the same prepayment a
  // second time ($100 fee, $60 prepaid predicts $40 net; crediting $60
  // again against that $40 would zero the charge although $40 is owed).
  it('charges the real remaining balance against the gross fee, crediting the prepayment once', () => {
    render(
      <MobileCheckoutSheet
        service={{
          ...BASE_SERVICE,
          waveguardTier: null,
          estimatedPrice: null,
          prepaidAmount: 60,
          prepaidMethod: 'cash',
          billingLane: {
            mode: 'per_application',
            source: 'explicit',
            monthlyRate: null,
            prediction: { kind: 'invoice', amount: 40, grossAmount: 100, conflictStampedPrice: false },
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Charge $40.00' })).toBeInTheDocument();
    expect(screen.getByText('Prepaid credit')).toBeInTheDocument();
    expect(screen.getByText('−$60.00')).toBeInTheDocument();
  });

  // A 'prepaid' kind means completion mints nothing new against the base
  // visit — grossAmount ($80) is the fee, fully absorbed by the $100
  // prepaid, so the button still mints (a $0-due invoice the prepaid
  // credit settles), never disabled outright — the base is chargeable
  // pre-prepaid even though the net total is $0 (mirrors the existing
  // attached-invoice "fully prepaid" behavior above).
  it('nets a fully-covered "prepaid" prediction to $0 with no extras added, crediting the gross fee', () => {
    render(
      <MobileCheckoutSheet
        service={{
          ...BASE_SERVICE,
          waveguardTier: null,
          estimatedPrice: null,
          prepaidAmount: 100,
          prepaidMethod: 'cash',
          billingLane: {
            mode: 'per_application',
            source: 'explicit',
            monthlyRate: null,
            prediction: { kind: 'prepaid', amount: 100, grossAmount: 80, conflictStampedPrice: false },
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Charge $0.00' })).toBeInTheDocument();
    expect(screen.getByText('Prepaid credit')).toBeInTheDocument();
    expect(screen.getByText('−$80.00')).toBeInTheDocument();
  });

  // Older cached payload (or a kind that never nets against THIS customer's
  // prepaid, like 'payer') carries no grossAmount at all — falls back to
  // `amount` rather than crashing on a missing field.
  it('falls back to `amount` when the payload has no grossAmount', () => {
    render(
      <MobileCheckoutSheet
        service={{
          ...BASE_SERVICE,
          waveguardTier: null,
          estimatedPrice: null,
          billingLane: {
            mode: 'per_visit',
            source: 'inferred',
            monthlyRate: 60,
            prediction: { kind: 'invoice', amount: 60, conflictStampedPrice: false },
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Charge $60.00' })).toBeInTheDocument();
  });
});
