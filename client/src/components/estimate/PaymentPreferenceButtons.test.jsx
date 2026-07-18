// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PaymentPreferenceButtons, { CARD_SURCHARGE_DISCLOSURE } from './PaymentPreferenceButtons';
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

    fireEvent.click(screen.getByRole('button', { name: /pay the 12-month plan in full/i }));

    expect(screen.getByText('12-month invoice opens after confirmation.')).toBeInTheDocument();
    expect(onSelect).toHaveBeenCalledWith('prepay_annual');
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
    expect(screen.getByText('First service visit')).toBeInTheDocument();
    expect(screen.getByText('Invoice total')).toBeInTheDocument();
    expect(screen.getAllByText('$99.00').length).toBeGreaterThan(0);
    expect(screen.getByText('$125.00')).toBeInTheDocument();
    expect(screen.getByText('$224.00')).toBeInTheDocument();
  });

  it('prefers discounted treatment rows for the first service visit amount', () => {
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

    expect(screen.getByText('First service visit')).toBeInTheDocument();
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
    expect(screen.queryByText('First service visit')).not.toBeInTheDocument();
    expect(screen.getAllByText('$99.00').length).toBeGreaterThan(0);
    expect(screen.getByText('Choose pay per application with a setup invoice after confirmation, or annual prepay to approve the 12-month plan up front with setup included.')).toBeInTheDocument();
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

    // No exact "First service visit $X" / invoice rows — they'd contradict the
    // "$X–$Y, confirmed on site" range, and the accept creates no invoice.
    expect(screen.queryByText('First service visit')).not.toBeInTheDocument();
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

  it('uses "an" with the bare invoice fallback label (never "a invoice")', () => {
    render(
      <PaymentPreferenceButtons
        onSelect={vi.fn()}
        disabled={false}
        serviceMode="recurring"
        setupFee={null}
        annualPrepayEligible
      />,
    );

    // No setup fee and no first-visit amount → the fallback label is bare
    // 'invoice', which takes 'an'.
    expect(screen.getByText(/with an invoice after confirmation/)).toBeInTheDocument();
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
});
