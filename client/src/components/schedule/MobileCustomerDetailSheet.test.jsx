// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }));
vi.mock('../admin/CallBridgeLink', () => ({ default: ({ phone }) => <span>{phone}</span> }));
vi.mock('../../lib/adminFetch', () => ({
  adminFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({
      customer: { firstName: 'Test', lastName: 'Customer' },
      services: [], payments: [], cards: [],
      scheduled: [{ id: 'v-far', scheduled_date: '2099-01-05', status: 'pending', service_type: 'Far visit' }],
      upcomingScheduled: [{ id: 'v-far', scheduled_date: '2099-01-05', status: 'pending', service_type: 'Far visit' }],
    }),
  })),
}));
import { adminFetch } from '../../lib/adminFetch';
import MobileCustomerDetailSheet from './MobileCustomerDetailSheet';

afterEach(cleanup);

describe('MobileCustomerDetailSheet', () => {
  it('pins the open visit via focusServiceId and renders the upcoming list', async () => {
    render(<MobileCustomerDetailSheet customerId="c1" focusServiceId="v-far" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Far visit')).toBeTruthy());
    expect(adminFetch).toHaveBeenCalledWith('/admin/customers/c1?focusServiceId=v-far');
  });

  it('omits the param when no visit is in scope', async () => {
    render(<MobileCustomerDetailSheet customerId="c1" onClose={() => {}} />);
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith('/admin/customers/c1'));
  });

  it('shows the server visit count, not one per service record row', async () => {
    // One stop today with two appointments (one with a sibling record) plus a
    // record that never completed: four rows, one visit.
    adminFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        customer: { firstName: 'Test', lastName: 'Customer' },
        services: [
          { id: 'r1', service_date: '2026-10-29', status: 'completed' },
          { id: 'r2', service_date: '2026-10-29', status: 'completed' },
          { id: 'r3', service_date: '2026-10-29', status: 'completed' },
          { id: 'r4', service_date: '2026-10-15', status: 'in_progress' },
        ],
        visitStats: { count: 1, firstDate: '2026-10-29', lastDate: '2026-10-29' },
        payments: [], cards: [], scheduled: [], upcomingScheduled: [],
      }),
    });
    render(<MobileCustomerDetailSheet customerId="c1" onClose={() => {}} />);
    const label = await screen.findByText('Visits');
    expect(label.parentElement.textContent).toContain('1');
    expect(label.parentElement.textContent).not.toContain('4');
  });
});
