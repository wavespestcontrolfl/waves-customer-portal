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

    expect(screen.getByText('12-month invoice after approval.')).toBeInTheDocument();
    expect(onSelect).toHaveBeenCalledWith('prepay_annual');
  });

  it('shows setup invoice total and first visit amount for pay-after-visit setup', () => {
    render(
      <PaymentPreferenceButtons
        onSelect={vi.fn()}
        disabled={false}
        serviceMode="recurring"
        setupFee={{ amount: 99, waivedWithPrepay: true }}
        selectedFrequency={{ key: 'quarterly', monthly: 41.6667 }}
      />,
    );

    expect(screen.getByRole('button', { name: /pay after each visit/i })).toBeInTheDocument();
    expect(screen.getByText('WaveGuard Membership Setup')).toBeInTheDocument();
    expect(screen.getByText('First service visit')).toBeInTheDocument();
    expect(screen.getByText('Invoice total')).toBeInTheDocument();
    expect(screen.getAllByText('$99').length).toBeGreaterThan(0);
    expect(screen.getByText('$125')).toBeInTheDocument();
  });

  it('uses same-day treatment total for the first service visit amount', () => {
    render(
      <PaymentPreferenceButtons
        onSelect={vi.fn()}
        disabled={false}
        serviceMode="recurring"
        setupFee={{ amount: 99, waivedWithPrepay: true }}
        selectedFrequency={{
          key: 'quarterly',
          monthly: 200,
          sameDayTreatmentTotal: 125,
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
  });
});
