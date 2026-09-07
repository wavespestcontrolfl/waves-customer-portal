// @vitest-environment jsdom
import React, { createRef } from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import GlobalCommandPalette from './GlobalCommandPalette';
import useIsMobile from '../../hooks/useIsMobile';
import { IntelligenceBarPageDataProvider, usePublishIntelligenceBarPageData } from '../../hooks/useIntelligenceBarPageData';

vi.mock('../../hooks/useIsMobile', () => ({ default: vi.fn(() => false) }));
vi.mock('../../hooks/useModalFocus', () => ({ default: () => {} }));
vi.mock('../tech/DictationButton', () => ({ default: () => null }));
const ok = body => ({ ok: true, json: async () => body });
let navigate, queryResolvers, fetchMock;
function RouteHarness({ paletteRef }) { navigate = useNavigate(); return <GlobalCommandPalette ref={paletteRef} />; }
function SelectedAppointment({ id }) {
  usePublishIntelligenceBarPageData({ appointment_id: id });
  return null;
}
async function mount() {
  const ref = createRef();
  render(<MemoryRouter initialEntries={['/admin/customers?customerId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']}><RouteHarness paletteRef={ref} /></MemoryRouter>);
  act(() => ref.current.open());
  await screen.findByPlaceholderText(/Ask anything/);
  return ref;
}
function submit(text) {
  const input = screen.getByPlaceholderText(/Ask anything/);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}
beforeEach(() => {
  useIsMobile.mockReturnValue(false);
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

it('a new selected appointment on the same route invalidates a late response', async () => {
  const ref = createRef();
  const tree = id => <MemoryRouter initialEntries={['/admin/dispatch']}>
    <IntelligenceBarPageDataProvider><SelectedAppointment id={id} /><GlobalCommandPalette ref={ref} /></IntelligenceBarPageDataProvider>
  </MemoryRouter>;
  const view = render(tree('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
  act(() => ref.current.open());
  submit('Read this appointment');
  await waitFor(() => expect(queryResolvers).toHaveLength(1));
  const body = JSON.parse(fetchMock.mock.calls.find(([url]) => url.endsWith('/query'))[1].body);
  expect(body.pageData.appointment_id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  view.rerender(tree('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
  await act(async () => queryResolvers[0](ok({ response: 'Old appointment result', conversationHistory: [] })));
  expect(screen.queryByText('Old appointment result')).not.toBeInTheDocument();
  submit('Read the selected appointment');
  await waitFor(() => expect(queryResolvers).toHaveLength(2));
  const bodies = fetchMock.mock.calls.filter(([url]) => url.endsWith('/query')).map(([, options]) => JSON.parse(options.body));
  expect(bodies[1].pageData.appointment_id).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
});

it.each(['navigation', 'clear'])('a late confirmation cannot restore its old task after %s', async change => {
  await mount();
  submit('Update this customer');
  const card = { id: 'fixture-card', tool: 'update_customer', summary: 'Change fixture note', expiresInMs: 600000 };
  await act(async () => queryResolvers[0](ok({ response: 'Prepared.', taskId: 'old-task', taskState: 'awaiting_approval',
    pendingActions: [card], taskTarget: { label: 'Original customer', href: '/admin/customers?customerId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } })));
  let confirm;
  fetchMock.mockImplementation(url => url.endsWith('/confirm-action')
    ? new Promise(resolve => { confirm = resolve; }) : Promise.resolve(ok({ actions: [], tasks: [], threads: [] })));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm', exact: true }));
  if (change === 'navigation') act(() => navigate('/admin/customers?customerId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
  else {
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
  }
  await act(async () => confirm(ok({ success: true, outcome: 'completed' })));
  expect(screen.queryByText('Original customer')).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) => url.includes('/tasks/old-task'))).toBe(false);
});

it('cancellation remains canceled after close and reopen', async () => {
  const ref = await mount();
  submit('Update this customer');
  await act(async () => queryResolvers[0](ok({ response: 'Prepared.', pendingActions: [
    { id: 'fixture-card', tool: 'update_customer', summary: 'Change fixture note', expiresInMs: 600000 },
  ] })));
  fetchMock.mockResolvedValue(ok({ success: true, cancelled: true, outcome: 'canceled' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
  await screen.findByText('Cancelled');
  act(() => ref.current.close());
  act(() => ref.current.open());
  expect(await screen.findByText('Cancelled')).toBeInTheDocument();
  expect(screen.queryByText('✓ Done')).not.toBeInTheDocument();
});

it.each([false, true])('keeps a legacy threaded confirmation across navigation when tasks are disabled (mobile=%s)', async mobile => {
  useIsMobile.mockReturnValue(mobile);
  fetchMock.mockImplementation(url => {
    if (url.endsWith('/query')) return new Promise(resolve => queryResolvers.push(resolve));
    if (url.includes('/tasks?')) return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: 'Not enabled' }) });
    if (url.endsWith('/confirm-action')) return Promise.resolve(ok({ success: true, outcome: 'completed' }));
    return Promise.resolve(ok({ thread: null, actions: [], threads: [] }));
  });
  await mount();
  submit('Update this customer');
  await act(async () => queryResolvers[0](ok({ response: 'Prepared.', threadsEnabled: true,
    pendingActions: [{ id: 'legacy-card', tool: 'update_customer', summary: 'Change Original fixture note', expiresInMs: 600000 }],
  })));
  act(() => navigate('/admin/customers?customerId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm', exact: true }));
  expect(await screen.findByText('✓ Done')).toBeInTheDocument();
  const confirmation = fetchMock.mock.calls.find(([url]) => url.endsWith('/confirm-action'));
  expect(JSON.parse(confirmation[1].body).pending_action_id).toBe('legacy-card');
});

it('persists a legacy receipt when confirmation finishes after navigation and the bar reopens', async () => {
  let confirm;
  fetchMock.mockImplementation(url => {
    if (url.endsWith('/query')) return new Promise(resolve => queryResolvers.push(resolve));
    if (url.includes('/tasks?')) return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: 'Not enabled' }) });
    if (url.endsWith('/confirm-action')) return new Promise(resolve => { confirm = resolve; });
    return Promise.resolve(ok({ thread: null, actions: [], threads: [] }));
  });
  const ref = await mount();
  submit('Update this customer');
  await act(async () => queryResolvers[0](ok({ response: 'Prepared.', threadsEnabled: true,
    pendingActions: [{ id: 'legacy-card', tool: 'update_customer', summary: 'Change Original fixture note', expiresInMs: 600000 }],
  })));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm', exact: true }));
  act(() => navigate('/admin/customers?customerId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
  await act(async () => confirm(ok({ success: true, outcome: 'completed' })));
  act(() => ref.current.close());
  act(() => ref.current.open());
  expect(await screen.findByText('✓ Done')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Confirm', exact: true })).not.toBeInTheDocument();
});

test.each([[false, 200], [true, 200], [false, 409], [true, 409]])('failure stays settled across a follow-up (mobile=%s, HTTP=%s)', async (mobile, status) => {
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
      const error = 'The destination changed. Request a fresh preview.';
      return { ok: status === 200, status, json: async () => status === 200 ? { success: false, result: { error } } : { error } };
    } else if (String(url).includes('/actions/')) {
      body = { success: false, outcome: 'blocked', result: { error: 'The destination changed. Request a fresh preview.' } };
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
