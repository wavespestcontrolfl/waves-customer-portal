// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ScheduleListView from './ScheduleListView';

const BASE_ROWS = [
  { id: 'svc-plan', customerName: 'Pat Plan', serviceType: 'Pest Control', scheduledDate: '2026-09-10', status: 'confirmed', isRecurring: true },
  { id: 'svc-once', customerName: 'Sam Once', serviceType: 'Flea Treatment', scheduledDate: '2026-09-11', status: 'confirmed', isRecurring: false },
  // A booster: stored is_recurring=false but linked to its plan.
  { id: 'svc-boost', customerName: 'Bo Booster', serviceType: 'Mosquito Booster', scheduledDate: '2026-09-12', status: 'confirmed', isRecurring: false, recurringParentId: 'svc-plan' },
];
let ROWS = BASE_ROWS;

function mockFetch() {
  global.fetch = vi.fn((url) => {
    if (String(url).includes('/admin/schedule/list')) {
      const services = ROWS;
      return Promise.resolve({ ok: true, json: async () => ({ services, total: services.length }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ updatedCount: 1, failed: [] }) });
  });
}

async function renderWithRows(props = {}) {
  const view = render(<ScheduleListView technicians={[]} {...props} />);
  await screen.findByText('Pat Plan');
  return view;
}

function chooseCancel() {
  fireEvent.change(screen.getByDisplayValue('Choose action…'), { target: { value: 'cancel' } });
}

beforeEach(() => {
  ROWS = BASE_ROWS;
  localStorage.setItem('waves_admin_token', 'test-token');
  mockFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ScheduleListView bulk cancel — recurring plan notice', () => {
  it('names the recurring visits and says the plan continues when one is selected', async () => {
    await renderWithRows();
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[1]); // svc-plan (boxes[0] is select-all)
    fireEvent.click(boxes[2]); // svc-once
    chooseCancel();
    expect(screen.getByText(/belong to a recurring plan: 1\./)).toBeInTheDocument();
    expect(screen.getByText(/each plan continues/)).toBeInTheDocument();
  });

  it('counts a plan-linked booster even though it is not itself recurring', async () => {
    await renderWithRows();
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[2]); // svc-once
    fireEvent.click(boxes[3]); // svc-boost
    chooseCancel();
    expect(screen.getByText(/belong to a recurring plan: 1\./)).toBeInTheDocument();
  });

  it('re-reads a selected row when the host bumps refreshKey after an edit', async () => {
    const view = await renderWithRows({ refreshKey: 0 });
    fireEvent.click(screen.getAllByRole('checkbox')[2]); // svc-once, one-time at select time
    chooseCancel();
    expect(screen.queryByText(/recurring plan/)).not.toBeInTheDocument();
    // The Edit modal made it recurring; the host page bumps the key.
    ROWS = ROWS.map((r) => (r.id === 'svc-once' ? { ...r, isRecurring: true } : r));
    view.rerender(<ScheduleListView technicians={[]} refreshKey={1} />);
    await screen.findByText(/belong to a recurring plan: 1\./);
  });

  it('drops the edited row from the selection when the refresh no longer returns it', async () => {
    const onEdit = vi.fn();
    const view = await renderWithRows({ refreshKey: 0, onEdit });
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[1]); // svc-plan stays selected (other-page semantics)
    fireEvent.click(boxes[2]); // svc-once, then edited
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Sam Once')); // row click opens the Edit modal
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'svc-once' }));
    // The edit moved it out of the filtered window; the host bumps the key.
    ROWS = ROWS.filter((r) => r.id !== 'svc-once');
    view.rerender(<ScheduleListView technicians={[]} refreshKey={1} onEdit={onEdit} />);
    await screen.findByText('1 selected');
    expect(screen.queryByText('Sam Once')).not.toBeInTheDocument();
  });

  it('keeps a row whose modal was opened but not saved when a later fetch omits it', async () => {
    const onEdit = vi.fn();
    const view = await renderWithRows({ refreshKey: 0, onEdit });
    fireEvent.click(screen.getAllByRole('checkbox')[2]); // svc-once
    fireEvent.click(screen.getByText('Sam Once')); // modal opened…
    // …and dismissed; then a filter/page fetch (no refreshKey bump) omits the row.
    ROWS = ROWS.filter((r) => r.id !== 'svc-once');
    fireEvent.change(screen.getByPlaceholderText('Name or service…'), { target: { value: 'Pat' } });
    await waitFor(() => expect(fetch.mock.calls.filter(([u]) => String(u).includes('/admin/schedule/list')).length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.queryByText('Sam Once')).not.toBeInTheDocument());
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    view.unmount();
  });

  it('shows nothing for a selection with no recurring visit', async () => {
    await renderWithRows();
    fireEvent.click(screen.getAllByRole('checkbox')[2]); // svc-once only
    chooseCancel();
    expect(screen.queryByText(/recurring plan/)).not.toBeInTheDocument();
  });

  it('asks before posting when a recurring visit is in the batch, and posts nothing on decline', async () => {
    await renderWithRows();
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    chooseCancel();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/plan continues[\s\S]*Cancel 1 selected\?/));
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/bulk-action'))).toBe(false);
  });

  it('posts a plain (one-row-per-id) cancel when confirmed', async () => {
    await renderWithRows();
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    chooseCancel();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      const call = fetch.mock.calls.find(([url]) => String(url).includes('/bulk-action'));
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toEqual({
        action: 'cancel',
        serviceIds: ['svc-plan'],
        payload: { waiveCardHoldFee: false, notifyCustomer: true },
      });
    });
  });

  it('does not ask when no recurring visit is selected', async () => {
    await renderWithRows();
    fireEvent.click(screen.getAllByRole('checkbox')[2]);
    chooseCancel();
    const confirm = vi.spyOn(window, 'confirm');
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes('/bulk-action'))).toBe(true));
    expect(confirm).not.toHaveBeenCalled();
  });
});
