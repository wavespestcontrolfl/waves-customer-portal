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
const saveNotice = vi.hoisted(() => ({ shown: [] }));
vi.mock('../../components/schedule/ScheduleSaveNotice', async (importOriginal) => ({
  ...(await importOriginal()),
  showScheduleSaveNotice: (message) => { saveNotice.shown.push(message); },
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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.resetAllMocks(); bestTimesState.availability = undefined; saveNotice.shown.length = 0; });

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
// Together: the other changes are saved first (on the stop's current slot),
// the whole-stop move runs last and sends the one customer text.
const combo = { ...service, visit: { id: 'fixture-stop', serviceCount: 2, liveCount: 2, memberIds: ['fixture-visit', 'fixture-lawn'], serviceTypes: ['Lawn Care', 'Pest Control'] } };
const writeUrls = () => writes().map(([url, options]) => `${options.method} ${String(url).replace(/^.*\/api/, '')}`);
const okJson = (url) => ({ ok: true, json: async () => (String(url).endsWith('/admin/discounts') ? [] : {}) });
const isPut = (url, options) => String(url).includes('/update-details') && !String(url).includes('/preview') && options?.method === 'PUT';
const PUT = 'PUT /admin/schedule/fixture-visit/update-details';
const MOVE = 'POST /admin/dispatch/fixture-visit/reschedule';
const openModal = (svc = combo, technicians = []) => {
  if (!fetch.getMockImplementation()) fetch.mockImplementation(async (url) => okJson(url));
  render(<EditServiceModal service={svc} technicians={technicians} onClose={vi.fn()} onSaved={vi.fn()} />);
  return screen.getByRole('dialog', { name: 'Edit appointment' });
};
const openCombo = () => openModal();
const setDate = (dialog, value) => fireEvent.change(dialog.querySelector('input[type="date"]'), { target: { value } });
// Save enables once the debounced money preview lands (see the save test above).
const clickSave = async () => {
  const save = screen.getByRole('button', { name: 'Save', exact: true });
  await waitFor(() => expect(save).toBeEnabled(), { timeout: 2000 });
  fireEvent.click(save);
};
const body = (index) => JSON.parse(writes()[index][1].body);

it('a combo edited without touching its date or time saves as one ordinary edit', async () => {
  openCombo();
  expect(screen.queryByTestId('combo-move-choice')).not.toBeInTheDocument();
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writeUrls()).toEqual([PUT]);
});

it('moving a combo saves the other changes on the current slot first, then moves the whole stop', async () => {
  const dialog = openCombo();
  setDate(dialog, '2035-01-03');
  const choice = screen.getByTestId('combo-move-choice');
  expect(choice).toHaveTextContent('This stop has 2 services (Lawn Care, Pest Control).');
  expect(within(choice).getByLabelText('Move all of them together')).toBeChecked();
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(writeUrls()).toEqual([PUT, MOVE]);
  // The edit carries no date, window or technician at all: it moves
  // nothing, reassigns nothing, texts nobody and acks nothing.
  for (const key of ['scheduledDate', 'windowStart', 'windowEnd', 'technicianId']) expect(body(0)).not.toHaveProperty(key);
  expect(body(0).notifyCustomer).toBeUndefined();
  expect(body(0).seriesAck).toBeUndefined();
  expect(body(1)).toMatchObject({
    newDate: '2035-01-03', newWindow: { start: '08:00', end: '09:00' }, deriveWindowFromCurrentVisit: true, notifyCustomer: false,
    expectVisit: { id: 'fixture-stop', memberIds: ['fixture-visit', 'fixture-lawn'], liveCount: 2 },
  });
  expect(body(1)).not.toHaveProperty('technicianId');
});

it('choosing Separate splits this service off, then saves it on its own', async () => {
  const dialog = openCombo();
  setDate(dialog, '2035-01-03');
  fireEvent.click(screen.getByLabelText('Separate: move only this service'));
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(writeUrls()).toEqual(['POST /admin/visits/fixture-stop/split', PUT]);
  expect(body(0)).toEqual({ serviceId: 'fixture-visit' });
  expect(body(1).scheduledDate).toBe('2035-01-03');
});

it('a failed edit moves nothing; a refused move says the other changes were saved, and the retry posts only the move', async () => {
  let putFails = true;
  let moveFails = true;
  fetch.mockImplementation(async (url, options) => {
    if (isPut(url, options) && putFails) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
    if (String(url).includes('/reschedule') && moveFails) return { ok: false, status: 409, json: async () => ({ error: 'That window is past the end of the workday' }) };
    return okJson(url);
  });
  const dialog = openCombo();
  setDate(dialog, '2035-01-03');
  await clickSave();
  expect(await screen.findByRole('alert')).toHaveTextContent('Save failed: boom');
  expect(screen.getByRole('alert')).not.toHaveTextContent('other changes were saved');
  expect(writeUrls()).toEqual([PUT]);
  putFails = false;
  await clickSave();
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The other changes were saved, but the stop was not moved. Save failed: That window is past the end of the workday'));
  expect(writeUrls()).toEqual([PUT, PUT, MOVE]);
  // The operator picks another day; the saved details are not posted again.
  moveFails = false;
  setDate(dialog, '2035-01-04');
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(4));
  expect(writeUrls()[3]).toBe(MOVE);
  expect(body(3).newDate).toBe('2035-01-04');
});

it('after a refused move, a changed detail is saved again before the move', async () => {
  let moveFails = true;
  fetch.mockImplementation(async (url) => (String(url).includes('/reschedule') && moveFails
    ? { ok: false, status: 409, json: async () => ({ error: 'refused' }) } : okJson(url)));
  const dialog = openCombo();
  setDate(dialog, '2035-01-03');
  await clickSave();
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The other changes were saved'));
  moveFails = false;
  fireEvent.change(dialog.querySelector('textarea'), { target: { value: 'A new note' } });
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(4));
  expect(writeUrls()).toEqual([PUT, MOVE, PUT, MOVE]);
});

it('a partly finished whole-stop move is reported as such, never as "not moved"', async () => {
  fetch.mockImplementation(async (url) => (String(url).includes('/reschedule')
    ? { ok: true, json: async () => ({ needsAttention: { code: 'VISIT_MOVE_INCOMPLETE', message: 'Only part of this stop finished moving: fixture repair text.' } }) }
    : okJson(url)));
  const dialog = openCombo();
  setDate(dialog, '2035-01-03');
  await clickSave();
  expect(await screen.findByRole('alert')).toHaveTextContent('The other changes were saved. Save failed: Only part of this stop finished moving: fixture repair text.');
  expect(screen.getByRole('alert')).not.toHaveTextContent('the stop was not moved');
});

it('a recurring combo moved together moves this visit only: no "later visits" line, no series ack, no recurrence change', async () => {
  const preview = {
    enabled: true, collective: true, deltaDays: 1, movableCount: 2, occurrenceIds: ['occ-1', 'occ-2'],
    skippedCount: 0, exceptionCount: 0, conflictCount: 0, firstAffectedDate: '2035-01-16', lastAffectedDate: '2035-01-30',
  };
  fetch.mockImplementation(async (url) => (String(url).includes('/series-move-preview')
    ? { ok: true, status: 200, json: async () => preview, text: async () => JSON.stringify(preview) }
    : okJson(url)));
  const dialog = openModal({ ...combo, isRecurring: true, recurringPattern: 'quarterly' });
  setDate(dialog, '2035-01-03');
  expect(screen.getByTestId('combo-move-scope')).toHaveTextContent('Only this visit moves. Later visits in the plan stay where they are.');
  // Separate is an ordinary row again: its recurring-plan line comes back.
  fireEvent.click(screen.getByLabelText('Separate: move only this service'));
  expect(await screen.findByTestId('series-move-notice')).toBeInTheDocument();
  expect(screen.queryByTestId('combo-move-scope')).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Move all of them together'));
  expect(screen.queryByTestId('series-move-notice')).not.toBeInTheDocument();
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(2));
  for (const [, options] of writes()) {
    const sent = JSON.parse(options.body);
    expect(sent.seriesAck).toBeUndefined();
    expect(sent.seriesAckIds).toBeUndefined();
  }
  // The edit runs before the move and sends no date: the plan stays
  // anchored to the stored one.
  expect(body(0)).not.toHaveProperty('scheduledDate');
});

it('a separation that committed is disclosed when the edit after it fails, and a retry never splits twice', async () => {
  fetch.mockImplementation(async (url, options) => (isPut(url, options)
    ? { ok: false, status: 500, json: async () => ({ error: 'boom' }) } : okJson(url)));
  const dialog = openCombo();
  setDate(dialog, '2035-01-03');
  fireEvent.click(screen.getByLabelText('Separate: move only this service'));
  await clickSave();
  expect(await screen.findByRole('alert')).toHaveTextContent('This service was separated from the stop, but the other changes were not saved. Save failed: boom');
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(3));
  expect(writeUrls().filter((u) => u.includes('/split'))).toHaveLength(1);
});

it('the move choice is frozen while a save is in flight', async () => {
  let release;
  fetch.mockImplementation(async (url, options) => (isPut(url, options)
    ? new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => ({}) }); })
    : okJson(url)));
  const dialog = openCombo();
  setDate(dialog, '2035-01-03');
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(screen.getByLabelText('Separate: move only this service')).toBeDisabled();
  expect(screen.getByLabelText('Move all of them together')).toBeDisabled();
  // The whole form is frozen for the save, not only the choice.
  expect(screen.getByTestId('edit-appointment-body')).toHaveAttribute('inert');
  await act(async () => release());
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(writeUrls()).toEqual([PUT, MOVE]);
});

it('a field edited while the details are saving stops the save before the stop is moved to a stale time', async () => {
  let release;
  fetch.mockImplementation(async (url, options) => (isPut(url, options)
    ? new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => ({}) }); })
    : okJson(url)));
  const dialog = openCombo();
  setDate(dialog, '2035-01-03');
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(1));
  setDate(dialog, '2035-01-04');
  await act(async () => release());
  expect(await screen.findByRole('alert')).toHaveTextContent('The other changes were saved, but the stop was not moved. Save failed: The form changed while that was saving. Review it and save again.');
  expect(writeUrls()).toEqual([PUT]);
});

it('a technician change rides the whole-stop move; the edit keeps the technician the stop is on', async () => {
  const dialog = openModal({ ...combo, technicianId: 'tech-1' }, [{ id: 'tech-1', name: 'Tech One' }, { id: 'tech-2', name: 'Tech Two' }]);
  setDate(dialog, '2035-01-03');
  const techSelect = [...dialog.querySelectorAll('select')].find((el) => [...el.options].some((o) => o.value === 'tech-2'));
  fireEvent.change(techSelect, { target: { value: 'tech-2' } });
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(body(0)).not.toHaveProperty('technicianId');
  expect(body(0).assignmentScope).toBeUndefined();
  expect(body(1).technicianId).toBe('tech-2');
});

it('the customer text is asked of the move, never of the edit; a repeated move that finds the stop already there says no new text went out', async () => {
  fetch.mockImplementation(async (url) => (String(url).includes('/reschedule')
    ? { ok: true, json: async () => ({ notificationSent: false, notificationSkipped: 'already_at_target', warnings: ['Fixture overlap warning.'] }) }
    : okJson(url)));
  const dialog = openCombo();
  setDate(dialog, '2035-01-03');
  const notify = [...dialog.querySelectorAll('select')].find((el) => [...el.options].some((o) => o.value === 'sms'));
  fireEvent.change(notify, { target: { value: 'sms' } });
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(body(0).notifyCustomer).toBeUndefined();
  expect(body(1).notifyCustomer).toBe(true);
  await waitFor(() => expect(saveNotice.shown).toHaveLength(1));
  expect(saveNotice.shown[0]).toContain('Fixture overlap warning.');
  expect(saveNotice.shown[0]).toContain('The stop was already at this time, so no new text was sent.');
});

it('the stop is read live on open: a row opened without a visit summary (Week, List, dispatch board) still gets the choice', async () => {
  fetch.mockImplementation(async (url) => (String(url).includes('/visit-summary')
    ? { ok: true, json: async () => ({ visit: combo.visit }) } : okJson(url)));
  const dialog = openModal(service);
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes('/admin/schedule/fixture-visit/visit-summary'))).toBe(true));
  setDate(dialog, '2035-01-03');
  expect(await screen.findByTestId('combo-move-choice')).toBeInTheDocument();
});

it('the live read wins over a stale summary: a stop that is no longer shared is an ordinary edit', async () => {
  fetch.mockImplementation(async (url) => (String(url).includes('/visit-summary')
    ? { ok: true, json: async () => ({ visit: null }) } : okJson(url)));
  const dialog = openCombo();
  setDate(dialog, '2035-01-03');
  await waitFor(() => expect(screen.queryByTestId('combo-move-choice')).not.toBeInTheDocument());
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writeUrls()).toEqual([PUT]);
});

it('a stop with one live service left (the other cancelled) is an ordinary visit: no choice, one ordinary save', async () => {
  const dialog = openModal({ ...combo, visit: { ...combo.visit, liveCount: 1 } });
  setDate(dialog, '2035-01-03');
  expect(screen.queryByTestId('combo-move-choice')).not.toBeInTheDocument();
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writeUrls()).toEqual([PUT]);
});

// ---- GitHub Codex round 4 on #5759 ----
it('the form is not frozen when no save is in flight', () => {
  openCombo();
  expect(screen.getByTestId('edit-appointment-body')).not.toHaveAttribute('inert');
});

it('an edit that still lands while the stop is moving is disclosed, never dropped silently', async () => {
  let release;
  fetch.mockImplementation(async (url) => (String(url).includes('/reschedule')
    ? new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => ({}) }); })
    : okJson(url)));
  const dialog = openCombo();
  setDate(dialog, '2035-01-03');
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(2));
  fireEvent.change(dialog.querySelector('textarea'), { target: { value: 'Typed during the move' } });
  await act(async () => release());
  await waitFor(() => expect(saveNotice.shown).toHaveLength(1));
  expect(saveNotice.shown[0]).toContain('The form was changed while the stop was moving. Those last changes were not saved');
});

it('a split whose response was lost is not repeated into a dead end: the stop is re-read and the edit is saved', async () => {
  let summaryReads = 0;
  fetch.mockImplementation(async (url) => {
    if (String(url).includes('/visit-summary')) {
      summaryReads += 1;
      // On open the stop is shared; after the lost split it no longer is.
      return { ok: true, json: async () => ({ visit: summaryReads === 1 ? combo.visit : null }) };
    }
    if (String(url).includes('/split')) return { ok: false, status: 404, json: async () => ({ error: 'row is not a member of this visit' }) };
    return okJson(url);
  });
  const dialog = openCombo();
  setDate(dialog, '2035-01-03');
  fireEvent.click(await screen.findByLabelText('Separate: move only this service'));
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(writeUrls()).toEqual(['POST /admin/visits/fixture-stop/split', PUT]);
  expect(body(1).scheduledDate).toBe('2035-01-03');
});

it('a split refused while the service is still on the stop saves nothing', async () => {
  fetch.mockImplementation(async (url) => {
    if (String(url).includes('/visit-summary')) return { ok: true, json: async () => ({ visit: combo.visit }) };
    if (String(url).includes('/split')) return { ok: false, status: 409, json: async () => ({ error: 'This visit is frozen' }) };
    return okJson(url);
  });
  const dialog = openCombo();
  setDate(dialog, '2035-01-03');
  fireEvent.click(await screen.findByLabelText('Separate: move only this service'));
  await clickSave();
  expect(await screen.findByRole('alert')).toHaveTextContent('Save failed: This visit is frozen');
  expect(writeUrls()).toEqual(['POST /admin/visits/fixture-stop/split']);
});

it('a shared stop the form did not know about: the server refusal re-reads the stop and shows the choice', async () => {
  let summaryReads = 0;
  let refuse = true;
  fetch.mockImplementation(async (url, options) => {
    if (String(url).includes('/visit-summary')) {
      summaryReads += 1;
      // The read on open fails; the read after the refusal answers.
      return summaryReads === 1 ? { ok: false, status: 500, json: async () => ({ error: 'down' }) } : { ok: true, json: async () => ({ visit: combo.visit }) };
    }
    if (isPut(url, options) && refuse) {
      return { ok: false, status: 409, json: async () => ({ error: 'This service is grouped with another at the same stop.', code: 'VISIT_EDIT_SCHEDULE_UNSUPPORTED' }) };
    }
    return okJson(url);
  });
  const dialog = openModal(service);
  setDate(dialog, '2035-01-03');
  expect(screen.queryByTestId('combo-move-choice')).not.toBeInTheDocument();
  await clickSave();
  expect(await screen.findByRole('alert')).toHaveTextContent('This stop has more than one service. Choose how to move it below the date and time, then save again. Nothing was changed.');
  expect(screen.getByTestId('combo-move-choice')).toBeInTheDocument();
  refuse = false;
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(3));
  expect(writeUrls()).toEqual([PUT, PUT, MOVE]);
});

it('a move that did not confirm (lost response or server error) is never reported as "not moved"', async () => {
  fetch.mockImplementation(async (url) => {
    if (String(url).includes('/reschedule')) throw new TypeError('Failed to fetch');
    return okJson(url);
  });
  const dialog = openCombo();
  setDate(dialog, '2035-01-03');
  await clickSave();
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('The other changes were saved. The move did not confirm, so the stop may or may not have moved: check the schedule');
  expect(alert).not.toHaveTextContent('but the stop was not moved');
});

// ---- GitHub Codex round 6 on #5759 (owner 2026-10-03: merge with known limits) ----
it('a combo with no set time can be given one: a filled start and end is a move, and only the start is sent', async () => {
  const dialog = openModal({ ...combo, windowStart: '', windowEnd: '', visit: { ...combo.visit, liveMemberIds: ['fixture-visit', 'fixture-lawn'] } });
  const [start, end] = dialog.querySelectorAll('input[type="time"]');
  fireEvent.change(start, { target: { value: '10:00' } });
  fireEvent.change(end, { target: { value: '11:00' } });
  expect(screen.getByTestId('combo-move-choice')).toBeInTheDocument();
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(writeUrls()).toEqual([PUT, MOVE]);
  expect(body(1).newWindow).toEqual({ start: '10:00' });
  expect(body(1).expectVisit.liveMemberIds).toEqual(['fixture-visit', 'fixture-lawn']);
});

