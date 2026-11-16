// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PayrollSettings from './PayrollSettings';
import { adminFetch } from '../../lib/adminFetch';

vi.mock('../../lib/adminFetch', () => ({ adminFetch: vi.fn() }));

const reply = (body, ok = true, status = ok ? 200 : 400) => Promise.resolve({ ok, status, json: async () => body });
const TECHS = [{ id: 'tech-a', name: 'Sample Alpha', payRate: '23.00', payMethod: 'check', employmentStatus: 'active', currentW4: null }];
const STEP = (over = {}) => ({
  id: 'step-1', technicianId: 'tech-a', effectiveOn: '2027-04-05', hourlyRate: '25.00', previousRate: null,
  status: 'scheduled', appliedAt: null, cancelledAt: null, note: 'After day 90', createdAt: '2026-11-09T15:00:00.000Z', ...over,
});
const STEPS_PATH = '/admin/payroll/technicians/tech-a/rate-steps';

let steps;
let suggested;
let calls;
let refusal;
// The dialog compares the day-90 Monday with today's Eastern date, so the clock is fixed: the dates in
// this file stay "ahead" or "past" for good. Only Date is faked; timers stay real for waitFor.
const NOW = new Date('2026-11-09T15:00:00.000Z');
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  steps = []; suggested = '2027-04-05'; calls = []; refusal = null;
  adminFetch.mockReset();
  adminFetch.mockImplementation((path, options = {}) => {
    if (path === '/admin/payroll/technicians') return reply({ technicians: TECHS });
    if (path === '/admin/payroll/runs') return reply({ runs: [] });
    if (path === STEPS_PATH && !options.method) return reply({ steps, suggestedDay90Monday: suggested });
    if (path.includes('rate-step')) {
      calls.push({ path, method: options.method, body: options.body });
      if (refusal) return reply({ error: refusal.message }, false, refusal.status);
      return reply({ step: STEP() }, true, options.method === 'POST' ? 201 : 200);
    }
    return reply({}, false, 404);
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function openDialog() {
  render(<PayrollSettings />);
  await screen.findByText('Sample Alpha');
  fireEvent.click(screen.getByRole('button', { name: 'Pay rate change' }));
  return screen.findByRole('dialog');
}
const listIn = async dialog => within(await within(dialog).findByRole('list', { name: /Pay rate changes/ }));

describe('Pay rate changes', () => {
  it('fetches nothing for a row until the dialog opens', async () => {
    render(<PayrollSettings />);
    await screen.findByText('Sample Alpha');
    expect(adminFetch.mock.calls.some(([path]) => path.includes('rate-steps'))).toBe(false);
  });

  it('shows the pay rate now and each step with its status in words, the replaced rate and the note', async () => {
    steps = [
      STEP(),
      STEP({ id: 'step-2', effectiveOn: '2026-12-07', hourlyRate: '23.00', previousRate: '22.00', status: 'applied', appliedAt: '2026-12-07T10:00:00Z', note: null }),
      STEP({ id: 'step-3', effectiveOn: '2026-10-05', hourlyRate: '30.00', status: 'cancelled', cancelledAt: '2026-10-01T10:00:00Z', note: null }),
    ];
    const dialog = await openDialog();
    expect(dialog).toHaveTextContent('Pay rate now: $23.00/hr');
    const items = (await listIn(dialog)).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('$25.00/hr from Apr 5, 2027');
    expect(items[0]).toHaveTextContent('Scheduled');
    expect(items[0]).toHaveTextContent('After day 90');
    expect(items[1]).toHaveTextContent('Applied');
    expect(items[1]).toHaveTextContent('Replaced $22.00/hr');
    expect(items[2]).toHaveTextContent('Cancelled');
  });

  it('prefills the day-90 Monday only when no step is scheduled', async () => {
    let dialog = await openDialog();
    await waitFor(() => expect(within(dialog).getByLabelText(/First pay week/)).toHaveValue('2027-04-05'));
    expect(dialog).toHaveTextContent('The first full pay week after day 90');
    cleanup();
    steps = [STEP()];
    dialog = await openDialog();
    await listIn(dialog);
    expect(within(dialog).getByLabelText(/First pay week/)).toHaveValue('');
  });

  it('leaves the date empty when the day-90 Monday is already past (the server would refuse it)', async () => {
    suggested = '2020-04-06';
    const dialog = await openDialog();
    expect(within(dialog).getByLabelText(/First pay week/)).toHaveValue('');
    expect(within(dialog).getByText('Must be a Monday after today.')).toBeInTheDocument();
  });

  it('posts the typed rate, date and note, then reloads the list and the row', async () => {
    const dialog = await openDialog();
    const view = within(dialog);
    await waitFor(() => expect(view.getByLabelText(/First pay week/)).toHaveValue('2027-04-05'));
    fireEvent.change(view.getByLabelText(/New hourly rate/), { target: { value: '25.00' } });
    fireEvent.change(view.getByLabelText('Note'), { target: { value: 'After day 90' } });
    steps = [STEP()];
    fireEvent.click(view.getByRole('button', { name: 'Save pay rate change' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ path: STEPS_PATH, method: 'POST', body: { effectiveOn: '2027-04-05', hourlyRate: '25.00', note: 'After day 90' } });
    expect((await listIn(dialog)).getByRole('listitem')).toHaveTextContent('Scheduled');
    // The row under the button names the scheduled step.
    expect(within(screen.getByText('Sample Alpha').closest('tr')).getByText('$25.00/hr from Apr 5, 2027')).toBeInTheDocument();
    expect(adminFetch.mock.calls.filter(([path]) => path === '/admin/payroll/technicians').length).toBeGreaterThan(1);
  });

  it('keeps Save off until a rate and a date are typed', async () => {
    const dialog = await openDialog();
    const save = await within(dialog).findByRole('button', { name: 'Save pay rate change' });
    expect(save).toBeDisabled();
  });

  it.each([[400, 'Start date must be a Monday'], [409, 'A step already exists for that date']])('shows the server %i message and keeps the form', async (status, message) => {
    refusal = { status, message };
    const dialog = await openDialog();
    const view = within(dialog);
    await waitFor(() => expect(view.getByLabelText(/First pay week/)).toHaveValue('2027-04-05'));
    fireEvent.change(view.getByLabelText(/New hourly rate/), { target: { value: '25' } });
    fireEvent.click(view.getByRole('button', { name: 'Save pay rate change' }));
    expect(await view.findByRole('alert')).toHaveTextContent(message);
    expect(view.getByLabelText(/New hourly rate/)).toHaveValue('25');
  });

  it('cancels a scheduled step only after the confirm, then reloads', async () => {
    steps = [STEP()];
    const dialog = await openDialog();
    const view = within(dialog);
    fireEvent.click(await view.findByRole('button', { name: 'Cancel this change' }));
    expect(calls).toHaveLength(0);
    fireEvent.click(within(view.getByRole('group', { name: /Confirm cancel/ })).getByRole('button', { name: 'Yes, cancel this change' }));
    steps = [STEP({ status: 'cancelled', cancelledAt: '2026-11-09T16:00:00Z' })];
    await waitFor(() => expect(calls).toEqual([{ path: '/admin/payroll/rate-steps/step-1', method: 'DELETE', body: undefined }]));
    await waitFor(() => expect(view.queryByRole('button', { name: 'Cancel this change' })).toBeNull());
    expect((await listIn(dialog)).getByRole('listitem')).toHaveTextContent('Cancelled');
  });

  it('offers no cancel on an applied or cancelled step', async () => {
    steps = [STEP({ status: 'applied', previousRate: '22.00' }), STEP({ id: 'step-2', status: 'cancelled' })];
    const dialog = await openDialog();
    await listIn(dialog);
    expect(within(dialog).queryByRole('button', { name: 'Cancel this change' })).toBeNull();
  });
});
