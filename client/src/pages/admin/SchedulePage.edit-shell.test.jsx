// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditServiceModal } from './SchedulePage';

vi.mock('../../components/schedule/useSlotConflicts', () => ({ useSlotConflicts: () => ({ conflicts: [] }) }));
vi.mock('../../components/schedule/useBestTimes', () => ({ useBestTimes: () => ({ bestTimes: [], picked: null, bestInRange: [] }) }));
const service = { id: 'fixture-visit', customerId: 'fixture-account', customerName: 'Fixture account', serviceType: 'Pest Control', scheduledDate: '2035-01-02', windowStart: '08:00', windowEnd: '09:00', status: 'confirmed', notes: 'Existing note' };
const writes = () => fetch.mock.calls.filter(([, options]) => options?.method && options.method !== 'GET');

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));

});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

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
  fireEvent.click(save);
  fireEvent.click(save);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(writes()).toHaveLength(1);
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
