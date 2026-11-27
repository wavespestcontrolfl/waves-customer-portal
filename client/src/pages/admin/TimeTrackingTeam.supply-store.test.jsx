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

describe('TeamTab supply store', () => {
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

  it('shows the saved store on Edit and sends the typed text on Update (the server trims it)', async () => {
    const puts = setup({ ...BASE_TECH, supply_store: 'Synthetic Supply North' });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const input = screen.getByLabelText('Supply store');
    expect(input).toHaveValue('Synthetic Supply North');
    fireEvent.change(input, { target: { value: '  Synthetic Supply South ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].supplyStore).toBe('  Synthetic Supply South ');
  });

  it('a store that was never set sends nothing; one the office clears sends empty text, which the server stores as none', async () => {
    const puts = setup(BASE_TECH);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Supply store')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).not.toHaveProperty('supplyStore'); // left alone
  });

  it('clearing a saved store sends empty text', async () => {
    const puts = setup({ ...BASE_TECH, supply_store: 'Synthetic Supply North' });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Supply store'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].supplyStore).toBe('');
  });

  it('an edit of another field leaves the store out of the save, so a store another admin just set is never overwritten', async () => {
    const puts = setup({ ...BASE_TECH, supply_store: 'Synthetic Supply North' });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByDisplayValue('River Tech'), { target: { value: 'River T.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].name).toBe('River T.');
    expect(puts[0]).not.toHaveProperty('supplyStore');
  });

  it('typing the loaded store back unchanged sends nothing for it', async () => {
    const puts = setup({ ...BASE_TECH, supply_store: 'Synthetic Supply North' });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Supply store'), { target: { value: 'Synthetic Supply North' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).not.toHaveProperty('supplyStore');
  });
});
