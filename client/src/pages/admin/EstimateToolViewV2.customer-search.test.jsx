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
beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'test-token');
  search = vi.fn(async () => response([customer]));
  vi.stubGlobal('fetch', vi.fn((url, options) => String(url).startsWith('/api/admin/customers?')
    ? search(url, options)
    : Promise.resolve({ ok: true, json: async () => ({}) })));
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
  await screen.findByText(/No customers found/);
  fireEvent.change(input(), { target: { value: 'Failure' } });
  await screen.findByRole('alert');
  expect(screen.queryByText(/No customers found/)).not.toBeInTheDocument();
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
  expect(screen.queryByText(/Searching customers|No customers found/)).not.toBeInTheDocument();
});
