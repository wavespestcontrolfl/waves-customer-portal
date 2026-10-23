// @vitest-environment jsdom
// The address picker's selected coordinates travel with a staff-added service address (the county reclaimed-water match and the route
// planner read them), only while the typed address is still the selected one.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The picker is stubbed: a field that types like the real one, and a button that "selects" a Places result.
vi.mock('../AddressAutocomplete', () => ({
  __esModule: true,
  sameAutocompleteAddress: (previous, parts) => String(previous?.line1 || '').toLowerCase() === String(parts?.line1 || '').toLowerCase(),
  default: ({ id, value, onChange, onSelect }) => (
    <div>
      <input id={id} aria-label="Street address" value={value} onChange={(e) => onChange(e.target.value)} />
      <button type="button" onClick={() => onSelect(window.__PICK__)}>Pick</button>
    </div>
  ),
}));
import CustomerPropertiesPanelV2 from './CustomerPropertiesPanelV2';

const PRIMARY = { id: 'p1', address_line1: '10 Palm Ave', city: 'Naples', state: 'FL', zip: '34102', is_primary: true, occupancy_type: 'unknown', label: null };
const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

async function openAndPick(pick) {
  window.__PICK__ = pick;
  const fetchMock = vi.fn((url, opts = {}) => (opts.method === 'POST'
    ? json({ properties: [PRIMARY] }, 201) : json({ properties: [PRIMARY] })));
  vi.stubGlobal('fetch', fetchMock);
  render(<CustomerPropertiesPanelV2 customerId="c1" canEdit />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add service address' }));
  fireEvent.click(screen.getByRole('button', { name: 'Pick' }));
  return fetchMock;
}
const posted = (fetchMock) => JSON.parse(fetchMock.mock.calls.find(([, o]) => o?.method === 'POST')[1].body);
const save = async (fetchMock) => {
  fireEvent.click(screen.getByRole('button', { name: 'Save address' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'POST')).toBe(true));
  return posted(fetchMock);
};
const PARTS = { line1: '30 Bay Rd', line2: '', city: 'Parrish', state: 'FL', zip: '34219', lat: 27.5821, lng: -82.4276 };

describe('CustomerPropertiesPanelV2: coordinates of a picked address', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete window.__PICK__; });

  it('sends the selected lat/lng with the new address', async () => {
    const fetchMock = await openAndPick(PARTS);
    const body = await save(fetchMock);
    expect(body).toMatchObject({ address_line1: '30 Bay Rd', city: 'Parrish', state: 'FL', zip: '34219', latitude: 27.5821, longitude: -82.4276 });
  });

  it('sends none when the pick had no coordinates, or the street was edited after the pick', async () => {
    let fetchMock = await openAndPick({ ...PARTS, lat: null, lng: null });
    expect(await save(fetchMock)).not.toHaveProperty('latitude');
    cleanup(); vi.unstubAllGlobals();
    fetchMock = await openAndPick(PARTS);
    fireEvent.change(screen.getByLabelText('Street address'), { target: { value: '32 Bay Rd' } });
    const body = await save(fetchMock);
    expect(body).toMatchObject({ address_line1: '32 Bay Rd' });
    expect(body).not.toHaveProperty('latitude');
    expect(body).not.toHaveProperty('longitude');
  });

  it('typing an address by hand (no pick) sends no coordinates', async () => {
    window.__PICK__ = PARTS;
    const fetchMock = vi.fn((url, opts = {}) => (opts.method === 'POST' ? json({ properties: [PRIMARY] }, 201) : json({ properties: [PRIMARY] })));
    vi.stubGlobal('fetch', fetchMock);
    render(<CustomerPropertiesPanelV2 customerId="c1" canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add service address' }));
    fireEvent.change(screen.getByLabelText('Street address'), { target: { value: '40 Hand St' } });
    fireEvent.change(document.getElementById('cp-city'), { target: { value: 'Parrish' } });
    fireEvent.change(document.getElementById('cp-zip'), { target: { value: '34219' } });
    const body = await save(fetchMock);
    expect(body).toMatchObject({ address_line1: '40 Hand St' });
    expect(body).not.toHaveProperty('latitude');
  });
});
