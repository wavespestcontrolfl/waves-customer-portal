// @vitest-environment jsdom
import React, { createRef } from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GlobalCommandPalette from './GlobalCommandPalette';
import useIsMobile from '../../hooks/useIsMobile';
import { IntelligenceBarPageDataProvider, usePublishIntelligenceBarPageData } from '../../hooks/useIntelligenceBarPageData';

// Server dictation (GATE_SERVER_DICTATION) spells the customer on
// screen right when the Intelligence Bar mic sends that customer's id. The bar must forward the
// page's customer id, on the desktop bar and on the phone sheet, and nothing when none is on screen.
const micProps = vi.hoisted(() => []);
vi.mock('../tech/DictationButton', async () => {
  const { createElement } = await import('react');
  return {
    default: (props) => {
      micProps.push(props);
      return createElement('span', { 'data-testid': `mic:${props.title}` });
    },
  };
});
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

  // A send with no answer (iOS "Load failed", owner 2026-11-06) may ask to resend: the prompt takes any words.
  it.each([[false, 'Dictate your question'], [true, 'Tap to talk']])('mobile=%s: the mic asks to resend a recording that got no answer', async (mobile, title) => {
    useIsMobile.mockReturnValue(mobile);
    await openBar(CUSTOMER);
    expect(micProps.filter((props) => props.title === title).at(-1).resendWanted()).toBe(true);
  });

  it('New chat remounts the mic: a recording or resend question from the old chat never lands in the new one', async () => {
    useIsMobile.mockReturnValue(true);
    await openBar(CUSTOMER);
    const before = await screen.findByTestId('mic:Tap to talk');
    fireEvent.click(screen.getByText('New chat'));
    await waitFor(() => expect(screen.getByTestId('mic:Tap to talk')).not.toBe(before));
  });

  const savedThread = (id, reply) => ({ id, lastSeq: 2,
    conversationHistory: [{ role: 'user', content: 'Synthetic ask' }, { role: 'assistant', content: reply }] });

  it('a thread picked from History remounts the mic at the pick, before the thread loads', async () => {
    useIsMobile.mockReturnValue(true);
    let pickedThread;
    fetch.mockImplementation((url) => {
      if (String(url).includes('/threads/latest')) return Promise.resolve(ok({ thread: null }));
      if (String(url).includes('/threads/thread-b')) return new Promise((resolve) => { pickedThread = resolve; });
      return Promise.resolve(ok({ actions: [], tasks: [], threads: [{ id: 'thread-b', title: 'Synthetic earlier chat' }] }));
    });
    await openBar(CUSTOMER);
    const before = await screen.findByTestId('mic:Tap to talk');
    fireEvent.click(await screen.findByText('History'));
    fireEvent.click(await screen.findByText('Synthetic earlier chat'));
    // The old mic is gone while the thread loads, so a transcript of it that lands now is dropped
    // (useSpeechDictation: an unmounted mic appends nothing).
    await waitFor(() => expect(screen.getByTestId('mic:Tap to talk')).not.toBe(before));
    expect(pickedThread).toBeTypeOf('function');
    await act(async () => pickedThread(ok({ thread: savedThread('thread-b', 'Synthetic picked reply') })));
    expect(await screen.findByText('Synthetic picked reply')).toBeInTheDocument();
  });

  it('the automatic resume on open keeps the mic: a recording started before it lands goes on', async () => {
    useIsMobile.mockReturnValue(true);
    let resume;
    fetch.mockImplementation((url) => (String(url).includes('/threads/latest')
      ? new Promise((resolve) => { resume = resolve; })
      : Promise.resolve(ok({ actions: [], tasks: [], threads: [] }))));
    await openBar(CUSTOMER);
    const before = await screen.findByTestId('mic:Tap to talk');
    await waitFor(() => expect(resume).toBeTypeOf('function'));
    await act(async () => resume(ok({ thread: savedThread('thread-a', 'Synthetic resumed reply') })));
    expect(await screen.findByText('Synthetic resumed reply')).toBeInTheDocument();
    expect(screen.getByTestId('mic:Tap to talk')).toBe(before);
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

// Text pasted or dropped into the message (a customer's email or text)
// is not all the operator's own words, so the bar says so (pasted_text) and the server shows a
// card for every write. The flag goes with the message it was pasted into, not the next one.
describe('Intelligence Bar pasted-text flag', () => {
  const queryBodies = () => fetch.mock.calls
    .filter(([url, opts]) => String(url).includes('/intelligence-bar/query') && opts?.method === 'POST')
    .map(([, opts]) => JSON.parse(opts.body));
  async function send(box, value, how) {
    const text = { getData: (type) => (type === 'text/plain' ? value : '') };
    if (how === 'paste') fireEvent.paste(box, { clipboardData: text });
    if (how === 'drop') fireEvent.drop(box, { dataTransfer: text });
    fireEvent.change(box, { target: { value } });
    const sent = queryBodies().length;
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(queryBodies()).toHaveLength(sent + 1));
    await waitFor(() => expect(box).toHaveValue(''));
    return queryBodies().at(-1);
  }
  async function composer(mobile = false) {
    useIsMobile.mockReturnValue(mobile);
    await openBar(null);
    return screen.findByPlaceholderText(/Ask anything|Tell me|Ask/);
  }

  it.each([
    { how: 'paste', mobile: false }, { how: 'drop', mobile: false }, { how: 'paste', mobile: true },
  ])('text by $how (mobile=$mobile) sends pasted_text: true; the next typed message does not', async ({ how, mobile }) => {
    const box = await composer(mobile);
    expect((await send(box, 'Hi, this is Pat Example. Please change my name on the account', how)).pasted_text).toBe(true);
    expect(await send(box, 'thanks', null)).not.toHaveProperty('pasted_text');
  });

  it('a typed message sends no flag, and a paste with no text (an image) sets none', async () => {
    const box = await composer();
    fireEvent.paste(box, { clipboardData: { getData: () => '' } });
    expect(await send(box, 'update Pat Example notes', null)).not.toHaveProperty('pasted_text');
  });
});
