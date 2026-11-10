// @vitest-environment jsdom
// The technician estimate tool's phone screen (GATE_TECH_ESTIMATES): what it asks the server, what it shows for
// each answer, and that a raw reason code never reaches the technician.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

let mockSoldBy = false;
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: (key) => (key === 'commission_sold_by' ? mockSoldBy : false) }));
vi.mock('./fieldPortal', () => ({ useFieldPortalClass: () => '' }));
vi.mock('../../hooks/useModalFocus', () => ({ default: () => ({ current: null }) }));
vi.mock('../../hooks/useIsMobile', () => ({ default: () => true }));
vi.mock('../../lib/adminAuth', () => ({ getAdminAuthToken: () => 'token' }));

import TechEstimateSheet from './TechEstimateSheet';

const SETUP = {
  oneTimeHoldDollars: 1000,
  services: [
    { key: 'PEST', label: 'Recurring pest control', category: 'pest' },
    { key: 'TERMITE_BAIT', label: 'Termite bait stations', category: 'termite' },
  ],
};
const VISIT = { id: 'visit-1', customer_id: 'customer-1', customerName: 'Sample Customer', address: '100 Sample St' };
const DIGEST = 'a'.repeat(64);
const READY = {
  lines: [{ label: 'Recurring pest control', monthly: 45, annual: 540 }],
  monthlyTotal: 45, annualTotal: 540, oneTimeTotal: 0,
  facts: { homeSqFt: { value: 1800, source: 'lookup' }, lotSqFt: { value: 9000, source: 'lookup' }, stories: { value: 1, source: 'lookup' } },
  officeFirst: { required: false, reasons: [] },
  digest: DIGEST,
};
const SAVED = { id: 'est-1', status: 'draft', ...READY };

let calls; // [{ method, path, body }]
let replies; // path key -> queue of { status, body }

function reply(key, status, body) { (replies[key] = replies[key] || []).push({ status, body }); }
beforeEach(() => {
  calls = [];
  replies = {};
  mockSoldBy = false;
  let n = 0;
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`);
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const method = options.method || 'GET';
    const path = String(url).replace('/api/tech/estimates', '') || '/';
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    const next = (replies[key] || []).shift() || { status: 200, body: {} };
    return { ok: next.status < 400, status: next.status, json: async () => next.body };
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const open = (props = {}) => render(<TechEstimateSheet setup={SETUP} service={VISIT} onClose={() => {}} onHandOff={() => {}} {...props} />);
const pick = (label) => fireEvent.click(screen.getByLabelText(label));
const getPrice = () => fireEvent.click(screen.getByRole('button', { name: 'Get price' }));
const priceCalls = () => calls.filter((c) => c.path === '/price');

describe('who and which services', () => {
  it('shows the visit customer, preselects nothing and asks for a service before pricing', () => {
    open();
    expect(screen.getByText('Sample Customer')).toBeInTheDocument();
    expect(screen.getByLabelText('Recurring pest control')).not.toBeChecked();
    expect(screen.getByLabelText('Termite bait stations')).not.toBeChecked();
    getPrice();
    expect(screen.getByRole('alert')).toHaveTextContent('Pick at least one service.');
    expect(calls).toEqual([]);
  });

  it('asks for the new person fields the server requires before it prices', () => {
    open({ service: null });
    pick('Recurring pest control');
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Pat' } });
    getPrice();
    expect(screen.getByRole('alert')).toHaveTextContent('First name, phone, address and ZIP are required.');
    expect(calls).toEqual([]);
  });
});

describe('the price request and the save request', () => {
  it('prices a visit quote with exactly visitId and services, never a customerId', async () => {
    reply('POST /price', 200, READY);
    open();
    pick('Recurring pest control');
    getPrice();
    await screen.findByText('This estimate is ready. Save it.');
    expect(priceCalls()).toEqual([{ method: 'POST', path: '/price', body: { visitId: 'visit-1', services: ['PEST'] } }]);
    expect(JSON.stringify(calls)).not.toMatch(/customerId|customer-1/);
  });

  it('prices a new person with exactly prospect and services', async () => {
    reply('POST /price', 200, READY);
    open({ service: null });
    const fill = { 'First name': 'Pat', 'Last name': 'Sample', 'Mobile phone': '(941) 555-0100', 'Street address': '100 Sample St', City: 'Bradenton', ZIP: '34205' };
    for (const [label, value] of Object.entries(fill)) fireEvent.change(screen.getByLabelText(label), { target: { value } });
    pick('Recurring pest control');
    getPrice();
    await screen.findByText('This estimate is ready. Save it.');
    expect(priceCalls()[0].body).toEqual({
      prospect: { firstName: 'Pat', lastName: 'Sample', phone: '(941) 555-0100', address: '100 Sample St', city: 'Bradenton', zip: '34205' },
      services: ['PEST'],
    });
  });

  it('saves with the same body plus clientDraftId and digest, and a retry reuses the id', async () => {
    reply('POST /price', 200, READY);
    reply('POST /', 500, { error: 'Server trouble' });
    reply('POST /', 200, SAVED);
    open();
    pick('Recurring pest control');
    getPrice();
    await screen.findByText('This estimate is ready. Save it.');
    fireEvent.click(screen.getByRole('button', { name: 'Save estimate' }));
    await screen.findByText('Server trouble');
    fireEvent.click(screen.getByRole('button', { name: 'Save estimate' }));
    await screen.findByText('Saved. Sending from the phone comes next; for now the office sends it.');
    const saves = calls.filter((c) => c.method === 'POST' && c.path === '/');
    expect(saves).toHaveLength(2);
    expect(Object.keys(saves[0].body).sort()).toEqual(['clientDraftId', 'digest', 'services', 'visitId']);
    expect(saves[0].body).toMatchObject({ visitId: 'visit-1', services: ['PEST'], digest: DIGEST });
    expect(saves[1].body.clientDraftId).toBe(saves[0].body.clientDraftId);
  });

  it('a re-price after a changed fact sends the facts and makes a new draft id', async () => {
    reply('POST /price', 200, READY);
    reply('POST /price', 200, { ...READY, facts: { ...READY.facts, homeSqFt: { value: 2000, source: 'technician' } }, officeFirst: { required: true, reasons: ['changed_fact:homeSqFt'] } });
    reply('POST /', 200, { ...SAVED, officeFirst: { required: true, reasons: ['changed_fact:homeSqFt'] } });
    open();
    pick('Recurring pest control');
    getPrice();
    await screen.findByText('This estimate is ready. Save it.');
    fireEvent.click(screen.getByRole('button', { name: 'Change home size' }));
    fireEvent.change(screen.getByLabelText('New home size'), { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update price' }));
    await screen.findByText('The office checks this one first.');
    expect(priceCalls()[1].body).toEqual({ visitId: 'visit-1', services: ['PEST'], facts: { homeSqFt: 2000 } });
    fireEvent.click(screen.getByRole('button', { name: 'Save estimate' }));
    await screen.findByText('Saved. The office checks it and sends it.');
    const save = calls.find((c) => c.method === 'POST' && c.path === '/');
    expect(save.body.clientDraftId).toBe('00000000-0000-4000-8000-000000000002');
    expect(save.body.facts).toEqual({ homeSqFt: 2000 });
  });

  it('shows the termite perimeter only when the termite line is chosen', async () => {
    reply('POST /price', 200, READY);
    open();
    pick('Termite bait stations');
    getPrice();
    await screen.findByText('This estimate is ready. Save it.');
    expect(screen.getByRole('button', { name: 'Change termite perimeter' })).toBeInTheDocument();
    expect(screen.getByText('If you change a measured fact, the office checks the estimate before it goes.')).toBeInTheDocument();
  });
});

describe('the verdict in plain words', () => {
  const verdictFor = async (reasons) => {
    reply('POST /price', 200, { ...READY, oneTimeTotal: 1200, officeFirst: { required: true, reasons } });
    open();
    pick('Recurring pest control');
    getPrice();
    await screen.findByText('The office checks this one first.');
  };

  it('says each reason in a sentence and never shows a code', async () => {
    await verdictFor(['changed_fact:homeSqFt', 'changed_fact:lotSqFt', 'one_time_over_limit', 'office_review']);
    expect(screen.getByText('You changed the home size.')).toBeInTheDocument();
    expect(screen.getByText('You changed the lot size.')).toBeInTheDocument();
    expect(screen.getByText('A one-time job over $1,000.')).toBeInTheDocument();
    expect(screen.getByText('The office must check this one.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/changed_fact|one_time_over_limit|office_review|homeSqFt/);
  });

  it('reads a code it does not know as the office check, not as the code', async () => {
    await verdictFor(['something_new']);
    expect(screen.getByText('The office must check this one.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/something_new/);
  });

  it('shows the lines and the three totals', async () => {
    reply('POST /price', 200, { ...READY, oneTimeTotal: 150, lines: [...READY.lines, { label: 'One-time mosquito treatment', oneTime: 150 }] });
    open();
    pick('Recurring pest control');
    getPrice();
    await screen.findByText('This estimate is ready. Save it.');
    expect(screen.getByText('$45.00 a month')).toBeInTheDocument();
    expect(screen.getByText('$540.00 a year')).toBeInTheDocument();
    expect(screen.getByText('$150.00 one time')).toBeInTheDocument();
    expect(screen.getByText('Monthly total').nextSibling).toHaveTextContent('$45.00');
    expect(screen.getByText('Yearly total').nextSibling).toHaveTextContent('$540.00');
    expect(screen.getByText('One-time total').nextSibling).toHaveTextContent('$150.00');
  });
});

describe('refusals', () => {
  it('422 office_prices says so and hands the same visit to the lead flag', async () => {
    reply('POST /price', 422, { error: 'The office needs to price this one.', code: 'office_prices' });
    const onHandOff = vi.fn();
    open({ onHandOff });
    pick('Recurring pest control');
    getPrice();
    await screen.findByText('The office needs to price this one.');
    fireEvent.click(screen.getByRole('button', { name: 'Flag it for the office' }));
    expect(onHandOff).toHaveBeenCalledWith({ service: VISIT, prospect: null });
  });

  it('422 for a new person hands over what he typed, only while the Neighbor flag form exists', async () => {
    reply('POST /price', 422, { error: 'x', code: 'office_prices' });
    reply('POST /price', 422, { error: 'x', code: 'office_prices' });
    const onHandOff = vi.fn();
    const { unmount } = open({ service: null, onHandOff });
    const fill = () => {
      for (const [label, value] of Object.entries({ 'First name': 'Pat', 'Mobile phone': '9415550100', 'Street address': '100 Sample St', ZIP: '34205' })) fireEvent.change(screen.getByLabelText(label), { target: { value } });
      pick('Recurring pest control');
      getPrice();
    };
    fill();
    await screen.findByText('The office needs to price this one.');
    expect(screen.queryByRole('button', { name: 'Flag it for the office' })).not.toBeInTheDocument();
    unmount();
    mockSoldBy = true;
    open({ service: null, onHandOff });
    fill();
    fireEvent.click(await screen.findByRole('button', { name: 'Flag it for the office' }));
    expect(onHandOff).toHaveBeenCalledWith({ service: null, prospect: expect.objectContaining({ firstName: 'Pat', phone: '9415550100', zip: '34205' }) });
  });

  it('502 says the lookup is not available', async () => {
    reply('POST /price', 502, { error: 'The property lookup is not available right now. Try again, or ask the office.' });
    open();
    pick('Recurring pest control');
    getPrice();
    expect(await screen.findByText('The property lookup is not available right now. Try again.')).toBeInTheDocument();
  });

  it('429 daily_limit shows the server message, offers the office hand-off and no retry', async () => {
    const message = "You reached today's limit of new address lookups. Ask the office to price this one.";
    reply('POST /price', 429, { error: message, code: 'daily_limit' });
    const onHandOff = vi.fn();
    open({ onHandOff });
    pick('Recurring pest control');
    getPrice();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Get price' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Flag it for the office' }));
    expect(onHandOff).toHaveBeenCalledWith({ service: VISIT, prospect: null });
  });

  it('404 on a visit says it left his route and closes the actions', async () => {
    reply('POST /price', 404, { error: 'Visit not found' });
    open();
    pick('Recurring pest control');
    getPrice();
    expect(await screen.findByText('This visit is no longer on your route.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Get price' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save estimate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Flag it for the office' })).not.toBeInTheDocument();
  });

  it('a 404 enabled:false (his switch went off) is not read as a visit that left his route', async () => {
    reply('POST /price', 404, { enabled: false });
    open();
    pick('Recurring pest control');
    getPrice();
    expect(await screen.findByText('Something went wrong. Try again.')).toBeInTheDocument();
  });

  it('the card shows the address the visit itself carries (a second home)', () => {
    open({ service: { ...VISIT, address: '200 Second Home Way' } });
    expect(screen.getByText('200 Second Home Way')).toBeInTheDocument();
  });

  it('400 shows the server message', async () => {
    reply('POST /price', 400, { error: 'A 10-digit phone number is required' });
    open();
    pick('Recurring pest control');
    getPrice();
    expect(await screen.findByText('A 10-digit phone number is required')).toBeInTheDocument();
  });

  it('a dropped connection reads as a retry line, not a browser message', async () => {
    fetch.mockImplementationOnce(async () => { throw new TypeError('Failed to fetch'); });
    open();
    pick('Recurring pest control');
    getPrice();
    expect(await screen.findByText('Something went wrong. Try again.')).toBeInTheDocument();
  });

  it('409 price_changed prices the quote again by itself, with a new id, and asks him to look', async () => {
    reply('POST /price', 200, READY);
    reply('POST /', 409, { error: 'The price changed. Price it again.', code: 'price_changed' });
    reply('POST /price', 200, { ...READY, monthlyTotal: 50, annualTotal: 600, digest: 'b'.repeat(64) });
    open();
    pick('Recurring pest control');
    getPrice();
    await screen.findByText('This estimate is ready. Save it.');
    fireEvent.click(screen.getByRole('button', { name: 'Save estimate' }));
    await screen.findByText('The price changed. Check it, then save.');
    expect(priceCalls()).toHaveLength(2);
    expect(priceCalls()[1].body).toEqual(priceCalls()[0].body);
    expect(screen.getByText('Monthly total').nextSibling).toHaveTextContent('$50.00');
    reply('POST /', 200, SAVED);
    fireEvent.click(screen.getByRole('button', { name: 'Save estimate' }));
    await screen.findByText(/^Saved\./);
    const saves = calls.filter((c) => c.method === 'POST' && c.path === '/');
    expect(saves[1].body.digest).toBe('b'.repeat(64));
    expect(saves[1].body.clientDraftId).not.toBe(saves[0].body.clientDraftId);
  });

  it('a second tap while the price is loading sends nothing more', async () => {
    let release;
    fetch.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, json: async () => READY }); }));
    open();
    pick('Recurring pest control');
    getPrice();
    const busy = screen.getByRole('button', { name: 'Getting the price…' });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(priceCalls()).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    release();
    await screen.findByText('This estimate is ready. Save it.');
  });
});

describe('My estimates', () => {
  const ROW = {
    id: 'est-1', status: 'sent', who: 'Sample Customer', addressLine: '100 Sample St',
    monthlyTotal: 45, annualTotal: 540, oneTimeTotal: 0, officeFirst: { required: true, reasons: ['office_review'] },
  };

  it('lists his estimates in words and opens one with its lines', async () => {
    reply('GET /', 200, { estimates: [ROW, { ...ROW, id: 'est-2', who: null, status: 'draft', officeFirst: { required: false, reasons: [] } }] });
    reply('GET /est-1', 200, { ...ROW, lines: READY.lines });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'My estimates' }));
    expect(await screen.findByRole('button', { name: /Sample Customer/ })).toBeInTheDocument();
    expect(screen.getByText(/Sent · \$45.00 a month · \$540.00 a year$/)).toBeInTheDocument();
    expect(screen.getByText(/Draft ·/)).toBeInTheDocument();
    expect(screen.getAllByText('Office checks first')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Sample Customer/ }));
    expect(await screen.findByText('Recurring pest control')).toBeInTheDocument();
    expect(calls.map((c) => c.path)).toContain('/est-1');
    expect(document.body.textContent).not.toMatch(/office_review/);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('says so when he has none', async () => {
    reply('GET /', 200, { estimates: [] });
    open({ service: null });
    fireEvent.click(screen.getByRole('button', { name: 'My estimates' }));
    expect(await screen.findByText('You have not saved an estimate yet.')).toBeInTheDocument();
  });

  it('keeps a priced quote while he looks at My estimates', async () => {
    reply('POST /price', 200, READY);
    reply('GET /', 200, { estimates: [] });
    open();
    pick('Recurring pest control');
    getPrice();
    await screen.findByText('This estimate is ready. Save it.');
    fireEvent.click(screen.getByRole('button', { name: 'My estimates' }));
    await screen.findByText('You have not saved an estimate yet.');
    fireEvent.click(screen.getByRole('button', { name: 'New estimate' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save estimate' })).toBeVisible());
  });
});
