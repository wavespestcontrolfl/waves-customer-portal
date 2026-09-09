// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import FollowThroughCards from './FollowThroughCards';
import { adminFetch } from '../../utils/admin-fetch';
vi.mock('../../utils/admin-fetch', () => ({ adminFetch: vi.fn() }));
const ui = {
  Card: ({ children }) => <article>{children}</article>, Text: ({ children }) => <p>{children}</p>,
  Button: ({ secondary, ...props }) => <button {...props} />, Select: (props) => <select {...props} />, Link: (props) => <a {...props} />,
};
const row = { id: 'callback-1', customer_first_name: 'Synthetic', customer_last_name: 'Caller',
  description: 'Call about the next appointment', updated_at: new Date().toISOString(),
  due_at: new Date(Date.now() + 3600000).toISOString(), from_phone: '+15555550176' };
const feed = { callbacks_enabled: true, callbacks: [row], proposals: [], no_shows: [] };
beforeEach(() => { adminFetch.mockReset().mockResolvedValue(feed); });
afterEach(cleanup);
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
