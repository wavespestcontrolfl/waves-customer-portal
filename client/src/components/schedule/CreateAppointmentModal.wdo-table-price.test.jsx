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
  newCallerBookBlockReason, saveFormMoved, wdoLineHintText, wdoQuoteAnswer, wdoQuoteBody, wdoQuoteQuery, wdoSubmitGate,
} from './CreateAppointmentModal.jsx';
import modalSource from './CreateAppointmentModal.jsx?raw';

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
function installFetch({ quote, save = () => json({ id: 'appt-1' }), catalog = [WDO, PEST_ONCE], estimates = [], discounts = [] }) {
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
    if (url.includes('/admin/services?')) return Promise.resolve(json({ services: catalog }));
    if (url.includes('/properties?context=appointment_address')) return Promise.resolve(json({ properties: [] }));
    if (url.includes('/schedule-estimates')) return Promise.resolve(json({ estimates }));
    if (url.endsWith('/admin/technicians')) return Promise.resolve(json({ technicians: [] }));
    if (url.endsWith('/admin/discounts')) return Promise.resolve(json(discounts));
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

  it('a cleared line beside a blank WDO line books the $0 the total shows, never its catalog price', async () => {
    const fetcher = installFetch({ quote: () => FRAME_2600 });
    mount();
    await addLine('Pest', /One-Time Pest Service/i);
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '' } });
    await addWdoLine();
    await waitFor(() => expect(hint()?.textContent).toBe('Table price: $200.00 (2,600 sq ft, wood frame).'));
    expect(total()).toContain('$200');
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(saveButton());
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    // The pest line posts the $0 it showed (a null would book its $150 catalog price); the WDO line posts blank.
    expect(schedulePosts(fetcher)[0]).toMatchObject({
      serviceId: 'svc-pest1', primaryLinePrice: 0, estimatedPrice: 200, wdoExpectedPrice: 200,
      serviceAddons: [expect.objectContaining({ serviceId: 'svc-wdo', basePrice: null })],
    });
  });

  it('a retry after a partial save reads no price for a WDO line already booked, so a failed read never blocks the rest', async () => {
    const FIRST = { id: 'svc-first', service_key: 'svc_first', name: 'First seasonal service', billing_type: 'recurring', frequency: 'seasonal_feb_oct', visits_per_year: 9, base_price: 40, default_duration_minutes: 30 };
    const SECOND = { ...FIRST, id: 'svc-second', service_key: 'svc_second', name: 'Second seasonal service' };
    let quoteFails = false;
    let secondTries = 0;
    const fetcher = installFetch({
      catalog: [WDO, FIRST, SECOND],
      quote: () => (quoteFails ? json({ error: 'read failed' }, { ok: false, status: 500 }) : FRAME_2600),
      save: (body) => {
        if (body.serviceId !== 'svc-second') return json({ id: 'appt-1' });
        secondTries += 1;
        return secondTries === 1 ? json({ error: 'failed' }, { ok: false, status: 500 }) : json({ id: 'appt-2' });
      },
    });
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    mount();
    await addLine('seasonal', /First seasonal service/i);
    await addWdoLine();
    await addLine('seasonal', /Second seasonal service/i);
    await waitFor(() => expect(hint()?.textContent).toContain('$200.00'));
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(saveButton());
    // The first appointment (the first seasonal line with the WDO line) books; the second fails.
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(2));
    expect(schedulePosts(fetcher)[0]).toMatchObject({ serviceId: 'svc-first', wdoExpectedPrice: 200 });
    const reads = quoteCalls(fetcher).length;
    quoteFails = true;
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(saveButton());
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(3));
    expect(schedulePosts(fetcher)[2]).toMatchObject({ serviceId: 'svc-second' });
    expect(schedulePosts(fetcher)[2]).not.toHaveProperty('wdoExpectedPrice');
    expect(quoteCalls(fetcher)).toHaveLength(reads);
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

  it('a WDO main line with another paid line asks for that, and the line shows the catalog price and why; a free line changes nothing', async () => {
    const note = 'Other paid services are booked on this WDO visit, so the WDO line keeps the catalog price.';
    const fetcher = installFetch({
      quote: (body) => (body.withOtherLines === '1' ? { price: 250, source: 'catalog_base', basis: null, staffNote: note } : FRAME_2600),
      discounts: [{ id: 'd-free', name: 'Free add-on', discount_type: 'percentage', amount: '100.00', is_active: true, show_in_invoices: true }],
    });
    mount();
    await addWdoLine();
    await waitFor(() => expect(hint()?.textContent).toContain('$200.00'));
    await addLine('Pest', /One-Time Pest Service/i);
    await waitFor(() => expect(hint()?.textContent).toBe(`Catalog price: $250.00. ${note}`));
    expect(quoteCalls(fetcher).at(-1)).toEqual({ customerId: 'customer-a', withOtherLines: '1' });
    // The pest line made free ($0): the inspection is the only paid line again, so it takes the table price.
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '0' } });
    await waitFor(() => expect(hint()?.textContent).toBe('Table price: $200.00 (2,600 sq ft, wood frame).'));
    expect(quoteCalls(fetcher).at(-1)).toEqual({ customerId: 'customer-a' });
    // A price a discount takes to $0 is still a paid line (the server's rule: beside an appointment credit, the discount
    // stacking stores part of that price on the line, and the WDO filing reads it as paid).
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '50' } });
    await waitFor(() => expect(hint()?.textContent).toBe(`Catalog price: $250.00. ${note}`));
    fireEvent.focus(screen.getByPlaceholderText(/Search discounts for One-Time Pest/));
    fireEvent.click(await screen.findByRole('button', { name: /Free add-on/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove discount' })).toBeTruthy());
    expect(hint()?.textContent).toBe(`Catalog price: $250.00. ${note}`);
    expect(quoteCalls(fetcher).at(-1)).toEqual({ customerId: 'customer-a', withOtherLines: '1' });
  });

  it('Save counts the form as changed when any field it posts moved: a line, the day, the prepay choice, a note', () => {
    const services = [{ lineId: 'a' }];
    const atClick = { services, apptDate: '2026-12-01', collectPrepay: true, prepayNote: '', appointmentDiscount: null };
    expect(saveFormMoved({ ...atClick }, atClick)).toBe(false);
    for (const [field, value] of [['services', [...services]], ['apptDate', '2026-12-02'], ['collectPrepay', false], ['prepayNote', 'paid'],
      ['appointmentDiscount', { id: 'd' }]]) {
      expect(saveFormMoved({ ...atClick, [field]: value }, atClick)).toBe(true);
    }
    // Every field the Save body posts, or the save acts on after it posts (the manual prepay invoice, the card form), is in
    // the form it compares.
    const saveFormLiteral = modalSource.slice(modalSource.indexOf('  const saveForm = {'), modalSource.indexOf('  };', modalSource.indexOf('  const saveForm = {')));
    for (const field of ['services', 'selectedPropertyId', 'wdoQuoteKey', 'linkedEstimate', 'apptDate', 'windowStart', 'techMode', 'techId',
      'customerAskedTime', 'customerNotes', 'internalNotes', 'customerWords', 'usedSuggestion', 'separateProgramReason', 'recurringCount', 'skipWeekends',
      'weekendShift', 'appointmentDiscount', 'collectPrepay', 'billAsAnnualPrepay', 'billAsManualPrepay', 'prepayMethod', 'prepayNote',
      'manualPrepay', 'sendCardLink', 'cardHere', 'sendSms']) {
      expect(saveFormLiteral).toMatch(new RegExp(`\\b${field}\\b`));
    }
  });

  it.each([
    ['the day', 'new-appt-date', futureDate(31), { scheduledDate: futureDate(31) }],
    ['the internal note', 'new-appt-internal-notes', 'Call before arriving', { internalNotes: 'Call before arriving' }],
  ])('%s changed while Save re-reads the WDO price books nothing; the next save books the new one', async (_label, fieldId, value, posted) => {
    let holdReads = false;
    const releases = [];
    const fetcher = installFetch({
      quote: () => (holdReads ? new Promise((resolve) => { releases.push(() => resolve(FRAME_2600)); }) : FRAME_2600),
    });
    mount();
    await addWdoLine();
    await waitFor(() => expect(hint()?.textContent).toContain('$200.00'));
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    holdReads = true;
    fireEvent.click(saveButton());
    await waitFor(() => expect(releases).toHaveLength(1));
    // The office changes the field while the price is re-read.
    fireEvent.change(document.getElementById(fieldId), { target: { value } });
    releases.forEach((release) => release());
    expect(await screen.findByText(/The booking changed while the WDO price was checked/)).toBeTruthy();
    expect(schedulePosts(fetcher)).toHaveLength(0);
    holdReads = false;
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(saveButton());
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    expect(schedulePosts(fetcher)[0]).toMatchObject({ serviceId: 'svc-wdo', ...posted });
  });

  it('Save compares the form after its last wait, just before each POST', () => {
    const compareText = 'if (unsavedBlankWdoLines > 0 && saveFormMoved(latestSaveRef.current.saveForm, saveForm)) {';
    const post = modalSource.indexOf("const r = await adminFetch('/admin/schedule', { method: 'POST', body: JSON.stringify(body) });");
    const compare = modalSource.indexOf(compareText);
    // One compare, inside the group loop: after the address and discount-setting reads, with no wait before the POST.
    expect(modalSource.indexOf(compareText, compare + 1)).toBe(-1);
    expect(modalSource.lastIndexOf('? await recheckAddressAskAtSubmit({', post)).toBeGreaterThan(0);
    expect(compare).toBeGreaterThan(modalSource.lastIndexOf('? await recheckAddressAskAtSubmit({', post));
    expect(compare).toBeGreaterThan(modalSource.lastIndexOf('await ensureStackingFresh();', post));
    expect(post).toBeGreaterThan(compare);
    expect(modalSource.slice(compare, post)).not.toMatch(/\bawait\b/);
  });

  it('an estimate unlinked while Save re-reads the WDO price books nothing, so the quote is not marked accepted', async () => {
    let holdReads = false;
    const releases = [];
    const fetcher = installFetch({
      quote: () => (holdReads ? new Promise((resolve) => { releases.push(() => resolve(FRAME_2600)); }) : FRAME_2600),
      estimates: [{ id: 'est-1', status: 'sent', serviceInterest: 'WDO inspection', lines: [], propertyId: null }],
    });
    mount();
    const estimateSelect = async () => (await screen.findByRole('option', { name: /WDO inspection/ })).closest('select');
    fireEvent.change(await estimateSelect(), { target: { value: 'est-1' } });
    await addWdoLine();
    await waitFor(() => expect(quoteCalls(fetcher).at(-1)).toEqual({ customerId: 'customer-a', estimateId: 'est-1' }));
    await waitFor(() => expect(hint()?.textContent).toContain('$200.00'));
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    holdReads = true;
    fireEvent.click(saveButton());
    await waitFor(() => expect(releases).toHaveLength(1));
    // The office unlinks the estimate while the price is re-read.
    fireEvent.change(await estimateSelect(), { target: { value: '' } });
    releases.forEach((release) => release());
    expect(await screen.findByText(/The booking changed while the WDO price was checked/)).toBeTruthy();
    expect(schedulePosts(fetcher)).toHaveLength(0);
    holdReads = false;
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(saveButton());
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    expect(schedulePosts(fetcher)[0]).toMatchObject({ serviceId: 'svc-wdo', wdoExpectedPrice: 200 });
    expect(schedulePosts(fetcher)[0].sourceEstimateId).toBeUndefined();
  });

  it('a line edited while Save re-reads the WDO price books nothing; the next save books what the form shows', async () => {
    let holdReads = false;
    const releases = [];
    const fetcher = installFetch({
      quote: () => (holdReads ? new Promise((resolve) => { releases.push(() => resolve(FRAME_2600)); }) : FRAME_2600),
    });
    mount();
    await addWdoLine();
    await waitFor(() => expect(hint()?.textContent).toContain('$200.00'));
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    holdReads = true;
    fireEvent.click(saveButton());
    await waitFor(() => expect(releases).toHaveLength(1));
    // The office types a price while the price is re-read.
    fireEvent.change(screen.getByPlaceholderText('Auto (home size)'), { target: { value: '260' } });
    releases.forEach((release) => release());
    expect(await screen.findByText(/The booking changed while the WDO price was checked/)).toBeTruthy();
    expect(schedulePosts(fetcher)).toHaveLength(0);
    holdReads = false;
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(saveButton());
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    expect(schedulePosts(fetcher)[0]).toMatchObject({ serviceId: 'svc-wdo', primaryLinePrice: 260 });
    expect(schedulePosts(fetcher)[0]).not.toHaveProperty('wdoExpectedPrice');
  });
});
