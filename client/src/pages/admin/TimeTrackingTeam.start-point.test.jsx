// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real component needs Google Places; this stub lets a test "pick" a suggestion.
vi.mock('../../components/AddressAutocomplete', () => ({
  default: ({ value, onChange, onSelect, ...rest }) => (
    <div>
      <input aria-label={rest['aria-label']} value={value} onChange={(e) => onChange(e.target.value)} />
      <button type="button" onClick={() => onSelect({
        formatted: '100 Example Way, Bradenton, FL 34205, USA',
        line1: '100 Example Way', city: 'Bradenton', state: 'FL', zip: '34205',
        lat: 27.498928, lng: -82.574819,
      })}>pick-suggestion</button>
      <button type="button" onClick={() => onSelect({ formatted: '200 Example Way', lat: null, lng: null })}>pick-no-coords</button>
    </div>
  ),
}));

import { TeamTab } from './TimeTrackingPage';

const BASE_TECH = {
  id: 'tech-1', name: 'River Tech', email: 'river@example.com', role: 'technician',
  active: true, employment_status: 'active', field_dispatchable: true,
};

function setup(tech) {
  const puts = [];
  const fetchMock = vi.fn((url, options = {}) => {
    if (options.method === 'PUT') {
      puts.push(JSON.parse(options.body));
      return Promise.resolve({ ok: true, json: async () => ({ success: true, futureAssignedVisits: [] }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ technicians: [tech] }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<TeamTab showToast={vi.fn()} />);
  return puts;
}

describe('TeamTab start point', () => {
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

  it('defaults to Office, shows "Starts: office", and sends startPoint null', async () => {
    const puts = setup(BASE_TECH);
    expect(await screen.findByText('Starts: office')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Starts the day from')).toHaveValue('office');
    expect(screen.queryByLabelText('Home address')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].startPoint).toBeNull();
    expect(puts[0]).not.toHaveProperty('startMode');
    expect(puts[0]).not.toHaveProperty('startText');
  });

  it('Home needs a picked suggestion: free text and coordinate-less picks keep Update disabled', async () => {
    const puts = setup(BASE_TECH);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Starts the day from'), { target: { value: 'home' } });
    const update = screen.getByRole('button', { name: 'Update' });
    expect(update).toBeDisabled();
    expect(screen.getByText('Pick the address from the list')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Home address'), { target: { value: '100 Example Way' } });
    expect(update).toBeDisabled();
    fireEvent.click(screen.getByText('pick-no-coords'));
    expect(update).toBeDisabled();
    expect(puts).toHaveLength(0);
  });

  it('picking an address enables Update and sends { address, lat, lng }', async () => {
    const puts = setup(BASE_TECH);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Starts the day from'), { target: { value: 'home' } });
    fireEvent.click(screen.getByText('pick-suggestion'));
    expect(screen.queryByText('Pick the address from the list')).not.toBeInTheDocument();
    const update = screen.getByRole('button', { name: 'Update' });
    expect(update).toBeEnabled();
    fireEvent.click(update);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].startPoint).toEqual({
      address: '100 Example Way, Bradenton, FL 34205, USA', lat: 27.498928, lng: -82.574819,
    });
  });

  it('editing the text after a pick drops the coordinates', async () => {
    setup(BASE_TECH);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Starts the day from'), { target: { value: 'home' } });
    fireEvent.click(screen.getByText('pick-suggestion'));
    fireEvent.change(screen.getByLabelText('Home address'), { target: { value: '100 Example Way, Brad' } });
    expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled();
  });

  it('shows a saved home point on the row, seeds the form from it, and Office clears it', async () => {
    const puts = setup({
      ...BASE_TECH,
      start_address: '100 Example Way, Bradenton, FL 34205, USA',
      start_lat: 27.498928,
      start_lng: -82.574819,
    });
    expect(await screen.findByText('Starts: home, 100 Example Way, Bradenton')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Starts the day from')).toHaveValue('home');
    expect(screen.getByLabelText('Home address')).toHaveValue('100 Example Way, Bradenton, FL 34205, USA');
    expect(screen.getByRole('button', { name: 'Update' })).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Starts the day from'), { target: { value: 'office' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].startPoint).toBeNull();
  });

  it('the add form has no start-point field', async () => {
    setup(BASE_TECH);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add Technician' }));
    expect(screen.queryByLabelText('Starts the day from')).not.toBeInTheDocument();
  });
});

// GATE_TECH_MOVE_SWITCH (owner 2026-10-25): the per-technician "Can move visits"
// switch loads from the row and rides the Team save as canMoveVisits.
describe('TeamTab Can move visits', () => {
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

  it('shows the saved switch and sends the change on Update', async () => {
    const puts = setup({ ...BASE_TECH, can_move_visits: false });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('checkbox', { name: /Can move visits/ });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].canMoveVisits).toBe(true);
  });

  it('a technician who can move visits loads ticked and saves unchanged', async () => {
    const puts = setup({ ...BASE_TECH, can_move_visits: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('checkbox', { name: /Can move visits/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].canMoveVisits).toBe(true);
  });
});

describe('TeamTab Can move visits, unknown value', () => {
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

  it('a row without the switch saves without canMoveVisits, so an edit never turns moves off', async () => {
    const puts = setup(BASE_TECH);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).not.toHaveProperty('canMoveVisits');
  });
});
