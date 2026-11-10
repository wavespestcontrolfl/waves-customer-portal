// @vitest-environment jsdom
// The SMS "To" box: only the latest search may fill the result list.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SmsTab } from './CommunicationsPageV2';

vi.mock('../../hooks/useRenderedTabBeacon', () => ({ default: () => {} }));
vi.mock('../../hooks/useSpeechDictation', () => ({ default: () => ({ listening: false, supported: false, toggle: () => {} }) }));

const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const customer = (id, firstName, phone) => ({ id, firstName, lastName: 'Synthetic', phone });
const PLACEHOLDER = 'Search by name or enter phone number…';

let pending;
beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'synthetic-token');
  pending = {};
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const m = String(url).match(/\/admin\/customers\?search=([^&]+)&/);
    if (m) return new Promise((resolve) => { pending[decodeURIComponent(m[1])] = resolve; });
    return response({});
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

async function renderTo() {
  render(<MemoryRouter><SmsTab active /></MemoryRouter>);
  return screen.findByPlaceholderText(PLACEHOLDER);
}
const reply = (term, customers) => act(async () => { pending[term](response({ customers })); });

it('keeps only the newest search results when replies land out of order', async () => {
  const to = await renderTo();
  fireEvent.change(to, { target: { value: 'Al' } });
  fireEvent.change(to, { target: { value: 'Alice' } });
  await reply('Alice', [customer('alice-id', 'Alice', '2025550101')]);
  expect(await screen.findByText(/Alice Synthetic/)).toBeInTheDocument();
  await reply('Al', [customer('alberto-id', 'Alberto', '2025550102')]);
  expect(to).toHaveValue('Alice');
  expect(screen.getByText(/Alice Synthetic/)).toBeInTheDocument();
  expect(screen.queryByText(/Alberto Synthetic/)).not.toBeInTheDocument();
});

it('does not reopen the list when a reply lands after a pick', async () => {
  const to = await renderTo();
  fireEvent.change(to, { target: { value: 'Al' } });
  await reply('Al', [customer('alice-id', 'Alice', '2025550101')]);
  fireEvent.change(to, { target: { value: 'Alic' } });
  fireEvent.click(await screen.findByText(/Alice Synthetic/));
  expect(screen.queryByText(/Alice Synthetic/)).not.toBeInTheDocument();
  await reply('Alic', [customer('alberto-id', 'Alberto', '2025550102')]);
  expect(screen.queryByText(/Alberto Synthetic/)).not.toBeInTheDocument();
});

it('shows no list when a reply lands after a phone number was typed', async () => {
  const to = await renderTo();
  fireEvent.change(to, { target: { value: 'Al' } });
  fireEvent.change(to, { target: { value: '2025550199' } });
  await reply('Al', [customer('alberto-id', 'Alberto', '2025550102')]);
  expect(to).toHaveValue('2025550199');
  expect(screen.queryByText(/Alberto Synthetic/)).not.toBeInTheDocument();
});

it('shows no list when a reply lands after the box dropped under 2 characters', async () => {
  const to = await renderTo();
  fireEvent.change(to, { target: { value: 'Al' } });
  fireEvent.change(to, { target: { value: 'A' } });
  await reply('Al', [customer('alberto-id', 'Alberto', '2025550102')]);
  expect(screen.queryByText(/Alberto Synthetic/)).not.toBeInTheDocument();
});
