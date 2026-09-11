// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import FollowThroughCards from './FollowThroughCards';
import { adminFetch } from '../../utils/admin-fetch';
vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn() }));
const ui = {
  Card: ({ children }) => <article>{children}</article>, Text: ({ children }) => <p>{children}</p>,
  Button: ({ secondary, ...props }) => <button {...props} />, Select: (props) => <select {...props} />, Link: (props) => <a {...props} />,
};
const LIST = '/admin/call-recordings/commitments/open?party=waves&kind=callback&limit=100&offset=0';
const row = { id: 'callback-1', kind: 'callback', party: 'waves', customer_first_name: 'Synthetic', customer_last_name: 'Caller',
  description: 'Call about the next appointment', updated_at: new Date().toISOString(), due_at: null,
  effective_due_at: new Date(Date.now() + 3600000).toISOString(), overdue: false, from_phone: '+15555550176' };
const feed = { callbacks_enabled: true, enabled: true, commitments: [row], has_more: false, next_offset: null };
beforeEach(() => { adminFetch.mockReset().mockResolvedValue(feed); });
afterEach(cleanup);
describe('callback cards', () => {
  it('reads open callback cards Waves owes from the commitments ledger', async () => {
    render(<FollowThroughCards ui={ui} />);
    await screen.findByText(row.description);
    expect(adminFetch).toHaveBeenCalledWith(LIST);
    expect(screen.getByText(/^Due /)).toBeInTheDocument();
  });
  it('renders nothing while callback cards are off', async () => {
    adminFetch.mockResolvedValue({ ...feed, callbacks_enabled: false, commitments: [] });
    const onSummary = vi.fn();
    const { container } = render(<FollowThroughCards ui={ui} onSummary={onSummary} />);
    await waitFor(() => expect(adminFetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSummary).toHaveBeenLastCalledWith({ enabled: false, open: 0, overdue: 0, hasMore: false }));
    expect(container).toBeEmptyDOMElement();
  });
  it('surfaces a callback whose snooze or deadline expires between polls', async () => {
    const soon = new Date(Date.now() + 30000).toISOString();
    adminFetch.mockResolvedValue({ ...feed, commitments: [
      { ...row, id: 'rest', description: 'Snoozed callback', effective_due_at: soon, snoozed_until: soon },
    ] });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const onSummary = vi.fn();
      render(<FollowThroughCards ui={ui} pollMs={600000} onSummary={onSummary} />);
      await screen.findByText('1 snoozed callback');
      // vi.waitFor, not RTL's waitFor: with setInterval faked, RTL's poller
      // never ticks and only DOM mutations re-run the check — the summary
      // callback mutates nothing, so on a loaded machine the assertion timed
      // out on the mount-time summary (CI flake). vi.waitFor advances the
      // fake clock per check instead.
      await vi.waitFor(() => expect(onSummary).toHaveBeenLastCalledWith({ enabled: true, open: 1, overdue: 0, hasMore: false }));
      expect(screen.getByText(/^Due /)).toBeInTheDocument();
      vi.setSystemTime(Date.now() + 61000);
      act(() => { vi.advanceTimersByTime(60000); });
      expect(screen.queryByText('1 snoozed callback')).not.toBeInTheDocument();
      expect(screen.getByText(/^Overdue · /)).toBeInTheDocument();
      expect(onSummary).toHaveBeenLastCalledWith({ enabled: true, open: 1, overdue: 1, hasMore: false });
    } finally { vi.useRealTimers(); }
  });
  it('keeps the operator note and the possibly-kept warning the Owed row carried', async () => {
    adminFetch.mockResolvedValue({ ...feed, commitments: [{ ...row, human_note: 'Ask for Pat',
      fulfillment: { kind: 'outbound_call', strength: 'association', basis: 'completed_outbound_call_to_caller_within_14_days', matched_at: '2026-09-03T14:00:00Z' } }] });
    render(<FollowThroughCards ui={ui} />);
    await screen.findByText('Note: Ask for Pat');
    expect(screen.getByText(/^Possibly kept: outbound call on .* · completed outbound call to caller within 14 days — confirm with Done$/)).toBeInTheDocument();
  });
  it('warns when the assigned owner is no longer active', async () => {
    adminFetch.mockResolvedValue({ ...feed, commitments: [
      { ...row, owner_name: 'Former Tech', owner_active: false },
      { ...row, id: 'covered', description: 'Covered callback', owner_name: 'Current Tech', owner_active: true },
    ] });
    render(<FollowThroughCards ui={ui} />);
    await screen.findByText('Covered callback');
    expect(screen.getByText('Assigned to Former Tech, who is no longer active — take this over')).toBeInTheDocument();
    expect(screen.getAllByText(/no longer active/)).toHaveLength(1);
  });
  it('marks a card the ledger judged overdue and lists a snoozed card separately', async () => {
    const past = new Date(Date.now() - 3600000).toISOString();
    const future = new Date(Date.now() + 7200000).toISOString();
    adminFetch.mockResolvedValue({ ...feed, commitments: [
      { ...row, id: 'late', description: 'Late callback', effective_due_at: past, overdue: true },
      { ...row, id: 'rest', description: 'Snoozed callback', effective_due_at: future, snoozed_until: future },
    ] });
    render(<FollowThroughCards ui={ui} />);
    await screen.findByText('Late callback');
    expect(screen.getByText(/^Overdue · /)).toBeInTheDocument();
    expect(screen.getByText('1 snoozed callback')).toBeInTheDocument();
    expect(screen.getByText(/^Snoozed until /)).toBeInTheDocument();
  });
  it('passes the hints filter through and reports its counts to the host', async () => {
    const onSummary = vi.fn();
    adminFetch.mockResolvedValue({ ...feed, commitments: [row, { ...row, id: 'late', description: 'Late callback', overdue: true }] });
    render(<FollowThroughCards ui={ui} hints={false} onSummary={onSummary} />);
    await screen.findByText('Late callback');
    expect(adminFetch).toHaveBeenCalledWith(LIST.replace('&limit', '&hints=0&limit'));
    await waitFor(() => expect(onSummary).toHaveBeenLastCalledWith({ enabled: true, open: 2, overdue: 1, hasMore: false }));
  });
  it('drops the previous filter\'s rows and pagination when the hints filter changes', async () => {
    adminFetch.mockImplementation(async (url) => {
      if (url.includes('hints=0')) throw new Error('Could not load follow-through.');
      return { ...feed, has_more: true, next_offset: 100 };
    });
    const onSummary = vi.fn();
    const { rerender } = render(<FollowThroughCards ui={ui} hints onSummary={onSummary} />);
    await screen.findByText('Load more');
    rerender(<FollowThroughCards ui={ui} hints={false} onSummary={onSummary} />);
    await screen.findByText('Could not load follow-through.');
    await waitFor(() => expect(onSummary).toHaveBeenLastCalledWith({ enabled: false, open: 0, overdue: 0, hasMore: false }));
    expect(screen.queryByText(row.description)).not.toBeInTheDocument();
    expect(screen.queryByText('Load more')).not.toBeInTheDocument();
    expect(screen.queryByText('No follow-through needs attention.')).not.toBeInTheDocument();
  });
  it('re-reads every loaded page on a background refresh instead of snapping back to page one', async () => {
    const second = { ...row, id: 'callback-2', description: 'Second page callback' };
    adminFetch.mockImplementation(async (url) => url.includes('offset=100')
      ? { ...feed, commitments: [second] } : { ...feed, has_more: true, next_offset: 100 });
    render(<FollowThroughCards ui={ui} />);
    fireEvent.click(await screen.findByText('Load more'));
    await screen.findByText('Second page callback');
    adminFetch.mockClear();
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(adminFetch).toHaveBeenCalledTimes(2));
    expect(adminFetch.mock.calls.map(([url]) => url)).toEqual([LIST, LIST.replace('offset=0', 'offset=100')]);
    expect(screen.getByText('Second page callback')).toBeInTheDocument();
    expect(screen.getByText(row.description)).toBeInTheDocument();
  });
  it('lets a Load more page land when a focus, poll or manual refresh fires mid-read', async () => {
    let releasePage;
    adminFetch.mockImplementation((url) => url.includes('offset=100')
      ? new Promise((resolve) => { releasePage = () => resolve({ ...feed, commitments: [{ ...row, id: 'callback-2', description: 'Second page callback' }] }); })
      : Promise.resolve({ ...feed, has_more: true, next_offset: 100 }));
    render(<FollowThroughCards ui={ui} />);
    fireEvent.click(await screen.findByText('Load more'));
    await waitFor(() => expect(releasePage).toBeTypeOf('function'));
    adminFetch.mockClear();
    fireEvent(window, new Event('focus'));
    fireEvent.click(screen.getByText('Refresh'));
    expect(adminFetch).not.toHaveBeenCalled();
    releasePage();
    await screen.findByText('Second page callback');
    expect(screen.getByText(row.description)).toBeInTheDocument();
  });
  it('walks the queue by offset when the ledger says there is more, and tells the host more remains', async () => {
    const onSummary = vi.fn();
    adminFetch.mockResolvedValueOnce({ ...feed, has_more: true, next_offset: 100 })
      .mockResolvedValueOnce({ ...feed, commitments: [{ ...row, id: 'callback-2', description: 'Second page callback' }] });
    render(<FollowThroughCards ui={ui} onSummary={onSummary} />);
    fireEvent.click(await screen.findByText('Load more'));
    await waitFor(() => expect(onSummary).toHaveBeenLastCalledWith({ enabled: true, open: 1, overdue: 0, hasMore: true }));
    await screen.findByText('Second page callback');
    expect(adminFetch).toHaveBeenLastCalledWith(LIST.replace('offset=0', 'offset=100'));
    expect(screen.getByText(row.description)).toBeInTheDocument();
    await waitFor(() => expect(onSummary).toHaveBeenLastCalledWith({ enabled: true, open: 2, overdue: 0, hasMore: false }));
  });
  it.each(['outbound', 'outbound-api', 'outbound-dial'])('shows and dials the customer side of a %s call', async (direction) => {
    adminFetch.mockResolvedValue({ ...feed, commitments: [{ ...row, direction, from_phone: '+15555550100', to_phone: '+15555550199' }] });
    render(<FollowThroughCards ui={ui} />);
    await screen.findByText(/^\+15555550199 · Call /);
    fireEvent.click(screen.getByText('Call'));
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith('/admin/communications/call', expect.objectContaining({
      body: JSON.stringify({ to: '+15555550199', relatedCommitmentId: 'callback-1', expected_at: row.updated_at }),
    })));
  });
});
describe('callback actions', () => {
  it.each(['fulfill', 'dismiss', 'two_hours', 'tomorrow'])('sends a versioned canonical PATCH for %s', async (action) => {
    render(<FollowThroughCards ui={ui} />);
    await screen.findByText(row.description);
    const button = { fulfill: 'Done', dismiss: 'Dismiss' }[action];
    if (button) fireEvent.click(screen.getByText(button));
    else fireEvent.change(screen.getByLabelText('Snooze callback for Synthetic Caller'), { target: { value: action } });
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith('/admin/call-recordings/commitments/callback-1', {
      method: 'PATCH', body: JSON.stringify({ action: button ? action : 'snooze',
        ...(button ? {} : { snooze: action }), expected_at: row.updated_at }),
    }));
    await waitFor(() => expect(adminFetch).toHaveBeenCalledTimes(3));
  });
  it('refreshes after an action through the hints filter in force when the action finishes', async () => {
    let releasePatch;
    adminFetch.mockImplementation((url, options) => options
      ? new Promise((resolve) => { releasePatch = () => resolve({ success: true }); }) : Promise.resolve(feed));
    const { rerender } = render(<FollowThroughCards ui={ui} hints />);
    fireEvent.click(await screen.findByText('Done'));
    await waitFor(() => expect(releasePatch).toBeTypeOf('function'));
    rerender(<FollowThroughCards ui={ui} hints={false} />);
    adminFetch.mockClear();
    releasePatch();
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith(LIST.replace('&limit', '&hints=0&limit')));
    await waitFor(() => expect(screen.queryByText(/Done/)).toBeEnabled());
    expect(adminFetch.mock.calls.map(([url]) => url)).not.toContain(LIST);
  });
  it('refreshes a stale callback after a rejected update and displays the conflict', async () => {
    adminFetch.mockImplementation(async (url, options) => {
      if (options) throw new Error('This callback changed. Refresh to see the latest action.');
      return feed;
    });
    render(<FollowThroughCards ui={ui} />);
    fireEvent.click(await screen.findByText('Done'));
    await screen.findByText('This callback changed. Refresh to see the latest action.');
    expect(adminFetch).toHaveBeenCalledTimes(3);
  });
});
