// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../components/AddressAutocomplete', () => ({ default: () => null }));

import { TeamTab } from './TimeTrackingPage';

// GATE_TECH_SHIFT_HOURS (owner 2026-11-19, page item D4): the Team tab "Shift
// hours" row (a start and an end time), shown only when the server says the
// gate is on.
const BASE_TECH = {
  id: 'tech-1', name: 'River Tech', email: 'river@example.com', role: 'technician',
  active: true, employment_status: 'active', field_dispatchable: true,
};

// `reply`: what the save's answer carries besides the route's fixed keys.
function setup(tech, { enabled = true, reply = {} } = {}) {
  const writes = [];
  const showToast = vi.fn();
  vi.stubGlobal('fetch', vi.fn((url, options = {}) => {
    if (options.method === 'PUT' || options.method === 'POST') {
      writes.push({ method: options.method, body: JSON.parse(options.body) });
      // The route's shape: a create answers with the new row (the save handler reads its id).
      return Promise.resolve({
        ok: true,
        json: async () => ({
          success: true,
          futureAssignedVisits: [],
          ...(options.method === 'POST' ? { technician: { id: 'tech-new' } } : {}),
          ...reply,
        }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ technicians: [tech], ...(enabled ? { shiftHoursEnabled: true } : {}) }),
    });
  }));
  render(<TeamTab showToast={showToast} />);
  return { writes, showToast };
}

const start = () => screen.getByLabelText('Shift start');
const end = () => screen.getByLabelText('Shift end');

describe('TeamTab shift hours', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('waves_admin_token', 'admin-token');
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('gate off: no row, no summary, and nothing about shift hours is sent', async () => {
    const { writes } = setup({ ...BASE_TECH, shift_start: '08:00', shift_end: '18:00' }, { enabled: false });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.queryByLabelText('Shift start')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Shift \d/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body).not.toHaveProperty('shiftHours');
  });

  it('shows the saved hours on the row and loads them into the editor', async () => {
    setup({ ...BASE_TECH, shift_start: '07:00', shift_end: '17:30' });
    expect(await screen.findByText('Shift 7:00 AM–5:30 PM')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(start()).toHaveValue('07:00');
    expect(end()).toHaveValue('17:30');
  });

  it('reads midnight and noon as 12 AM and 12 PM', async () => {
    setup({ ...BASE_TECH, shift_start: '00:30', shift_end: '12:00' });
    expect(await screen.findByText('Shift 12:30 AM–12:00 PM')).toBeInTheDocument();
  });

  it('a row with no set hours says nothing and loads both times empty', async () => {
    setup({ ...BASE_TECH, shift_start: null, shift_end: null });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.queryByText(/^Shift \d/)).not.toBeInTheDocument();
    expect(start()).toHaveValue('');
    expect(end()).toHaveValue('');
  });

  it('sends the edited hours as { start, end }', async () => {
    const { writes } = setup({ ...BASE_TECH, shift_start: null, shift_end: null });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(start(), { target: { value: '08:00' } });
    fireEvent.change(end(), { target: { value: '18:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body.shiftHours).toEqual({ start: '08:00', end: '18:00' });
  });

  // The server lists the coming visits the new hours do not hold; they stay where they are.
  const saveHours = async (reply) => {
    const { writes, showToast } = setup({ ...BASE_TECH, shift_start: null, shift_end: null }, { reply });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(start(), { target: { value: '08:00' } });
    fireEvent.change(end(), { target: { value: '12:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    return showToast.mock.calls;
  };
  const listed = (count) => Array.from({ length: count }, (_, i) => ({ id: `visit-${i}`, scheduledDate: '2031-03-03', serviceType: 'Pest Control', customerName: 'Synthetic One' }));

  it('new hours that leave visits outside them: the toast gives the count and where to act', async () => {
    expect(await saveHours({ outsideShiftVisits: listed(3) }))
      .toEqual([['Technician updated — 3 upcoming visits outside the new shift hours; move or reassign on the Schedule']]);
  });

  it('one visit outside the new hours reads in the singular', async () => {
    expect(await saveHours({ outsideShiftVisits: listed(1) }))
      .toEqual([['Technician updated — 1 upcoming visit outside the new shift hours; move or reassign on the Schedule']]);
  });

  it('new hours that hold every visit, or an answer with no list: the plain toast', async () => {
    expect(await saveHours({ outsideShiftVisits: [] })).toEqual([['Technician updated']]);
    cleanup();
    expect(await saveHours({})).toEqual([['Technician updated']]);
  });

  it('a technician who leaves the pool in the same save: the still-assigned line wins', async () => {
    expect(await saveHours({ futureAssignedVisits: listed(2), outsideShiftVisits: listed(1) }))
      .toEqual([['Technician updated — 2 upcoming visits still assigned; reassign on the Schedule']]);
  });

  it('an edit that leaves the hours as loaded sends no shiftHours (the saved hours stand)', async () => {
    const { writes } = setup({ ...BASE_TECH, shift_start: '08:00', shift_end: '18:00' });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByPlaceholderText('e.g. John D.'), { target: { value: 'River Tech Jr' } });
    // Changed and changed back is unchanged too.
    fireEvent.change(end(), { target: { value: '17:00' } });
    fireEvent.change(end(), { target: { value: '18:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body.name).toBe('River Tech Jr');
    expect(writes[0].body).not.toHaveProperty('shiftHours');
  });

  it('Clear empties both times and sends null (no set hours)', async () => {
    const { writes } = setup({ ...BASE_TECH, shift_start: '08:00', shift_end: '18:00' });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(start()).toHaveValue('');
    expect(end()).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body.shiftHours).toBeNull();
  });

  it.each([
    ['only a start', '08:00', '', 'Enter both shift times, or clear both'],
    ['an end before the start', '18:00', '08:00', 'The shift must end after it starts'],
    ['an end equal to the start', '08:00', '08:00', 'The shift must end after it starts'],
  ])('%s shows why and blocks the save', async (_label, from, to, message) => {
    const { writes } = setup({ ...BASE_TECH, shift_start: null, shift_end: null });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(start(), { target: { value: from } });
    fireEvent.change(end(), { target: { value: to } });
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    const update = screen.getByRole('button', { name: 'Update' });
    expect(update).toBeDisabled();
    fireEvent.click(update);
    expect(writes).toHaveLength(0);
  });

  it('the add form starts empty and posts null', async () => {
    const { writes, showToast } = setup(BASE_TECH);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add Technician' }));
    expect(start()).toHaveValue('');
    fireEvent.change(screen.getByPlaceholderText('e.g. John D.'), { target: { value: 'New Tech' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].method).toBe('POST');
    expect(writes[0].body.shiftHours).toBeNull();
    // The save ran to its end: one toast, the success one, and the form closed.
    await waitFor(() => expect(screen.queryByLabelText('Shift start')).not.toBeInTheDocument());
    expect(showToast.mock.calls).toEqual([['Technician added']]);
  });

  it('the add form posts the hours the admin typed', async () => {
    const { writes, showToast } = setup(BASE_TECH);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add Technician' }));
    fireEvent.change(screen.getByPlaceholderText('e.g. John D.'), { target: { value: 'New Tech' } });
    fireEvent.change(start(), { target: { value: '07:00' } });
    fireEvent.change(end(), { target: { value: '17:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body.shiftHours).toEqual({ start: '07:00', end: '17:00' });
    await waitFor(() => expect(screen.queryByLabelText('Shift start')).not.toBeInTheDocument());
    expect(showToast.mock.calls).toEqual([['Technician added']]);
  });

  // The edit above sends no shiftHours while nothing changed, gate on or off,
  // so only the add form shows that the gate itself keeps the field off the wire.
  it('gate off: the add form has no row and posts nothing about shift hours', async () => {
    const { writes, showToast } = setup(BASE_TECH, { enabled: false });
    fireEvent.click(await screen.findByRole('button', { name: '+ Add Technician' }));
    expect(screen.queryByLabelText('Shift start')).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('e.g. John D.'), { target: { value: 'New Tech' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].method).toBe('POST');
    expect(writes[0].body.name).toBe('New Tech');
    expect(writes[0].body).not.toHaveProperty('shiftHours');
    // The form's own fields never travel, whatever the gate says.
    expect(writes[0].body).not.toHaveProperty('shiftStart');
    expect(writes[0].body).not.toHaveProperty('shiftEnd');
    await waitFor(() => expect(screen.queryByPlaceholderText('e.g. John D.')).not.toBeInTheDocument());
    expect(showToast.mock.calls).toEqual([['Technician added']]);
  });
});
