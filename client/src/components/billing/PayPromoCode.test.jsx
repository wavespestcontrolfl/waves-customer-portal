// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PayPromoCode from './PayPromoCode';

afterEach(() => cleanup());

const open = { canEnter: true, applied: null };
const typeAndApply = (value) => {
  fireEvent.change(screen.getByLabelText('Have a promo code?'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
};

describe('PayPromoCode', () => {
  it('renders nothing without a served block, or when the block offers neither a field nor a code', () => {
    const { container, rerender } = render(<PayPromoCode promoCode={undefined} submitCode={vi.fn()} onSaved={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<PayPromoCode promoCode={{ canEnter: false, applied: null }} submitCode={vi.fn()} onSaved={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('a saved code hands over to the page (which reloads) and shows no amount of its own', async () => {
    const submitCode = vi.fn(async () => ({ ok: true }));
    const onSaved = vi.fn();
    render(<PayPromoCode promoCode={open} submitCode={submitCode} onSaved={onSaved} />);
    typeAndApply('  save25 ');
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(submitCode).toHaveBeenCalledWith('save25');
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it('a refused code keeps the field and says so; a failed request asks for a retry; neither reloads', async () => {
    const submitCode = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'invalid_code' })
      .mockRejectedValueOnce(new Error('offline'));
    const onSaved = vi.fn();
    render(<PayPromoCode promoCode={open} submitCode={submitCode} onSaved={onSaved} />);
    typeAndApply('NOPE');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('That code isn’t valid for this invoice.'));
    typeAndApply('NOPE2');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Please try again.'));
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
  });

  it('a code already on the invoice shows the server amount and no field', () => {
    render(<PayPromoCode promoCode={{ canEnter: false, applied: { code: 'SAVE25', creditAmount: 25 } }} submitCode={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByText('Promo code SAVE25')).toBeInTheDocument();
    expect(screen.getByText(/\$25(\.00)? credit toward this invoice\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  });
});
