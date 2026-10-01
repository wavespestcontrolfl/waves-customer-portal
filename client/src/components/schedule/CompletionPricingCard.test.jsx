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

// Codex round-6 P2: a same-day combined per-application trip whose sibling
// lookup couldn't confirm coverage ('sibling_needs_review' — billing-lane.js
// siblingCoverageForSchedule) used to fall through to
// `data.currentAmount`/`data.proposedAmount` here — a real positive
// acceptance-fee charge — since neither `covered` nor `noCharge` recognized
// the kind. The server's own mint resolver refuses to charge this visit
// either way, so this card must show the review state and read as $0, not
// offer a chargeable fee.
it('never falls back to a positive fee charge for a sibling-needs-review prediction — shows review copy and $0', async () => {
  const reviewSvc = { id: 'job-review', serviceType: 'Every 6 Weeks Lawn Care', estimatedPrice: null,
    billingLane: { prediction: { kind: 'sibling_needs_review', amount: null } } };
  const reviewData = { ...data, serviceId: reviewSvc.id, currentAmount: 97.2, proposedAmount: 97.2, canApply: false, lines: [] };
  render(<CompletionPricingCard service={reviewSvc} adminFetch={vi.fn().mockResolvedValue({ completionPricing: reviewData })} onReviewChange={vi.fn()} />);
  expect(await screen.findByText('Needs review before charging')).toBeInTheDocument();
  expect(screen.getByText('Combined-trip invoice needs review — resolve on Customer 360')).toBeInTheDocument();
  expect(screen.getByText('$0.00')).toBeInTheDocument();
  expect(screen.queryByText('$97.20')).not.toBeInTheDocument();
});

it('reads a covered_sibling_invoice prediction as covered — no charge', async () => {
  const coveredSvc = { id: 'job-covered', serviceType: 'Every 6 Weeks Lawn Care', estimatedPrice: null,
    billingLane: { prediction: { kind: 'covered_sibling_invoice', amount: null } } };
  const coveredData = { ...data, serviceId: coveredSvc.id, currentAmount: 97.2, proposedAmount: 97.2, canApply: false, lines: [] };
  render(<CompletionPricingCard service={coveredSvc} adminFetch={vi.fn().mockResolvedValue({ completionPricing: coveredData })} onReviewChange={vi.fn()} />);
  expect(await screen.findByText('Covered application')).toBeInTheDocument();
  expect(screen.getByText('Covered by sibling invoice — nothing to collect')).toBeInTheDocument();
  expect(screen.getByText('$0.00')).toBeInTheDocument();
});

// Codex round-7 P1: a covered_sibling_invoice prediction whose sibling
// invoice is still collectible (draft/sent/overdue/…) previously read
// exactly like a settled one — "Covered application" / "nothing to
// collect" — even though the combined trip invoice still has a real
// balance due elsewhere. This never mints a charge HERE either (amount
// stays $0.00 — the completion never bills this visit a second time), but
// the label/note must flag it, not call it "covered".
it('reads a still-collectible covered_sibling_invoice prediction as flagged, not covered — still $0 here', async () => {
  const collectibleSvc = { id: 'job-collectible', serviceType: 'Every 6 Weeks Lawn Care', estimatedPrice: null,
    billingLane: {
      prediction: {
        kind: 'covered_sibling_invoice', amount: null, invoiceId: 'inv-1', invoiceNumber: 'WPC-TEST-0001',
      },
      // The server's own canonical verdict (billing-lane.js
      // siblingCoverageForSchedule) — this card renders THAT, never a raw
      // invoiceStatus.
      siblingCoverage: { state: 'collect_on_combined_invoice', invoiceId: 'inv-1', invoiceNumber: 'WPC-TEST-0001', amountDue: 153.6, reason: null },
    } };
  const collectibleData = { ...data, serviceId: collectibleSvc.id, currentAmount: 97.2, proposedAmount: 97.2, canApply: false, lines: [] };
  render(<CompletionPricingCard service={collectibleSvc} adminFetch={vi.fn().mockResolvedValue({ completionPricing: collectibleData })} onReviewChange={vi.fn()} />);
  expect(await screen.findByText('Combined trip invoice due')).toBeInTheDocument();
  expect(screen.queryByText('Covered application')).not.toBeInTheDocument();
  expect(screen.getByText('Collect on invoice WPC-TEST-0001 ($153.60 due)')).toBeInTheDocument();
  expect(screen.getByText('$0.00')).toBeInTheDocument();
  expect(screen.queryByText('$97.20')).not.toBeInTheDocument();
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
