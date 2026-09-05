// @vitest-environment jsdom
import React, { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import GlobalCommandPalette from './GlobalCommandPalette';
import useIsMobile from '../../hooks/useIsMobile';

vi.mock('../../hooks/useIsMobile', () => ({ default: vi.fn(() => false) }));
vi.mock('../tech/DictationButton', () => ({ default: () => null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

test.each([false, true])('handled failure stays settled across a follow-up (mobile=%s)', async mobile => {
  useIsMobile.mockReturnValue(mobile);
  const store = new Map([['waves_admin_token', 'fixture-token']]);
  vi.stubGlobal('localStorage', { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) });
  let queries = 0;
  vi.stubGlobal('fetch', vi.fn(async url => {
    let body;
    if (String(url).endsWith('/query')) {
      queries += 1;
      body = { response: queries === 1 ? 'Prepared.' : 'Follow-up answer.', conversationHistory: [],
        pendingActions: queries === 1 ? [{ id: 'fixture-card', tool: 'update_customer', summary: 'Update fixture city', expiresInMs: 600000, contract_hash: 'fixture-hash' }] : [],
      };
    } else if (String(url).endsWith('/confirm-action')) {
      body = { success: false, result: { error: 'The destination changed. Request a fresh preview.' } };
    } else return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, json: async () => body };
  }));
  const ref = createRef();
  render(<MemoryRouter initialEntries={['/admin/customers']}><GlobalCommandPalette ref={ref} /></MemoryRouter>);
  act(() => ref.current.open());
  const input = screen.getByPlaceholderText(/Ask anything/);
  fireEvent.change(input, { target: { value: 'Update this customer' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
  await screen.findByText('The destination changed. Request a fresh preview.');
  fireEvent.change(input, { target: { value: 'Why did it fail?' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await screen.findByText('Follow-up answer.');
  expect(screen.getByText('The destination changed. Request a fresh preview.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
});
