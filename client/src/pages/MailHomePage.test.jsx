// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../glass/glass-engine', () => ({ useGlassSurface: () => {} }));

import MailHomePage, { addressCase } from './MailHomePage';

const TOKEN = '0123456789abcdef0123456789abcdef';
const ADDRESS = { line1: '101 EXAMPLE TRL', city: 'SAMPLETON', zip: '34212' };
const PRICE = { monthly: 37, annual: 444, setupFee: 99, pricedAt: '2026-11-22T21:51:00.000Z' };

const response = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function renderPage(fetchImpl) {
  const fetchMock = vi.fn(fetchImpl);
  vi.stubGlobal('fetch', fetchMock);
  render(
    <MemoryRouter initialEntries={[`/h/${TOKEN}`]}>
      <Routes><Route path="/h/:token" element={<MailHomePage />} /></Routes>
    </MemoryRouter>,
  );
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('shows the big monthly price, the street, the plan line and the setup fee', async () => {
  const fetchMock = renderPage(async () => response(200, { address: ADDRESS, price: PRICE, plan: 'pest_quarterly' }));

  expect(screen.getByRole('status')).toHaveTextContent('Loading');
  expect(await screen.findByTestId('monthly-price')).toHaveTextContent('$37 a month');
  expect(fetchMock).toHaveBeenCalledWith(`/api/public/home/${TOKEN}`);
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome to your new home');
  expect(screen.getByTestId('address')).toHaveTextContent('101 Example TrlSampleton');
  expect(screen.getByText('Quarterly pest control for 101 Example Trl')).toBeInTheDocument();
  expect(screen.getByText('One-time setup: $99')).toBeInTheDocument();
  // Plan lines are the estimate's own quarterly pest lines.
  expect(screen.getByText(/Protected 4× a year/)).toBeInTheDocument();
  expect(screen.getByText(/Interior treatment included/)).toBeInTheDocument();
  expect(screen.getByText(/unlimited free callbacks/)).toBeInTheDocument();
  // Never the token or the word shadow.
  expect(document.body.textContent).not.toContain(TOKEN);
  expect(document.body.textContent).not.toMatch(/shadow/i);
});

it('shows cents only when the monthly price is not whole', async () => {
  renderPage(async () => response(200, { address: ADDRESS, price: { ...PRICE, monthly: 37.5 }, plan: 'pest_quarterly' }));
  expect(await screen.findByTestId('monthly-price')).toHaveTextContent('$37.50 a month');
});

it.each([[0], [null]])('says nothing about setup when the setup fee is %s', async (setupFee) => {
  renderPage(async () => response(200, { address: ADDRESS, price: { ...PRICE, setupFee }, plan: 'pest_quarterly' }));
  await screen.findByTestId('monthly-price');
  expect(document.body.textContent).not.toMatch(/setup/i);
});

it('asks the visitor to call when there is no price', async () => {
  renderPage(async () => response(200, { address: ADDRESS, price: null, plan: 'pest_quarterly' }));
  expect(await screen.findByText('Call us for your price')).toBeInTheDocument();
  expect(screen.queryByTestId('monthly-price')).not.toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/\$/);
  expect(screen.getByText('Quarterly pest control for 101 Example Trl')).toBeInTheDocument();
});

it('links the call button to the main line', async () => {
  renderPage(async () => response(200, { address: ADDRESS, price: PRICE, plan: 'pest_quarterly' }));
  const call = await screen.findByRole('link', { name: 'Call (941) 297-5749' });
  expect(call).toHaveAttribute('href', 'tel:+19412975749');
  expect(screen.queryByRole('link', { name: /book|text|email/i })).not.toBeInTheDocument();
});

it.each([
  ['a 404', async () => response(404, { error: 'Not found' })],
  ['a server error', async () => response(500, {})],
  ['a network error', async () => { throw new Error('offline'); }],
])('shows the same unavailable state for %s', async (_name, impl) => {
  renderPage(impl);
  expect(await screen.findByRole('heading', { level: 1, name: 'This page is not available' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Call (941) 297-5749' })).toHaveAttribute('href', 'tel:+19412975749');
  expect(screen.queryByTestId('monthly-price')).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain(TOKEN);
});

it('addressCase reads county capitals in normal case, keeps compass words, lowers ordinals', () => {
  expect(addressCase('101 EXAMPLE TRL')).toBe('101 Example Trl');
  expect(addressCase('  2200 NW 1ST  AVE ')).toBe('2200 NW 1st Ave');
  expect(addressCase('LAKEWOOD RANCH')).toBe('Lakewood Ranch');
  expect(addressCase(null)).toBe('');
});
