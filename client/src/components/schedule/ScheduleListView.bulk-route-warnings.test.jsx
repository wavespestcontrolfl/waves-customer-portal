// @vitest-environment jsdom
// GATE_ROUTE_CHECK_STAFF_SAVES: a bulk reschedule's route-check results come back as
// `routeWarnings` ([{ id, warning }]), apart from `overlapWarnings`. The list shows the
// route text on its own line and never counts a route result as an overlap.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ScheduleListView from './ScheduleListView';

const ROWS = [
  { id: 'svc-a', customerName: 'Pat Plan', serviceType: 'Pest Control', scheduledDate: '2026-09-10', status: 'confirmed', isRecurring: false },
  { id: 'svc-b', customerName: 'Sam Once', serviceType: 'Flea Treatment', scheduledDate: '2026-09-11', status: 'confirmed', isRecurring: false },
];
const ROUTE_TEXT = "The route on 2099-01-15 cannot keep every promised arrival window with the planned service and driving times. Review the stop order or choose another window.";
let bulkResponse;
let alertSpy;

beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'test-token');
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  global.fetch = vi.fn((url) => {
    if (String(url).includes('/admin/schedule/list')) {
      return Promise.resolve({ ok: true, json: async () => ({ services: ROWS, total: ROWS.length }) });
    }
    return Promise.resolve({ ok: true, json: async () => bulkResponse });
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function reschedule() {
  const { container } = render(<ScheduleListView technicians={[]} />);
  await screen.findByText('Pat Plan');
  const boxes = screen.getAllByRole('checkbox');
  fireEvent.click(boxes[1]);
  fireEvent.click(boxes[2]);
  fireEvent.change(screen.getByDisplayValue('Choose action…'), { target: { value: 'reschedule' } });
  // The bulk bar's date box is the last date input (the filters' From/To come first).
  const dates = container.querySelectorAll('input[type="date"]');
  fireEvent.change(dates[dates.length - 1], { target: { value: '2099-01-15' } });
  fireEvent.change(screen.getByDisplayValue('Don’t send notifications'), { target: { value: 'none' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(alertSpy).toHaveBeenCalled());
}

describe('ScheduleListView bulk reschedule — route warnings', () => {
  it('shows the route text on its own, never as an overlap', async () => {
    bulkResponse = {
      updatedCount: 2, failed: [], overlapWarnings: [],
      routeWarnings: [{ id: 'svc-a', warning: ROUTE_TEXT }, { id: 'svc-b', warning: ROUTE_TEXT }],
    };
    await reschedule();
    expect(alertSpy).toHaveBeenCalledTimes(1);
    const message = alertSpy.mock.calls[0][0];
    expect(message).toContain('The route check flagged 2 visit(s)');
    expect(message).toContain(ROUTE_TEXT);
    expect(message.split(ROUTE_TEXT)).toHaveLength(2); // one line for a shared text
    expect(message).not.toMatch(/overlap/);
  });

  it('counts a visit once however many route notes it carries', async () => {
    bulkResponse = {
      updatedCount: 1, failed: [], overlapWarnings: [],
      routeWarnings: [{ id: 'svc-a', warning: 'First route note.' }, { id: 'svc-a', warning: 'Second route note.' }],
    };
    await reschedule();
    const message = alertSpy.mock.calls[0][0];
    expect(message).toContain('flagged 1 visit(s)');
    expect(message).toContain('• First route note.');
    expect(message).toContain('• Second route note.');
  });

  it('keeps the overlap line as it was, with its own count, beside the route line', async () => {
    bulkResponse = {
      updatedCount: 2, failed: [],
      overlapWarnings: [{ id: 'svc-a', warning: 'Heads up: overlap' }],
      routeWarnings: [{ id: 'svc-a', warning: ROUTE_TEXT }, { id: 'svc-b', warning: ROUTE_TEXT }],
    };
    await reschedule();
    expect(alertSpy).toHaveBeenCalledTimes(2);
    expect(alertSpy.mock.calls[0][0]).toBe('Moved. 1 visit(s) now overlap another appointment on the schedule — all are kept on the calendar.');
    expect(alertSpy.mock.calls[1][0]).toContain('flagged 2 visit(s)');
  });

  it('gate off (no routeWarnings key): only the overlap line, exactly as before', async () => {
    bulkResponse = { updatedCount: 1, failed: [], overlapWarnings: [{ id: 'svc-a', warning: 'Heads up: overlap' }] };
    await reschedule();
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0][0]).toMatch(/^Moved\. 1 visit\(s\) now overlap/);
  });
});
