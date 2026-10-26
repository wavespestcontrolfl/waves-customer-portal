// @vitest-environment jsdom
/**
 * Terminal-action gating (Codex P1 on #2717): Cancel appointment must only
 * render while the visit is still active — the status route reads the
 * CURRENT row as fromStatus, so offering it on a completed/cancelled visit
 * lets one tap flip a finished (possibly compliance) visit terminal in the
 * other direction. (Mark as no-show was removed 2026-07-31, owner call —
 * misses go through the Quick Move sheet's soft No-show reason; the
 * negative assertion stays so the terminal button never quietly returns.)
 */
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('./MobileCustomerDetailSheet', () => ({ default: () => null }));
vi.mock('./RainOutSheet', () => ({ default: () => null }));
vi.mock('./EstimateProvenanceCard', () => ({ default: () => null }));
vi.mock('../../hooks/useCustomerCards', () => ({
  useCustomerCards: () => ({ cards: [], loading: false, error: null }),
}));
vi.mock('../../lib/cardHoldCancel', () => ({
  confirmCardHoldFeeChoice: vi.fn(),
}));

import MobileAppointmentDetailSheet from './MobileAppointmentDetailSheet';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';

window.scrollTo = vi.fn();

const baseService = {
  id: 55,
  customerId: 9,
  customerName: 'Test Customer',
  serviceType: 'WDO Inspection',
  scheduledDate: '2026-07-13',
  scheduledTime: '10:00',
  address: '123 Palm Ave',
  monthlyRate: 250,
};

function renderSheet(status) {
  return render(
    <MobileAppointmentDetailSheet
      service={{ ...baseService, status }}
      onClose={() => {}}
    />,
  );
}

function FocusHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.currentTarget.focus({ preventScroll: true });
          setOpen(true);
        }}
      >
        Open appointment
      </button>
      {open && (
        <MobileAppointmentDetailSheet
          service={{ ...baseService, status: 'completed' }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function SiblingBodyLock() {
  useLockBodyScroll(true);
  return null;
}

function StackedOverlayHarness() {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <>
      <SiblingBodyLock />
      <MobileAppointmentDetailSheet
        service={{ ...baseService, status: 'completed' }}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

describe('MobileAppointmentDetailSheet modal behavior', () => {
  it('names and contains focus, locks scroll, closes on Escape, and restores its opener', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    render(<FocusHarness />);
    const opener = screen.getByRole('button', { name: 'Open appointment' });

    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Appointment details' });
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Appointment details' })).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe('');
    vi.unstubAllGlobals();
    cleanup();
  });

  it('keeps a dirty note open on Escape while saving and after a failed save', async () => {
    let resolveNote;
    const noteResponse = new Promise((resolve) => { resolveNote = resolve; });
    const fetchMock = vi.fn(async (url, options = {}) => {
      if (options.method === 'PATCH' && String(url).endsWith('/note')) return noteResponse;
      return { ok: true, json: async () => ({}) };
    });
    const alertMock = vi.fn();
    const onClose = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('alert', alertMock);
    render(
      <MobileAppointmentDetailSheet
        service={{ ...baseService, status: 'completed' }}
        onClose={onClose}
      />,
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Appointment note' }), {
      target: { value: 'Keep this draft' },
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' }).disabled).toBe(true));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'PATCH')).toHaveLength(1);

    await act(async () => {
      resolveNote({ ok: false, json: async () => ({ error: 'offline' }) });
      await noteResponse;
    });
    await waitFor(() => expect(alertMock).toHaveBeenCalledWith('Failed to save note: offline'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Appointment details' })).toBeTruthy();
    vi.unstubAllGlobals();
    cleanup();
  });

  it('restores body scroll styles when Details and an underlying locked overlay close together', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    vi.stubGlobal('scrollTo', vi.fn());
    Object.assign(document.body.style, {
      position: 'relative',
      top: '3px',
      left: '2px',
      right: '1px',
      width: '90%',
      overflow: 'auto',
    });

    render(<StackedOverlayHarness />);
    expect(document.body.style.position).toBe('fixed');
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Appointment details' })).toBeNull());
    expect(document.body.style.position).toBe('relative');
    expect(document.body.style.top).toBe('3px');
    expect(document.body.style.left).toBe('2px');
    expect(document.body.style.right).toBe('1px');
    expect(document.body.style.width).toBe('90%');
    expect(document.body.style.overflow).toBe('auto');

    document.body.removeAttribute('style');
    vi.unstubAllGlobals();
    cleanup();
  });
});

describe('MobileAppointmentDetailSheet terminal-action gating', () => {
  it('offers Cancel while the visit is active — and never the removed terminal no-show', () => {
    renderSheet('confirmed');
    expect(screen.getByText('Cancel appointment')).toBeTruthy();
    expect(screen.queryByText('Mark as no-show')).toBeNull();
    cleanup();
  });

  it.each(['completed', 'cancelled', 'no_show', 'skipped'])(
    'hides Cancel and No-show for a %s visit',
    (status) => {
      renderSheet(status);
      expect(screen.queryByText('Cancel appointment')).toBeNull();
      expect(screen.queryByText('Mark as no-show')).toBeNull();
      cleanup();
    },
  );
});

describe('MobileAppointmentDetailSheet completion routing', () => {
  it('honors an explicit standard profile when a closed legacy project remains linked', () => {
    render(
      <MobileAppointmentDetailSheet
        service={{
          ...baseService,
          status: 'confirmed',
          completionProfile: { projectBacked: false, requiresProject: false },
          linkedProject: { id: 44, status: 'closed' },
        }}
        onClose={() => {}}
      />,
    );

    const complete = screen.getByRole('button', { name: 'Complete service' });
    expect(complete.disabled).toBe(false);
    cleanup();
  });

  it('opens a no-charge project visit through the project completion route', async () => {
    const onCompleteService = vi.fn();
    const onReviewCheckout = vi.fn();
    render(
      <MobileAppointmentDetailSheet
        service={{
          ...baseService,
          status: 'confirmed',
          monthlyRate: 0,
          servicePrice: 0,
          completionProfile: { projectBacked: true },
          linkedProject: { id: 44, status: 'draft' },
        }}
        onClose={() => {}}
        onCompleteService={onCompleteService}
        onReviewCheckout={onReviewCheckout}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open project details' }));
    await waitFor(() => expect(onCompleteService).toHaveBeenCalledTimes(1));
    expect(onReviewCheckout).not.toHaveBeenCalled();
    cleanup();
  });
});

describe('MobileAppointmentDetailSheet consultation outcome', () => {
  it('offers Consultation outcome on a Waves Assessment and opens the sheet with its saved read', async () => {
    const fetchMock = vi.fn(async (url) => ({
      ok: true,
      json: async () => (String(url).includes('/consultations/')
        ? { outcome: { outcome: 'cold', interests: [], follow_up_at: null } }
        : {}),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(
        <MobileAppointmentDetailSheet
          service={{ ...baseService, serviceType: 'Waves Assessment', status: 'completed' }}
          onClose={() => {}}
        />,
      );
      fireEvent.click(screen.getByText('Consultation outcome'));
      await waitFor(() => expect(screen.getByRole('radio', { name: 'Cold' }).getAttribute('aria-checked')).toBe('true'));
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/admin/consultations/55/outcome'))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      cleanup();
    }
  });

  it('does not offer it on other services', () => {
    renderSheet('confirmed');
    expect(screen.queryByText('Consultation outcome')).toBeNull();
    cleanup();
  });
});
