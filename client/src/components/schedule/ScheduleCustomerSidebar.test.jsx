// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

vi.mock('../admin/CallBridgeLink', () => ({ default: ({ phone }) => <span>{phone}</span> }));
vi.mock('../../lib/cardHoldCancel', () => ({ confirmCardHoldFeeChoice: vi.fn() }));
vi.mock('../../lib/adminFetch', () => ({
  adminFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({
      customer: { firstName: 'Test', lastName: 'Customer' },
      payments: [],
      cards: [],
      // Newest-first history from the server; 9 rows so the 8-cap applies.
      scheduled: Array.from({ length: 9 }, (_, i) => ({
        id: `v${i}`,
        scheduled_date: `2026-0${9 - Math.floor(i / 4)}-${String(28 - (i % 4) * 7).padStart(2, '0')}`,
        status: 'completed',
        service_type: `Visit ${i}`,
      })),
    }),
  })),
}));

import ScheduleCustomerSidebar from './ScheduleCustomerSidebar';

afterEach(cleanup);

describe('ScheduleCustomerSidebar appointment history', () => {
  it('renders the newest 8 history rows without the helper being shadowed by the memo local', async () => {
    render(
      <ScheduleCustomerSidebar
        service={{ id: 'v0', customerId: 'c1', customerName: 'Test Customer', status: 'pending' }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText('Visit 0')).toBeTruthy());
    expect(screen.getByText('Visit 7')).toBeTruthy();
    expect(screen.queryByText('Visit 8')).toBeNull();
    expect(screen.getByText('Current')).toBeTruthy();
  });
});
