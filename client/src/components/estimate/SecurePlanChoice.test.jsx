// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SecurePlanChoice from './SecurePlanChoice';
import { CARD_SURCHARGE_DISCLOSURE } from './PaymentPreferenceButtons';

afterEach(() => cleanup());

// Every number below comes from the (mock) server payload — the component
// must render whatever the server derives, never a client-side constant.
// A $120 fee and 7% would be wrong numbers in prod, but the component must
// faithfully render them: that's the proof nothing is hardcoded.
const FEE_WAIVER_CONTEXT = {
  mode: 'recurring',
  planClass: 'fee_waiver',
  perVisit: 135,
  visitsPerYear: 4,
  annualBase: 540,
  prepay: { total: 540, discount: 0, ratePctLabel: '' },
  setupFee: { amount: 120, waivedWithPrepay: true },
  selected: null,
};
const DISCOUNT_CONTEXT = {
  mode: 'recurring',
  planClass: 'discount',
  perVisit: 89,
  visitsPerYear: 6,
  annualBase: 534,
  prepay: { total: 497.62, discount: 36.38, ratePctLabel: '7%' },
  setupFee: null,
  selected: null,
};

describe('SecurePlanChoice', () => {
  it('renders nothing without a recurring planContext', () => {
    const { container: none } = render(<SecurePlanChoice planContext={null} onSelect={() => {}} />);
    expect(none).toBeEmptyDOMElement();
    const { container: oneTime } = render(
      <SecurePlanChoice planContext={{ mode: 'one_time', perVisit: 189 }} onSelect={() => {}} />,
    );
    expect(oneTime).toBeEmptyDOMElement();
  });

  it('renders ONLY the per-application option (with its setup disclosure) when the server suppresses prepay', () => {
    const onSelect = vi.fn();
    render(<SecurePlanChoice planContext={{ ...FEE_WAIVER_CONTEXT, planClass: 'discount', prepay: null, setupFee: { amount: 99, waivedWithPrepay: false } }} onSelect={onSelect} />);
    expect(screen.getByText('Pay per application')).toBeInTheDocument();
    expect(screen.getByText('$99.00 setup fee applies')).toBeInTheDocument();
    expect(screen.queryByText(/Prepay the year/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Pay per application'));
    expect(onSelect).toHaveBeenCalledWith('per_application');
  });

  it('fee-waiver mix: setup fee amount and waiver copy come from the payload (no hardcoded $99)', () => {
    render(<SecurePlanChoice planContext={FEE_WAIVER_CONTEXT} selected={null} onSelect={() => {}} />);
    expect(screen.getByText('Pay per application')).toBeInTheDocument();
    expect(screen.getByText('$120.00 setup fee applies')).toBeInTheDocument();
    expect(screen.getByText('$120.00 setup fee waived')).toBeInTheDocument();
    // Waiver class shows no strikethrough/percent framing.
    expect(screen.getByText('Prepay the year')).toBeInTheDocument();
    expect(screen.queryByText(/save \d/i)).not.toBeInTheDocument();
  });

  it('unwaived setup (non-member rodent bait): prepay copy says the fee is INCLUDED, never waived (codex #3591 r9 P1)', () => {
    render(<SecurePlanChoice planContext={{
      ...DISCOUNT_CONTEXT,
      prepay: { total: 437.2, coverageTotal: 338.2, setupAmount: 99, discount: 17.8, ratePctLabel: '5%' },
      annualBase: 356,
      setupFee: { amount: 99, waivedWithPrepay: false },
    }} selected={null} onSelect={() => {}} />);
    expect(screen.getByText(/Plus a one-time \$99\.00 setup fee on your first visit's invoice/)).toBeInTheDocument();
    expect(screen.getByText(/Includes the one-time \$99\.00 setup fee\. Pay once today\./)).toBeInTheDocument();
    expect(screen.queryByText(/setup fee is waived/)).toBeNull();
    expect(screen.queryByText(/setup fee waived/)).toBeNull();
    expect(screen.getByText('You save $17.80')).toBeInTheDocument();
    expect(screen.getByText('$437.20')).toBeInTheDocument();
    // The struck pay-per-application-year comparison includes the same
    // unwaived setup (356 + 99), never a figure below the offer (codex #3591 r25 P2).
    expect(screen.getByText('$455.00')).toBeInTheDocument();
    expect(screen.queryByText('$356.00')).toBeNull();
  });

  it('discount mix: percent label, strikethrough base, and savings badge from the payload', () => {
    render(<SecurePlanChoice planContext={DISCOUNT_CONTEXT} selected={null} onSelect={() => {}} />);
    expect(screen.getByText('Prepay the year — save 7%')).toBeInTheDocument();
    expect(screen.getByText('$534.00')).toBeInTheDocument(); // strikethrough base
    expect(screen.getByText('$497.62')).toBeInTheDocument();
    expect(screen.getByText('You save $36.38')).toBeInTheDocument();
    expect(screen.queryByText(/setup fee/i)).not.toBeInTheDocument();
  });

  it('clicks report the plan key; selection state reflects the selected prop', () => {
    const onSelect = vi.fn();
    render(<SecurePlanChoice planContext={FEE_WAIVER_CONTEXT} selected="per_application" onSelect={onSelect} />);
    const perApp = screen.getByRole('button', { name: /pay per application/i });
    const prepay = screen.getByRole('button', { name: /prepay the year/i });
    expect(perApp).toHaveAttribute('aria-pressed', 'true');
    expect(prepay).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(prepay);
    expect(onSelect).toHaveBeenCalledWith('prepay_annual');
    fireEvent.click(perApp);
    expect(onSelect).toHaveBeenCalledWith('per_application');
  });

  it('disabled blocks selection', () => {
    const onSelect = vi.fn();
    render(<SecurePlanChoice planContext={DISCOUNT_CONTEXT} selected={null} onSelect={onSelect} disabled />);
    fireEvent.click(screen.getByRole('button', { name: /prepay the year/i }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('renders the canonical surcharge disclosure verbatim (single consent-derived source)', () => {
    render(<SecurePlanChoice planContext={FEE_WAIVER_CONTEXT} selected={null} onSelect={() => {}} />);
    expect(screen.getByText(CARD_SURCHARGE_DISCLOSURE)).toBeInTheDocument();
  });
});
