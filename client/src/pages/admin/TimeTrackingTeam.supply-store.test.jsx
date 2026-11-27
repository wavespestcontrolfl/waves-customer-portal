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

  it('a blank store is sent as empty text, which the server stores as none', async () => {
    const puts = setup(BASE_TECH);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Supply store')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].supplyStore).toBe('');
  });
});
