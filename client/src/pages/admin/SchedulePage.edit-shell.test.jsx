// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditServiceModal } from './SchedulePage';

vi.mock('../../components/schedule/useSlotConflicts', () => ({ useSlotConflicts: () => ({ conflicts: [] }) }));
const bestTimesState = vi.hoisted(() => ({ availability: undefined }));
vi.mock('../../components/schedule/useBestTimes', () => ({
  useBestTimes: () => ({ bestTimes: [], picked: null, bestInRange: [], availability: bestTimesState.availability }),
}));
const service = { id: 'fixture-visit', customerId: 'fixture-account', customerName: 'Fixture account', serviceType: 'Pest Control', scheduledDate: '2035-01-02', windowStart: '08:00', windowEnd: '09:00', status: 'confirmed', notes: 'Existing note' };
// Structural round 3 on #4657: the debounced money preview is a
// non-GET call too (POST .../update-details/preview) but never
// persists anything — excluded so "a write happened" still means the
// real PUT save.
const writes = () => fetch.mock.calls.filter(([url, options]) => (
  options?.method && options.method !== 'GET' && !url.includes('/update-details/preview')
));

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));

});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.resetAllMocks(); bestTimesState.availability = undefined; });

function Harness({ onSaved = vi.fn() }) {
  const [open, setOpen] = React.useState(false);
  return <>
    <button onClick={(event) => { event.currentTarget.focus(); setOpen(true); }}>Edit visit</button>
    {open && <EditServiceModal service={service} technicians={[]} onClose={() => setOpen(false)} onSaved={onSaved} />}
  </>;
}

it('names the editor, traps focus, locks background scrolling, and returns focus on Escape without writes', async () => {
  render(<Harness />);
  const trigger = screen.getByRole('button', { name: 'Edit visit' });
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Edit appointment' });
  expect(dialog).toHaveFocus();
  expect(document.body.style.position).toBe('fixed');
  const first = within(dialog).getByRole('button', { name: 'Cancel appointment' });
  first.focus();
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
  expect(dialog).toContainElement(document.activeElement);
  expect(first).not.toHaveFocus();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(document.body.style.position).toBe('');
  expect(writes()).toHaveLength(0);
});

it('keeps cancellation focus and Escape within the nested confirmation', async () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  const trigger = screen.getByRole('button', { name: 'Cancel appointment' });
  fireEvent.click(trigger);
  expect(screen.getByRole('dialog', { name: 'Cancel appointment' })).toHaveFocus();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Cancel appointment' })).not.toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: 'Edit appointment' })).toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(writes()).toHaveLength(0);
});

it('retains edits after a failed save and prevents duplicate saves and dismissal while pending', async () => {
  let rejectSave;
  let attempts = 0;
  fetch.mockImplementation(async (url) => {
    if (url.endsWith('/update-details')) {
      attempts += 1;
      if (attempts === 1) return new Promise((resolve, reject) => { rejectSave = reject; });
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => url.endsWith('/admin/discounts') ? [] : {} };
  });
  const onSaved = vi.fn();
  render(<Harness onSaved={onSaved} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  const notes = screen.getByDisplayValue('Existing note');
  fireEvent.change(notes, { target: { value: 'Updated note' } });
  const save = screen.getByRole('button', { name: 'Save', exact: true });
  // Every money figure now waits on a debounced server preview before Save
  // enables (structural round 3 on #4657) — this test isn't about that
  // round trip, so just let it land before exercising the double-click /
  // failed-save flow it actually pins.
  await waitFor(() => expect(save).toBeEnabled(), { timeout: 2000 });
  fireEvent.click(save);
  fireEvent.click(save);
  // Codex pre-push audit P1 (round 4 on #4657, :2936): handleSave now
  // re-probes the stacking gate on every save before it actually POSTs —
  // the write lands one microtask after the click.
  await waitFor(() => expect(writes()).toHaveLength(1));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getByRole('dialog', { name: 'Edit appointment' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
  await act(async () => rejectSave(new Error('Synthetic save failure')));
  expect(await screen.findByRole('alert')).toHaveTextContent('Save failed: Synthetic save failure');
  expect(notes).toHaveValue('Updated note');
  expect(save).toBeEnabled();
  fireEvent.click(save);
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(writes()).toHaveLength(2);
  expect(JSON.parse(writes()[1][1].body)).toMatchObject({ notes: 'Updated note', createInvoice: false });
});

it('keeps a failed cancellation open for retry and blocks duplicate cancellation while pending', async () => {
  let rejectCancel;
  let attempts = 0;
  fetch.mockImplementation(async (url) => {
    if (url.endsWith('/status')) {
      attempts += 1;
      if (attempts === 1) return new Promise((resolve, reject) => { rejectCancel = reject; });
    }
    return { ok: true, json: async () => url.endsWith('/admin/discounts') ? [] : {} };
  });
  const onSaved = vi.fn();
  render(<Harness onSaved={onSaved} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel appointment' }));
  const confirmation = screen.getByRole('dialog', { name: 'Cancel appointment' });
  const cancel = within(confirmation).getByRole('button', { name: 'Cancel appointment' });
  fireEvent.click(cancel);
  fireEvent.click(cancel);
  await waitFor(() => expect(attempts).toBe(1));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(confirmation).toBeInTheDocument();
  expect(within(confirmation).getByRole('button', { name: 'Keep appointment' })).toBeDisabled();
  await act(async () => rejectCancel(new Error('Synthetic cancel failure')));
  expect(within(confirmation).getByRole('alert')).toHaveTextContent('Failed to cancel appointment: Synthetic cancel failure');
  fireEvent.click(cancel);
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(attempts).toBe(2);
  expect(screen.queryByRole('dialog', { name: 'Cancel appointment' })).not.toBeInTheDocument();
});

it('a verified route miss relabels both save paths as overrides', () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  cleanup();
  bestTimesState.availability = {
    pickedDate: '2035-01-02',
    picked: { start: '08:00', fits: false, reason: 'arrival_window', detourMinutes: null },
    days: [{ date: '2035-01-02', status: 'open', hours: [{ date: '2035-01-02', start: '10:00', end: '11:00', detourMinutes: 3, technicianId: 't1', technicianName: null }] }],
  };
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit visit' }));
  // Untouched slot (a price or notes edit): nothing is being overridden.
  expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save & take payment' })).toBeInTheDocument();
  // Moving the visit onto the missed slot is an override.
  fireEvent.change(screen.getByRole('dialog', { name: 'Edit appointment' }).querySelector('input[type="date"]'), { target: { value: '2035-01-03' } });
  expect(screen.getByRole('button', { name: 'Save anyway' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save & take payment anyway' })).toBeInTheDocument();
  expect(writes()).toHaveLength(0);
});

it('re-entering the stored time (HH:MM:SS vs HH:MM) is not an edit', () => {
  bestTimesState.availability = {
    pickedDate: '2035-01-02',
    picked: { start: '08:00', fits: false, reason: 'arrival_window', detourMinutes: null },
    days: [{ date: '2035-01-02', status: 'open', hours: [] }],
  };
  render(<EditServiceModal service={{ ...service, windowStart: '08:00:00', windowEnd: '09:00:00' }} technicians={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
  const dialog = screen.getByRole('dialog', { name: 'Edit appointment' });
  const [start] = dialog.querySelectorAll('input[type="time"]');
  fireEvent.change(start, { target: { value: '10:00' } });
  fireEvent.change(start, { target: { value: '08:00' } });
  expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
});

// ---- a stop shared by two services (owner ruling 2026-10-03) ----
const combo = { ...service, visit: { id: 'fixture-stop', serviceCount: 2, serviceTypes: ['Lawn Care', 'Pest Control'] } };
const writeUrls = () => writes().map(([url, options]) => `${options.method} ${String(url).replace(/^.*\/api/, '')}`);
const okJson = (url) => ({ ok: true, json: async () => (String(url).endsWith('/admin/discounts') ? [] : {}) });
const openCombo = () => {
  if (!fetch.getMockImplementation()) fetch.mockImplementation(async (url) => okJson(url));
  render(<EditServiceModal service={combo} technicians={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
  return screen.getByRole('dialog', { name: 'Edit appointment' });
};
// Save enables once the debounced money preview lands (see the save test above).
const clickSave = async () => {
  const save = screen.getByRole('button', { name: 'Save', exact: true });
  await waitFor(() => expect(save).toBeEnabled(), { timeout: 2000 });
  fireEvent.click(save);
};

it('a combo edited without touching its date or time saves as one ordinary edit', async () => {
  openCombo();
  expect(screen.queryByTestId('combo-move-choice')).not.toBeInTheDocument();
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writeUrls()).toEqual(['PUT /admin/schedule/fixture-visit/update-details']);
});

it('moving a combo moves the whole stop first, then saves the rest', async () => {
  const dialog = openCombo();
  fireEvent.change(dialog.querySelector('input[type="date"]'), { target: { value: '2035-01-03' } });
  const choice = screen.getByTestId('combo-move-choice');
  expect(choice).toHaveTextContent('This stop has 2 services (Lawn Care, Pest Control).');
  expect(within(choice).getByLabelText('Move all of them together')).toBeChecked();
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(writeUrls()).toEqual([
    'POST /admin/dispatch/fixture-visit/reschedule',
    'PUT /admin/schedule/fixture-visit/update-details',
  ]);
  const move = JSON.parse(writes()[0][1].body);
  expect(move).toMatchObject({ newDate: '2035-01-03', newWindow: { start: '08:00', end: '09:00' }, deriveWindowFromCurrentVisit: true, notifyCustomer: false });
  // The edit that follows no longer moves or texts anyone.
  expect(JSON.parse(writes()[1][1].body).notifyCustomer).toBeUndefined();
});

it('choosing Separate splits this service off, then saves it on its own', async () => {
  const dialog = openCombo();
  fireEvent.change(dialog.querySelector('input[type="date"]'), { target: { value: '2035-01-03' } });
  fireEvent.click(screen.getByLabelText('Separate: move only this service'));
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(writeUrls()).toEqual([
    'POST /admin/visits/fixture-stop/split',
    'PUT /admin/schedule/fixture-visit/update-details',
  ]);
  expect(JSON.parse(writes()[0][1].body)).toEqual({ serviceId: 'fixture-visit' });
});

it('a failed whole-stop move saves nothing else; a failed edit after it says the stop did move, and a retry does not move it twice', async () => {
  let rescheduleFails = true;
  let putFails = true;
  fetch.mockImplementation(async (url, options) => {
    if (String(url).includes('/reschedule') && rescheduleFails) return { ok: false, status: 409, json: async () => ({ error: 'That window is past the end of the workday' }) };
    if (String(url).includes('/update-details') && !String(url).includes('/preview') && options?.method === 'PUT' && putFails) {
      return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
    }
    return okJson(url);
  });
  const dialog = openCombo();
  fireEvent.change(dialog.querySelector('input[type="date"]'), { target: { value: '2035-01-03' } });
  await clickSave();
  expect(await screen.findByRole('alert')).toHaveTextContent('Save failed: That window is past the end of the workday');
  expect(writeUrls()).toEqual(['POST /admin/dispatch/fixture-visit/reschedule']);
  rescheduleFails = false;
  await clickSave();
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Both services were moved, but the other changes were not saved.'));
  putFails = false;
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(4));
  expect(writeUrls()[3]).toBe('PUT /admin/schedule/fixture-visit/update-details');
  // Two reschedule calls in all (one refused, one committed) — never a third.
  expect(writeUrls().filter((u) => u.includes('/reschedule'))).toHaveLength(2);
});

