// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PaymentPreferenceButtons from './PaymentPreferenceButtons';

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

    fireEvent.click(screen.getByRole('button', { name: /pay the year upfront/i }));

    expect(screen.getByText('12-month invoice after approval')).toBeInTheDocument();
    expect(onSelect).toHaveBeenCalledWith('prepay_annual');
  });
});
