// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PaymentPreferenceButtons from './PaymentPreferenceButtons';

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
    expect(screen.getAllByText('$99').length).toBeGreaterThan(0);
    expect(screen.getByText('$125')).toBeInTheDocument();
    expect(screen.getByText('$224')).toBeInTheDocument();
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
    expect(screen.getByText('$125')).toBeInTheDocument();
    expect(screen.queryByText('$600')).not.toBeInTheDocument();
    expect(screen.queryByText('$244')).not.toBeInTheDocument();
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
    expect(screen.getAllByText('$99').length).toBeGreaterThan(0);
    expect(screen.getByText('Choose pay per application with a setup invoice after confirmation, or annual prepay to approve the 12-month plan up front with setup included.')).toBeInTheDocument();
    expect(screen.queryByText('$72')).not.toBeInTheDocument();
    expect(screen.queryByText('$144')).not.toBeInTheDocument();
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
