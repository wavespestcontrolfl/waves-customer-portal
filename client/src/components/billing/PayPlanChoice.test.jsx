// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PayPlanChoice from './PayPlanChoice';

afterEach(() => cleanup());

// Quarterly pest control: four $128 applications and a $99 setup fee, or $512 for
// the year with the fee waived.
const offer = {
  selected: false,
  serviceType: 'Quarterly Pest Control',
  visitsPerYear: 4,
  perApplication: { perVisit: 128, setupFee: 99, yearTotal: 611 },
  prepay: { total: 512, setupFeeWaived: 99, discount: 0, discountLabel: '', savings: 99 },
};

describe('PayPlanChoice', () => {
  it('renders nothing without a served block', () => {
    const { container } = render(<PayPlanChoice planChoice={undefined} choosePrepay={vi.fn()} onChosen={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows both plans with the server’s figures, and a pick goes to the prepay invoice’s own link', async () => {
    const choosePrepay = vi.fn(async () => ({ ok: true, payUrl: 'https://portal.example/pay/prepay' }));
    const onChosen = vi.fn();
    render(<PayPlanChoice planChoice={offer} choosePrepay={choosePrepay} onChosen={onChosen} />);
    expect(screen.getByText(/\$128\.00 per application, 4 applications a year, plus the one-time \$99\.00 setup fee: \$611\.00 for the year/)).toBeInTheDocument();
    expect(screen.getByText(/\$512\.00 today covers all 4 applications, including the one on this invoice\. The \$99\.00 setup fee is waived\./)).toBeInTheDocument();
    // Paying per application is paying this invoice: the one button is the prepay pick.
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Prepay the year for $512.00' }));
    await waitFor(() => expect(onChosen).toHaveBeenCalledWith('https://portal.example/pay/prepay'));
    expect(choosePrepay).toHaveBeenCalledTimes(1);
  });

  it('a discounted program states the saving instead of a waived fee', () => {
    render(<PayPlanChoice
      planChoice={{ ...offer, perApplication: { perVisit: 100, setupFee: 0, yearTotal: 900 }, visitsPerYear: 9,
        prepay: { total: 855, setupFeeWaived: 0, discount: 45, discountLabel: '5%', savings: 45 } }}
      choosePrepay={vi.fn()}
      onChosen={vi.fn()}
    />);
    expect(screen.getByText(/You save \$45\.00 \(5% off\)\./)).toBeInTheDocument();
    expect(screen.queryByText(/setup fee/)).not.toBeInTheDocument();
    // AGENTS.md: customer price units read "per application", never "per visit".
    expect(screen.queryByText(/visit/)).not.toBeInTheDocument();
  });

  it('a refused or failed pick stays on the page, says so and can be retried', async () => {
    const choosePrepay = vi.fn().mockResolvedValueOnce({ ok: false }).mockRejectedValueOnce(new Error('offline'));
    const onChosen = vi.fn();
    render(<PayPlanChoice planChoice={offer} choosePrepay={choosePrepay} onChosen={onChosen} />);
    const pick = () => fireEvent.click(screen.getByRole('button', { name: 'Prepay the year for $512.00' }));
    pick();
    expect(await screen.findByRole('alert')).toHaveTextContent('pay this invoice instead');
    pick();
    await waitFor(() => expect(choosePrepay).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(onChosen).not.toHaveBeenCalled();
  });

  it('after a pick the block points at the prepay invoice and says this invoice can still be paid', async () => {
    const choosePrepay = vi.fn(async () => ({ ok: true, payUrl: 'https://portal.example/pay/prepay' }));
    const onChosen = vi.fn();
    render(<PayPlanChoice planChoice={{ selected: true, prepay: { total: 512 } }} choosePrepay={choosePrepay} onChosen={onChosen} />);
    expect(screen.getByText(/Your annual prepay invoice is \$512\.00\. Paying it closes this invoice\./)).toBeInTheDocument();
    expect(screen.getByText(/pay this invoice instead/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go to the annual prepay invoice' }));
    await waitFor(() => expect(onChosen).toHaveBeenCalledWith('https://portal.example/pay/prepay'));
  });
});
