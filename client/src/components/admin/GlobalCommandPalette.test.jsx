// @vitest-environment jsdom
import React, { createRef } from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import GlobalCommandPalette from './GlobalCommandPalette';

vi.mock('../../hooks/useIsMobile', () => ({ default: () => false }));
vi.mock('../../hooks/useModalFocus', () => ({ default: () => {} }));
vi.mock('../tech/DictationButton', () => ({ default: () => null }));
const ok = body => ({ ok: true, json: async () => body });
let navigate, queryResolvers, fetchMock;
function RouteHarness({ paletteRef }) { navigate = useNavigate(); return <GlobalCommandPalette ref={paletteRef} />; }
async function mount() {
  const ref = createRef();
  render(<MemoryRouter initialEntries={['/admin/customers?customerId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']}><RouteHarness paletteRef={ref} /></MemoryRouter>);
  act(() => ref.current.open());
  await screen.findByPlaceholderText('Ask anything...');
  return ref;
}
function submit(text) {
  const input = screen.getByPlaceholderText('Ask anything...');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); queryResolvers = [];
  fetchMock = vi.fn((url) => {
    if (url.endsWith('/query')) return new Promise(resolve => queryResolvers.push(resolve));
    if (url.includes('/threads/latest')) return Promise.resolve(ok({ thread: null }));
    return Promise.resolve(ok({ actions: [], tasks: [], threads: [] }));
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('sends the viewed record and isolates a late A response after query-only navigation to B', async () => {
  await mount();
  submit('Read this customer');
  await waitFor(() => expect(queryResolvers).toHaveLength(1));
  const body = JSON.parse(fetchMock.mock.calls.find(([url]) => url.endsWith('/query'))[1].body);
  expect(body.pageData.search).toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  expect(body.session_id).toMatch(/^[a-f0-9-]{36}$/);
  act(() => navigate('/admin/customers?customerId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
  submit('Read Customer B');
  await waitFor(() => expect(queryResolvers).toHaveLength(2));
  await act(async () => queryResolvers[0](ok({ response: 'Late Customer A result', conversationHistory: [] })));
  expect(screen.queryByText('Late Customer A result')).not.toBeInTheDocument();
  expect(screen.getByPlaceholderText('Ask anything...')).toHaveValue('Read Customer B');
  await act(async () => queryResolvers[1](ok({ response: 'Current Customer B result', conversationHistory: [] })));
  expect(await screen.findByText('Current Customer B result')).toBeInTheDocument();
});

it('close/reopen retains the in-flight request, and double Enter starts only one query', async () => {
  const ref = await mount();
  submit('Read this customer');
  fireEvent.keyDown(screen.getByPlaceholderText('Ask anything...'), { key: 'Enter' });
  expect(queryResolvers).toHaveLength(1);
  act(() => ref.current.close());
  await act(async () => queryResolvers[0](ok({ response: 'Saved request result', conversationHistory: [] })));
  act(() => ref.current.open());
  expect(await screen.findByText('Saved request result')).toBeInTheDocument();
});
