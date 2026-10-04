// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import EstimateToolViewV2 from './EstimateToolViewV2';

const customer = { id: 'synthetic-search', firstName: 'Jamie', lastName: 'Fixture', address: '1 Synthetic Way' };
const response = (customers) => ({ ok: true, json: async () => ({ customers }) });
let search;
let leadSearch;
beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'test-token');
  search = vi.fn(async () => response([customer]));
  leadSearch = vi.fn(async () => ({ ok: true, json: async () => ({ leads: [] }) }));
  vi.stubGlobal('fetch', vi.fn((url, options) => {
    if (String(url).startsWith('/api/admin/customers?')) return search(url, options);
    if (String(url).startsWith('/api/admin/leads?')) return leadSearch(url, options);
    return Promise.resolve({ ok: true, json: async () => ({}) });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
function input() {
  return screen.getByRole('textbox', { name: 'Search customers by first name, last name, or full name' });
}
function mount() { render(<MemoryRouter><EstimateToolViewV2 /></MemoryRouter>); }

it.each(['Jamie', 'Fixture', '  Jamie Fixture  '])('passes %s to the shared name search and displays matches', async (term) => {
  mount();
  fireEvent.change(input(), { target: { value: term } });
  expect(screen.getByText('Searching customers…')).toBeInTheDocument();
  await screen.findByRole('button', { name: /Jamie Fixture/ });
  expect(search.mock.calls[0][0]).toBe(`/api/admin/customers?search=${encodeURIComponent(term.trim())}`);
});

it('distinguishes no matches from a failed request and recovers on the next search', async () => {
  search.mockResolvedValueOnce(response([])).mockResolvedValueOnce({ ok: false });
  mount();
  fireEvent.change(input(), { target: { value: 'Missing' } });
  await screen.findByText(/No customers or leads found/);
  fireEvent.change(input(), { target: { value: 'Failure' } });
  await screen.findByRole('alert');
  expect(screen.queryByText(/No customers or leads found/)).not.toBeInTheDocument();
  fireEvent.change(input(), { target: { value: 'Jamie' } });
  await screen.findByRole('button', { name: /Jamie Fixture/ });
  expect(screen.queryByText(/Customer search failed/)).not.toBeInTheDocument();
});

it('ignores an older response after a newer search and clears results when erased', async () => {
  let finishOld;
  search.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  mount();
  fireEvent.change(input(), { target: { value: 'Older' } });
  await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
  fireEvent.change(input(), { target: { value: 'Jamie' } });
  await screen.findByRole('button', { name: /Jamie Fixture/ });
  expect(search.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => finishOld(response([{ ...customer, firstName: 'Obsolete' }])));
  expect(screen.queryByRole('button', { name: /Obsolete/ })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Jamie Fixture/ })).toBeInTheDocument();
  fireEvent.change(input(), { target: { value: '' } });
  expect(screen.queryByRole('button', { name: /Jamie Fixture/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/Searching customers|No customers or leads found/)).not.toBeInTheDocument();
});

const lead = { id: 'synthetic-lead', first_name: 'Dana', last_name: 'Sample', email: 'dana.sample@example.com', phone: null, address: '100 Test Palm Way, Parrish, FL 34219', service_interest: 'Pest Control', customer_id: null };
const leadResponse = (leads) => ({ ok: true, json: async () => ({ leads }) });

it('lists an open lead that has no customer record, and picking it fills the contact fields and links the lead', async () => {
  search.mockResolvedValue(response([]));
  leadSearch.mockResolvedValue(leadResponse([lead, { ...lead, id: 'has-customer', first_name: 'Linked', customer_id: 'c-1' }]));
  mount();
  fireEvent.change(input(), { target: { value: 'Dana' } });
  fireEvent.click(await screen.findByRole('button', { name: /Dana Sample.*Lead/ }));
  expect(leadSearch.mock.calls[0][0]).toBe('/api/admin/leads?status=open&no_customer=1&limit=8&search=Dana');
  // A lead that already has a customer record is found through the customer.
  expect(screen.queryByRole('button', { name: /Linked Sample/ })).not.toBeInTheDocument();
  expect(document.getElementById('estimate-customerName')).toHaveValue('Dana Sample');
  expect(document.getElementById('estimate-customerEmail')).toHaveValue('dana.sample@example.com');
  expect(screen.getByRole('textbox', { name: 'Service address' })).toHaveValue('100 Test Palm Way, Parrish, FL 34219');
  expect(screen.getByText(/Linked to lead:/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Remove link' }));
  expect(screen.queryByText(/Linked to lead:/)).not.toBeInTheDocument();
});

it('a failed lead search still shows the customer results', async () => {
  leadSearch.mockResolvedValue({ ok: false });
  mount();
  fireEvent.change(input(), { target: { value: 'Jamie' } });
  await screen.findByRole('button', { name: /Jamie Fixture/ });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
