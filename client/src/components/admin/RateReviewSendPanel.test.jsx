// @vitest-environment jsdom
// Rate review → Send letters: the send preview (counts, per-customer lines,
// suppressions with reasons), the cost-block gate, and Send posting the
// preview's digest after a confirm step. Hidden while the gate is off (404).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockAdminFetch = vi.fn();
vi.mock('../../utils/admin-fetch', () => ({ adminFetch: (...a) => mockAdminFetch(...a) }));

import RateReviewSendPanel from './RateReviewSendPanel';

const DIGEST = 'b'.repeat(64);
const preview = (over = {}) => ({
  ok: true, batchKey: '2026-12', digest: DIGEST, costBlockReady: true, unscheduled: 0,
  counts: { letters: 1, lines: 1, email: 1, sms: 1, suppressedCustomers: 1, suppressedLines: 1, alreadySent: 0 },
  customers: [
    { customerId: 'c1', name: 'Testcust One', channels: { email: true, sms: true }, reason: null, reasonLabel: null, lines: [{ noticeId: 'n1', service: 'Pest control · 100 Example Way', now: '$117 per application', new: '$121 per application (up $4)', effectiveDate: '2026-12-10' }], suppressedLines: [], alreadySent: 0 },
    { customerId: 'c2', name: 'Testcust Two', channels: { email: false, sms: false }, reason: 'no_contact', reasonLabel: 'No email or phone on file', lines: [{ noticeId: 'n2', service: 'Lawn care', now: '$61 per application', new: '$64 per application (up $3)', effectiveDate: '2026-12-20' }], suppressedLines: [], alreadySent: 0 },
  ],
  ...over,
});

afterEach(() => { cleanup(); mockAdminFetch.mockReset(); });

describe('RateReviewSendPanel', () => {
  it('lists who gets a letter and why others are held', async () => {
    mockAdminFetch.mockResolvedValue(preview());
    render(<RateReviewSendPanel batchKey="2026-12" />);
    expect(await screen.findByText('Testcust One')).toBeInTheDocument();
    expect(screen.getByText(/\$117 per application → \$121 per application \(up \$4\)/)).toBeInTheDocument();
    expect(screen.getByText('No email or phone on file')).toBeInTheDocument();
    expect(screen.getByText('Email + Text')).toBeInTheDocument();
    expect(mockAdminFetch).toHaveBeenCalledWith('/admin/rate-review/batches/2026-12/send-preview');
  });

  it('Send confirms, then posts the preview digest', async () => {
    mockAdminFetch.mockImplementation(async (path, opts) => (opts?.method === 'POST' ? { ok: true, sent: 1, emailed: 1, texted: 1, failed: 0 } : preview()));
    render(<RateReviewSendPanel batchKey="2026-12" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send 1 letter' }));
    const dialogSend = (await screen.findAllByRole('button', { name: 'Send 1 letter' })).at(-1);
    // true for all three billing lanes: per application, monthly dues, prepaid renewal
    expect(screen.getByRole('dialog').textContent).toMatch(/the first application, the first monthly charge or the prepaid renewal on or after that date/);
    expect(screen.getByRole('dialog').textContent).toMatch(/at least 30 days from today \(32 for a prepaid renewal\)/);
    fireEvent.click(dialogSend);
    await waitFor(() => expect(mockAdminFetch).toHaveBeenCalledWith('/admin/rate-review/batches/2026-12/send', { method: 'POST', body: JSON.stringify({ expectedDigest: DIGEST }) }));
    expect(await screen.findByText('1 letter sent (1 emailed, 1 texted).')).toBeInTheDocument();
  });

  it('no cost block: Send is disabled and says why', async () => {
    mockAdminFetch.mockResolvedValue(preview({ costBlockReady: false }));
    render(<RateReviewSendPanel batchKey="2026-12" />);
    expect(await screen.findByText(/Write the cost block in Settings first/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send 1 letter' })).toBeDisabled();
  });

  it('gate off (404): renders nothing', async () => {
    mockAdminFetch.mockRejectedValue(Object.assign(new Error('Rate review is not enabled'), { status: 404 }));
    const { container } = render(<RateReviewSendPanel batchKey="2026-12" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('page busy disables Send; its own send reports busy, then tells the page the batch changed', async () => {
    mockAdminFetch.mockImplementation(async (path, opts) => (opts?.method === 'POST' ? { ok: true, sent: 1, emailed: 1, texted: 1, failed: 0 } : preview()));
    const { rerender } = render(<RateReviewSendPanel batchKey="2026-12" disabled />);
    expect(await screen.findByRole('button', { name: 'Send 1 letter' })).toBeDisabled();
    const onBusyChange = vi.fn();
    const onChanged = vi.fn();
    rerender(<RateReviewSendPanel batchKey="2026-12" onBusyChange={onBusyChange} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send 1 letter' }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Send 1 letter' })).at(-1));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(onBusyChange).toHaveBeenCalledWith(true);
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it('refreshKey change reads the send preview again', async () => {
    mockAdminFetch.mockResolvedValue(preview({ unscheduled: 0 }));
    const { rerender } = render(<RateReviewSendPanel batchKey="2026-12" refreshKey={0} />);
    await screen.findByText('Testcust One');
    expect(screen.queryByRole('button', { name: /Prepare/ })).not.toBeInTheDocument();
    mockAdminFetch.mockResolvedValue(preview({ unscheduled: 2 }));
    rerender(<RateReviewSendPanel batchKey="2026-12" refreshKey={1} />);
    expect(await screen.findByRole('button', { name: 'Prepare 2 notices' })).toBeInTheDocument();
    expect(mockAdminFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['stoppedByGate', { stoppedByGate: 2 }, /2 stopped because the rate review was switched off mid-send/],
    ['inFlight', { inFlight: 1 }, /1 not sent: held or changed since the preview/],
    ['failed', { failed: 1 }, /1 failed/],
    ['uncertain', { uncertain: 1 }, /1 held: outcome uncertain/],
    ['unreachable', { unreachable: 1 }, /1 unreachable/],
  ])('an incomplete send (%s) is never reported as a success', async (_k, counters, text) => {
    mockAdminFetch.mockImplementation(async (path, opts) => (opts?.method === 'POST' ? { ok: false, sent: 1, emailed: 1, texted: 0, ...counters } : preview()));
    render(<RateReviewSendPanel batchKey="2026-12" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send 1 letter' }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Send 1 letter' })).at(-1));
    const msg = await screen.findByText(text);
    expect(msg.closest('[role="alert"]') || msg).toBeTruthy();
    expect(msg.textContent).toMatch(/1 letter sent/); // what DID go out is still stated
    expect(screen.queryByText(/^1 letter sent \(1 emailed, 0 texted\)\.$/)).not.toBeInTheDocument();
  });

  it('a complete send (ok: true, nothing incomplete) is the plain success message', async () => {
    mockAdminFetch.mockImplementation(async (path, opts) => (opts?.method === 'POST' ? { ok: true, sent: 1, emailed: 1, texted: 1 } : preview()));
    render(<RateReviewSendPanel batchKey="2026-12" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send 1 letter' }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Send 1 letter' })).at(-1));
    expect(await screen.findByText('1 letter sent (1 emailed, 1 texted).')).toBeInTheDocument();
  });

  it('names the customers waiting for another approved line (awaitingLines) and why they are held', async () => {
    mockAdminFetch.mockResolvedValue(preview({
      counts: { letters: 1, lines: 1, email: 1, sms: 1, suppressedCustomers: 1, suppressedLines: 2, awaitingLines: 1, alreadySent: 0 },
      customers: [
        { customerId: 'c1', name: 'Testcust One', channels: { email: true, sms: true }, reason: null, reasonLabel: null, lines: [{ noticeId: 'n1', service: 'Pest control', now: '$117 per application', new: '$121 per application (up $4)', effectiveDate: '2026-12-10' }], suppressedLines: [], alreadySent: 0 },
        { customerId: 'c3', name: 'Testcust Three', channels: { email: true, sms: false }, reason: 'awaiting_lines', reasonLabel: 'Another approved line for this customer is not prepared yet', lines: [{ noticeId: 'n3', service: 'Pest control', now: '$90 per application', new: '$94 per application (up $4)', effectiveDate: '2026-12-12' }], suppressedLines: [], alreadySent: 0 },
      ],
    }));
    render(<RateReviewSendPanel batchKey="2026-12" />);
    expect(await screen.findByText('waiting for another line')).toBeInTheDocument();
    expect(screen.getByText('Another approved line for this customer is not prepared yet')).toBeInTheDocument();
  });
});
