// @vitest-environment jsdom
// C4 cancelled state: the banner names the cancellation date and what still
// works; the plan panel offers ONE restart action that hands the customer to
// the server-minted estimate (today's price, approval on the estimate page);
// a 409 lands on the priced-by-hand state with the office number; no
// "pause"/"hold" copy anywhere.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/api', () => ({ default: { restartPlan: vi.fn() } }));

import api from '../../utils/api';
import CancelledPlanPanel, { CancelledBanner, cancelledCopy } from './CancelledPlan';
import { WAVES_PHONE_DISPLAY } from '../../theme-customer';

const styles = {
  card: { background: '#fff' },
  muted: '#475569',
  subtle: '#FAF8F3',
  sectionTitle: { fontSize: 12 },
  primaryButton: { background: '#04395E', color: '#fff', minHeight: 40, fontSize: 14 },
  secondaryButton: { background: '#fff', color: '#04395E', minHeight: 40, fontSize: 14 },
};
const customer = { firstName: 'Jordan', cancelled: true, cancelledAt: '2026-08-22' };

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('CancelledBanner', () => {
  it('names the cancellation date and what still works, and opens Billing', () => {
    const onOpenBilling = vi.fn();
    render(<CancelledBanner cancelledAt="2026-08-22" onOpenBilling={onOpenBilling} />);
    expect(screen.getByRole('status')).toHaveTextContent('Your plan is cancelled as of August 22, 2026. You can still see your reports and pay any open balance here.');
    fireEvent.click(screen.getByRole('button', { name: 'Go to Billing' }));
    expect(onOpenBilling).toHaveBeenCalledTimes(1);
  });

  it('degrades without a date and never says pause or hold', () => {
    expect(cancelledCopy(null)).toBe('Your plan is cancelled. You can still see your reports and pay any open balance here.');
    expect(cancelledCopy('2026-08-22')).not.toMatch(/pause|hold/i);
  });
});

describe('CancelledPlanPanel', () => {
  it('renders the cancelled state (no live plan cards) with one restart action', () => {
    render(<CancelledPlanPanel customer={customer} compact={false} styles={styles} navigate={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent("Jordan's plan");
    expect(screen.getByText(/ended on August 22, 2026/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart my plan' })).toBeInTheDocument();
    expect(screen.getByText(/today.s rates/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/pause|hold|your .* rate returns/i);
    expect(document.body.textContent).toContain(WAVES_PHONE_DISPLAY);
  });

  it('restart asks the server for the estimate and hands off to its url', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const navigate = vi.fn();
    api.restartPlan.mockResolvedValueOnce({ ok: true, url: '/estimate/abc123', estimateId: 'e1', reused: false });
    render(<CancelledPlanPanel customer={customer} compact={false} styles={styles} navigate={navigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Restart my plan' }));
    expect(api.restartPlan).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Your estimate is ready.'));
    const link = screen.getByRole('link', { name: 'Review and approve my estimate' });
    expect(link).toHaveAttribute('href', '/estimate/abc123');
    expect(navigate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1600);
    expect(navigate).toHaveBeenCalledWith('/estimate/abc123');
    vi.useRealTimers();
  });

  it('a 409 lands on the priced-by-hand state with the office number, no retry loop', async () => {
    const err = new Error('We need a property measurement on file before we can price this online.');
    err.status = 409;
    err.code = 'pricing_unavailable';
    api.restartPlan.mockRejectedValueOnce(err);
    render(<CancelledPlanPanel customer={customer} compact={false} styles={styles} navigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Restart my plan' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('We will price this one by hand.'));
    expect(screen.getByRole('status')).toHaveTextContent(err.message);
    expect(screen.getByRole('link', { name: `Call or text ${WAVES_PHONE_DISPLAY}` })).toHaveAttribute('href', 'tel:+19412975749');
    expect(screen.queryByRole('button', { name: 'Restart my plan' })).not.toBeInTheDocument();
  });

  it('a transient failure keeps the button and shows the error', async () => {
    api.restartPlan.mockRejectedValueOnce(new Error('Unable to reach the server. Check your connection and try again.'));
    render(<CancelledPlanPanel customer={customer} compact={false} styles={styles} navigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Restart my plan' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Unable to reach the server'));
    expect(screen.getByRole('button', { name: 'Restart my plan' })).not.toBeDisabled();
  });
});
