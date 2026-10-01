// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PaymentPreferenceButtons, { CARD_SURCHARGE_DISCLOSURE, standardInvoiceShape } from './PaymentPreferenceButtons';
import { resolvePaymentTiming } from '../../lib/paymentTiming';
import {
  CARD_CONSENT_TEXT as CLIENT_CARD_CONSENT_TEXT,
  CONSENT_VERSION as CLIENT_CONSENT_VERSION,
} from '../../lib/paymentMethodConsentText';
// Server-authoritative sources (CJS, dependency-light — vitest interops them).
// AGENTS.md: computeChargeAmount policy in server/services/stripe-pricing.js
// is the single source of truth for the surcharge; the consent text mirror
// must stay in sync with server/services/payment-method-consent-text.js.
import serverConsent from '../../../../server/services/payment-method-consent-text';
import stripePricing from '../../../../server/services/stripe-pricing';

afterEach(() => cleanup());

describe('PaymentPreferenceButtons', () => {
  it('offers annual prepay when the service mix is eligible without a setupFee', () => {
    const onSelect = vi.fn();

    render(
      <PaymentPreferenceButtons
        onSelect={onSelect}
        disabled={false}
        serviceMode="recurring"
        setupFee={null}
        annualPrepayEligible
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /prepay 12 months/i }));

    expect(screen.getByText('12-month invoice opens after you approve.')).toBeInTheDocument();
    expect(onSelect).toHaveBeenCalledWith('prepay_annual');
  });

  // GATE_PREPAY_CARD_AND_CHARGE (owner ruling 2026-08-25): in-lane prepay
  // saves a card at checkout and charges the 12-month total on confirmation —
  // the button copy must never promise an after-the-fact invoice pay link.
  it('in-lane prepay copy says the card is charged at confirm, not that an invoice opens later', () => {
    render(
      <PaymentPreferenceButtons
        onSelect={vi.fn()}
        disabled={false}
        serviceMode="recurring"
        setupFee={null}
        annualPrepayEligible
        prepayInLane
        prepayCardCapture
      />,
    );

    expect(screen.getByText('Save your card at checkout; the 12-month total is charged when you confirm.')).toBeInTheDocument();
    expect(screen.queryByText('12-month invoice opens after you approve.')).not.toBeInTheDocument();
  });

  // Codex #3492 r10: auto-satisfy accepts (saved card / Auto Pay already
  // active) charge the SAVED method — which may be a bank account — with no
  // card-save step, so the copy must stay tender-neutral there.
  it('in-lane prepay without a capture step says the saved payment method is charged', () => {
    render(
      <PaymentPreferenceButtons
        onSelect={vi.fn()}
        disabled={false}
        serviceMode="recurring"
        setupFee={null}
        annualPrepayEligible
        prepayInLane
      />,
    );

    expect(screen.getByText('Your saved payment method on file is charged the 12-month total when you confirm.')).toBeInTheDocument();
    expect(screen.queryByText(/Save your card at checkout/)).not.toBeInTheDocument();
    expect(screen.queryByText('12-month invoice opens after you approve.')).not.toBeInTheDocument();
  });

  it('in-lane prepay with a waivable setup fee appends the charge-at-confirm line', () => {
    render(
      <PaymentPreferenceButtons
        onSelect={vi.fn()}
        disabled={false}
        serviceMode="recurring"
        setupFee={{ amount: 99, waivedWithPrepay: true }}
        annualPrepayEligible
        prepayInLane
        prepayCardCapture
      />,
    );

    expect(screen.getByText(/setup fee waived\. Save your card at checkout; the 12-month total is charged when you confirm\./)).toBeInTheDocument();
  });

  it('shows setup plus first visit invoice total for pay per application', () => {
    const onSelect = vi.fn();

    render(
      <PaymentPreferenceButtons
        onSelect={onSelect}
        disabled={false}
        serviceMode="recurring"
        setupFee={{ amount: 99, waivedWithPrepay: true }}
        selectedFrequency={{ key: 'quarterly', monthly: 41.6667 }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /pay per application/i }));

    expect(onSelect).toHaveBeenCalledWith('pay_at_visit');
    expect(screen.getByText('WaveGuard Membership Setup')).toBeInTheDocument();
    expect(screen.getByText('Per application')).toBeInTheDocument();
    expect(screen.getByText('Invoice total')).toBeInTheDocument();
    expect(screen.getAllByText('$99.00').length).toBeGreaterThan(0);
    expect(screen.getByText('$125.00')).toBeInTheDocument();
    expect(screen.getByText('$224.00')).toBeInTheDocument();
  });

  it('previews up-front extra rows (rodent bait-station setup) inside the first invoice (codex #3591 r33 P1)', () => {
    const onSelect = vi.fn();
    render(
      <PaymentPreferenceButtons
        onSelect={onSelect}
        disabled={false}
        serviceMode="recurring"
        setupFee={null}
        extraInvoiceRows={[{ label: 'Bait Station Setup', amount: 99 }]}
        selectedFrequency={{ key: 'quarterly', monthly: 29.6667 }}
      />,
    );
    expect(screen.getByText('Bait Station Setup')).toBeInTheDocument();
    expect(screen.getByText('Per application')).toBeInTheDocument();
    expect(screen.getByText('Invoice total')).toBeInTheDocument();
    expect(screen.getAllByText('$99.00').length).toBeGreaterThan(0);
    expect(screen.getByText('$89.00')).toBeInTheDocument();
    expect(screen.getByText('$188.00')).toBeInTheDocument();
    expect(screen.getByText(/setup \+ first application invoice/i)).toBeInTheDocument();
    expect(screen.queryByText('WaveGuard Membership Setup')).not.toBeInTheDocument();
  });

  it('prefers discounted treatment rows for the per-application amount', () => {
    render(
      <PaymentPreferenceButtons
        onSelect={vi.fn()}
        disabled={false}
        serviceMode="recurring"
        setupFee={{ amount: 99, waivedWithPrepay: true }}
        selectedFrequency={{
          key: 'quarterly',
          monthly: 200,
          sameDayTreatmentTotal: 244,
          perServiceTreatments: [
            { service: 'pest_control', displayPrice: 75 },
            { service: 'lawn_care', displayPrice: 50 },
          ],
        }}
      />,
    );

    expect(screen.getByText('Per application')).toBeInTheDocument();
    expect(screen.getByText('$125.00')).toBeInTheDocument();
    expect(screen.queryByText('$600.00')).not.toBeInTheDocument();
    expect(screen.queryByText('$244.00')).not.toBeInTheDocument();
  });

  it('excludes monthly-billed service tiers from the immediate first-visit invoice', () => {
    render(
      <PaymentPreferenceButtons
        onSelect={vi.fn()}
        disabled={false}
        serviceMode="recurring"
        setupFee={{ amount: 99, waivedWithPrepay: true }}
        selectedFrequency={{
          key: 'standard_lawn',
          billingFrequencyKey: 'monthly',
          monthly: 72,
          sameDayTreatmentTotal: 144,
          perServiceTreatments: [
            { service: 'lawn_care', displayPrice: 144 },
          ],
        }}
      />,
    );

    expect(screen.getByText('WaveGuard Membership Setup')).toBeInTheDocument();
    expect(screen.queryByText('Per application')).not.toBeInTheDocument();
    expect(screen.getAllByText('$99.00').length).toBeGreaterThan(0);
    // Both breakdown boxes render, so the combined fineprint is gone
    // (owner 2026-08-30) — the boxes carry the when-money-moves copy.
    expect(screen.queryByText(/Choose pay per application/)).not.toBeInTheDocument();
    expect(screen.queryByText('$72.00')).not.toBeInTheDocument();
    expect(screen.queryByText('$144.00')).not.toBeInTheDocument();
  });

  it('invoice-mode + site-confirmation hold drops the immediate-invoice promise', () => {
    render(
      <PaymentPreferenceButtons
        onSelect={vi.fn()}
        disabled={false}
        serviceMode="recurring"
        setupFee={null}
        invoiceMode
        siteConfirmationHold
        selectedFrequency={{ key: 'monthly', monthly: 400 }}
      />,
    );

    expect(screen.getByRole('button', { name: 'Accept your estimate' })).toBeInTheDocument();
    expect(screen.queryByText(/send an invoice pay link due immediately/i)).not.toBeInTheDocument();
    expect(screen.getByText(/confirms the exact price on a quick site visit/i)).toBeInTheDocument();
  });

  it('non-invoice site-confirmation hold hides annual prepay (a ranged price is never prepaid)', () => {
    const onSelect = vi.fn();
    render(
      <PaymentPreferenceButtons
        onSelect={onSelect}
        disabled={false}
        serviceMode="recurring"
        setupFee={null}
        annualPrepayEligible
        siteConfirmationHold
        selectedFrequency={{ key: 'monthly', monthly: 400 }}
      />,
    );

    expect(screen.queryByRole('button', { name: /pay the 12-month plan in full/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /pay per application/i }));
    expect(onSelect).toHaveBeenCalledWith('pay_at_visit');
  });

  it('non-invoice site-confirmation hold suppresses the exact invoice preview + promises only the site confirmation', () => {
    render(
      <PaymentPreferenceButtons
        onSelect={vi.fn()}
        disabled={false}
        serviceMode="recurring"
        setupFee={{ amount: 99, waivedWithPrepay: true }}
        siteConfirmationHold
        selectedFrequency={{ key: 'monthly', monthly: 400 }}
      />,
    );

    // No exact "Per application $X" / invoice rows — they'd contradict the
    // "$X–$Y, confirmed on site" range, and the accept creates no invoice.
    expect(screen.queryByText('Per application')).not.toBeInTheDocument();
    expect(screen.queryByText('Invoice total')).not.toBeInTheDocument();
    expect(screen.queryByText(/after confirmation, we open the invoice/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/confirm your exact price on/i).length).toBeGreaterThan(0);
  });

  it('quantifies the credit-card surcharge at the one-time card-hold consent point', () => {
    render(
      <PaymentPreferenceButtons
        onSelect={vi.fn()}
        disabled={false}
        serviceMode="one_time"
        setupFee={null}
        cardHold={{ requiredForOneTime: true, noShowFeeAmount: 49, cancelWindowHours: 24 }}
      />,
    );

    // The rendered figure must be the server-authoritative rate
    // (CONFIGURED_COST_BPS in server/services/stripe-pricing.js), never a
    // hardcoded or separately maintained client number.
    const serverPct = String(stripePricing.CONFIGURED_COST_BPS / 100); // '2.9'
    expect(
      screen.getByText(new RegExp(`A credit card surcharge of up to ${serverPct.replace('.', '\\.')}% may apply`)),
    ).toBeInTheDocument();
    // The vague unquantified line is gone.
    expect(screen.queryByText(/small processing fee/i)).not.toBeInTheDocument();
  });

  describe('CARD_SURCHARGE_DISCLOSURE is server-authoritative (AGENTS.md surcharge P0)', () => {
    it('discloses exactly the rate computeChargeAmount charges (CONFIGURED_COST_BPS)', () => {
      const match = CARD_SURCHARGE_DISCLOSURE.match(/up to (\d+(?:\.\d+)?)%/);
      expect(match).not.toBeNull();
      expect(Number(match[1])).toBe(stripePricing.CONFIGURED_COST_BPS / 100);
      // Exactly one percentage figure — no second, conflicting rate in the copy.
      expect(CARD_SURCHARGE_DISCLOSURE.match(/\d+(?:\.\d+)?%/g)).toHaveLength(1);
    });

    it('renders the rate phrase verbatim from the versioned consent copy — not a second client mirror', () => {
      const consentPhrase = CLIENT_CARD_CONSENT_TEXT.match(/up to \d+(?:\.\d+)?%/);
      expect(consentPhrase).not.toBeNull(); // extraction the component relies on must work
      expect(CARD_SURCHARGE_DISCLOSURE).toContain(consentPhrase[0]);
    });

    it('client consent mirror is in sync with the server canonical (version + card text aligned)', () => {
      expect(CLIENT_CONSENT_VERSION).toBe(serverConsent.CONSENT_VERSION);
      expect(CLIENT_CARD_CONSENT_TEXT).toBe(serverConsent.CARD_CONSENT_TEXT);
    });
  });

  it('renders no combined fineprint when prepay is offered', () => {
    render(
      <PaymentPreferenceButtons
        onSelect={vi.fn()}
        disabled={false}
        serviceMode="recurring"
        setupFee={null}
        annualPrepayEligible
      />,
    );

    // With prepay offered the combined fineprint never renders (owner
    // 2026-08-30) — the a/an article helper it needed is gone with it.
    expect(screen.queryByText(/invoice after confirmation/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\ba invoice\b/)).not.toBeInTheDocument();
  });

  it('invoice-mode WITHOUT the hold keeps the standard "Accept + send invoice" CTA', () => {
    render(
      <PaymentPreferenceButtons
        onSelect={vi.fn()}
        disabled={false}
        serviceMode="recurring"
        setupFee={null}
        invoiceMode
        selectedFrequency={{ key: 'monthly', monthly: 400 }}
      />,
    );

    expect(screen.getByRole('button', { name: 'Accept + send invoice' })).toBeInTheDocument();
    expect(screen.getByText(/send an invoice pay link due immediately/i)).toBeInTheDocument();
  });

  // GATE_PAF_EXISTING_CUSTOMERS (PR-B): an existing customer on the
  // pay-after-first-visit card rail gets no invoice and no pay link at accept,
  // so the "we send the invoice after you approve" copy must not render.
  describe('pay-after-first-visit (existing customer on the card rail)', () => {
    const FREQ = { key: 'quarterly', billingFrequencyKey: 'quarterly', perVisit: 89, monthly: 30 };
    // The component reads ONE timing answer (lib/paymentTiming.js). The cases
    // below are written in the server's cohort terms (payAfterFirstVisit /
    // autopayPaused / autopayOff, and paymentTimingDenied for a refused
    // confirm); this builds the answer from them through the real resolver,
    // exactly as EstimateViewPage does.
    const renderButtons = (extra = {}) => {
      const {
        payAfterFirstVisit = false, autopayPaused = false, autopayOff = false, paymentTimingDenied = false, ...rest
      } = extra;
      const props = { onSelect: vi.fn(), disabled: false, serviceMode: 'recurring', setupFee: null, selectedFrequency: FREQ, ...rest };
      const paymentTiming = resolvePaymentTiming({
        policy: payAfterFirstVisit ? {
          afterVisitExisting: true,
          afterVisitConsent: props.prepayCardCapture === true && !autopayPaused && !autopayOff,
          ...(autopayPaused ? { afterVisitPaused: true } : {}),
          ...(autopayOff ? { afterVisitAutopayOff: true } : {}),
        } : {},
        serviceMode: props.serviceMode,
        invoiceShape: standardInvoiceShape({
          setupFee: props.setupFee, extraInvoiceRows: props.extraInvoiceRows, selectedFrequency: props.selectedFrequency,
        }),
        selectionKey: 'sel',
        timingAnswer: paymentTimingDenied ? { key: 'sel', deferred: false } : null,
      });
      return render(<PaymentPreferenceButtons {...props} paymentTiming={paymentTiming} />);
    };

    it('gate off (flag absent): today\'s invoice-after-approval copy, byte for byte', () => {
      renderButtons();
      expect(screen.getByText(/we will send the first application invoice after confirmation/)).toBeInTheDocument();
    });

    it('flag on + Auto Pay paused: card kept but never charged automatically — says a pay link follows the visit (once)', () => {
      renderButtons({ payAfterFirstVisit: true, autopayPaused: true });
      expect(screen.getByText(/Your Auto Pay is paused, so we send you a pay link after your first visit\./)).toBeInTheDocument();
      expect(screen.queryByText(/is billed for your first visit/)).not.toBeInTheDocument();
    });

    it('flag on but a SETUP-ONLY invoice (no first-application amount): keeps the existing disclosure (its pay link goes out at accept)', () => {
      renderButtons({
        payAfterFirstVisit: true,
        selectedFrequency: { key: 'monthly', billingFrequencyKey: 'monthly', monthly: 49 },
        extraInvoiceRows: [{ label: 'Rodent bait-station setup', amount: 99 }],
      });
      expect(screen.queryByText(/Nothing is charged today/)).not.toBeInTheDocument();
      expect(screen.getByText(/we will send the setup invoice after confirmation/)).toBeInTheDocument();
    });

    it('flag on: says nothing is charged today and the saved payment method is billed after the first visit (tender-neutral: a bank capture is not "a card")', () => {
      renderButtons({ payAfterFirstVisit: true });
      expect(screen.getByText(/Nothing is charged today — your saved payment method is billed for your first visit after it is completed\./)).toBeInTheDocument();
      expect(screen.queryByText(/we will send the/)).not.toBeInTheDocument();
    });

    it('flag on + Auto Pay explicitly off: neutral pay-link-after-the-visit wording, never an automatic charge', () => {
      renderButtons({ payAfterFirstVisit: true, autopayOff: true });
      expect(screen.getByText(/Nothing due today\. We send you a link to pay after your first visit\./)).toBeInTheDocument();
      expect(screen.queryByText(/is billed for your first visit/)).not.toBeInTheDocument();
    });

    // GitHub Codex #5481 r1 P1: the invoice box's "Auto Pay bills your card"
    // line rendered for every required-capture customer, including the paused
    // and Auto-Pay-off cohorts that are never auto-charged.
    describe('invoice-box "Auto Pay bills your card" line', () => {
      const AUTO_PAY_LINE = /Auto Pay bills your card after your first application/;

      it('renders for a customer who will be auto-charged (required capture, not held)', () => {
        renderButtons({ payAfterFirstVisit: true, prepayCardCapture: true });
        expect(screen.getByText(AUTO_PAY_LINE)).toBeInTheDocument();
      });

      it('is suppressed for a paused customer and says a pay link follows the visit instead (prepay-offered layout too, where the combined fineprint is hidden)', () => {
        renderButtons({ payAfterFirstVisit: true, autopayPaused: true, prepayCardCapture: true, annualPrepayEligible: true });
        expect(screen.queryByText(AUTO_PAY_LINE)).not.toBeInTheDocument();
        expect(screen.getByText(/Nothing due today\. Your Auto Pay is paused, so we send you a pay link after your first visit\./)).toBeInTheDocument();
      });

      it('is suppressed for an Auto-Pay-off customer, with neutral wording', () => {
        renderButtons({ payAfterFirstVisit: true, autopayOff: true, prepayCardCapture: true, annualPrepayEligible: true });
        expect(screen.queryByText(AUTO_PAY_LINE)).not.toBeInTheDocument();
        expect(screen.getByText(/Nothing due today\. We send you a link to pay after your first visit\./)).toBeInTheDocument();
      });

      it('a paused customer with a saved card (capture not required) still sees the pay-link sentence', () => {
        renderButtons({ payAfterFirstVisit: true, autopayPaused: true, prepayCardCapture: false, annualPrepayEligible: true });
        expect(screen.getByText(/Your Auto Pay is paused, so we send you a pay link after your first visit\./)).toBeInTheDocument();
      });

      it('a held customer with a setup-only invoice gets no "nothing due" claim (its pay link goes out at accept)', () => {
        renderButtons({
          payAfterFirstVisit: true,
          autopayPaused: true,
          prepayCardCapture: true,
          selectedFrequency: { key: 'monthly', billingFrequencyKey: 'monthly', monthly: 49 },
          extraInvoiceRows: [{ label: 'Rodent bait-station setup', amount: 99 }],
        });
        expect(screen.queryByText(AUTO_PAY_LINE)).not.toBeInTheDocument();
        expect(screen.queryByText(/Nothing due today/)).not.toBeInTheDocument();
      });

      it('r7: a saved-method customer on the after-visit rail is told when the saved method is charged', () => {
        renderButtons({ payAfterFirstVisit: true, prepayCardCapture: false, annualPrepayEligible: true });
        expect(screen.getByText(/Nothing due today — your saved payment method is charged after your first application\./)).toBeInTheDocument();
      });

      it('r6: after the server denied after-visit timing for this selection, the capture customer sees no deferred-payment claim', () => {
        const props = { payAfterFirstVisit: true, prepayCardCapture: true };
        const { unmount } = renderButtons(props);
        expect(screen.getByText(AUTO_PAY_LINE)).toBeInTheDocument();
        unmount();
        renderButtons({ ...props, paymentTimingDenied: true });
        expect(screen.queryByText(AUTO_PAY_LINE)).not.toBeInTheDocument();
        expect(screen.queryByText(/Nothing due today/)).not.toBeInTheDocument();
      });

      it('r5: a NOT-held capture customer with a setup-only invoice gets no Auto Pay line either (its pay link goes out at accept)', () => {
        renderButtons({
          payAfterFirstVisit: true,
          prepayCardCapture: true,
          selectedFrequency: { key: 'monthly', billingFrequencyKey: 'monthly', monthly: 49 },
          extraInvoiceRows: [{ label: 'Rodent bait-station setup', amount: 99 }],
        });
        expect(screen.queryByText(AUTO_PAY_LINE)).not.toBeInTheDocument();
        expect(screen.queryByText(/Nothing due today/)).not.toBeInTheDocument();
      });
    });
  });
});

// GitHub Codex #5481 r3: the shared invoice-shape predicate behind the
// after-visit card promise — a SETUP-ONLY invoice goes out unattached with a
// pay link at accept, so it is never the "billed after your first visit" promise.
describe('standardInvoiceShape (after-visit promise gate)', () => {
  const PER_VISIT = { key: 'quarterly', perVisit: 60 };
  it('setup + first application, or first application alone: deferrable (not setup-only)', () => {
    expect(standardInvoiceShape({ setupFee: { amount: 99 }, selectedFrequency: PER_VISIT }).setupOnly).toBe(false);
    expect(standardInvoiceShape({ selectedFrequency: PER_VISIT }).setupOnly).toBe(false);
  });
  it('a setup fee (or rodent setup row) with no first-application amount is setup-only', () => {
    expect(standardInvoiceShape({ setupFee: { amount: 99 }, selectedFrequency: { key: 'monthly', billingFrequencyKey: 'monthly' } }))
      .toEqual({ hasSetupInvoice: true, hasFirstVisitInvoice: false, setupOnly: true });
    expect(standardInvoiceShape({ extraInvoiceRows: [{ label: 'Bait Station Setup', amount: 99 }], selectedFrequency: {} }).setupOnly).toBe(true);
  });
  it('no invoice rows at all is not setup-only (nothing is collected at accept)', () => {
    expect(standardInvoiceShape({ selectedFrequency: {} }).setupOnly).toBe(false);
    expect(standardInvoiceShape().setupOnly).toBe(false);
  });
});
