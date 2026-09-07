// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import CompletionPricingCard from './CompletionPricingCard';
afterEach(cleanup);
const service = { id: 'job-1', serviceType: 'Lawn Care', estimatedPrice: 100 };
const data = { serviceId: service.id, witness: 'a'.repeat(64), estimate: { reference: 'Synthetic accepted estimate', pdfUrl: '/synthetic.pdf' },
  currentAmount: 100, proposedAmount: 85, canApply: true, lines: [{ jobLineId: 'primary', status: 'matched', serviceName: 'Lawn Care',
    scheduledAmount: 100, quote: { base: 100, amount: 100, unit: 'application', discounts: [], breakdownAvailable: true },
    proposal: { amount: 85, discounts: [{ name: 'WaveGuard Gold', percent: 15, dollars: 15 }] } }] };
it('reviews only the selected job and toggles application without writing money', async () => {
  const fetch = vi.fn().mockResolvedValue({ completionPricing: data }); const review = vi.fn();
  render(<CompletionPricingCard service={service} adminFetch={fetch} onReviewChange={review} />);
  await screen.findByText('WaveGuard Gold · 15%');
  expect(fetch).toHaveBeenCalledWith('/admin/schedule/job-1/estimate-source?completion=1');
  await waitFor(() => expect(review).toHaveBeenLastCalledWith(expect.objectContaining({ amount: 85, review: { witness: data.witness, applyDiscounts: true } })));
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() => expect(review).toHaveBeenLastCalledWith(expect.objectContaining({ amount: 100, apply: false })));
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('source viewing preserves the surrounding draft and restores keyboard focus', async () => {
  render(<><textarea aria-label="Completion notes" defaultValue="Synthetic draft retained" /><CompletionPricingCard service={service} adminFetch={vi.fn().mockResolvedValue({ completionPricing: data })} onReviewChange={vi.fn()} /></>);
  const view = await screen.findByRole('button', { name: 'View estimate' });
  fireEvent.click(view);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox')).toHaveValue('Synthetic draft retained');
  expect(view).toHaveFocus();
});
it('clears a previous job and ignores a late response', async () => {
  let resolveOld; const fetch = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
    .mockResolvedValueOnce({ completionPricing: null }); const review = vi.fn();
  const { rerender } = render(<CompletionPricingCard service={service} adminFetch={fetch} onReviewChange={review} />);
  rerender(<CompletionPricingCard service={{ ...service, id: 'job-2' }} adminFetch={fetch} onReviewChange={review} />);
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  resolveOld({ completionPricing: data });
  await waitFor(() => expect(screen.queryByText('WaveGuard Gold · 15%')).not.toBeInTheDocument());
  expect(review).toHaveBeenLastCalledWith({ serviceId: "job-2", ready: true });
});
it('keeps pricing failures explicit and allows a read retry', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ completionPricing: data });
  render(<CompletionPricingCard service={service} adminFetch={fetch} onReviewChange={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry pricing' }));
  expect(await screen.findByText('WaveGuard Gold · 15%')).toBeInTheDocument();
});

it('shows an accepted discount once when the same net is already stamped on the job', async () => {
  const saved = { ...data, canApply: false, currentAmount: 85, proposedAmount: null,
    lines: [{ ...data.lines[0], proposal: null, scheduledAmount: 85, scheduledBase: 100,
      scheduledDiscount: { name: 'Accepted estimate discounts', dollars: 15 },
      quote: { base: 100, amount: 85, unit: 'application', breakdownAvailable: true,
        discounts: [{ name: 'WaveGuard Gold', percent: 15, dollars: 15 }] } }] };
  render(<CompletionPricingCard service={service} adminFetch={vi.fn().mockResolvedValue({ completionPricing: saved })} onReviewChange={vi.fn()} />);
  expect(await screen.findByText('WaveGuard Gold · 15%')).toBeInTheDocument();
  expect(screen.getAllByText('−$15.00')).toHaveLength(1);
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
});

it('remains unready during loading and failure, then becomes ready after retry', async () => {
  let rejectRead;
  const fetch = vi.fn().mockImplementationOnce(() => new Promise((resolve, reject) => { rejectRead = reject; }))
    .mockResolvedValueOnce({ completionPricing: data });
  const review = vi.fn();
  render(<CompletionPricingCard service={service} adminFetch={fetch} onReviewChange={review} />);
  expect(review).toHaveBeenLastCalledWith(null);
  rejectRead(new Error('offline'));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry pricing' }));
  expect(review).toHaveBeenLastCalledWith(null);
  await waitFor(() => expect(review).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true, review: { witness: data.witness, applyDiscounts: true } })));
});
