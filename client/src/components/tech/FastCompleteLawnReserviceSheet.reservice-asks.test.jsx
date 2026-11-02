// @vitest-environment jsdom
// The lawn re-service Fast Complete sheet with the "They told us" block (GATE_RESERVICE_ASKS, step S2b of the
// consolidated re-service report; owner 2026-11-02). Flag absent: no read, no block, today's /complete body.
// Flag on: the block reads the asks, Complete waits for every answer, and the answers ride the body as
// `reserviceAnswers`. A failed read never holds Complete. Synthetic data only.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FastCompleteLawnReserviceSheet from './FastCompleteLawnReserviceSheet';

vi.setConfig({ testTimeout: 30000 });

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

const CATALOG = [
  { id: 'celsius', name: 'Celsius WG', category: 'herbicide', formulation: 'WG' },
  { id: 'talstar', name: 'Talstar Chinch Bug Insecticide', category: 'insecticide', formulation: 'SC' },
];
const VISIT = {
  id: 'svc-lawn', customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-lawn', serviceKey: 'lawn_re_service',
  serviceType: 'Lawn Care Re-Service', scheduledDate: '2026-10-04', address: { line1: '100 Example St' }, status: 'confirmed',
};
const SERVICE = {
  id: 'svc-lawn', customerId: 'cust-1', customerName: 'Dana Q.', serviceType: 'Lawn Re-Service', address: '100 Example St', timeLabel: '2:00 PM',
  onSiteAt: new Date(Date.now() - 9 * 60 * 1000).toISOString(),
};
const FLAGGED = { ...SERVICE, reserviceAsksEnabled: true };

const ITEMS = [
  { id: 'form:1', source: 'request_form', at: '2026-10-06T14:00:00.000Z', text: 'Brown patches by the mailbox', quoted: true, lead: null, kind: 'problem', pests: ['Chinch bugs'] },
  { id: 'call:7', source: 'call', at: '2026-10-07T01:30:00.000Z', text: 'weeds by the garage', quoted: false, lead: 'On your call on Oct 6, you mentioned', kind: 'problem', pests: [] },
  { id: 'text:9', source: 'text', at: '2026-10-08T15:00:00.000Z', text: 'Is it ok to mow?', quoted: true, lead: null, kind: 'question', pests: [] },
];

function contextOf({ customerRequest = null } = {}) {
  return {
    enabled: true, eligible: true, reason: null, service: VISIT, customerRequest, products: CATALOG,
    methods: [{ value: 'spot_treatment', label: 'Spot treatment', common: true, requiresSqft: false }],
    lawnSqft: 6400,
    lastVisit: {
      serviceRecordId: 'rec-1', serviceDate: '2026-09-20', serviceType: 'Lawn Care',
      products: [
        { productId: 'celsius', name: 'Celsius WG', totalAmount: 1.5, amountUnit: 'oz', method: 'spot_treatment', areaValue: null, areaUnit: null },
        { productId: 'talstar', name: 'Talstar Chinch Bug Insecticide', totalAmount: 1, amountUnit: 'oz', method: 'spot_treatment', areaValue: null, areaUnit: null },
      ],
    },
  };
}

// `asks`: the reservice-asks answer (an object), or a function of the attempt number that returns or throws.
function makeRequest({ asks = { enabled: true, lane: 'lawn', window: { from: 'a', to: 'b' }, items: ITEMS }, complete = null, customerRequest = null } = {}) {
  const calls = [];
  let askReads = 0;
  const request = vi.fn(async (path, options) => {
    calls.push({ path, body: options?.body ? JSON.parse(options.body) : null });
    const bare = path.split('?')[0];
    if (bare.endsWith('/lawn-reservice/fast-context')) return contextOf({ customerRequest });
    if (bare.endsWith('/reservice-asks')) {
      askReads += 1;
      return typeof asks === 'function' ? asks(askReads) : asks;
    }
    if (bare.endsWith('/complete')) return complete ? complete(calls.filter((c) => c.path.endsWith('/complete')).length) : { success: true };
    return {};
  });
  request.completes = () => calls.filter((call) => call.path.endsWith('/complete'));
  request.askReads = () => calls.filter((call) => call.path.endsWith('/reservice-asks'));
  return request;
}

async function openSheet(request, service = FLAGGED) {
  render(<FastCompleteLawnReserviceSheet service={service} request={request} onClose={() => {}} />);
  await screen.findByRole('heading', { name: 'Products used' });
}
const issue = (name) => within(screen.getByRole('heading', { name: 'Treating for' }).closest('section')).getByRole('button', { name });
// The lawn sheet's own required taps, with Celsius on.
function tapRequired() {
  fireEvent.click(screen.getByRole('button', { name: /^Celsius WG/ }));
  fireEvent.click(issue('Dollarweed'));
  fireEvent.click(within(within(screen.getByRole('group', { name: 'Celsius WG' })).getByRole('group', { name: 'For' })).getByRole('button', { name: 'Dollarweed' }));
  fireEvent.click(screen.getByRole('button', { name: 'Moderate' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fair' }));
  fireEvent.click(within(within(screen.getByRole('group', { name: 'Celsius WG' })).getByRole('group', { name: 'Where' })).getByRole('button', { name: 'Front lawn' }));
}
const completeButton = () => screen.getByRole('button', { name: 'Complete lawn re-service' });
const HINT = 'Answer each item in They told us.';
const card = (label) => screen.getByRole('group', { name: label });
const tap = (scope, name) => fireEvent.click(within(scope).getByRole('button', { name }));

describe('flag absent or false', () => {
  test.each([['absent', SERVICE], ['false', { ...SERVICE, reserviceAsksEnabled: false }]])('flag %s: no read, no block, today\'s body', async (_name, service) => {
    const request = makeRequest();
    await openSheet(request, service);
    tapRequired();
    expect(screen.queryByText(/They told us/)).toBeNull();
    fireEvent.click(completeButton());
    await waitFor(() => expect(request.completes()).toHaveLength(1));
    expect(request.askReads()).toHaveLength(0);
    expect(request.completes()[0].body).not.toHaveProperty('reserviceAnswers');
    expect(Object.keys(request.completes()[0].body).filter((key) => /reservice|ask/i.test(key))).toEqual([]);
  });
});

describe('flag on', () => {
  test('draws the block at the top with the eyebrow, labels and words', async () => {
    await openSheet(makeRequest());
    expect(await screen.findByText('They told us · 3 items')).toBeTruthy();
    // The block sits above the products.
    const block = screen.getByRole('region', { name: 'They told us' });
    const products = screen.getByRole('heading', { name: 'Products used' }).closest('section');
    expect(block.compareDocumentPosition(products) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(card('Request form · Oct 6')).getByText('“Brown patches by the mailbox”')).toBeTruthy();
    // 9:30 PM Eastern on Oct 6 (01:30 UTC on the 7th): the label is the Eastern day.
    expect(within(card('Call · Oct 6')).getByText('On your call on Oct 6, you mentioned weeds by the garage')).toBeTruthy();
    expect(within(card('Question · Oct 8')).getByText('“Is it ok to mow?”')).toBeTruthy();
  });

  test('the older "They said" box is left out while the block shows items, and stays when the read fails', async () => {
    const said = { text: 'Brown patches by the mailbox', pests: [] };
    await openSheet(makeRequest({ customerRequest: said }));
    await screen.findByText('They told us · 3 items');
    expect(screen.queryByRole('heading', { name: 'They said' })).toBeNull();
    cleanup();
    await openSheet(makeRequest({ customerRequest: said, asks: () => { throw Object.assign(new Error('boom'), { status: 500 }); } }));
    await screen.findByText('Could not load what the customer told us.');
    expect(screen.getByRole('heading', { name: 'They said' })).toBeTruthy();
  });

  test('one item reads "1 item"', async () => {
    await openSheet(makeRequest({ asks: { enabled: true, lane: 'lawn', items: [ITEMS[0]] } }));
    expect(await screen.findByText('They told us · 1 item')).toBeTruthy();
  });

  test('problem items offer five chips, a question offers an input and Not about this visit', async () => {
    await openSheet(makeRequest());
    await screen.findByText('They told us · 3 items');
    const problem = card('Request form · Oct 6');
    expect(within(problem).getAllByRole('button').map((b) => b.textContent)).toEqual(['Treated', 'Checked, none found', 'Noted', 'Not today', 'Not about this visit']);
    for (const b of within(problem).getAllByRole('button')) expect(b.getAttribute('aria-pressed')).toBe('false');
    const question = card('Question · Oct 8');
    expect(within(question).getByLabelText('Your answer').getAttribute('maxlength')).toBe('200');
    expect(within(question).getAllByRole('button').map((b) => b.textContent)).toEqual(['Not about this visit']);
  });

  test('Complete waits for every answer, then the answers ride the body', async () => {
    const request = makeRequest();
    await openSheet(request);
    await screen.findByText('They told us · 3 items');
    tapRequired();
    expect(screen.getByText(HINT)).toBeTruthy();
    expect(completeButton().disabled).toBe(true);

    tap(card('Request form · Oct 6'), 'Treated');
    // Treated needs a product; Celsius is the only one on the completion.
    expect(completeButton().disabled).toBe(true);
    const picker = within(card('Request form · Oct 6')).getByRole('group', { name: 'Products used for this item' });
    tap(picker, 'Celsius WG');
    expect(within(picker).getByRole('button', { name: 'Celsius WG' }).getAttribute('aria-pressed')).toBe('true');

    tap(card('Call · Oct 6'), 'Not about this visit');
    expect(completeButton().disabled).toBe(true);
    fireEvent.change(within(card('Question · Oct 8')).getByLabelText('Your answer'), { target: { value: '  Yes, wait a day.  ' } });
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    expect(screen.queryByText(HINT)).toBeNull();

    fireEvent.click(completeButton());
    await waitFor(() => expect(request.completes()).toHaveLength(1));
    expect(request.completes()[0].body.reserviceAnswers).toEqual({
      items: [
        { itemId: 'form:1', answer: 'treated', productIds: ['celsius'] },
        { itemId: 'call:7', answer: 'hidden' },
        { itemId: 'text:9', answer: 'answered', text: 'Yes, wait a day.' },
      ],
    });
  });

  test('Treated with no product on the sheet is disabled and says why; products matching the item\'s pest come first', async () => {
    const request = makeRequest();
    await openSheet(request);
    await screen.findByText('They told us · 3 items');
    const first = card('Request form · Oct 6');
    expect(within(first).getByRole('button', { name: 'Treated' }).disabled).toBe(true);
    expect(within(first).getByText('Add the product first.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Celsius WG/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Talstar Chinch Bug Insecticide/ }));
    expect(within(first).queryByText('Add the product first.')).toBeNull();
    tap(first, 'Treated');
    // The item's pest is chinch bugs: the row whose name names them leads, the other follows.
    expect(within(within(first).getByRole('group', { name: 'Products used for this item' })).getAllByRole('button').map((b) => b.textContent))
      .toEqual(['Talstar Chinch Bug Insecticide', 'Celsius WG']);
    // An item that names no pest the rows match is offered every row in sheet order.
    const second = card('Call · Oct 6');
    tap(second, 'Treated');
    expect(within(within(second).getByRole('group', { name: 'Products used for this item' })).getAllByRole('button').map((b) => b.textContent))
      .toEqual(['Celsius WG', 'Talstar Chinch Bug Insecticide']);
  });

  test('a product row removed later drops out of the answer, and the answer is incomplete again', async () => {
    const request = makeRequest({ asks: { enabled: true, lane: 'lawn', items: [ITEMS[0]] } });
    await openSheet(request);
    await screen.findByText('They told us · 1 item');
    tapRequired();
    const first = card('Request form · Oct 6');
    tap(first, 'Treated');
    tap(within(first).getByRole('group', { name: 'Products used for this item' }), 'Celsius WG');
    expect(completeButton().disabled).toBe(false);
    // Turn the product off again on the sheet.
    fireEvent.click(within(screen.getByRole('heading', { name: 'Products used' }).closest('section')).getByRole('button', { name: /^Celsius WG/ }));
    expect(screen.queryByRole('button', { name: 'Complete lawn re-service' })).toBeTruthy();
    expect(within(first).getByRole('button', { name: 'Treated' }).disabled).toBe(true);
    expect(screen.getByText(/Select at least one product|Answer each item/)).toBeTruthy();
    // Back on: the old pick is gone, so the item needs a product again.
    fireEvent.click(within(screen.getByRole('heading', { name: 'Products used' }).closest('section')).getByRole('button', { name: /^Celsius WG/ }));
    expect(within(within(first).getByRole('group', { name: 'Products used for this item' })).getByRole('button', { name: 'Celsius WG' }).getAttribute('aria-pressed')).toBe('false');
  });

  test('Not today needs a reason of 1 to 160 characters', async () => {
    const request = makeRequest({ asks: { enabled: true, lane: 'lawn', items: [ITEMS[0]] } });
    await openSheet(request);
    await screen.findByText('They told us · 1 item');
    tapRequired();
    tap(card('Request form · Oct 6'), 'Not today');
    const reason = within(card('Request form · Oct 6')).getByLabelText('Why not today? (office only)');
    expect(reason.getAttribute('maxlength')).toBe('160');
    expect(completeButton().disabled).toBe(true);
    fireEvent.change(reason, { target: { value: '   ' } });
    expect(completeButton().disabled).toBe(true);
    fireEvent.change(reason, { target: { value: 'Rain all day' } });
    expect(completeButton().disabled).toBe(false);
    fireEvent.click(completeButton());
    await waitFor(() => expect(request.completes()).toHaveLength(1));
    expect(request.completes()[0].body.reserviceAnswers).toEqual({ items: [{ itemId: 'form:1', answer: 'not_today', reason: 'Rain all day' }] });
  });

  test('a typed answer with a web link or a phone number is caught before Complete', async () => {
    const request = makeRequest({ asks: { enabled: true, lane: 'lawn', items: [ITEMS[2]] } });
    await openSheet(request);
    await screen.findByText('They told us · 1 item');
    tapRequired();
    const input = within(card('Question · Oct 8')).getByLabelText('Your answer');
    fireEvent.change(input, { target: { value: 'See www.example.com' } });
    expect(screen.getByText('Leave web links out of the answer.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'Call 941 555 0100' } });
    expect(screen.getByText('Leave phone numbers out of the answer.')).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'Yes, mow in a day.' } });
    expect(completeButton().disabled).toBe(false);
  });

  test('tapping the pressed chip again clears the answer', async () => {
    await openSheet(makeRequest({ asks: { enabled: true, lane: 'lawn', items: [ITEMS[0]] } }));
    await screen.findByText('They told us · 1 item');
    const first = card('Request form · Oct 6');
    tap(first, 'Noted');
    expect(within(first).getByRole('button', { name: 'Noted' }).getAttribute('aria-pressed')).toBe('true');
    tap(first, 'Checked, none found');
    expect(within(first).getByRole('button', { name: 'Noted' }).getAttribute('aria-pressed')).toBe('false');
    expect(within(first).getByRole('button', { name: 'Checked, none found' }).getAttribute('aria-pressed')).toBe('true');
    tap(first, 'Checked, none found');
    expect(within(first).getByRole('button', { name: 'Checked, none found' }).getAttribute('aria-pressed')).toBe('false');
  });

  test('the server\'s 400 for a wrong answer shows in plain words and the tech can fix and resend', async () => {
    const request = makeRequest({
      asks: { enabled: true, lane: 'lawn', items: [ITEMS[2]] },
      complete: (n) => {
        if (n === 1) throw Object.assign(new Error('That wording cannot go to a customer. Rewrite the answer.'), { status: 400, code: 'reservice_answer_invalid' });
        return { success: true };
      },
    });
    await openSheet(request);
    await screen.findByText('They told us · 1 item');
    tapRequired();
    fireEvent.change(within(card('Question · Oct 8')).getByLabelText('Your answer'), { target: { value: 'It is safe.' } });
    fireEvent.click(completeButton());
    expect(await screen.findByText('That wording cannot go to a customer. Rewrite the answer.')).toBeTruthy();
    fireEvent.change(within(card('Question · Oct 8')).getByLabelText('Your answer'), { target: { value: 'Yes, mow in a day.' } });
    fireEvent.click(completeButton());
    await waitFor(() => expect(request.completes()).toHaveLength(2));
    expect(request.completes()[1].body.reserviceAnswers.items[0]).toEqual({ itemId: 'text:9', answer: 'answered', text: 'Yes, mow in a day.' });
  });
});

describe('the read', () => {
  test.each([
    ['gate off (404)', () => { throw Object.assign(new Error('x'), { status: 404 }); }],
    ['not a re-service (409)', () => { throw Object.assign(new Error('x'), { status: 409 }); }],
    ['no items', () => ({ enabled: true, lane: 'lawn', items: [] })],
  ])('%s: no block, Complete is not held, nothing extra is sent', async (_name, asks) => {
    const request = makeRequest({ asks });
    await openSheet(request);
    await waitFor(() => expect(request.askReads()).toHaveLength(1));
    tapRequired();
    await waitFor(() => expect(completeButton().disabled).toBe(false));
    expect(screen.queryByText(/They told us/)).toBeNull();
    expect(screen.queryByText(/Could not load/)).toBeNull();
    fireEvent.click(completeButton());
    await waitFor(() => expect(request.completes()).toHaveLength(1));
    expect(request.completes()[0].body).not.toHaveProperty('reserviceAnswers');
  });

  test('any other failure shows a notice with Retry and does not hold Complete; Retry loads the block', async () => {
    const request = makeRequest({
      asks: (n) => {
        if (n === 1) throw Object.assign(new Error('Server error'), { status: 500 });
        return { enabled: true, lane: 'lawn', items: [ITEMS[0]] };
      },
    });
    await openSheet(request);
    expect(await screen.findByText('Could not load what the customer told us.')).toBeTruthy();
    tapRequired();
    expect(completeButton().disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('They told us · 1 item')).toBeTruthy();
    expect(screen.queryByText(/Could not load/)).toBeNull();
    expect(completeButton().disabled).toBe(true);
    expect(screen.getByText(HINT)).toBeTruthy();
  });

  test('a failed read sends no answers', async () => {
    const request = makeRequest({ asks: () => { throw Object.assign(new Error('Server error'), { status: 503 }); } });
    await openSheet(request);
    await screen.findByText('Could not load what the customer told us.');
    tapRequired();
    fireEvent.click(completeButton());
    await waitFor(() => expect(request.completes()).toHaveLength(1));
    expect(request.completes()[0].body).not.toHaveProperty('reserviceAnswers');
  });
});
