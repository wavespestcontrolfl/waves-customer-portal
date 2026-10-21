// @vitest-environment jsdom
import React, { createRef } from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GlobalCommandPalette from './GlobalCommandPalette';
import useIsMobile from '../../hooks/useIsMobile';
import { IntelligenceBarPageDataProvider, usePublishIntelligenceBarPageData } from '../../hooks/useIntelligenceBarPageData';

// Server dictation (GATE_SERVER_DICTATION, GATE_DICTATION_CUSTOMER_NAMES) spells the customer on
// screen right when the Intelligence Bar mic sends that customer's id. The bar must forward the
// page's customer id, on the desktop bar and on the phone sheet, and nothing when none is on screen.
const micProps = vi.hoisted(() => []);
vi.mock('../tech/DictationButton', () => ({
  default: (props) => {
    micProps.push(props);
    return null;
  },
}));
vi.mock('../../lib/adminUsage', () => ({ markUsageSource: vi.fn(), trackAdminPageView: vi.fn() }));
vi.mock('../../hooks/useIsMobile', () => ({ default: vi.fn(() => false) }));

const CUSTOMER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ok = (body) => ({ ok: true, json: async () => body });

function PageCustomer({ id }) {
  usePublishIntelligenceBarPageData({ customer_id: id });
  return null;
}

async function openBar(customerId) {
  const ref = createRef();
  render(
    <MemoryRouter initialEntries={['/admin/customers']}>
      <IntelligenceBarPageDataProvider>
        <PageCustomer id={customerId} />
        <GlobalCommandPalette ref={ref} />
      </IntelligenceBarPageDataProvider>
    </MemoryRouter>,
  );
  act(() => ref.current.open());
  await screen.findByPlaceholderText(/Ask anything|Tell me|Ask/);
}

beforeEach(() => {
  micProps.length = 0;
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn((url) => Promise.resolve(
    String(url).includes('/threads/latest') ? ok({ thread: null }) : ok({ actions: [], tasks: [], threads: [] }),
  )));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Intelligence Bar mic context', () => {
  it.each([[false, 'Dictate your question'], [true, 'Tap to talk']])('mobile=%s: the mic gets the page customer id', async (mobile, title) => {
    useIsMobile.mockReturnValue(mobile);
    await openBar(CUSTOMER);
    const mic = micProps.filter((props) => props.title === title).at(-1);
    expect(mic).toBeTruthy();
    expect(mic.dictationContext).toEqual({ customerId: CUSTOMER });
  });

  it.each([false, true])('mobile=%s: no customer on screen sends no context', async (mobile) => {
    useIsMobile.mockReturnValue(mobile);
    await openBar(null);
    expect(micProps.length).toBeGreaterThan(0);
    expect(micProps.every((props) => props.dictationContext === undefined)).toBe(true);
  });
});

// GATE_DICTATION_MONEY_NORMALIZE: the mic hands over the server's note about an amount it could not
// settle; the question carries it as dictation_money while those digits are still in the message.
describe('Intelligence Bar dictated amounts', () => {
  const AMBIGUOUS = { heard: '6133', candidates: ['$61.33', '$6,133'] };
  const queryBody = () => {
    const call = fetch.mock.calls.find(([url, opts]) => String(url).includes('/intelligence-bar/query') && opts?.method === 'POST');
    return call ? JSON.parse(call[1].body) : null;
  };
  async function dictateAndAsk(spoken, typedAfter, ambiguous = [AMBIGUOUS], edits = []) {
    useIsMobile.mockReturnValue(false);
    await openBar(null);
    const mic = micProps.filter((props) => props.title === 'Dictate your question').at(-1);
    act(() => mic.onAppend(spoken, { money: { changes: [], ambiguous } }));
    const box = await screen.findByPlaceholderText(/Ask anything|Tell me|Ask/);
    for (const value of [...edits, typedAfter].filter(Boolean)) fireEvent.change(box, { target: { value } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(queryBody()).not.toBeNull());
    return queryBody();
  }

  it('sends the ambiguous amount with the question that still contains it', async () => {
    const body = await dictateAndAsk('charge 6133 a month');
    expect(body.dictation_money).toEqual([AMBIGUOUS]);
  });

  it('sends nothing when the operator edited the digits out', async () => {
    const body = await dictateAndAsk('charge 6133 a month', 'charge $61.33 a month');
    expect(body.dictation_money).toBeUndefined();
  });

  it.each([
    ['charge $6133 a month', 'charge $6133 a month', true],
    ['charge 6133 a month', 'it is 6133, ok', true],
    ['charge 6133 a month', 'charge $6133.00 a month', false],
    ['charge 6133 a month', 'charge 16133 a month', false],
    ['charge 6133 a month', 'charge $6,133 a month', false],
    ['charge 6133 a month', 'charge 61330 a month', false],
    ['charge 6133 a month', 'charge 6133.5 a month', false],
  ])('dictated %j then edited to %j: flag kept=%s', async (spoken, edited, kept) => {
    const body = await dictateAndAsk(spoken, edited === spoken ? undefined : edited);
    if (kept) expect(body.dictation_money).toEqual([AMBIGUOUS]);
    else expect(body.dictation_money).toBeUndefined();
  });

  it('a space after the dollar sign still counts as the same amount', async () => {
    const body = await dictateAndAsk('charge $ 6133 a month');
    expect(body.dictation_money).toEqual([AMBIGUOUS]);
  });

  it('keeps one entry per amount, so repeats cannot crowd out a fourth amount (cap is three)', async () => {
    const amounts = ['1111', '2222', '3333', '4444'].map((heard) => ({ heard, candidates: [`$${heard.slice(0, 2)}.${heard.slice(2)}`, `$${heard}`] }));
    const list = [amounts[0], amounts[0], amounts[0], amounts[1], amounts[2], amounts[3]];
    const body = await dictateAndAsk('prices 1111 2222 3333 4444', undefined, list);
    expect(body.dictation_money.map((a) => a.heard)).toEqual(['1111', '2222', '3333']);
  });

  it('once an edit takes the dictated digits out, typing them back in is not flagged', async () => {
    const body = await dictateAndAsk('charge 6133 a month', 'charge 6133 a month, as agreed', [AMBIGUOUS], ['charge 5000 a month']);
    expect(body.dictation_money).toBeUndefined();
  });

  it('an edit that keeps the digits keeps the flag', async () => {
    const body = await dictateAndAsk('charge 6133 a month', 'charge 6133 a month, as agreed', [AMBIGUOUS], ['charge 6133']);
    expect(body.dictation_money).toEqual([AMBIGUOUS]);
  });
});
