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

// GATE_DICTATION_MONEY_NORMALIZE: the server reads a dictated question for amounts, so the bar only
// says that dictation went into the message (dictation_used); no heard words or amounts are sent.
describe('Intelligence Bar dictation flag', () => {
  const queryBody = () => {
    const call = fetch.mock.calls.find(([url, opts]) => String(url).includes('/intelligence-bar/query') && opts?.method === 'POST');
    return call ? JSON.parse(call[1].body) : null;
  };
  async function ask({ dictate = [], typed } = {}) {
    useIsMobile.mockReturnValue(false);
    await openBar(null);
    const mic = micProps.filter((props) => props.title === 'Dictate your question').at(-1);
    for (const chunk of dictate) act(() => mic.onAppend(chunk, { money: { changes: [], ambiguous: [{ heard: '6133' }] } }));
    const box = await screen.findByPlaceholderText(/Ask anything|Tell me|Ask/);
    if (typed) fireEvent.change(box, { target: { value: typed } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(queryBody()).not.toBeNull());
    return queryBody();
  }

  it('a dictated message carries dictation_used: true and nothing else about the amounts', async () => {
    const body = await ask({ dictate: ['charge 6133 a month'] });
    expect(body.dictation_used).toBe(true);
    expect(body).not.toHaveProperty('dictation_money');
    expect(JSON.stringify(body)).not.toMatch(/suggested|candidates/);
  });

  it('several chunks still send the one flag', async () => {
    const body = await ask({ dictate: ['charge sixty-one', 'thirty-three a month'] });
    expect(body.dictation_used).toBe(true);
  });

  it('a typed message sends no flag', async () => {
    const body = await ask({ typed: 'charge 6133 a month' });
    expect(body).not.toHaveProperty('dictation_used');
  });

  it('an edited dictated message still sends the flag (the server reads what is there)', async () => {
    const body = await ask({ dictate: ['charge 6133 a month'], typed: 'charge $61.33 a month' });
    expect(body.dictation_used).toBe(true);
  });
});
