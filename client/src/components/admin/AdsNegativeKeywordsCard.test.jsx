// @vitest-environment jsdom
/**
 * Ads -> Advisor "Blocked search words" card. The server routes ship behind
 * GATE_ADS_NEGATIVES, so the card stays invisible while GET answers 404 and
 * sends exactly the documented paths and bodies for every owner action.
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdsNegativeKeywordsCard from './AdsNegativeKeywordsCard';

function json(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

function payload(overrides = {}) {
  return {
    words: [
      { id: 'w1', text: 'squirrel', addedAt: '2026-11-02T12:00:00Z', campaigns: [{ campaignId: 'c1', campaignName: 'Synthetic Search', state: 'active', lastError: null }] },
      { id: 'w2', text: 'snake', addedAt: '2026-11-02T12:00:00Z', campaigns: [{ campaignId: 'c1', campaignName: 'Synthetic Search', state: 'pending', lastError: null }] },
      { id: 'w3', text: 'jobs', addedAt: '2026-11-02T12:00:00Z', campaigns: [{ campaignId: 'c1', campaignName: 'Synthetic Search', state: 'failed', lastError: 'converted' }] },
      { id: 'w4', text: 'wildlife', addedAt: '2026-11-02T12:00:00Z', campaigns: [{ campaignId: 'c1', campaignName: 'Synthetic Search', state: 'failed', lastError: 'boom' }] },
    ],
    pending: [
      {
        id: ID_A, text: 'free', campaignId: 'c1', campaignName: 'Synthetic Search', reason: 'Searches with this word never converted.',
        metrics: { term: 'free pest quote', clicks: 3, cost: 4.1, conversions: 0 }, createdAt: '2026-11-02T12:00:00Z', notifiedAt: null,
      },
      { id: ID_B, text: 'diy', campaignId: 'c1', campaignName: 'Synthetic Search', reason: 'Do-it-yourself searches.', metrics: null, createdAt: '2026-11-02T12:00:00Z', notifiedAt: null },
    ],
    log: [
      { id: 'l1', text: 'bats', campaignId: 'c1', campaignName: 'Synthetic Search', source: 'advisor', state: 'active', decidedAt: '2026-11-01T15:00:00Z', pushedAt: '2026-11-01T15:00:01Z', removedAt: null, lastError: null, canUndo: true },
      { id: 'l2', text: 'rats', campaignId: 'c1', campaignName: 'Synthetic Search', source: 'owner_list', state: 'declined', decidedAt: '2026-11-01T14:00:00Z', pushedAt: null, removedAt: null, lastError: null, canUndo: false },
      { id: 'l3', text: 'moles', campaignId: 'c1', campaignName: 'Synthetic Search', source: 'advisor', state: 'removed', decidedAt: '2026-10-28T15:00:00Z', pushedAt: '2026-10-28T15:00:01Z', removedAt: '2026-11-02T13:00:00Z', lastError: null, canUndo: false },
    ],
    ...overrides,
  };
}

let calls;
let handlers;
function route(map) {
  calls = [];
  handlers = map;
  globalThis.fetch = vi.fn((url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    const handler = handlers[`${method} ${url.replace(/^.*\/api/, '')}`];
    return handler ? handler() : json({ error: 'unexpected' }, 500);
  });
}
const posts = () => calls.filter((c) => c.method === 'POST');

function renderCard(path = '/admin/ppc?tab=advisor') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AdsNegativeKeywordsCard />
    </MemoryRouter>,
  );
}

describe('AdsNegativeKeywordsCard', () => {
  beforeEach(() => {
    localStorage.setItem('waves_admin_token', 'test-token');
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('renders nothing when the switch is off (404)', async () => {
    route({ 'GET /admin/ads/negatives': () => json({ error: 'not_found' }, 404) });
    const { container } = renderCard();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it('shows one short error line for any other failure', async () => {
    route({ 'GET /admin/ads/negatives': () => json({ error: 'boom' }, 500) });
    renderCard();
    expect(await screen.findByText('Could not load the blocked search words.')).toBeInTheDocument();
  });

  it('sends the admin token and renders waiting items with their numbers', async () => {
    route({ 'GET /admin/ads/negatives': () => json(payload()) });
    renderCard();
    expect(await screen.findByText('“free”')).toBeInTheDocument();
    expect(calls[0].headers.Authorization).toBe('Bearer test-token');
    expect(screen.getByText('Searches with this word never converted.')).toBeInTheDocument();
    expect(screen.getByText('3 clicks · $4.10 · 0 conversions · from “free pest quote”')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add “free”' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline “free”' })).toBeInTheDocument();
    // An item without metrics shows no numbers line.
    expect(within(screen.getByTestId(`pending-${ID_B}`)).queryByText(/clicks/)).toBeNull();
  });

  it('Add posts the decision, then reloads the card', async () => {
    let loads = 0;
    route({
      'GET /admin/ads/negatives': () => {
        loads += 1;
        return json(loads === 1 ? payload() : payload({ pending: [] }));
      },
      [`POST /admin/ads/negatives/${ID_A}/decide`]: () => json({ state: 'active', message: 'Blocked "free" in Google Ads.' }),
    });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Add “free”' }));
    await waitFor(() => expect(screen.queryByText('“free”')).toBeNull());
    expect(posts()).toHaveLength(1);
    expect(posts()[0].url).toMatch(new RegExp(`/admin/ads/negatives/${ID_A}/decide$`));
    expect(posts()[0].body).toEqual({ decision: 'add' });
    expect(loads).toBe(2);
  });

  it('Decline posts the decline decision', async () => {
    route({
      'GET /admin/ads/negatives': () => json(payload()),
      [`POST /admin/ads/negatives/${ID_B}/decide`]: () => json({ state: 'declined', message: 'Declined.' }),
    });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Decline “diy”' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ decision: 'decline' });
  });

  it('disables both buttons while a request runs and shows the server message on a 409', async () => {
    let release;
    route({
      'GET /admin/ads/negatives': () => json(payload()),
      [`POST /admin/ads/negatives/${ID_A}/decide`]: () =>
        new Promise((resolve) => {
          release = () => resolve(new Response(JSON.stringify({ error: 'converted', message: 'A search with this word brought a conversion in the last 90 days, so it was not blocked.' }), { status: 409 }));
        }),
    });
    renderCard();
    const add = await screen.findByRole('button', { name: 'Add “free”' });
    const decline = screen.getByRole('button', { name: 'Decline “free”' });
    fireEvent.click(add);
    await waitFor(() => expect(add).toBeDisabled());
    expect(decline).toBeDisabled();
    release();
    // Other items stay usable, and the message sits next to the item.
    expect(await screen.findByText(/brought a conversion in the last 90 days/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add “free”' })).not.toBeDisabled();
  });

  it('keeps each word busy until its own request ends, whatever else runs meanwhile', async () => {
    const release = {};
    const refusal = () => new Response(JSON.stringify({ error: 'decided', message: 'This word was already decided.' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    route({
      'GET /admin/ads/negatives': () => json(payload()),
      [`POST /admin/ads/negatives/${ID_A}/decide`]: () => new Promise((resolve) => { release.a = () => resolve(refusal()); }),
      [`POST /admin/ads/negatives/${ID_B}/decide`]: () => new Promise((resolve) => { release.b = () => resolve(refusal()); }),
    });
    renderCard();
    const addA = await screen.findByRole('button', { name: 'Add “free”' });
    fireEvent.click(addA);
    await waitFor(() => expect(addA).toBeDisabled());
    // A second click on the same word while it runs starts nothing.
    fireEvent.click(addA);
    fireEvent.click(screen.getByRole('button', { name: 'Decline “diy”' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Decline “diy”' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Add “free”' })).toBeDisabled();
    expect(posts()).toHaveLength(2);

    release.b();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Decline “diy”' })).not.toBeDisabled());
    // The first word's request is still running: its buttons stay off.
    expect(screen.getByRole('button', { name: 'Add “free”' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Decline “free”' })).toBeDisabled();

    release.a();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add “free”' })).not.toBeDisabled());
  });

  it('an older reload that answers last never overwrites a newer one', async () => {
    const reads = [];
    route({
      'GET /admin/ads/negatives': () => new Promise((resolve) => { reads.push(resolve); }),
      [`POST /admin/ads/negatives/${ID_A}/decide`]: () => json({ state: 'active', message: 'Blocked "free" in Google Ads.' }),
      [`POST /admin/ads/negatives/${ID_B}/decide`]: () => json({ state: 'declined', message: 'Declined "diy".' }),
    });
    renderCard();
    await waitFor(() => expect(reads).toHaveLength(1));
    reads[0](json(payload()));
    fireEvent.click(await screen.findByRole('button', { name: 'Add “free”' }));
    fireEvent.click(screen.getByRole('button', { name: 'Decline “diy”' }));
    await waitFor(() => expect(reads).toHaveLength(3));
    // The newest read (both words settled) answers first, then the older read (both still waiting) answers.
    reads[2](json(payload({ pending: [] })));
    await waitFor(() => expect(screen.getByText('Nothing is waiting.')).toBeInTheDocument());
    reads[1](json(payload()));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('Nothing is waiting.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add “free”' })).toBeNull();
  });

  it('shows the word list states and removes a word', async () => {
    let loads = 0;
    route({
      'GET /admin/ads/negatives': () => {
        loads += 1;
        return json(payload());
      },
      'POST /admin/ads/negatives/words/w1/remove': () => json({ word: { id: 'w1', text: 'squirrel', removedAt: '2026-11-02T13:00:00Z' }, failed: 0 }),
    });
    renderCard();
    await screen.findByText('squirrel');
    expect(screen.getByText('In Google')).toBeInTheDocument();
    expect(screen.getByText('Waiting')).toBeInTheDocument();
    expect(screen.getByText('Not sent: a search with it converted in 90 days')).toBeInTheDocument();
    expect(screen.getByText('Not sent: Google did not take it')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove “squirrel”' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url).toMatch(/\/admin\/ads\/negatives\/words\/w1\/remove$/);
    await waitFor(() => expect(loads).toBe(2));
  });

  it('adds a word, clears the input, and shows a 422 message under the input', async () => {
    let answer = () => json({ error: 'protected', message: 'That word is the name of a service you sell, so it cannot be blocked.' }, 422);
    route({
      'GET /admin/ads/negatives': () => json(payload()),
      'POST /admin/ads/negatives/words': () => answer(),
    });
    renderCard();
    const input = await screen.findByLabelText('Add a word');
    fireEvent.change(input, { target: { value: 'termite' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText(/name of a service you sell/)).toBeInTheDocument();
    expect(posts()[0].body).toEqual({ text: 'termite' });
    expect(input).toHaveValue('termite');

    answer = () => json({ word: { id: 'w9', text: 'gnat', addedAt: '2026-11-02T12:00:00Z', campaigns: [] } });
    fireEvent.change(input, { target: { value: 'gnat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(posts()[1].body).toEqual({ text: 'gnat' });
    expect(screen.queryByText(/name of a service you sell/)).toBeNull();
  });

  it('keeps history closed until opened, labels the rows, and Undo posts then reloads', async () => {
    let loads = 0;
    route({
      'GET /admin/ads/negatives': () => {
        loads += 1;
        return json(payload());
      },
      'POST /admin/ads/negatives/l1/undo': () => json({ state: 'removed', message: 'Undid "bats".' }),
    });
    renderCard();
    await screen.findByText('squirrel');
    expect(screen.queryByText('bats')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Show history' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    const table = await screen.findByRole('table', { name: 'Blocked word history' });
    const rowBats = within(table).getByText('bats').closest('tr');
    expect(within(rowBats).getByText('Advisor')).toBeInTheDocument();
    expect(within(rowBats).getByText('Blocked')).toBeInTheDocument();
    expect(within(rowBats).getByText(/Nov 1/)).toBeInTheDocument();
    const rowRats = within(table).getByText('rats').closest('tr');
    expect(within(rowRats).getByText('Your list')).toBeInTheDocument();
    expect(within(rowRats).getByText('Declined')).toBeInTheDocument();
    expect(within(rowRats).queryByRole('button', { name: /Undo/ })).toBeNull();
    // An undone row shows when it was undone, not when it was first added.
    const rowMoles = within(table).getByText('moles').closest('tr');
    expect(within(rowMoles).getByText('Undone')).toBeInTheDocument();
    expect(within(rowMoles).getByText(/Nov 2/)).toBeInTheDocument();
    expect(within(rowMoles).queryByText(/Oct 28/)).toBeNull();

    fireEvent.click(within(rowBats).getByRole('button', { name: 'Undo “bats”' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url).toMatch(/\/admin\/ads\/negatives\/l1\/undo$/);
    await waitFor(() => expect(loads).toBe(2));
  });

  it('shows the message when Undo fails', async () => {
    route({
      'GET /admin/ads/negatives': () => json(payload()),
      'POST /admin/ads/negatives/l1/undo': () => json({ error: 'google_error', message: 'Google Ads did not answer. Try again later.' }, 502),
    });
    renderCard();
    await screen.findByText('squirrel');
    fireEvent.click(screen.getByRole('button', { name: 'Show history' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo “bats”' }));
    expect(await screen.findByText('Google Ads did not answer. Try again later.')).toBeInTheDocument();
  });

  it('scrolls to and highlights the item named in the link, once', async () => {
    const scroll = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scroll;
    route({ 'GET /admin/ads/negatives': () => json(payload()) });
    renderCard(`/admin/ppc?tab=advisor&negative=${ID_B}`);
    const target = await screen.findByTestId(`pending-${ID_B}`);
    expect(target.className).toMatch(/ring-2/);
    expect(screen.getByTestId(`pending-${ID_A}`).className).not.toMatch(/ring-2/);
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
    expect(scroll.mock.instances[0]).toBe(target);
  });

  it('renders without a router (no highlight)', async () => {
    route({ 'GET /admin/ads/negatives': () => json(payload()) });
    render(<AdsNegativeKeywordsCard />);
    expect(await screen.findByText('“free”')).toBeInTheDocument();
  });
});
