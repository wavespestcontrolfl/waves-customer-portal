// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PromoCodeSection from './PromoCodeSection';

afterEach(() => cleanup());

const open = { canEnter: true, applied: null };
const applied = (credited = false) => ({ canEnter: false, applied: { code: 'SAVE25', creditAmount: 25, credited } });

const typeAndApply = (value) => {
  fireEvent.change(screen.getByLabelText('Promo code'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
};

describe('PromoCodeSection', () => {
  it('renders nothing without a served block, or when the block offers neither a field nor a code', () => {
    const { container, rerender } = render(<PromoCodeSection promoCode={null} submitCode={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<PromoCodeSection promoCode={{ canEnter: false, applied: null }} submitCode={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('an accepted code replaces the field with the server amount, worded as a credit still to come', async () => {
    const submitCode = vi.fn(async () => ({ ok: true, promoCode: applied() }));
    render(<PromoCodeSection promoCode={open} submitCode={submitCode} />);
    typeAndApply('  save25 ');
    await waitFor(() => expect(screen.getByText('Promo code SAVE25')).toBeInTheDocument());
    expect(submitCode).toHaveBeenCalledWith('save25');
    expect(screen.getByText(/add a \$25(\.00)? credit to your account when you accept this estimate/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  });

  it('after acceptance the note says the credit was added', () => {
    render(<PromoCodeSection promoCode={applied(true)} submitCode={vi.fn()} />);
    expect(screen.getByText(/\$25(\.00)? credit was added to your account/)).toBeInTheDocument();
  });

  it('a refused code keeps the field and says so; a failed request asks for a retry', async () => {
    const submitCode = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'invalid_code' })
      .mockRejectedValueOnce(new Error('offline'));
    render(<PromoCodeSection promoCode={open} submitCode={submitCode} />);
    typeAndApply('NOPE');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('That code isn’t valid for this estimate.'));
    typeAndApply('NOPE2');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Please try again.'));
    expect(screen.getByLabelText('Promo code')).toBeInTheDocument();
  });

  it('a staff preview never submits', () => {
    const submitCode = vi.fn();
    render(<PromoCodeSection promoCode={open} submitCode={submitCode} staffView />);
    expect(screen.getByLabelText('Promo code')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText('Promo code').closest('form'));
    expect(submitCode).not.toHaveBeenCalled();
  });
});
