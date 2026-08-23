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
});
