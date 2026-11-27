// @vitest-environment jsdom
/**
 * WDO inspection table price on the Create Appointment modal (owner ruling 2026-11-27 "yes booking"). A WDO line starts
 * blank and books at the table price by home size and construction ($150 to $275) for the home the visit is booked at; the
 * line shows that price and what the table read before save, and a typed price overrides it. The answer belongs to one
 * question (customer, picked property and linked estimate, or a new caller's picked address): an answer to another one is
 * not shown, and a blank line is not booked until its price is shown and re-read at the moment of booking. The question is
 * a POST body (no address in a request log); the save posts the price shown, so the server books it or refuses. A WDO main
 * line with other lines keeps the catalog price, and the line says why.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../hooks/useDiscountStacking', () => ({
  useDiscountStackingState: vi.fn(() => ({ enabled: false, known: true, retry: vi.fn() })),
  ensureStackingFresh: vi.fn(async () => ({ enabled: false, known: true })),
}));
import CreateAppointmentModal, {
  newCallerBookBlockReason, wdoLineHintText, wdoQuoteAnswer, wdoQuoteBody, wdoQuoteQuery, wdoSubmitGate,
} from './CreateAppointmentModal.jsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const FRAME_2600 = { price: 200, source: 'wdo_table', basis: '2,600 sq ft, wood frame', staffNote: null };

describe('wdoQuoteQuery (the question the line asks)', () => {
  it('asks for the customer once the booking property is settled, with the picked property and the linked estimate', () => {
    expect(wdoQuoteQuery({ customerId: 'cust-1', propertySettled: false })).toBe('');
    expect(wdoQuoteQuery({ customerId: 'cust-1', propertySettled: true })).toBe('customerId=cust-1');
    expect(wdoQuoteQuery({ customerId: 'cust-1', propertySettled: true, propertyId: 'prop-2', estimateId: 'est-3' }))
      .toBe('customerId=cust-1&propertyId=prop-2&estimateId=est-3');
  });

  it('a new caller with no customer asks by the picked address; a customer wins over a leftover address; nothing asks nothing', () => {
    const address = { line1: '300 Sample Ct', city: 'Venice', state: '', zip: '34285', lat: 27.09, lng: -82.44 };
    expect(wdoQuoteQuery({ newCallerAddress: address })).toBe('line1=300+Sample+Ct&city=Venice&zip=34285&lat=27.09&lng=-82.44');
    expect(wdoQuoteQuery({ customerId: 'cust-1', propertySettled: true, newCallerAddress: address })).toBe('customerId=cust-1');
    expect(wdoQuoteQuery({})).toBe('');
  });

  it('a WDO main line with other lines asks for that; the question goes as a POST body, never in the address bar', () => {
    expect(wdoQuoteQuery({ customerId: 'cust-1', propertySettled: true, withOtherLines: true })).toBe('customerId=cust-1&withOtherLines=1');
    expect(wdoQuoteQuery({ customerId: 'cust-1', propertySettled: false, withOtherLines: true })).toBe('');
    expect(wdoQuoteBody('line1=300+Sample+Ct&zip=34285&withOtherLines=1'))
      .toBe(JSON.stringify({ line1: '300 Sample Ct', zip: '34285', withOtherLines: '1' }));
  });
});

describe('wdoQuoteAnswer and wdoLineHintText (what the line shows)', () => {
  const key = 'customerId=cust-1';

  it('a table price shows its amount, what the table read and the office note', () => {
    const answer = wdoQuoteAnswer(key, FRAME_2600);
    expect(answer).toEqual({ key, status: 'ready', price: 200, tablePriced: true, basis: '2,600 sq ft, wood frame', staffNote: null });
    expect(wdoLineHintText({ quote: answer, query: key })).toBe('Table price: $200.00 (2,600 sq ft, wood frame).');
    const noted = wdoQuoteAnswer(key, {
      price: 150, source: 'wdo_table', basis: 'no home size on record, construction not verified', staffNote: 'No home size on record: priced as 2,000 sq ft.',
    });
    expect(wdoLineHintText({ quote: noted, query: key }))
      .toBe('Table price: $150.00 (no home size on record, construction not verified). No home size on record: priced as 2,000 sq ft.');
  });

  it('no table price shows the catalog price; no price at all asks for one', () => {
    const catalog = wdoQuoteAnswer(key, { price: 250, source: 'catalog_base', basis: null, staffNote: null });
    expect(catalog).toMatchObject({ price: 250, tablePriced: false });
    expect(wdoLineHintText({ quote: catalog, query: key })).toBe('Catalog price: $250.00. The home size table has no price for this home.');
    const none = wdoQuoteAnswer(key, { price: null, source: 'catalog_base' });
    expect(none.price).toBeNull();
    expect(wdoLineHintText({ quote: none, query: key })).toBe('No price for this home. Type a price.');
    // A catalog price the server explains (a WDO main line with other lines) shows its reason.
    const withOthers = wdoQuoteAnswer(key, { price: 250, source: 'catalog_base', basis: null, staffNote: 'Other services are booked on this WDO visit.' });
    expect(wdoLineHintText({ quote: withOthers, query: key })).toBe('Catalog price: $250.00. Other services are booked on this WDO visit.');
  });

  it('an answer to another question is not shown; a failed read and an unasked question say so', () => {
    expect(wdoLineHintText({ quote: wdoQuoteAnswer('customerId=cust-0', FRAME_2600), query: key })).toBe('Reading the price for this home…');
    expect(wdoLineHintText({ quote: { key, status: 'error' }, query: key })).toMatch(/^Could not read the price for this home/);
    expect(wdoLineHintText({ quote: null, query: '' })).toBe('Priced by home size and construction once the customer and address are set.');
  });
});

describe('wdoSubmitGate (the check at the moment of booking)', () => {
  const query = 'customerId=cust-1';
  const shown = wdoQuoteAnswer(query, FRAME_2600);

  it('a typed price, or no WDO line left blank, needs no check', async () => {
    const fetchQuote = vi.fn();
    expect(await wdoSubmitGate({ needsPrice: false, quote: null, query: '', fetchQuote })).toBeNull();
    expect(fetchQuote).not.toHaveBeenCalled();
  });

  it('holds the booking until the price for this question is shown; a failed read asks again', async () => {
    const fetchQuote = vi.fn();
    for (const quote of [null, { ...shown, key: 'customerId=cust-0' }, { key: query, status: 'loading' }]) {
      expect(await wdoSubmitGate({ needsPrice: true, quote, query, fetchQuote }))
        .toMatchObject({ retry: false, refresh: null, message: expect.stringMatching(/^Reading the WDO price/) });
    }
    expect(await wdoSubmitGate({ needsPrice: true, quote: null, query: '', fetchQuote })).toMatchObject({ retry: false, refresh: null });
    expect(await wdoSubmitGate({ needsPrice: true, quote: { key: query, status: 'error' }, query, fetchQuote }))
      .toMatchObject({ retry: true, refresh: null, message: expect.stringMatching(/^Could not read the WDO price/) });
    expect(fetchQuote).not.toHaveBeenCalled();
  });

  it('re-reads the shown price: the same price books, a changed one is shown first, a failed read retries', async () => {
    const same = vi.fn(async () => FRAME_2600);
    expect(await wdoSubmitGate({ needsPrice: true, quote: shown, query, fetchQuote: same })).toBeNull();
    expect(same).toHaveBeenCalledWith('/admin/schedule/wdo-inspection-quote', { method: 'POST', body: JSON.stringify({ customerId: 'cust-1' }) });
    const changed = await wdoSubmitGate({
      needsPrice: true, quote: shown, query, fetchQuote: async () => ({ price: 225, source: 'wdo_table', basis: '3,600 sq ft, wood frame' }),
    });
    expect(changed).toMatchObject({ retry: false, refresh: { key: query, price: 225, basis: '3,600 sq ft, wood frame' }, message: expect.stringMatching(/changed/) });
    const failed = await wdoSubmitGate({ needsPrice: true, quote: shown, query, fetchQuote: async () => { throw new Error('offline'); } });
    expect(failed).toMatchObject({ retry: true, refresh: null });
  });

  it('two blank WDO lines hold without a read: one price question describes one line, so the office types each', async () => {
    const fetchQuote = vi.fn();
    expect(await wdoSubmitGate({ needsPrice: true, quote: shown, query: '', blankLines: 2, fetchQuote }))
      .toMatchObject({ retry: false, refresh: null, message: 'Two WDO lines are blank — type a price on each' });
    expect(fetchQuote).not.toHaveBeenCalled();
    expect(wdoLineHintText({ quote: null, query: '', blankLines: 2 })).toBe('Two WDO lines on this booking: type a price on each.');
  });

  it('a home with no price holds a blank line, even when both reads agree: the line asks for a typed price', async () => {
    const noPrice = { price: null, source: 'catalog_base', basis: null, staffNote: null };
    const hold = await wdoSubmitGate({ needsPrice: true, quote: wdoQuoteAnswer(query, noPrice), query, fetchQuote: async () => noPrice });
    expect(hold).toMatchObject({ retry: false, message: 'No WDO price for this home — type a price', refresh: { key: query, price: null } });
  });
});

describe('Book for a new caller', () => {
  it('a blank WDO line blocks Book until its price is shown; the other reasons come first', () => {
    expect(newCallerBookBlockReason({ serviceCount: 1, tablePriceUnread: true })).toMatch(/priced by home size/);
    expect(newCallerBookBlockReason({ serviceCount: 1, tablePriceUnread: false })).toBe('');
    expect(newCallerBookBlockReason({ serviceCount: 2, tablePriceUnread: true })).toMatch(/one service/);
  });
});

// ── The line in the modal ───────────────────────────────────────────────────────────────────────────────────────────
const json = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: vi.fn(async () => body) });
const CUSTOMER = { id: 'customer-a', firstName: 'Ada', lastName: 'Lovelace' };
const WDO = { id: 'svc-wdo', service_key: 'wdo_inspection', name: 'WDO Inspection Service', billing_type: 'one_time', base_price: 250, default_duration_minutes: 60 };

function futureDate(days = 30) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

const PEST_ONCE = { id: 'svc-pest1', service_key: 'one_time_pest', name: 'One-Time Pest Service', billing_type: 'one_time', base_price: 150, default_duration_minutes: 30 };

// `quote(body)` answers the line's POST (read each time, so a test can change the answer); `save(body)` answers a save.
function installFetch({ quote, save = () => json({ id: 'appt-1' }) }) {
  const fetcher = vi.fn((input, options = {}) => {
    const url = String(input);
    if (url.endsWith('/admin/schedule/wdo-inspection-quote') && options.method === 'POST') {
      const answer = quote(JSON.parse(options.body || '{}'));
      return Promise.resolve(answer?.status ? answer : json(answer));
    }
    if (url.endsWith('/admin/schedule/preview') && options.method === 'POST') {
      const groups = JSON.parse(options.body || '{}').groups || [];
      return Promise.resolve(json({ regime: true, results: groups.map((g) => ({ key: g.key })) }));
    }
    if (url.endsWith('/admin/schedule') && options.method === 'POST') return Promise.resolve(save(JSON.parse(options.body || '{}')));
    if (url.includes('/admin/triage?')) return Promise.resolve(json({ items: [] }));
    if (url.includes('/admin/services?')) return Promise.resolve(json({ services: [WDO, PEST_ONCE] }));
    if (url.includes('/properties?context=appointment_address')) return Promise.resolve(json({ properties: [] }));
    if (url.includes('/schedule-estimates')) return Promise.resolve(json({ estimates: [] }));
    if (url.endsWith('/admin/technicians')) return Promise.resolve(json({ technicians: [] }));
    if (url.endsWith('/admin/discounts')) return Promise.resolve(json([]));
    if (url.endsWith('/annual-prepay-availability')) return Promise.resolve(json({ enabled: false }));
    if (url.endsWith('/card-request-availability')) return Promise.resolve(json({ enabled: false }));
    if (url.endsWith('/admin/dispatch/slot-check')) return Promise.resolve(json({ ok: true, results: [{ conflicts: [] }] }));
    if (url.includes('/admin/schedule/find-time')) return Promise.resolve(json({ gated: true }));
    throw new Error(`Unhandled fetch in test: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

async function addLine(search, name) {
  if (!screen.queryByPlaceholderText('Search services')) fireEvent.click(screen.getByRole('button', { name: /\+ Add service/i }));
  const box = screen.queryByPlaceholderText('Search services') || screen.getByPlaceholderText('Search to add service');
  fireEvent.change(box, { target: { value: search } });
  fireEvent.click(await screen.findByRole('button', { name }));
}
const addWdoLine = () => addLine('WDO', /WDO Inspection Service/i);

const mount = () => render(<CreateAppointmentModal defaultCustomer={CUSTOMER} defaultDate={futureDate()} defaultWindowStart="09:00" onClose={vi.fn()} onCreated={vi.fn()} onChange={vi.fn()} />);
const hint = () => screen.queryByTestId('wdo-table-price');
const total = () => screen.getByText(/^Total: \$/).textContent;
// The quote questions asked, as their POST bodies. None goes in a query string.
const quoteCalls = (fetcher) => {
  const calls = fetcher.mock.calls.filter(([u]) => String(u).includes('/admin/schedule/wdo-inspection-quote'));
  for (const [u, o] of calls) {
    expect(String(u)).not.toContain('?');
    expect(o?.method).toBe('POST');
  }
  return calls.map(([, o]) => JSON.parse(o.body));
};
const schedulePosts = (fetcher) => fetcher.mock.calls.filter(([u, o]) => String(u).endsWith('/admin/schedule') && o?.method === 'POST').map(([, o]) => JSON.parse(o.body));
const saveButton = () => screen.getByRole('button', { name: 'Schedule appointment' });

describe('a WDO line in the modal', () => {
  it('starts blank, shows the table price and what it was read at, totals it, and books with no price so the server sets it', async () => {
    const fetcher = installFetch({ quote: () => FRAME_2600 });
    mount();
    await addWdoLine();
    await waitFor(() => expect(hint()?.textContent).toBe('Table price: $200.00 (2,600 sq ft, wood frame).'));
    expect(screen.getByPlaceholderText('Auto (home size)').value).toBe('');
    expect(total()).toContain('$200');
    expect(quoteCalls(fetcher)[0]).toEqual({ customerId: 'customer-a' });
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(saveButton());
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    // The save posts the price the line showed: the server books it or refuses.
    expect(schedulePosts(fetcher)[0]).toMatchObject({ serviceId: 'svc-wdo', primaryLinePrice: null, wdoExpectedPrice: 200 });
    // The price is read again at the moment of booking.
    expect(quoteCalls(fetcher)).toHaveLength(2);
  });

  it('a typed price overrides the table price: it totals and books as typed, and nothing is re-read', async () => {
    const fetcher = installFetch({ quote: () => FRAME_2600 });
    mount();
    await addWdoLine();
    await waitFor(() => expect(hint()).not.toBeNull());
    fireEvent.change(screen.getByPlaceholderText('Auto (home size)'), { target: { value: '260' } });
    await waitFor(() => expect(hint()).toBeNull());
    expect(total()).toContain('$260');
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(saveButton());
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    expect(schedulePosts(fetcher)[0]).toMatchObject({ serviceId: 'svc-wdo', primaryLinePrice: 260 });
    expect(schedulePosts(fetcher)[0]).not.toHaveProperty('wdoExpectedPrice');
    expect(quoteCalls(fetcher)).toHaveLength(1);
  });

  it('a price that changed while the form sat open is shown before anything books', async () => {
    let answer = FRAME_2600;
    const fetcher = installFetch({ quote: () => answer });
    mount();
    await addWdoLine();
    await waitFor(() => expect(hint()?.textContent).toContain('$200.00'));
    answer = { price: 225, source: 'wdo_table', basis: '3,600 sq ft, wood frame', staffNote: null };
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(saveButton());
    await waitFor(() => expect(hint()?.textContent).toBe('Table price: $225.00 (3,600 sq ft, wood frame).'));
    expect(schedulePosts(fetcher)).toHaveLength(0);
    expect(total()).toContain('$225');
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(saveButton());
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    expect(schedulePosts(fetcher)[0]).toMatchObject({ primaryLinePrice: null, wdoExpectedPrice: 225 });
  });

  it('a save the server refused because the price changed reads the price again, so the line shows the new one', async () => {
    let answer = FRAME_2600;
    const changed = { price: 225, source: 'wdo_table', basis: '3,600 sq ft, wood frame', staffNote: null };
    const fetcher = installFetch({
      quote: () => answer,
      save: () => {
        answer = changed;
        return json({ error: 'The WDO price for this home is now $225.00, not the $200.00 shown. This visit was not booked.', code: 'WDO_PRICE_CHANGED' }, { ok: false, status: 409 });
      },
    });
    const shownAlert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    mount();
    await addWdoLine();
    await waitFor(() => expect(hint()?.textContent).toContain('$200.00'));
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(saveButton());
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    await waitFor(() => expect(hint()?.textContent).toBe('Table price: $225.00 (3,600 sq ft, wood frame).'));
    expect(total()).toContain('$225');
    // The office is told why nothing was booked.
    expect(shownAlert.mock.calls.flat().join(' ')).toContain('This visit was not booked.');
  });

  it('a failed read offers Retry; Retry reads again and shows the price', async () => {
    let fail = true;
    const fetcher = installFetch({ quote: () => (fail ? json({ error: 'busy' }, { ok: false, status: 503 }) : FRAME_2600) });
    mount();
    await addWdoLine();
    await waitFor(() => expect(hint()?.textContent).toMatch(/^Could not read the price for this home/));
    const asked = quoteCalls(fetcher).length;
    fail = false;
    fireEvent.click(screen.getByTestId('wdo-table-price-retry'));
    await waitFor(() => expect(hint()?.textContent).toBe('Table price: $200.00 (2,600 sq ft, wood frame).'));
    expect(quoteCalls(fetcher).length).toBe(asked + 1);
    expect(screen.queryByTestId('wdo-table-price-retry')).toBeNull();
  });

  it('two blank WDO lines ask nothing and say to type each; typing one prices the other again', async () => {
    const note = 'Other services are booked on this WDO visit, so the WDO line keeps the catalog price.';
    const fetcher = installFetch({
      quote: (body) => (body.withOtherLines === '1' ? { price: 250, source: 'catalog_base', basis: null, staffNote: note } : FRAME_2600),
    });
    mount();
    await addWdoLine();
    await waitFor(() => expect(hint()?.textContent).toContain('$200.00'));
    const asked = quoteCalls(fetcher).length;
    await addWdoLine();
    await waitFor(() => expect(screen.getAllByTestId('wdo-table-price').map((el) => el.textContent))
      .toEqual(['Two WDO lines on this booking: type a price on each.', 'Two WDO lines on this booking: type a price on each.']));
    expect(quoteCalls(fetcher)).toHaveLength(asked);
    // The second line typed: the first is now the main line of an appointment with another line.
    fireEvent.change(screen.getAllByPlaceholderText('Auto (home size)')[1], { target: { value: '260' } });
    await waitFor(() => expect(hint()?.textContent).toBe(`Catalog price: $250.00. ${note}`));
  });

  it('a WDO main line with another line asks for that, and the line shows the catalog price and why', async () => {
    const note = 'Other services are booked on this WDO visit, so the WDO line keeps the catalog price.';
    const fetcher = installFetch({
      quote: (body) => (body.withOtherLines === '1' ? { price: 250, source: 'catalog_base', basis: null, staffNote: note } : FRAME_2600),
    });
    mount();
    await addWdoLine();
    await waitFor(() => expect(hint()?.textContent).toContain('$200.00'));
    await addLine('Pest', /One-Time Pest Service/i);
    await waitFor(() => expect(hint()?.textContent).toBe(`Catalog price: $250.00. ${note}`));
    expect(quoteCalls(fetcher).at(-1)).toEqual({ customerId: 'customer-a', withOtherLines: '1' });
  });
});
