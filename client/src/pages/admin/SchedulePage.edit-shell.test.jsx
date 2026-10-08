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

// ---- a stop shared by two services (owner rulings 2026-10-03) ----
// One request: the save carries the choice (`comboMove`) and the server does
// the edit, the whole-stop move and the text.
const combo = { ...service, visit: { id: 'fixture-stop', serviceCount: 2, liveCount: 2, memberIds: ['fixture-visit', 'fixture-lawn'], liveMemberIds: ['fixture-visit', 'fixture-lawn'], serviceTypes: ['Lawn Care', 'Pest Control'] } };
const writeUrls = () => writes().map(([url, options]) => `${options.method} ${String(url).replace(/^.*\/api/, '')}`);
const okJson = (url) => ({ ok: true, json: async () => (String(url).endsWith('/admin/discounts') ? [] : {}) });
const isPut = (url, options) => String(url).includes('/update-details') && !String(url).includes('/preview') && options?.method === 'PUT';
const PUT = 'PUT /admin/schedule/fixture-visit/update-details';
// The PUT answers `answer`; everything else answers as usual.
const putAnswers = (answer) => fetch.mockImplementation(async (url, options) => (isPut(url, options) ? answer(url, options) : okJson(url)));
const saved = (body) => ({ ok: true, json: async () => ({ success: true, ...body }) });
const openModal = (svc = combo, technicians = []) => {
  if (!fetch.getMockImplementation()) fetch.mockImplementation(async (url) => okJson(url));
  render(<EditServiceModal service={svc} technicians={technicians} onClose={vi.fn()} onSaved={vi.fn()} />);
  return screen.getByRole('dialog', { name: 'Edit appointment' });
};
const openCombo = () => openModal();
const setDate = (dialog, value) => fireEvent.change(dialog.querySelector('input[type="date"]'), { target: { value } });
const techSelectOf = (dialog) => [...dialog.querySelectorAll('select')].find((el) => [...el.options].some((o) => o.value === 'tech-2'));
const TECHS = [{ id: 'tech-1', name: 'Tech One' }, { id: 'tech-2', name: 'Tech Two' }];
// Save enables once the debounced money preview lands (see the save test above).
const clickSave = async () => {
  const save = screen.getByRole('button', { name: 'Save', exact: true });
  await waitFor(() => expect(save).toBeEnabled(), { timeout: 2000 });
  fireEvent.click(save);
};
const body = (index) => JSON.parse(writes()[index][1].body);

it('a combo edited without touching its date, time or technician saves as one ordinary edit', async () => {
  openCombo();
  expect(screen.queryByTestId('combo-move-choice')).not.toBeInTheDocument();
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writeUrls()).toEqual([PUT]);
  expect(body(0)).not.toHaveProperty('comboMove');
});

it('moving a combo together is ONE request that carries the choice and the new slot', async () => {
  const dialog = openCombo();
  setDate(dialog, '2035-01-03');
  const choice = screen.getByTestId('combo-move-choice');
  expect(choice).toHaveTextContent('This stop has 2 services (Lawn Care, Pest Control).');
  expect(within(choice).getByLabelText('Move all of them together')).toBeChecked();
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writeUrls()).toEqual([PUT]);
  expect(body(0)).toMatchObject({ comboMove: 'together', scheduledDate: '2035-01-03', windowStart: '08:00', windowEnd: '09:00' });
  // The stop this form showed rides along, so the server can refuse a changed one.
  expect(body(0).comboVisit).toEqual({ id: 'fixture-stop', memberIds: ['fixture-visit', 'fixture-lawn'], liveCount: 2, liveMemberIds: ['fixture-visit', 'fixture-lawn'] });
  // The whole-stop move owes no series ack.
  expect(body(0).seriesAck).toBeUndefined();
});

it('choosing Separate is the same one request with that choice', async () => {
  const dialog = openCombo();
  setDate(dialog, '2035-01-03');
  fireEvent.click(screen.getByLabelText('Separate: move only this service'));
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(body(0)).toMatchObject({ comboMove: 'separate', scheduledDate: '2035-01-03' });
});

it('a technician-only change on a combo asks too (owner ruling), and the request carries the choice and the technician', async () => {
  const dialog = openModal({ ...combo, technicianId: 'tech-1' }, TECHS);
  expect(screen.queryByTestId('combo-move-choice')).not.toBeInTheDocument();
  fireEvent.change(techSelectOf(dialog), { target: { value: 'tech-2' } });
  expect(within(screen.getByTestId('combo-move-choice')).getByLabelText('Move all of them together')).toBeChecked();
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(body(0)).toMatchObject({ comboMove: 'together', technicianId: 'tech-2', scheduledDate: '2035-01-02' });
});

it('the text choice rides the same request; warnings and a skipped text are shown with the saved notice', async () => {
  putAnswers(() => saved({ comboMove: { moved: true, warnings: ['Fixture overlap warning.'], notificationSent: false, notificationSkipped: 'already_at_target' } }));
  const dialog = openCombo();
  setDate(dialog, '2035-01-03');
  const notify = [...dialog.querySelectorAll('select')].find((el) => [...el.options].some((o) => o.value === 'sms'));
  fireEvent.change(notify, { target: { value: 'sms' } });
  await clickSave();
  await waitFor(() => expect(saveNotice.shown).toHaveLength(1));
  expect(body(0).notifyCustomer).toBe(true);
  expect(saveNotice.shown[0]).toContain('Fixture overlap warning.');
  expect(saveNotice.shown[0]).toContain('The stop was already at this time, so no new text was sent.');
});

it('a text that could not be sent is said so', async () => {
  putAnswers(() => saved({ comboMove: { moved: true, notificationSent: false, notificationError: 'the number is opted out' } }));
  const dialog = openCombo();
  setDate(dialog, '2035-01-03');
  const notify = [...dialog.querySelectorAll('select')].find((el) => [...el.options].some((o) => o.value === 'sms'));
  fireEvent.change(notify, { target: { value: 'sms' } });
  await clickSave();
  await waitFor(() => expect(saveNotice.shown).toHaveLength(1));
  expect(saveNotice.shown[0]).toContain('The customer was not texted about the move: the number is opted out.');
});

it('a move the server refused after saving the rest: the save counts (the details are saved) and the notice says the stop did not move', async () => {
  putAnswers(() => saved({ comboMove: { moved: false, error: 'That window is past the end of the workday.', code: 'INVALID_APPOINTMENT_WINDOW' } }));
  const onSaved = vi.fn();
  render(<EditServiceModal service={combo} technicians={[]} onClose={vi.fn()} onSaved={onSaved} />);
  setDate(screen.getByRole('dialog', { name: 'Edit appointment' }), '2035-01-03');
  await clickSave();
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(saveNotice.shown).toEqual(['The other changes were saved, but the stop was not moved: That window is past the end of the workday. Reopen the appointment to move it.']);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('a partly finished move and a move that did not confirm are each reported as such, never as "not moved"', async () => {
  let answer = { moved: false, needsAttention: { code: 'VISIT_MOVE_INCOMPLETE', message: 'Only part of this stop finished moving: fixture repair text.' } };
  putAnswers(() => saved({ comboMove: answer }));
  const first = openCombo();
  setDate(first, '2035-01-03');
  await clickSave();
  await waitFor(() => expect(saveNotice.shown).toHaveLength(1));
  expect(saveNotice.shown[0]).toBe('The other changes were saved. Only part of this stop finished moving: fixture repair text.');
  cleanup();
  answer = { moved: null, error: 'connection reset' };
  const second = openCombo();
  setDate(second, '2035-01-03');
  await clickSave();
  await waitFor(() => expect(saveNotice.shown).toHaveLength(2));
  expect(saveNotice.shown[1]).toContain('The move did not confirm, so the stop may or may not have moved: check the schedule.');
  expect(saveNotice.shown[1]).not.toContain('was not moved');
});

it('a refusal before anything was written is shown as the server said it', async () => {
  putAnswers(() => ({ ok: false, status: 409, json: async () => ({ error: 'This stop changed since it was opened. Nothing was changed.', code: 'VISIT_MEMBERSHIP_CHANGED' }) }));
  const dialog = openCombo();
  setDate(dialog, '2035-01-03');
  await clickSave();
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Save failed: This stop changed since it was opened. Nothing was changed.');
  expect(alert).not.toHaveTextContent('other changes were saved');
});

it('a length change with "together" is refused before the request; Separate may change it', async () => {
  const dialog = openCombo();
  const [, end] = dialog.querySelectorAll('input[type="time"]');
  setDate(dialog, '2035-01-03');
  fireEvent.change(end, { target: { value: '10:00' } });
  await clickSave();
  expect(await screen.findByRole('alert')).toHaveTextContent("Moving the whole stop keeps each service's length.");
  expect(writes()).toHaveLength(0);
  fireEvent.click(screen.getByLabelText('Separate: move only this service'));
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(body(0)).toMatchObject({ comboMove: 'separate', windowEnd: '10:00' });
});

it('a combo with no set time can be given one: a filled start and end is a move, not a length change', async () => {
  const dialog = openModal({ ...combo, windowStart: '', windowEnd: '' });
  const [start, end] = dialog.querySelectorAll('input[type="time"]');
  fireEvent.change(start, { target: { value: '10:00' } });
  fireEvent.change(end, { target: { value: '11:00' } });
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(body(0)).toMatchObject({ comboMove: 'together', windowStart: '10:00', windowEnd: '11:00' });
});

it('a recurring combo moved together moves this visit only: no "later visits" line, no series ack', async () => {
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
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(body(0).seriesAck).toBeUndefined();
  expect(body(0).seriesAckIds).toBeUndefined();
});

it('the whole form is frozen while a save is in flight', async () => {
  let release;
  putAnswers(() => new Promise((resolve) => { release = () => resolve(saved({})); }));
  const dialog = openCombo();
  expect(screen.getByTestId('edit-appointment-body')).not.toHaveAttribute('inert');
  setDate(dialog, '2035-01-03');
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(screen.getByLabelText('Separate: move only this service')).toBeDisabled();
  expect(screen.getByTestId('edit-appointment-body')).toHaveAttribute('inert');
  await act(async () => release());
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
  expect(body(0)).not.toHaveProperty('comboMove');
});

it('a stop with one live service left (the other cancelled) is an ordinary visit: no choice', async () => {
  const dialog = openModal({ ...combo, visit: { ...combo.visit, liveCount: 1 } });
  setDate(dialog, '2035-01-03');
  expect(screen.queryByTestId('combo-move-choice')).not.toBeInTheDocument();
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(body(0)).not.toHaveProperty('comboMove');
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
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(body(0)).not.toHaveProperty('comboMove');
  expect(body(1).comboMove).toBe('together');
});

it('a shared-stop save whose answer never arrives is not called a plain failed save', async () => {
  putAnswers(() => { throw new TypeError('Failed to fetch'); });
  const dialog = openCombo();
  setDate(dialog, '2035-01-03');
  await clickSave();
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('The save did not confirm, so it may or may not have gone through, including the move and any customer text. Close this and check the schedule before you save again.');
  expect(alert).not.toHaveTextContent('Save failed');
});

it('the money preview is told when the whole stop moves together, so it plans on the same date as the save', async () => {
  const dialog = openCombo();
  const previews = () => fetch.mock.calls.filter(([url]) => String(url).includes('/update-details/preview')).map(([, options]) => JSON.parse(options.body));
  setDate(dialog, '2035-01-03');
  await waitFor(() => expect(previews().some((b) => b.comboMove === 'together' && b.scheduledDate === '2035-01-03')).toBe(true), { timeout: 3000 });
  fireEvent.click(screen.getByLabelText('Separate: move only this service'));
  await waitFor(() => expect(previews().at(-1)).not.toHaveProperty('comboMove'), { timeout: 3000 });
});

// ---- Codex round 6 on #5838 (owner 2026-10-03: refuse the two risky mixes, then merge) ----
it('together + a technician change on a recurring combo: the scope picker is hidden and the request says this visit only', async () => {
  const dialog = openModal({ ...combo, technicianId: 'tech-1', isRecurring: true, recurringPattern: 'quarterly', recurringParentId: 'series-1' }, TECHS);
  fireEvent.change(techSelectOf(dialog), { target: { value: 'tech-2' } });
  expect(screen.getByTestId('combo-move-scope')).toHaveTextContent('Only this visit moves and changes technician. Later visits in the plan stay where they are, with their technician.');
  expect(screen.queryByText('Apply staff change to')).not.toBeInTheDocument();
  await clickSave();
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(body(0)).toMatchObject({ comboMove: 'together', technicianId: 'tech-2', assignmentScope: 'this_only' });
});

// Auto-dispatch lock box: recurring occurrences only; its own PATCH after update-details.
const occurrence = { ...service, isRecurring: true, recurringParentId: 'fixture-parent', autoDispatchLocked: true };
const lockCalls = () => fetch.mock.calls.filter(([url]) => String(url).endsWith('/admin/auto-dispatch/services/fixture-visit/lock'));

const asRole = (role) => localStorage.setItem('waves_admin_user', JSON.stringify({ role }));

it('hides the auto-dispatch box from a technician: the lock endpoint is admin-only', () => {
  asRole('technician');
  render(<EditServiceModal service={occurrence} technicians={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(screen.queryByText('Keep auto-dispatch off this visit')).not.toBeInTheDocument();
  localStorage.removeItem('waves_admin_user');
});

it('shows the auto-dispatch box checked for a locked recurring occurrence and hides it for a one-off visit', () => {
  asRole('admin');
  const view = render(<EditServiceModal service={occurrence} technicians={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(screen.getByLabelText(/Keep auto-dispatch off this visit/)).toBeChecked();
  view.unmount();
  render(<EditServiceModal service={service} technicians={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(screen.queryByText('Keep auto-dispatch off this visit')).not.toBeInTheDocument();
});

it('clearing the auto-dispatch box locks false after update-details, and an untouched box makes no lock call', async () => {
  asRole('admin');
  fetch.mockImplementation(async (url) => ({ ok: true, json: async () => (String(url).endsWith('/admin/discounts') ? [] : {}) }));
  const onSaved = vi.fn();
  const view = render(<EditServiceModal service={occurrence} technicians={[]} onClose={vi.fn()} onSaved={onSaved} />);
  const save = screen.getByRole('button', { name: 'Save', exact: true });
  await waitFor(() => expect(save).toBeEnabled(), { timeout: 2000 });
  fireEvent.click(screen.getByLabelText(/Keep auto-dispatch off this visit/));
  fireEvent.click(save);
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  const urls = writes().map(([url]) => String(url));
  expect(urls.findIndex((u) => u.endsWith('/update-details'))).toBeLessThan(urls.findIndex((u) => u.endsWith('/lock')));
  expect(lockCalls()).toHaveLength(1);
  expect(lockCalls()[0][1].method).toBe('PATCH');
  expect(JSON.parse(lockCalls()[0][1].body)).toEqual({ locked: false });
  view.unmount();
  fetch.mockClear();
  const onSaved2 = vi.fn();
  render(<EditServiceModal service={occurrence} technicians={[]} onClose={vi.fn()} onSaved={onSaved2} />);
  const save2 = screen.getByRole('button', { name: 'Save', exact: true });
  await waitFor(() => expect(save2).toBeEnabled(), { timeout: 2000 });
  fireEvent.click(save2);
  await waitFor(() => expect(onSaved2).toHaveBeenCalledOnce());
  expect(lockCalls()).toHaveLength(0);
});
