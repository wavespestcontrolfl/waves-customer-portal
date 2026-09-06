// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RescheduleConfirmModal from './RescheduleConfirmModal';
import { SERIES_ACK_REQUIRED } from './seriesMove';
import { useSlotConflicts } from './useSlotConflicts';

// The advisory hooks fetch on their own — keep them quiet so the only
// network traffic under test is the series-move preview.
vi.mock('./useSlotConflicts', () => ({ useSlotConflicts: vi.fn(() => ({ conflicts: [] })) }));
vi.mock('./useBestTimes', () => ({ useBestTimes: () => ({ bestTimes: [] }) }));

const PREVIEW = {
  enabled: true,
  collective: true,
  deltaDays: 2,
  movableCount: 3,
  occurrenceIds: ['occ-1', 'occ-2', 'occ-3'],
  skippedCount: 0,
  exceptionCount: 0,
  conflictCount: 0,
  firstAffectedDate: '2026-09-03',
  lastAffectedDate: '2026-11-03',
};

function mockPreview(body) {
  global.fetch = vi.fn(async (url) => {
    if (String(url).includes('/series-move-preview?newDate=2026-09-03')) {
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

function renderModal(props = {}) {
  const onConfirm = props.onConfirm || vi.fn(async () => {});
  const onCancel = vi.fn();
  render(
    <RescheduleConfirmModal
      open
      customerName="Pat Smith"
      fromDate="2026-09-01"
      fromMinutes={480}
      toDate="2026-09-03"
      toMinutes={480}
      isRecurring
      serviceId="svc-1"
      toWindow="08:00-09:00"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onConfirm, onCancel };
}

beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'test-token');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RescheduleConfirmModal — collective series moves', () => {
  it('renders the server preview as one line, drops the this/series chooser, and acks the previewed set', async () => {
    mockPreview(PREVIEW);
    const { onConfirm } = renderModal();

    const notice = await screen.findByTestId('series-move-notice');
    expect(notice).toHaveTextContent('Moves this visit and 2 later visits in the recurring plan (through Nov 3, 2026).');
    expect(screen.queryByRole('button', { name: 'Reschedule series' })).toBeNull();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/admin/dispatch/svc-1/series-move-preview?newDate=2026-09-03'),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Move visit + later visits' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith({
      notificationType: 'none',
      scope: 'this_only',
      seriesAck: true,
      seriesAckIds: ['occ-1', 'occ-2', 'occ-3'],
    });
  });

  it('gate off: keeps the legacy chooser and sends no ack', async () => {
    mockPreview({ ...PREVIEW, enabled: false });
    const { onConfirm } = renderModal();

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reschedule appointment' })).toBeEnabled());
    expect(screen.queryByTestId('series-move-notice')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reschedule series' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reschedule series' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ notificationType: 'none', scope: 'series' }));
    expect(onConfirm.mock.calls[0][0]).not.toHaveProperty('seriesAck');
  });

  it('a failed preview never offers the series chooser — the move goes this_only and the server discloses', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, statusText: 'Server Error', json: async () => ({}), text: async () => 'boom' }));
    const { onConfirm } = renderModal();

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reschedule appointment' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Reschedule series' })).toBeNull();
    expect(screen.queryByTestId('series-move-notice')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Reschedule appointment' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ notificationType: 'none', scope: 'this_only' }));
  });

  it('gate on, same-day time move: not collective, so the series chooser stays (the server never widens it)', async () => {
    const sameDay = { enabled: true, collective: false, deltaDays: 0, movableCount: 0, skippedCount: 0, exceptionCount: 0, conflictCount: 0, firstAffectedDate: null, lastAffectedDate: null };
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/series-move-preview?newDate=2026-09-01')) {
        return { ok: true, status: 200, json: async () => sameDay, text: async () => JSON.stringify(sameDay) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const { onConfirm } = renderModal({ toDate: '2026-09-01', toMinutes: 600, toWindow: '10:00-11:00' });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Reschedule series' })).toBeInTheDocument());
    expect(screen.queryByTestId('series-move-notice')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reschedule series' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ notificationType: 'none', scope: 'series' }));
  });

  it('never fetches a preview for a one-time visit', async () => {
    mockPreview(PREVIEW);
    renderModal({ isRecurring: false });
    expect(screen.getByRole('button', { name: 'Reschedule appointment' })).toBeEnabled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('a refused ack (plan changed) swaps in the refreshed preview and stays open', async () => {
    mockPreview(PREVIEW);
    // The 409 carries the rebooker's raw preview — no `enabled` stamp.
    const { enabled: _enabled, ...raw } = PREVIEW;
    const refreshed = { ...raw, movableCount: 4, occurrenceIds: ['occ-1', 'occ-2', 'occ-3', 'occ-4'], lastAffectedDate: '2026-12-03' };
    const onConfirm = vi.fn()
      .mockRejectedValueOnce(new Error(JSON.stringify({
        error: 'The recurring plan changed since the preview.',
        code: SERIES_ACK_REQUIRED,
        preview: refreshed,
      })))
      .mockResolvedValueOnce({});
    renderModal({ onConfirm });

    await screen.findByTestId('series-move-notice');
    fireEvent.click(screen.getByRole('button', { name: 'Move visit + later visits' }));

    await waitFor(() => expect(screen.getByTestId('series-move-notice'))
      .toHaveTextContent('Moves this visit and 3 later visits in the recurring plan (through Dec 3, 2026).'));
    expect(screen.getByTestId('series-move-notice')).toHaveTextContent('The recurring plan changed since you looked');

    fireEvent.click(screen.getByRole('button', { name: 'Move visit + later visits' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2));
    expect(onConfirm.mock.calls[1][0]).toMatchObject({ seriesAck: true, seriesAckIds: ['occ-1', 'occ-2', 'occ-3', 'occ-4'] });
  });
});


it('checks the landing technician and duration when confirming a cross-technician drag', () => {
  renderModal({ technicianId: 'destination-tech', durationMinutes: 90, isRecurring: false });
  expect(useSlotConflicts).toHaveBeenLastCalledWith(expect.objectContaining({
    technicianId: 'destination-tech', durationMinutes: 90,
  }));
});
