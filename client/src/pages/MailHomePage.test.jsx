// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../glass/glass-engine', () => ({ useGlassSurface: () => {} }));

import MailHomePage, { addressCase, perApplication } from './MailHomePage';

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
  expect(await screen.findByTestId('application-price')).toHaveTextContent('$111');
  expect(screen.getByText('per application, 4 a year')).toBeInTheDocument();
  expect(screen.getByTestId('monthly-price')).toHaveTextContent('About $37 a month');
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

it('a mailed home shows the day its printed price is held until, and an unmailed home shows none', async () => {
  renderPage(async () => response(200, { address: ADDRESS, price: PRICE, plan: 'pest_quarterly', heldUntil: '2027-01-23' }));
  expect(await screen.findByTestId('held-until')).toHaveTextContent('Your price is held until Jan 23');
  cleanup();
  renderPage(async () => response(200, { address: ADDRESS, price: PRICE, plan: 'pest_quarterly', heldUntil: null }));
  await screen.findByTestId('monthly-price');
  expect(screen.queryByTestId('held-until')).not.toBeInTheDocument();
});

it('shows cents only when the monthly price is not whole', async () => {
  renderPage(async () => response(200, { address: ADDRESS, price: { ...PRICE, annual: 450, monthly: 37.5 }, plan: 'pest_quarterly' }));
  expect(await screen.findByTestId('monthly-price')).toHaveTextContent('About $37.50 a month');
  expect(screen.getByTestId('application-price')).toHaveTextContent('$112.50');
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

it('perApplication is a quarter of the annual price, from whole cents', () => {
  expect(perApplication(444)).toBe(111);
  expect(perApplication(301.02)).toBe(75.26); // 30102 / 4 = 7525.5 cents
  expect(perApplication('450')).toBe(112.5);
});

// ---- first visit: pick a time and book it ---------------------------------------------------------------------------

const OFFER = (date, start, end, startLabel, endLabel) => ({
  date,
  start_time: start,
  end_time: end,
  start_label: startLabel,
  end_label: endLabel,
  technician_id: '0b0f6a2e-6f0e-4b53-9d0f-2f1d5b6a7c11',
  slot_sig: `sig-${date}-${start}-abcdef`,
});
// Given out of order on purpose: the page lists soonest first.
const OFFERS = [
  OFFER('2026-12-01', '09:00', '10:30', '9:00 AM', '10:30 AM'),
  OFFER('2026-11-30', '13:00', '14:30', '1:00 PM', '2:30 PM'),
  OFFER('2026-11-30', '09:00', '10:30', '9:00 AM', '10:30 AM'),
];
const PAGE = { address: ADDRESS, price: PRICE, plan: 'pest_quarterly' };
const BOOK_URL = `/api/public/home/${TOKEN}/book`;
const BOOKED = response(200, { booked: true, date: '2026-11-30', window: { start: '09:00', end: '11:00' } });
// The customer's time is the arrival window: the start plus 2 hours, not the slot's own end_label.
const NINE = '9:00-11:00 AM';
const CALL_LINK = { name: 'Call (941) 297-5749' };

// Routes the page's three requests; `book` answers the POST.
function pageFetch({ times = response(200, { offers: OFFERS }), book = BOOKED } = {}) {
  return async (url) => {
    if (String(url).endsWith('/times')) return times;
    if (String(url).endsWith('/book')) return book;
    return response(200, PAGE);
  };
}
const bookCalls = (fetchMock) => fetchMock.mock.calls.filter(([url]) => url === BOOK_URL);
const timesCalls = (fetchMock) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/times'));

async function pickFirstTime() {
  fireEvent.click(await screen.findByRole('button', { name: NINE }));
}
const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
function fillAndSubmit() {
  type('Your name', 'Jane Sample');
  type('Mobile phone', '(941) 555-0100');
  type('Email', 'jane@example.com');
  fireEvent.click(screen.getByRole('button', { name: 'Book this visit' }));
}

it('lists the open days soonest first and shows only the selected day\'s times', async () => {
  const fetchMock = renderPage(pageFetch());
  expect(await screen.findByRole('heading', { name: 'Pick your first visit' })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(`/api/public/home/${TOKEN}/times`);

  const days = within(screen.getByRole('group', { name: 'Day' })).getAllByRole('button');
  expect(days.map((b) => b.textContent)).toEqual(['Mon, Nov 30', 'Tue, Dec 1']);
  expect(days[0]).toHaveAttribute('aria-pressed', 'true');
  const times = within(screen.getByRole('group', { name: 'Time' })).getAllByRole('button');
  expect(times.map((b) => b.textContent)).toEqual([NINE, '1:00-3:00 PM']);

  fireEvent.click(days[1]);
  expect(days[1]).toHaveAttribute('aria-pressed', 'true');
  expect(within(screen.getByRole('group', { name: 'Time' })).getAllByRole('button').map((b) => b.textContent)).toEqual([NINE]);
  // One call button, at the bottom, while times are open.
  expect(screen.getAllByRole('link', CALL_LINK)).toHaveLength(1);
});

it('shows a loading state while the times load', async () => {
  let release;
  renderPage(async (url) => (String(url).endsWith('/times')
    ? new Promise((resolve) => { release = () => resolve(response(200, { offers: OFFERS })); })
    : response(200, PAGE)));
  expect(await screen.findByText(/Finding open times/)).toBeInTheDocument();
  release();
  expect(await screen.findByRole('heading', { name: 'Pick your first visit' })).toBeInTheDocument();
});

it.each([
  ['no open times', () => response(200, { offers: [] })],
  ['a 503', () => response(503, { error: 'not_available' })],
  ['a network error', () => { throw new Error('offline'); }],
])('says to call for a time on %s, with one call button', async (_name, times) => {
  renderPage(async (url) => {
    if (String(url).endsWith('/times')) return times();
    return response(200, PAGE);
  });
  expect(await screen.findByRole('heading', { name: 'Call us to pick a time' })).toBeInTheDocument();
  // The parent hides its own call link in a later render (onNeedCall): wait for that, not the first paint.
  await waitFor(() => expect(screen.getAllByRole('link', CALL_LINK)).toHaveLength(1));
  expect(screen.queryByRole('button', { name: /AM/ })).not.toBeInTheDocument();
});

it('opens the form on the same page with the right field types and autocomplete', async () => {
  renderPage(pageFetch());
  await pickFirstTime();

  expect(screen.getByRole('heading', { name: `Monday, November 30, ${NINE}` })).toBeInTheDocument();
  expect(screen.getByText(/Quarterly pest control · \$111 per application/)).toBeInTheDocument();
  const name = screen.getByLabelText('Your name');
  const phone = screen.getByLabelText('Mobile phone');
  const email = screen.getByLabelText('Email');
  expect(name).toHaveAttribute('autocomplete', 'name');
  expect(phone).toHaveAttribute('type', 'tel');
  expect(phone).toHaveAttribute('autocomplete', 'tel');
  expect(phone).toHaveAttribute('inputmode', 'tel');
  expect(email).toHaveAttribute('type', 'email');
  expect(email).toHaveAttribute('autocomplete', 'email');
  for (const field of [name, phone, email]) expect(field).toBeRequired();
});

it('goes back to the times from the form', async () => {
  renderPage(pageFetch());
  await pickFirstTime();
  fireEvent.click(screen.getByRole('button', { name: 'Pick a different time' }));
  expect(await screen.findByRole('group', { name: 'Time' })).toBeInTheDocument();
});

it('marks empty and plainly wrong fields without sending anything', async () => {
  const fetchMock = renderPage(pageFetch());
  await pickFirstTime();
  type('Mobile phone', '555');
  fireEvent.click(screen.getByRole('button', { name: 'Book this visit' }));

  expect(screen.getByLabelText('Your name')).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByLabelText('Mobile phone')).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByText('Enter your name.')).toBeInTheDocument();
  expect(bookCalls(fetchMock)).toHaveLength(0);
});

it('posts the exact offer, the typed contact and the shown price, then shows the booked screen', async () => {
  const fetchMock = renderPage(pageFetch());
  await pickFirstTime();
  fillAndSubmit();

  expect(await screen.findByRole('heading', { name: 'You’re booked' })).toBeInTheDocument();
  const calls = bookCalls(fetchMock);
  expect(calls).toHaveLength(1);
  const [, init] = calls[0];
  expect(init.method).toBe('POST');
  expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  expect(JSON.parse(init.body)).toEqual({
    offer: OFFERS[2],
    name: 'Jane Sample',
    phone: '(941) 555-0100',
    email: 'jane@example.com',
    price: { annual: 444, setupFee: 99 },
  });
  const booked = screen.getByTestId('booked');
  expect(booked).toHaveTextContent('Monday, November 30');
  expect(booked).toHaveTextContent('9:00-11:00 AM');
  expect(booked).toHaveTextContent('101 Example TrlSampleton');
  expect(booked).toHaveTextContent('Your confirmation is on its way.');
  expect(screen.queryByRole('button', { name: 'Book this visit' })).not.toBeInTheDocument();
});

it('sends a missing setup fee as 0, a JSON number', async () => {
  const fetchMock = renderPage(async (url, init) => (/\/(times|book)$/.test(String(url))
    ? pageFetch()(url, init)
    : response(200, { ...PAGE, price: { ...PRICE, setupFee: null } })));
  await pickFirstTime();
  fillAndSubmit();
  await screen.findByTestId('booked');
  expect(JSON.parse(bookCalls(fetchMock)[0][1].body).price).toEqual({ annual: 444, setupFee: 0 });
});

it('sends one request at a time while a booking is in flight', async () => {
  let release;
  const fetchMock = renderPage(async (url, init) => (String(url).endsWith('/book')
    ? new Promise((resolve) => { release = () => resolve(BOOKED); })
    : pageFetch()(url, init)));
  await pickFirstTime();
  fillAndSubmit();

  const button = await screen.findByRole('button', { name: /Booking/ });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  fireEvent.submit(button.closest('form'));
  expect(bookCalls(fetchMock)).toHaveLength(1);
  release();
  expect(await screen.findByRole('heading', { name: 'You’re booked' })).toBeInTheDocument();
});

it('goes back to the times with the next offers when the time was just taken', async () => {
  const next = [OFFER('2026-12-02', '09:00', '10:30', '9:00 AM', '10:30 AM')];
  const fetchMock = renderPage(pageFetch({ book: response(409, { error: 'slot_taken', offers: next }) }));
  await pickFirstTime();
  fillAndSubmit();

  expect(await screen.findByText('That time was just taken. Pick another time.')).toBeInTheDocument();
  expect(within(screen.getByRole('group', { name: 'Day' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['Wed, Dec 2']);
  // The returned offers are used: no second /times read.
  expect(timesCalls(fetchMock)).toHaveLength(1);
});

it('reads the times again when the offer was refused as invalid', async () => {
  const fetchMock = renderPage(pageFetch({ book: response(400, { error: 'invalid_offer' }) }));
  await pickFirstTime();
  fillAndSubmit();

  expect(await screen.findByText('That time was just taken. Pick another time.')).toBeInTheDocument();
  expect(await screen.findByRole('group', { name: 'Day' })).toBeInTheDocument();
  expect(timesCalls(fetchMock)).toHaveLength(2);
});

it.each([
  ['price_changed', 409, 'Your price was updated — call us.'],
  ['contact_on_file', 409, "You're already with Waves — call us and we'll get you scheduled."],
  ['not_available', 503, 'Something went wrong — call us.'],
  ['COMMIT_GUARD_REFUSED', 409, 'Something went wrong — call us.'],
  ['invalid_price', 400, 'Something went wrong — call us.'],
])('ends with the call button on %s', async (error, status, text) => {
  renderPage(pageFetch({ book: response(status, { error }) }));
  await pickFirstTime();
  fillAndSubmit();

  expect(await screen.findByText(text)).toBeInTheDocument();
  expect(screen.getAllByRole('link', CALL_LINK)).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Book this visit' })).not.toBeInTheDocument();
});

it('stops showing the old price once a booking answers price_changed', async () => {
  renderPage(pageFetch({ book: response(409, { error: 'price_changed' }) }));
  expect(await screen.findByTestId('application-price')).toBeInTheDocument();
  await pickFirstTime();
  fillAndSubmit();

  expect(await screen.findByText('Your price was updated — call us.')).toBeInTheDocument();
  expect(screen.queryByTestId('application-price')).not.toBeInTheDocument();
  expect(screen.getByText('Call us for your price')).toBeInTheDocument();
});

it('says something went wrong when the booking request fails', async () => {
  renderPage(async (url, init) => {
    if (String(url).endsWith('/book')) throw new Error('offline');
    return pageFetch()(url, init);
  });
  await pickFirstTime();
  fillAndSubmit();
  expect(await screen.findByText('Something went wrong — call us.')).toBeInTheDocument();
});

it.each([['name', 'Your name'], ['phone', 'Mobile phone'], ['email', 'Email']])('marks the %s box when the server refuses the contact', async (field, label) => {
  renderPage(pageFetch({ book: response(400, { error: 'invalid_contact', field }) }));
  await pickFirstTime();
  fillAndSubmit();

  await waitFor(() => expect(screen.getByLabelText(label)).toHaveAttribute('aria-invalid', 'true'));
  // The form stays, with what was typed.
  expect(screen.getByLabelText('Your name')).toHaveValue('Jane Sample');
  expect(screen.getByRole('button', { name: 'Book this visit' })).toBeEnabled();
});

it('shows no picker, and asks for no times, when the home has no price', async () => {
  const fetchMock = renderPage(async () => response(200, { address: ADDRESS, price: null, plan: 'pest_quarterly' }));
  expect(await screen.findByText('Call us for your price')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Pick your first visit' })).not.toBeInTheDocument();
  expect(timesCalls(fetchMock)).toHaveLength(0);
  expect(screen.getAllByRole('link', CALL_LINK)).toHaveLength(1);
});
