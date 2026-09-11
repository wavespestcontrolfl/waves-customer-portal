// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    const enabled = vi.fn();
    const { container } = render(<FollowThroughCards ui={ui} onCallbacksEnabled={enabled} />);
    await waitFor(() => expect(enabled).toHaveBeenCalledWith(false));
    expect(container).toBeEmptyDOMElement();
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
  it('walks the queue by offset when the ledger says there is more', async () => {
    adminFetch.mockResolvedValueOnce({ ...feed, has_more: true, next_offset: 100 })
      .mockResolvedValueOnce({ ...feed, commitments: [{ ...row, id: 'callback-2', description: 'Second page callback' }] });
    render(<FollowThroughCards ui={ui} />);
    fireEvent.click(await screen.findByText('Load more'));
    await screen.findByText('Second page callback');
    expect(adminFetch).toHaveBeenLastCalledWith(LIST.replace('offset=0', 'offset=100'));
    expect(screen.getByText(row.description)).toBeInTheDocument();
  });
});
describe('callback actions', () => {
  it.each(['fulfill', 'two_hours', 'tomorrow'])('sends a versioned canonical PATCH for %s', async (action) => {
    render(<FollowThroughCards ui={ui} />);
    await screen.findByText(row.description);
    if (action === 'fulfill') fireEvent.click(screen.getByText('Done'));
    else fireEvent.change(screen.getByLabelText('Snooze callback for Synthetic Caller'), { target: { value: action } });
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith('/admin/call-recordings/commitments/callback-1', {
      method: 'PATCH', body: JSON.stringify({ action: action === 'fulfill' ? 'fulfill' : 'snooze',
        ...(action === 'fulfill' ? {} : { snooze: action }), expected_at: row.updated_at }),
    }));
    await waitFor(() => expect(adminFetch).toHaveBeenCalledTimes(3));
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
