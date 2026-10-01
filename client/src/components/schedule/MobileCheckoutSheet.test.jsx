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

  // codex pre-push P2 (round 15, Codex r12 finding): this used to assert the
  // visit's OWN price ($115) stayed chargeable even though the attached
  // invoice was correctly suppressed — but the server's payer guard (POST
  // /:id/invoice, PayerService.resolveForInvoice) refuses in-person
  // collection for EVERY payer-resolved visit unconditionally, with no
  // price check at all, so a priced payer-billed visit 400'd on every tap
  // of that "Charge $115.00" button. Neither the attached invoice NOR the
  // visit's own price is chargeable through this sheet now.
  it('never presents a payer-billed visit\'s attached invoice — or its own price — as collectible', () => {
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
    expect(screen.queryByRole('button', { name: 'Charge $115.00' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No charge — complete from job' })).toBeDisabled();
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
  // so it reads `grossAmount` (the fee/rate BEFORE the recorded prepayment
  // was netted out) and applies its OWN prepaid-credit math against that
  // gross figure exactly once — never the already-net `amount` the other
  // three schedule surfaces use directly, which would net the same
  // prepayment a second time ($100 base, $60 prepaid predicts $40 net;
  // crediting $60 again against that $40 would zero the charge although $40
  // is owed). Lane is monthly_membership (never per_application — see the
  // REMOVE THE CHARGE NOW FEE FALLBACK block below for why that lane
  // deliberately no longer previews a chargeable amount here at all) so
  // this fixture's grossAmount traces to monthlyRate, a mint Charge Now
  // still makes.
  it('charges the real remaining balance against the gross base, crediting the prepayment once', () => {
    render(
      <MobileCheckoutSheet
        service={{
          ...BASE_SERVICE,
          waveguardTier: null,
          estimatedPrice: null,
          prepaidAmount: 60,
          prepaidMethod: 'cash',
          billingLane: {
            mode: 'monthly_membership',
            source: 'explicit',
            monthlyRate: 100,
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
  // visit — grossAmount ($80) is the base, fully absorbed by the $100
  // prepaid, so the button still mints (a $0-due invoice the prepaid
  // credit settles), never disabled outright — the base is chargeable
  // pre-prepaid even though the net total is $0 (mirrors the existing
  // attached-invoice "fully prepaid" behavior above). Same monthly_membership
  // lane choice as the test above, for the same reason.
  it('nets a fully-covered "prepaid" prediction to $0 with no extras added, crediting the gross base', () => {
    render(
      <MobileCheckoutSheet
        service={{
          ...BASE_SERVICE,
          waveguardTier: null,
          estimatedPrice: null,
          prepaidAmount: 100,
          prepaidMethod: 'cash',
          billingLane: {
            mode: 'monthly_membership',
            source: 'explicit',
            monthlyRate: 80,
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

  // Owner ruling — REMOVE THE CHARGE NOW FEE FALLBACK (2026-09-27): the SAME
  // two fixtures as above, but under the per_application lane the ruling
  // actually narrows — Charge Now must never preview (or mint) the
  // customer-level per_application_fee for an unpriced visit, whether the
  // prediction kind is 'invoice' (a balance still due) or 'prepaid' (fully
  // covered — Charge Now would still need to mint a $0 invoice off the fee
  // to settle it, and there is no fee left to build that invoice from
  // either). Both now show the same generic "nothing to charge" state every
  // other $0 visit shows.
  it.each([
    ['invoice', { kind: 'invoice', amount: 40, grossAmount: 100, conflictStampedPrice: false }, 60],
    ['prepaid', { kind: 'prepaid', amount: 100, grossAmount: 80, conflictStampedPrice: false }, 100],
  ])('never previews a per_application fee-based amount for prediction kind "%s"', (_kind, prediction, prepaidAmount) => {
    render(
      <MobileCheckoutSheet
        service={{
          ...BASE_SERVICE,
          waveguardTier: null,
          estimatedPrice: null,
          prepaidAmount,
          prepaidMethod: 'cash',
          billingLane: {
            mode: 'per_application',
            source: 'explicit',
            monthlyRate: null,
            prediction,
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /^Charge \$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No charge — complete from job' })).toBeDisabled();
  });

  // Codex pre-push P1 (round 13, Codex r11 finding): feeOnlyPerApplicationPreview
  // must require !hasOwnPrice explicitly — it is read directly (not only
  // inside `price`'s own hasOwnPrice-gated branch) to hide the Add
  // Service / Add Item pickers. An EXPLICITLY priced per_application visit
  // whose prediction still happens to carry kind 'invoice' (completionInvoiceAmount's
  // precedence doesn't change kind based on WHERE the amount came from)
  // must keep its normal Charge button and checkout-extra controls.
  it('a PRICED per_application visit keeps its Charge button and Add Service / Add Item controls', () => {
    render(
      <MobileCheckoutSheet
        service={{
          ...BASE_SERVICE,
          waveguardTier: null,
          estimatedPrice: 120,
          billingLane: {
            mode: 'per_application',
            source: 'explicit',
            monthlyRate: null,
            prediction: { kind: 'invoice', amount: 98, grossAmount: 98, conflictStampedPrice: false },
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Charge $120.00' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Service' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Item or Discount' })).toBeInTheDocument();
    expect(screen.queryByText(/bills its application fee at completion/)).not.toBeInTheDocument();
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

  // Codex ROUND 2 P2: the `?? amount` fallback above treats a legacy NET
  // amount as if it were the gross base. When a REAL prepayment is on
  // file, that double-credits it: a $100 fee with $60 prepaid predicts
  // `{ amount: 40 }` net — using $40 as the base and then crediting $60
  // again previews $0.00, although the mint endpoint would create a real
  // $40 balance. This must refuse to guess, not quietly undercharge.
  it('refuses to guess a gross base from a legacy net `amount` when a prepayment is on file', () => {
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
            // No grossAmount — the legacy/stale shape.
            prediction: { kind: 'invoice', amount: 40, conflictStampedPrice: false },
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Charge $0.00' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Charge $40.00' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /price needs a refresh/i })).toBeDisabled();
  });

  // Codex round-9 P2: the annual_prepay lane's own predictCompletionBilling
  // branch (billing-lane.js) used to return 'invoice'/'prepaid' with NO
  // grossAmount at all — unlike the per_application/self-pay lanes right
  // above, which always carried it. A same-day sibling-covered annual-plan
  // add-on (unpriced here, its own price arriving only via the prediction)
  // with a recorded prepayment then hit the exact "refuses to guess" guard
  // proven above and permanently disabled Charge Now, even though the
  // server's own mint would happily collect the real remaining balance.
  // Once billing-lane.js supplies grossAmount for this lane too, Charge
  // Now must NOT be blocked.
  it('does not block Charge Now on the missing-gross guard for an annual_prepay lane prediction now that it carries grossAmount', () => {
    render(
      <MobileCheckoutSheet
        service={{
          ...BASE_SERVICE,
          waveguardTier: null,
          estimatedPrice: null,
          prepaidAmount: 60,
          prepaidMethod: 'cash',
          billingLane: {
            mode: 'annual_prepay',
            source: 'explicit',
            monthlyRate: null,
            prediction: { kind: 'invoice', amount: 40, grossAmount: 100, conflictStampedPrice: false },
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /price needs a refresh/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Charge $40.00' })).toBeInTheDocument();
    expect(screen.getByText('Prepaid credit')).toBeInTheDocument();
    expect(screen.getByText('−$60.00')).toBeInTheDocument();
  });

  // Codex round 4 P1: a CONFIRMED no-charge prediction ('no_charge' with
  // reason 'fully_discounted' — hasAuthoritativeZeroPrice's genuine $0 net)
  // never carries grossAmount by design (it is 0 either way), and the
  // missing-grossAmount refresh guard above must not fire for it just
  // because a leftover prepaidAmount happens to be on the row — that
  // would permanently disable Charge for a legitimately free visit, even
  // once a chargeable extra is stacked on top.
  it('never blocks checkout on the missing-grossAmount guard for a confirmed fully-discounted $0 visit', () => {
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
            // No grossAmount — 'no_charge' never carries one.
            prediction: { kind: 'no_charge', amount: 0, reason: 'fully_discounted', conflictStampedPrice: false },
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /price needs a refresh/i })).not.toBeInTheDocument();
  });

  // Codex round-2 P1 (on the P2 fix above): predictionFromAttachedInvoice
  // (admin-schedule.js) never carries grossAmount for an attached invoice —
  // that's a legitimate, CURRENT payload shape, not a legacy/stale one.
  // Once an invoice is attached, totalBeforePrepaid comes from
  // invoicePreview.amountDue, never from the unpriced-prediction `price` at
  // all — so the missing-grossAmount refresh guard must not fire here; it
  // would otherwise disable checkout indefinitely for every unpriced,
  // partially-prepaid visit that already has an open attached invoice.
  // Lane is monthly_membership (never per_application — see the round-13
  // "Bills at completion" test below for why that lane's attached invoice
  // is refused instead of charged here).
  it('does not block checkout on the missing-grossAmount guard when an attached invoice already drives the total', () => {
    render(
      <MobileCheckoutSheet
        service={{
          ...BASE_SERVICE,
          ...ATTACHED_INVOICE_FIELDS,
          waveguardTier: null,
          estimatedPrice: null,
          prepaidAmount: 60,
          prepaidMethod: 'cash',
          billingLane: {
            mode: 'monthly_membership',
            source: 'explicit',
            monthlyRate: 40,
            // No grossAmount — same shape predictionFromAttachedInvoice
            // always produces, never a stale/legacy payload.
            prediction: { kind: 'invoice', amount: 40, conflictStampedPrice: false },
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /price needs a refresh/i })).not.toBeInTheDocument();
    // $214 invoice total, $60 prepaid credited once.
    expect(screen.getByRole('button', { name: 'Charge $154.00' })).toBeInTheDocument();
  });

  // Owner ruling — REFUSE EXTRAS-ONLY MINTS FOR THE FEE SHAPE (round 13,
  // Codex r11 finding): resolveScheduledServiceCharge refuses the
  // per_application_fee_at_completion shape UNCONDITIONALLY, even when this
  // visit already has an open, otherwise-collectible attached invoice — so
  // the SAME fixture as the test above, but under the per_application lane
  // the ruling actually narrows, must NOT preview a live "Charge $X" button
  // (it would 409 on every tap). "Bills at completion — see the invoice or
  // set a price" replaces it, and the copy block explains why instead of
  // promising the tap will work.
  it('refuses checkout for an unpriced per_application visit even with an attached invoice already driving the total', () => {
    render(
      <MobileCheckoutSheet
        service={{
          ...BASE_SERVICE,
          ...ATTACHED_INVOICE_FIELDS,
          waveguardTier: null,
          estimatedPrice: null,
          prepaidAmount: 60,
          prepaidMethod: 'cash',
          billingLane: {
            mode: 'per_application',
            source: 'explicit',
            monthlyRate: null,
            prediction: { kind: 'invoice', amount: 40, conflictStampedPrice: false },
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Charge $154.00' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bills at completion — see the invoice or set a price' })).toBeDisabled();
    expect(screen.getByText(/Charge Now can.t collect invoice WPC-2099-0001 here/)).toBeInTheDocument();
  });

  // codex pre-push P1 (round 14, Codex r11 finding): a fully-discounted
  // application (estimatedPrice stamped 0 alongside a positive
  // primaryLinePrice — hasAuthoritativeZeroPrice, billing-lane.js) IS an
  // authoritative price server-side — resolveScheduledServiceCharge's own
  // hasOwnPrice includes this exemption, so its per_application_fee_at_completion
  // refusal does NOT apply, and an attached invoice on this exact shape
  // (e.g. a genuine extras-only invoice on a $0-net application) stays
  // normally collectible through this sheet. The SAME fixture as the two
  // tests above, but with a provenance-backed $0 instead of a bare
  // unpriced row, must NOT be refused.
  it('does not refuse checkout for a per_application visit with a provenance-backed $0 (authoritative zero) even with an attached invoice', () => {
    render(
      <MobileCheckoutSheet
        service={{
          ...BASE_SERVICE,
          ...ATTACHED_INVOICE_FIELDS,
          waveguardTier: null,
          estimatedPrice: 0,
          primaryLinePrice: 100,
          prepaidAmount: 60,
          prepaidMethod: 'cash',
          billingLane: {
            mode: 'per_application',
            source: 'explicit',
            monthlyRate: null,
            prediction: { kind: 'invoice', amount: 40, conflictStampedPrice: false },
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Bills at completion — see the invoice or set a price' })).not.toBeInTheDocument();
    // $214 invoice total, $60 prepaid credited once.
    expect(screen.getByRole('button', { name: 'Charge $154.00' })).toBeInTheDocument();
  });

  // Codex pre-push P2 (round 3): predictionFromAttachedInvoice returns
  // `source: 'attached_invoice'` (never grossAmount) for a SETTLED
  // (paid/prepaid) or refunded invoice too, but `invoicePreview` above is
  // null for both (openVisitInvoice/processingVisitInvoice exclude
  // settled/uncollectible statuses) — the OLD `!invoicePreview` exemption
  // alone missed this subset, so an unpriced visit with a recorded
  // prepayment and a settled or refunded attached invoice was shown
  // "Price needs a refresh" permanently even though the payload was
  // current. Keying the exemption on the prediction's own `source` field
  // fixes both.
  it.each(['paid', 'refunded'])(
    'does not show the missing-grossAmount refresh guard for a %s attached invoice',
    (status) => {
      render(
        <MobileCheckoutSheet
          service={{
            ...BASE_SERVICE,
            ...ATTACHED_INVOICE_FIELDS,
            checkoutInvoiceStatus: status,
            waveguardTier: null,
            estimatedPrice: null,
            prepaidAmount: 60,
            prepaidMethod: 'cash',
            billingLane: {
              mode: 'per_application',
              source: 'explicit',
              monthlyRate: null,
              // Same shape predictionFromAttachedInvoice always returns for
              // a non-dead attached invoice — never grossAmount.
              prediction: { kind: 'prepaid', amount: 0, conflictStampedPrice: false, source: 'attached_invoice' },
            },
          }}
          onClose={() => {}}
        />,
      );
      expect(screen.queryByRole('button', { name: /price needs a refresh/i })).not.toBeInTheDocument();
    },
  );

  // Canceled/void is the one attached-invoice status predictionFromAttachedInvoice
  // itself treats as dead (DEAD_ATTACHED_INVOICE_STATUSES) — its prediction
  // falls through to the ordinary predictCompletionBilling shape with NO
  // `source: 'attached_invoice'`, so a missing grossAmount there is a real
  // legacy/stale signal and must still be refused, unchanged by this fix.
  it('still shows the refresh guard for a canceled attached invoice (source is not attached_invoice)', () => {
    render(
      <MobileCheckoutSheet
        service={{
          ...BASE_SERVICE,
          ...ATTACHED_INVOICE_FIELDS,
          checkoutInvoiceStatus: 'canceled',
          waveguardTier: null,
          estimatedPrice: null,
          prepaidAmount: 60,
          prepaidMethod: 'cash',
          billingLane: {
            mode: 'per_application',
            source: 'explicit',
            monthlyRate: null,
            prediction: { kind: 'invoice', amount: 40, conflictStampedPrice: false },
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /price needs a refresh/i })).toBeDisabled();
  });
});

describe('MobileCheckoutSheet priced-visit sibling review', () => {
  it('disables Charge on a PRICED visit the server marks review (voided combined invoice, sibling billed separately)', () => {
    render(
      <MobileCheckoutSheet
        service={{
          ...BASE_SERVICE,
          estimatedPrice: 153.6,
          billingLane: {
            siblingCoverage: { state: 'review', reason: 'sibling_already_invoiced_after_void' },
          },
        }}
        onClose={() => {}}
      />,
    );
    const button = screen.getByRole('button', { name: /Needs review on Customer 360/ });
    expect(button).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Charge \$/ })).not.toBeInTheDocument();
  });

  it('leaves a priced visit with a none verdict chargeable', () => {
    render(
      <MobileCheckoutSheet
        service={{ ...BASE_SERVICE, billingLane: { siblingCoverage: { state: 'none' } } }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Charge $115.00' })).toBeEnabled();
  });
});
