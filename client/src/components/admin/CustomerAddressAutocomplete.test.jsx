// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CustomerPropertiesPanelV2 from './CustomerPropertiesPanelV2';
import Customer360ProfileV2 from './Customer360ProfileV2';
import AddressAutocomplete from '../AddressAutocomplete';

vi.mock('./StickyActionBar', () => ({ CustomerActionBar: () => null }));
vi.mock('../../pages/admin/SchedulePage', () => ({ ZoneMarkingStep: () => null, StationMarkingStep: () => null }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlagReady: () => ({ enabled: false, ready: true }) }));

let selectPlace;
let fetchMock;
let remove;
let Autocomplete;
const component = (type, value) => ({ types: [type], long_name: value, short_name: value });
const place = (unit = '') => ({
  formatted_address: '100 Example Street, Sarasota, FL 34236',
  address_components: [component('street_number', '100'), component('route', 'Example Street'), component('locality', 'Sarasota'), component('administrative_area_level_1', 'FL'), component('postal_code', '34236'), component('subpremise', unit)],
});
const detail = { customer: { id: 'fixture', firstName: 'Test', lastName: 'Account', active: true, address: { line1: '200 Example Road', line2: 'Old unit', city: 'Venice', state: 'FL', zip: '34285' } } };

beforeEach(() => {
  vi.stubEnv('VITE_GATE_ADMIN_ADDRESS_AUTOCOMPLETE', 'true');
  vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'synthetic-key');
  localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
  remove = vi.fn();
  Autocomplete = vi.fn(function () {
    let selected;
    this.addListener = (_name, callback) => {
      selectPlace = (p) => { selected = p; act(callback); };
      return { remove };
    };
    this.getPlace = () => selected;
    this.unbindAll = vi.fn();
  });
  vi.stubGlobal('google', { maps: { places: { Autocomplete }, Geocoder: vi.fn() } });
  fetchMock = vi.fn(async (url) => new Response(JSON.stringify(
    String(url).endsWith('/properties') ? { properties: [] } :
    String(url).endsWith('/fixture') ? detail : {}
  ), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('fills and explicitly saves a property, preserving a manually entered unit', async () => {
  render(<CustomerPropertiesPanelV2 customerId="fixture" canEdit />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add service address' }));
  fireEvent.change(screen.getByLabelText('Unit / line 2'), { target: { value: 'Suite 2' } });
  selectPlace(place());
  expect(screen.getByLabelText('Street address')).toHaveValue('100 Example Street');
  expect(screen.getByLabelText('City')).toHaveValue('Sarasota');
  expect(screen.getByLabelText('ZIP')).toHaveValue('34236');
  expect(screen.getByLabelText('Unit / line 2')).toHaveFocus();
  expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'POST')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Save address' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'POST')).toBe(true));
  const body = JSON.parse(fetchMock.mock.calls.find(([, o]) => o?.method === 'POST')[1].body);
  expect(body).toMatchObject({ address_line1: '100 Example Street', address_line2: 'Suite 2', city: 'Sarasota', state: 'FL', zip: '34236' });
});

it('replaces the primary address without carrying the old unit to another property', async () => {
  render(<Customer360ProfileV2 customerId="fixture" onClose={() => {}} />);
  fireEvent.click((await screen.findAllByRole('button', { name: /^edit$/i }))[0]);
  selectPlace(place());
  expect(screen.getByLabelText('Address')).toHaveValue('100 Example Street');
  expect(screen.getByLabelText('Address line 2')).toHaveValue('');
  expect(screen.getByLabelText('Address line 2')).toHaveFocus();
  expect(screen.getByLabelText('City')).toHaveValue('Sarasota');
  expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'PUT')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'PUT')).toBe(true));
  expect(JSON.parse(fetchMock.mock.calls.find(([, o]) => o?.method === 'PUT')[1].body)).toMatchObject({ addressLine1: '100 Example Street', addressLine2: '', city: 'Sarasota', state: 'FL', zip: '34236' });
});

it.each(['gate', 'key'])('keeps manual entry available when the %s is absent', async (missing) => {
  vi.stubEnv(missing === 'gate' ? 'VITE_GATE_ADMIN_ADDRESS_AUTOCOMPLETE' : 'VITE_GOOGLE_MAPS_API_KEY', '');
  render(<CustomerPropertiesPanelV2 customerId="fixture" canEdit />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add service address' }));
  const street = screen.getByLabelText('Street address');
  fireEvent.change(street, { target: { value: 'New construction lot' } });
  fireEvent.blur(street);
  expect(street).toHaveValue('New construction lot');
  expect(Autocomplete).not.toHaveBeenCalled();
  expect(window.google.maps.Geocoder).not.toHaveBeenCalled();
});

it('imports Places after a map-only API load and removes its listener on unmount', async () => {
  const importLibrary = vi.fn(async () => { window.google.maps.places = { Autocomplete }; });
  vi.stubGlobal('google', { maps: { importLibrary } });
  const { unmount } = render(<AddressAutocomplete value="" onChange={() => {}} geocodeOnBlur={false} />);
  await waitFor(() => expect(Autocomplete).toHaveBeenCalledTimes(1));
  expect(importLibrary).toHaveBeenCalledWith('places');
  unmount();
  expect(remove).toHaveBeenCalledTimes(1);
});

it('does not submit on Enter or geocode on blur in selection-only mode', () => {
  const onSelect = vi.fn();
  render(<AddressAutocomplete aria-label="Street" value="typed address" onChange={() => {}} onSelect={onSelect} geocodeOnBlur={false} appearance="admin" />);
  const input = screen.getByLabelText('Street');
  fireEvent.focus(input);
  expect(document.body.dataset.addressAutocompleteAppearance).toBe('admin');
  expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
  fireEvent.blur(input);
  expect(window.google.maps.Geocoder).not.toHaveBeenCalled();
  selectPlace(place('Unit 4'));
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ line2: 'Unit 4' }));
});

it('initializes after a Maps download takes longer than eight seconds', () => {
  vi.useFakeTimers();
  vi.stubGlobal('google', undefined);
  const { unmount } = render(<AddressAutocomplete value="" onChange={() => {}} />);
  act(() => vi.advanceTimersByTime(9000));
  expect(Autocomplete).not.toHaveBeenCalled();
  vi.stubGlobal('google', { maps: { places: { Autocomplete } } });
  const script = document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]');
  fireEvent.load(script);
  expect(Autocomplete).toHaveBeenCalledTimes(1);
  unmount();
  fireEvent.load(script);
  expect(Autocomplete).toHaveBeenCalledTimes(1);
  script.remove();
});
