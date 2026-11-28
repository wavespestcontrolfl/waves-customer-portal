// @vitest-environment jsdom
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RainOutSheet from './RainOutSheet';
import BillingLaneCard from './BillingLaneCard';
import EstimateProvenanceCard from './EstimateProvenanceCard';
import MobileCustomerDetailSheet from './MobileCustomerDetailSheet';
import MobileAppointmentDetailSheet from './MobileAppointmentDetailSheet';
import MobileServiceEditModal from './MobileServiceEditModal';
import MobileDispatchList from './MobileDispatchList';
import TimeGridDay from './TimeGridDay';
import { PestRecapCard } from '../../pages/admin/SchedulePage';

vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlag: () => false,
  useFeatureFlagReady: () => ({ enabled: false, ready: true }),
}));

vi.mock('../../hooks/useScheduleDrag', () => ({
  useBoardOpenTimes: () => ({ fits: null, best: null }),
}));

vi.mock('../../hooks/useHourClock', () => ({
  default: () => new Date('2026-11-27T15:00:00Z'),
}));

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('waves_admin_token', 'test-token');
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SAMPLE_SERVICE = {
  id: 'svc-300',
  customerId: 'cust-300',
  customerName: 'Jordan Sample',
  serviceType: 'Quarterly Pest Control',
  serviceTypeDisplay: 'Quarterly Pest Control',
  scheduledDate: '2026-11-27',
  windowStart: '09:00:00',
  windowEnd: '10:00:00',
  windowDisplay: '9:00 AM - 10:00 AM',
  estimatedDuration: 60,
  estimatedPrice: 120,
  status: 'confirmed',
  notes: 'Check back gate',
  technicianId: 'tech-1',
  technicianName: 'Tech One',
};

describe('Schedule & Dispatch audit Batch 1 — Calendar, Detail & Modal UI', () => {
  it('P1-3: RainOutSheet shows Retry and Cancel when initial options fail to load', async () => {
    const onClose = vi.fn();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'Options unavailable' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          options: [{ kind: 'next_day', date: '2026-11-28', display: 'Sat Nov 28 · 9:00 AM', window: { start: '09:00', end: '10:00' }, conflicts: [] }],
          routeShift: null,
        }),
      });

    render(<RainOutSheet service={SAMPLE_SERVICE} onClose={onClose} onDone={() => {}} />);

    expect(await screen.findByText('Options unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Move appointment' })).toBeInTheDocument();
  });

  it('P1-9: BillingLaneCard and EstimateProvenanceCard hide owner money when adminActions is false', () => {
    render(
      <>
        <BillingLaneCard
          adminActions={false}
          billingLane={{
            mode: 'monthly_membership',
            monthlyRate: 89.5,
            duesPaidThisMonth: false,
            openBalance: 179,
            openInvoiceCount: 2,
            servicePausedAt: '2026-11-20T00:00:00Z',
            servicePausedReason: 'Card declined',
          }}
        />
        <EstimateProvenanceCard
          adminActions={false}
          estimateRef="EST-42"
          quotedTotal={540}
          lines={[{ name: 'Quarterly Pest', cadence: 'quarterly', perApplicationPrice: 135 }]}
          deposit={{ amount: 100, status: 'paid' }}
        />
      </>,
    );

    expect(screen.getByText(/BILLING HOLD/i)).toBeInTheDocument();
    expect(screen.queryByText(/\$89\.50/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$179/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$540/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$135/)).not.toBeInTheDocument();
  });

  it('P1-9: MobileCustomerDetailSheet hides admin-only links and payment details when adminActions is false', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        customer: {
          id: 'cust-300',
          firstName: 'Jordan',
          lastName: 'Sample',
          phone: '9415550100',
          address: '100 Main St',
          city: 'Sarasota',
          state: 'FL',
        },
        appointments: [],
        notes: [],
        // Intentionally omit `cards` (technician-scoped response)
      }),
    });

    render(
      <MemoryRouter>
        <MobileCustomerDetailSheet
          desktopVisible
          adminActions={false}
          customerId="cust-300"
          onClose={() => {}}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Jordan Sample')).toBeInTheDocument();
    expect(screen.queryByText(/View full profile/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Transactions/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/None saved/i)).not.toBeInTheDocument();
  });

  it('P0-5 & P1-9: MobileAppointmentDetailSheet hides Cancel Appointment and skips annual-prepay-availability when adminActions is false', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    render(
      <MobileAppointmentDetailSheet
        desktopVisible
        adminActions={false}
        service={SAMPLE_SERVICE}
        onClose={() => {}}
      />,
    );

    expect(screen.queryByRole('button', { name: /Cancel Appointment/i })).not.toBeInTheDocument();
    const urls = fetchSpy.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes('annual-prepay-availability'))).toBe(false);
  });

  it('P1-19: MobileAppointmentDetailSheet saves dirty appointment note before stepping to Edit', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    const onEdit = vi.fn();

    render(
      <MobileAppointmentDetailSheet
        desktopVisible
        adminActions
        service={SAMPLE_SERVICE}
        onClose={() => {}}
        onEdit={onEdit}
      />,
    );

    const noteBox = screen.getByLabelText('Appointment note');
    fireEvent.change(noteBox, { target: { value: 'Gate code 4411' } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit appointment' }));

    await waitFor(() => expect(onEdit).toHaveBeenCalledTimes(1));
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/admin/dispatch/svc-300/note'),
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('P1-10 & P2: MobileServiceEditModal confirms before discarding dirty edits on Close', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const onClose = vi.fn();
    render(
      <MobileServiceEditModal
        desktopVisible
        service={SAMPLE_SERVICE}
        technicians={[{ id: 'tech-1', name: 'Tech One' }]}
        onClose={onClose}
        onSaved={() => {}}
      />,
    );

    const priceInput = screen.getByDisplayValue('120');
    fireEvent.change(priceInput, { target: { value: '145' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('P1-10: MobileDispatchList disables technician reassignment pill when canAssign is false', () => {
    render(
      <MobileDispatchList
        mode="day"
        date="2026-11-27"
        canAssign={false}
        services={[SAMPLE_SERVICE]}
        technicians={[{ id: 'tech-1', name: 'Tech One' }, { id: 'tech-2', name: 'Tech Two' }]}
        onEdit={() => {}}
        onRefresh={() => {}}
      />,
    );

    expect(screen.queryByRole('button', { name: /Reassign technician/i })).not.toBeInTheDocument();
  });

  it('P1-10 & P2: TimeGridDay omits bulk selection when allowBulkActions is false and shows 8 PM+ stops in AllDayStrip', () => {
    const lateStop = {
      ...SAMPLE_SERVICE,
      id: 'svc-late',
      customerName: 'Late Night Customer',
      windowStart: '20:30:00',
      windowEnd: '21:30:00',
      windowDisplay: '8:30 PM - 9:30 PM',
    };

    render(
      <TimeGridDay
        date="2026-11-27"
        allowBulkActions={false}
        services={[SAMPLE_SERVICE, lateStop]}
        technicians={[{ id: 'tech-1', name: 'Tech One' }]}
        onEdit={() => {}}
      />,
    );

    // 8:30 PM stop is rendered in the All-day strip instead of silently dropped
    expect(screen.getByText(/Late Night Customer/)).toBeInTheDocument();

    // Shift+click does not open BulkActionBar when allowBulkActions is false
    const block = screen.getByText('Jordan Sample').closest('[title]');
    expect(block.getAttribute('title')).not.toContain('Shift+click to select for bulk actions');
    fireEvent.click(block, { shiftKey: true });
    expect(screen.queryByText(/selected/i)).not.toBeInTheDocument();
  });

  it('P2: PestRecapCard surfaces video blob load failure with Retry preview and shows Approve errors', async () => {
    let fileCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const s = String(url);
      if (s.endsWith('/recap-video/file')) {
        fileCalls += 1;
        return { ok: false, status: 502 };
      }
      if (s.endsWith('/recap-video/approve') && init?.method === 'POST') {
        return { ok: false, status: 500, json: async () => ({ error: 'SMS gateway rejected' }) };
      }
      return { ok: true, json: async () => ({ status: 'ready' }) };
    });

    render(<PestRecapCard serviceId="svc-300" />);

    expect(await screen.findByText(/Couldn’t load video preview/i)).toBeInTheDocument();
    expect(fileCalls).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }));
    await waitFor(() => expect(fileCalls).toBe(2));

    fireEvent.click(screen.getByRole('button', { name: /Approve & send/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/SMS gateway rejected/i);
  });

  it('P2: MobileDispatchList tolerates an omitted technicians roster when canAssign is true', () => {
    render(
      <MobileDispatchList
        mode="day"
        date="2026-11-27"
        canAssign
        services={[SAMPLE_SERVICE]}
        onEdit={() => {}}
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText('Jordan Sample')).toBeInTheDocument();
  });

  it('P2: TimeGridDay discards an in-progress resize when pointercancel fires', () => {
    const onResize = vi.fn();
    render(
      <TimeGridDay
        date="2026-11-27"
        services={[SAMPLE_SERVICE]}
        technicians={[{ id: 'tech-1', name: 'Tech One' }]}
        onEdit={() => {}}
        onResize={onResize}
      />,
    );

    const handle = screen.getByTitle('Drag to resize');
    fireEvent.pointerDown(handle, { clientY: 100 });
    fireEvent.pointerMove(window, { clientY: 180 });
    fireEvent.pointerCancel(window);

    expect(onResize).not.toHaveBeenCalled();
  });

  it('P2: PestRecapCard resumes polling on 409 greeting re-render and recovers from transient status errors via Retry', async () => {
    let statusCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const s = String(url);
      if (s.endsWith('/recap-video/file')) {
        return { ok: true, blob: async () => new Blob(['vid'], { type: 'video/mp4' }) };
      }
      if (s.endsWith('/recap-video/approve') && init?.method === 'POST') {
        return { ok: false, status: 409, json: async () => ({ error: 'rerendering_greeting' }) };
      }
      statusCalls += 1;
      if (statusCalls === 1) return { ok: true, json: async () => ({ status: 'ready' }) };
      return { ok: true, json: async () => ({ status: 'rendering' }) };
    });
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:recap-1');
    URL.revokeObjectURL = vi.fn();

    try {
      const { unmount } = render(<PestRecapCard serviceId="svc-301" />);
      const approveBtn = await screen.findByRole('button', { name: /Approve & send/i });
      fireEvent.click(approveBtn);
      expect(await screen.findByText(/Rendering the recap/i)).toBeInTheDocument();
      unmount();

      // Now verify transient error recovery with explicit Retry after 3 consecutive failures
      vi.useFakeTimers();
      let errCalls = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        errCalls += 1;
        if (errCalls <= 3) return { ok: false, status: 503, json: async () => ({ error: 'down' }) };
        return { ok: true, json: async () => ({ status: 'none' }) };
      });
      render(<PestRecapCard serviceId="svc-302" />);
      await vi.advanceTimersByTimeAsync(9000);
      vi.useRealTimers();
      const retryBtn = await screen.findByRole('button', { name: 'Retry' });
      fireEvent.click(retryBtn);
      expect(await screen.findByRole('button', { name: /Generate recap/i })).toBeInTheDocument();
    } finally {
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
    }
  });
});
