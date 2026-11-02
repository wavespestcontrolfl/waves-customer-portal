// @vitest-environment jsdom
// Moving page (GATE_MOVING_FLOW): the customer checks a new address, confirms
// it, gives dates and sends. The page never posts an address or a verdict on
// submit (only the confirmed check's id), shows no price, and answers a dead
// link with the not-found card.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../components/brand', async (importOriginal) => ({
  ...(await importOriginal()),
  WavesShell: ({ children }) => <div>{children}</div>,
  CustomerColumn: ({ children, ...props }) => <div {...props}>{children}</div>,
}));
// Google Places stays out of jsdom: a plain input with the same props.
vi.mock('../components/AddressAutocomplete', () => ({
  default: ({ id, value, onChange, disabled, placeholder }) => (
    <input id={id} value={value} disabled={disabled} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import MovingPage from './MovingPage';

const TOKEN = 'ab'.repeat(24);
const OPEN_VIEW = {
  firstName: 'Pat',
  services: ['Monthly Pest Control Service', 'Lawn Care Service'],
  status: 'open',
  moveOutDate: null,
  moveInDate: null,
  newCity: null,
  verdict: null,
  addressOnFile: false,
};

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function renderPage(routes) {
  const calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    const handler = routes.find(([match]) => String(url).endsWith(match));
    if (!handler) throw new Error(`unexpected fetch ${url}`);
    return handler[1](init);
  });
  render(
    <MemoryRouter initialEntries={[`/moving/${TOKEN}`]}>
      <Routes><Route path="/moving/:token" element={<MovingPage />} /></Routes>
    </MemoryRouter>,
  );
  return calls;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('MovingPage', () => {
  it('greets the customer, names the plan and says the level and setup fee carry over', async () => {
    renderPage([[`/public/moving/${TOKEN}`, () => jsonResponse(OPEN_VIEW)]]);
    expect(await screen.findByRole('heading', { level: 1, name: 'Moving, Pat?' })).toBeInTheDocument();
    expect(document.body.textContent).toContain('Your plan today: Monthly Pest Control Service and Lawn Care Service.');
    expect(document.body.textContent).toContain('there is no setup fee at the new home');
    expect(document.body.textContent).not.toMatch(/\$\d/);
    expect(screen.getByRole('button', { name: 'Send my move' })).toBeDisabled();
  });

  it('checks the address, asks to confirm, and submits only the confirmed check id with the dates', async () => {
    const calls = renderPage([
      [`/public/moving/${TOKEN}`, () => jsonResponse(OPEN_VIEW)],
      [`/public/moving/${TOKEN}/check`, () => jsonResponse({
        typed: '12 Example Way, Parrish FL',
        normalized: { line1: '12 Example Way', line2: null, city: 'Parrish', state: 'FL', zip: '34219' },
        verdict: 'in_area',
        checkId: 'abcdef0123456789',
      })],
      [`/public/moving/${TOKEN}/submit`, () => jsonResponse({
        ok: true,
        receipt: ['Thanks, Pat. We have your move. We will price your new home and send it to you to review. Nothing changes until you approve it.'],
        view: { ...OPEN_VIEW, status: 'submitted', newCity: 'Parrish', verdict: 'in_area', addressOnFile: true, moveOutDate: '2026-11-15' },
      })],
    ]);
    await screen.findByRole('heading', { level: 1, name: 'Moving, Pat?' });
    fireEvent.change(screen.getByLabelText('New address'), { target: { value: '12 Example Way, Parrish FL' } });
    // A typed but unchecked address blocks the send.
    expect(screen.getByRole('button', { name: 'Send my move' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Check address' }));
    expect(await screen.findByRole('heading', { name: 'Is this the right address?' })).toBeInTheDocument();
    expect(screen.getByText('We found: 12 Example Way, Parrish, FL 34219')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Yes, that/ }));
    fireEvent.change(screen.getByLabelText('Move-out date'), { target: { value: '2026-11-15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send my move' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Got it' })).toBeInTheDocument();
    expect(document.body.textContent).toContain('Nothing changes until you approve it.');

    const check = calls.find((c) => c.url.endsWith('/check'));
    expect(check.body).toEqual({ address: '12 Example Way, Parrish FL' });
    const submit = calls.find((c) => c.url.endsWith('/submit'));
    expect(submit.body).toEqual({ checkId: 'abcdef0123456789', moveOutDate: '2026-11-15', moveInDate: '' });
  });

  it('sends dates only when the address is not known yet', async () => {
    const calls = renderPage([
      [`/public/moving/${TOKEN}`, () => jsonResponse(OPEN_VIEW)],
      [`/public/moving/${TOKEN}/submit`, () => jsonResponse({
        ok: true,
        receipt: ['Thanks, Pat. We have your move dates. When you know your new address, open this same link and add it.'],
        view: { ...OPEN_VIEW, status: 'submitted', moveOutDate: '2026-11-15' },
      })],
    ]);
    await screen.findByRole('heading', { level: 1, name: 'Moving, Pat?' });
    fireEvent.click(screen.getAllByLabelText('Not sure yet')[0]);
    fireEvent.change(screen.getByLabelText('Move-out date'), { target: { value: '2026-11-15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send my move' }));
    expect(await screen.findByText(/We have your move dates/)).toBeInTheDocument();
    const submit = calls.find((c) => c.url.endsWith('/submit'));
    expect(submit.body).toEqual({ moveOutDate: '2026-11-15', moveInDate: '' });
  });

  it('an out-of-area check shows the fixed sentence before the customer confirms', async () => {
    renderPage([
      [`/public/moving/${TOKEN}`, () => jsonResponse(OPEN_VIEW)],
      [`/public/moving/${TOKEN}/check`, () => jsonResponse({
        typed: '1 Far Away Rd, Ormond Beach FL',
        normalized: { line1: '1 Far Away Rd', city: 'Ormond Beach', state: 'FL', zip: '32174' },
        verdict: 'out_of_area',
      })],
    ]);
    await screen.findByRole('heading', { level: 1, name: 'Moving, Pat?' });
    fireEvent.change(screen.getByLabelText('New address'), { target: { value: '1 Far Away Rd, Ormond Beach FL' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check address' }));
    expect(await screen.findByText(/We do not serve that address yet/)).toBeInTheDocument();
  });

  it('a submitted move shows the saved summary with the city only', async () => {
    renderPage([[`/public/moving/${TOKEN}`, () => jsonResponse({
      ...OPEN_VIEW, status: 'submitted', newCity: 'Parrish', verdict: 'in_area', addressOnFile: true, moveOutDate: '2026-11-15',
    })]]);
    expect(await screen.findByRole('heading', { level: 1, name: 'We have your move, Pat.' })).toBeInTheDocument();
    expect(document.body.textContent).toContain('Move-out date: Nov 15, 2026');
    expect(document.body.textContent).toContain('New home: Parrish');
    fireEvent.click(screen.getByRole('button', { name: 'Add or change details' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Moving, Pat?' })).toBeInTheDocument();
  });

  it('a check replaced in another window (409) shows the words and asks for a new check', async () => {
    renderPage([
      [`/public/moving/${TOKEN}`, () => jsonResponse(OPEN_VIEW)],
      [`/public/moving/${TOKEN}/check`, () => jsonResponse({
        typed: '12 Example Way, Parrish FL', normalized: { line1: '12 Example Way', city: 'Parrish', state: 'FL', zip: '34219' }, verdict: 'in_area', checkId: 'abcdef0123456789',
      })],
      [`/public/moving/${TOKEN}/submit`, () => jsonResponse({ error: 'That address changed in another window. Check it again, then confirm it.' }, 409)],
    ]);
    await screen.findByRole('heading', { level: 1, name: 'Moving, Pat?' });
    fireEvent.change(screen.getByLabelText('New address'), { target: { value: '12 Example Way, Parrish FL' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check address' }));
    fireEvent.click(await screen.findByRole('button', { name: /Yes, that/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send my move' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('That address changed in another window.'));
    expect(screen.getByRole('button', { name: 'Check address' })).toBeInTheDocument();
  });

  it('the address and its "Not sure yet" box are locked while a check runs', async () => {
    let answer;
    renderPage([
      [`/public/moving/${TOKEN}`, () => jsonResponse(OPEN_VIEW)],
      [`/public/moving/${TOKEN}/check`, () => new Promise((resolve) => { answer = resolve; })],
    ]);
    await screen.findByRole('heading', { level: 1, name: 'Moving, Pat?' });
    fireEvent.change(screen.getByLabelText('New address'), { target: { value: '12 Example Way, Parrish FL' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check address' }));
    await waitFor(() => expect(screen.getByLabelText('New address')).toBeDisabled());
    expect(screen.getAllByLabelText('Not sure yet')[0]).toBeDisabled();
    answer(jsonResponse({ typed: '12 Example Way, Parrish FL', normalized: { city: 'Parrish' }, verdict: 'in_area', checkId: 'abcdef0123456789' }));
    expect(await screen.findByRole('heading', { name: 'Is this the right address?' })).toBeInTheDocument();
  });

  it('a dead link shows the not-found card', async () => {
    renderPage([[`/public/moving/${TOKEN}`, () => jsonResponse({ error: 'Not found' }, 404)]]);
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });

  it('a check error shows the server words', async () => {
    renderPage([
      [`/public/moving/${TOKEN}`, () => jsonResponse(OPEN_VIEW)],
      [`/public/moving/${TOKEN}/check`, () => jsonResponse({ error: 'We have checked that address a few times today. Please try again tomorrow, or call us.' }, 429)],
    ]);
    await screen.findByRole('heading', { level: 1, name: 'Moving, Pat?' });
    fireEvent.change(screen.getByLabelText('New address'), { target: { value: '12 Example Way, Parrish FL' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check address' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('We have checked that address a few times today.'));
  });
});
