// @vitest-environment jsdom
import React, { createRef } from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import GlobalCommandPalette from './GlobalCommandPalette';
import useIsMobile from '../../hooks/useIsMobile';
import { IntelligenceBarPageDataProvider, usePublishIntelligenceBarPageData } from '../../hooks/useIntelligenceBarPageData';
import { AdminNavigationProvider } from '../../hooks/useAdminNavigation';
import { markUsageSource } from '../../lib/adminUsage';

vi.mock('../../lib/adminUsage', () => ({ markUsageSource: vi.fn(), trackAdminPageView: vi.fn() }));

vi.mock('../../hooks/useIsMobile', () => ({ default: vi.fn(() => false) }));
vi.mock('../tech/DictationButton', () => ({ default: () => null }));
const ok = body => ({ ok: true, json: async () => body });
let navigate, queryResolvers, fetchMock;
function RouteHarness({ paletteRef }) { navigate = useNavigate(); return <GlobalCommandPalette ref={paletteRef} />; }
function SelectedRecord({ kind, id }) {
  usePublishIntelligenceBarPageData({ [kind]: id });
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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each([false, true])('mobile History follows task availability when threads are off (tasks=%s)', async tasksEnabled => {
  useIsMobile.mockReturnValue(true);
  fetchMock.mockImplementation(async url => {
    if (url.includes('/threads') || (!tasksEnabled && url.includes('/tasks'))) return { ok: false, status: 404, json: async () => ({ error: 'Not enabled' }) };
    if (url.includes('/tasks/saved-task')) return ok({ taskId: 'saved-task', taskState: 'completed', response: 'Saved mobile request', canContinue: true });
    if (url.includes('/tasks?')) return ok({ tasks: [{ id: 'saved-task', target: { target: { label: 'Synthetic saved target' } }, state: 'completed' }] });
    return ok({ actions: [] });
  });
  await mount();
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.includes('/tasks?'))).toBe(true));
  fireEvent.click(screen.getByLabelText('Conversation options'));
  if (!tasksEnabled) { expect(screen.queryByRole('button', { name: 'History', exact: true })).not.toBeInTheDocument(); return; }
  fireEvent.click(await screen.findByRole('button', { name: 'History', exact: true }));
  fireEvent.click(await screen.findByRole('button', { name: /Synthetic saved target/ }));
  expect(await screen.findByText('Saved mobile request')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Continue request' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/tasks/saved-task/resume'))).toBe(true));
});

it.each([false, true])('retains a task receipt after confirmation when its status refresh fails (mobile=%s)', async mobile => {
  useIsMobile.mockReturnValue(mobile);
  fetchMock.mockImplementation(async url => {
    if (url.endsWith('/query')) return ok({ taskId: 'task-a', taskState: 'awaiting_approval', response: 'Prepared.',
      pendingActions: [{ id: 'action-a', tool: 'update_customer', summary: 'Save synthetic note', expiresInMs: 600000 }] });
    if (url.endsWith('/confirm-action')) return ok({ success: true, outcome: 'completed' });
    if (url.includes('/tasks/task-a?')) return { ok: false, status: 503, json: async () => ({ error: 'Unavailable' }) };
    return ok({ actions: [], tasks: [], threads: [], thread: null });
  });
  await mount();
  submit('Update this customer');
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm', exact: true }));
  await screen.findByText('Status unavailable: Unavailable');
  expect(screen.getByText('✓ Done', { exact: true })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Confirm', exact: true })).not.toBeInTheDocument();
});

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

it('keeps the visible reply when a persisted thread survives navigation', async () => {
  await mount();
  submit('Summarize this customer');
  await waitFor(() => expect(queryResolvers).toHaveLength(1));
  await act(async () => queryResolvers[0](ok({ response: 'Retained thread reply', threadId: 'thread-1',
    conversationHistory: [{ role: 'user', content: 'Summarize this customer' }, { role: 'assistant', content: 'Retained thread reply' }] })));
  expect(await screen.findByText('Retained thread reply')).toBeInTheDocument();
  act(() => navigate('/admin/customers?customerId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
  expect(screen.getByText('Retained thread reply')).toBeInTheDocument();
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

it.each(['appointment_id', 'product_id', 'property_id', 'estimate_id'])('a new selected %s on the same route invalidates a late response', async kind => {
  const ref = createRef();
  const tree = id => <MemoryRouter initialEntries={[kind === 'product_id' ? '/admin/inventory' : '/admin/dispatch']}>
    <IntelligenceBarPageDataProvider><SelectedRecord kind={kind} id={id} /><GlobalCommandPalette ref={ref} /></IntelligenceBarPageDataProvider>
  </MemoryRouter>;
  const view = render(tree('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
  act(() => ref.current.open());
  submit('Read this appointment');
  await waitFor(() => expect(queryResolvers).toHaveLength(1));
  const body = JSON.parse(fetchMock.mock.calls.find(([url]) => url.endsWith('/query'))[1].body);
  expect(body.pageData[kind]).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  view.rerender(tree('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
  await act(async () => queryResolvers[0](ok({ response: 'Old appointment result', conversationHistory: [] })));
  expect(screen.queryByText('Old appointment result')).not.toBeInTheDocument();
  submit('Read the selected appointment');
  await waitFor(() => expect(queryResolvers).toHaveLength(2));
  const bodies = fetchMock.mock.calls.filter(([url]) => url.endsWith('/query')).map(([, options]) => JSON.parse(options.body));
  expect(bodies[1].pageData[kind]).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
});

it('drops a task-backed card on navigation while the task-list probe is still pending', async () => {
  fetchMock.mockImplementation((url) => {
    if (url.endsWith('/query')) return new Promise(resolve => queryResolvers.push(resolve));
    if (url.includes('/threads/latest')) return Promise.resolve(ok({ thread: null }));
    if (url.includes('/tasks?')) return new Promise(() => {});
    return Promise.resolve(ok({ actions: [], threads: [] }));
  });
  await mount();
  submit('Update this customer');
  await waitFor(() => expect(queryResolvers).toHaveLength(1));
  await act(async () => queryResolvers[0](ok({ response: 'Prepared.', taskId: 'probe-pending-task', taskState: 'awaiting_approval',
    pendingActions: [{ id: 'probe-card', tool: 'update_customer', summary: 'Change fixture note', expiresInMs: 600000 }] })));
  expect(await screen.findByRole('button', { name: 'Confirm', exact: true })).toBeInTheDocument();
  act(() => navigate('/admin/customers?customerId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
  expect(screen.queryByRole('button', { name: 'Confirm', exact: true })).not.toBeInTheDocument();
  expect(screen.queryByText('Change fixture note')).not.toBeInTheDocument();
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

describe('local page search', () => {
  beforeEach(() => {
    const store = new Map([['waves_admin_token', 'fixture-token']]);
    vi.stubGlobal('localStorage', { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    useIsMobile.mockReturnValue(false);
  });
  function fixture({ id = 'fixture-admin', role = 'admin', enabled = true } = {}) {
    const ref = createRef();
    const onNavigate = vi.fn();
    const view = render(<MemoryRouter initialEntries={['/admin/customers']}>
      <AdminNavigationProvider key={id} user={{ id, role }} enabled={enabled}>
        <button onClick={() => ref.current.openNavigation()}>Open pages</button>
        <GlobalCommandPalette ref={ref} user={{ id, role }} onNavigate={onNavigate} />
      </AdminNavigationProvider>
    </MemoryRouter>);
    return { ...view, ref, onNavigate };
  }

  test('Cmd/Ctrl K searches aliases without assistant requests and Enter follows a real link', () => {
    const { onNavigate } = fixture();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = screen.getByRole('searchbox', { name: 'Search pages' });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: 'payers' } });
    expect(screen.getByRole('link', { name: /Billing accounts/ })).toHaveAttribute('href', '/admin/payers');
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(markUsageSource).toHaveBeenCalledWith('palette');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('arrows move between links, Escape restores focus, and a no-match query stays local', () => {
    fixture();
    const opener = screen.getByRole('button', { name: 'Open pages' });
    opener.focus();
    fireEvent.click(opener);
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'Accounting' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('link', { name: /Banking/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
    expect(screen.getByRole('link', { name: /Books & taxes/ })).toHaveFocus();
    fireEvent.change(input, { target: { value: 'no such page' } });
    expect(screen.getByText(/No pages match/)).toBeVisible();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(opener).toHaveFocus();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('pins up to three pages, frees slots on unpin, and isolates accounts on reload', () => {
    const view = fixture();
    act(() => view.ref.current.openNavigation());
    for (const label of ['Invoices', 'Pipeline', 'Books & taxes']) {
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: label } });
      fireEvent.click(screen.getByRole('button', { name: `Pin ${label}`, exact: true }));
    }
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Inventory' } });
    expect(screen.getByRole('button', { name: 'Pin Inventory', exact: true })).toBeDisabled();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Invoices' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unpin Invoices', exact: true }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Inventory' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pin Inventory', exact: true }));
    const saved = JSON.parse(localStorage.getItem('waves_admin_navigation:fixture-admin'));
    expect(saved.pins).toEqual(['pipeline', 'taxes', 'inventory']);
    expect(fetch).not.toHaveBeenCalled();
    view.unmount();
    const reload = fixture();
    act(() => reload.ref.current.openNavigation());
    expect(screen.getAllByRole('button', { name: /^Unpin / })).toHaveLength(3);
    reload.unmount();
    const other = fixture({ id: 'fixture-tech', role: 'technician' });
    act(() => other.ref.current.openNavigation());
    expect(screen.queryByRole('button', { name: /^Unpin / })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Contracts|System health|Estimates/ })).not.toBeInTheDocument();
  });

  test('drops invalid pins, hides revoked pages and keeps same-page navigation dismissible', () => {
    localStorage.setItem('waves_admin_navigation:fixture-admin', JSON.stringify({ pins: ['https://example.invalid', 'invoices', 'inventory', 'inventory'] }));
    const view = fixture({ role: 'technician' });
    act(() => view.ref.current.openNavigation());
    expect(screen.getAllByRole('button', { name: /^Unpin / })).toHaveLength(1);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Customers' } });
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });
    expect(view.onNavigate).toHaveBeenCalledOnce();
    expect(markUsageSource).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test.each([false, true])('page finder hands its original opener to Ask Waves (mobile=%s)', async (mobile) => {
    useIsMobile.mockReturnValue(mobile);
    fixture();
    const opener = screen.getByRole('button', { name: 'Open pages' });
    opener.focus();
    fireEvent.click(opener);
    const ask = screen.getByRole('button', { name: 'Ask Waves' });
    ask.focus();
    await act(async () => fireEvent.click(ask));
    expect(screen.getByPlaceholderText(/Ask anything/)).toBeVisible();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(opener).toHaveFocus();
  });

  test.each([false, true])('Ask Waves keeps its unsent question and original opener across modes (mobile=%s)', async (mobile) => {
    useIsMobile.mockReturnValue(mobile);
    const view = fixture();
    const opener = screen.getByRole('button', { name: 'Open pages' });
    opener.focus();
    await act(async () => view.ref.current.open());
    fireEvent.change(screen.getByPlaceholderText(/Ask anything/), { target: { value: 'Unsent question' } });
    const callsBefore = fetch.mock.calls.length;
    act(() => view.ref.current.openNavigation());
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Recovery' } });
    expect(fetch).toHaveBeenCalledTimes(callsBefore);
    const ask = screen.getByRole('button', { name: 'Ask Waves' });
    ask.focus();
    await act(async () => fireEvent.click(ask));
    expect(screen.getByPlaceholderText(/Ask anything/)).toHaveValue('Unsent question');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(opener).toHaveFocus();
  });

  test('the default-off flag preserves the assistant keyboard shortcut', async () => {
    fixture({ enabled: false });
    await act(async () => fireEvent.keyDown(window, { key: 'k', metaKey: true }));
    expect(screen.getByPlaceholderText(/Ask anything/)).toBeVisible();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });
});

test.each([["admin", "email"], ["technician", "comms"]].flatMap(([role, context]) =>
  ["/admin/communications", "/admin/communications/"].map((pathname) => [role, context, pathname]),
))("Email tab keeps the permitted tool context for %s (%s at %s)", async (role, expectedContext, pathname) => {
  useIsMobile.mockReturnValue(false);
  vi.stubGlobal("localStorage", { getItem: () => "fixture-token", setItem() {}, removeItem() {} });
  vi.stubGlobal("fetch", vi.fn(async (url) => String(url).endsWith("/query")
    ? { ok: true, json: async () => ({ response: "Synthetic context response", conversationHistory: [] }) }
    : { ok: false, status: 404, json: async () => ({}) }));
  const ref = createRef();
  render(<MemoryRouter initialEntries={[`${pathname}#tab=email`]}><GlobalCommandPalette ref={ref} user={{ id: "fixture-user", role }} /></MemoryRouter>);
  act(() => ref.current.open());
  const input = screen.getByPlaceholderText(/Ask anything/);
  fireEvent.change(input, { target: { value: "Show the inbox summary" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByText("Synthetic context response");
  const request = fetch.mock.calls.find(([url]) => String(url).endsWith("/query"));
  expect(JSON.parse(request[1].body).context).toBe(expectedContext);
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
