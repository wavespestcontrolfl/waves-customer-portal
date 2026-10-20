// @vitest-environment jsdom
import React, { createRef } from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
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
