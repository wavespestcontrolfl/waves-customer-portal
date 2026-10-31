// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import IntelligenceBarShell from './IntelligenceBarShell';

const ok = body => ({ ok: true, json: async () => body });
const target = { customer_id: 'customer-a', label: 'Synthetic Selected', address: '100 Test Street', href: '/admin/customers?customerId=customer-a' };
const action = { id: 'approval-a', tool: 'update_customer', summary: 'Save synthetic note', expiresInMs: 600000 };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('resolves one task through selection, confirmation, receipt, continuation and saved recovery', async () => {
  localStorage.clear(); sessionStorage.clear();
  let completed = false;
  const after = vi.fn();
  const fetch = vi.fn(async url => {
    if (url.endsWith('/query')) return ok({ taskId: 'task-a', taskState: 'needs_information', candidates: [target], response: null });
    if (url.endsWith('/select-target')) return ok({ taskId: 'task-a', taskState: 'awaiting_approval', taskTarget: target, pendingActions: [action], structuredData: { marker: 'preserved-slot' } });
    if (url.endsWith('/confirm-action')) { completed = true; return ok({ success: true, outcome: 'completed', result: { id: 'customer-a' } }); }
    if (url.endsWith('/resume')) return ok({ taskId: 'task-a', taskState: 'completed', taskTarget: target, response: 'Request finished.', receipts: [{ ...action, outcome: 'completed' }] });
    if (url.includes('/tasks/task-a?')) return ok({ taskId: 'task-a', taskState: 'completed', taskTarget: target, response: 'Saved outcome.',
      receipts: completed ? [{ ...action, outcome: 'completed' }] : [], canContinue: true });
    if (url.includes('/tasks?')) return ok({ tasks: [{ id: 'task-a', target: { target }, state: 'completed' }] });
    return ok({ actions: [] });
  });
  vi.stubGlobal('fetch', fetch);
  const view = render(<IntelligenceBarShell context="dispatch" onAfterSubmit={after} responseSlot={data => data?.marker && <span>{data.marker}</span>} />);
  fireEvent.change(screen.getByPlaceholderText(/Questions/), { target: { value: 'Update this customer' } });
  fireEvent.keyDown(screen.getByPlaceholderText(/Questions/), { key: 'Enter' });
  fireEvent.click(await screen.findByRole('button', { name: /Synthetic Selected — 100 Test Street/ }));
  expect(await screen.findByText('preserved-slot')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Confirm', exact: true })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm', exact: true }));
  expect(await screen.findByText('✓ Done')).toBeInTheDocument();
  fireEvent.click(await screen.findByRole('button', { name: 'Continue request' }));
  expect(await screen.findByText('Request finished.')).toBeInTheDocument();
  expect(after).toHaveBeenCalledWith(expect.objectContaining({ confirmedAction: true, toolCalls: [{ name: 'update_customer' }] }));
  const query = fetch.mock.calls.find(([url]) => url.endsWith('/query'));
  const session = JSON.parse(query[1].body).session_id;
  for (const suffix of ['/select-target', '/resume']) {
    const call = fetch.mock.calls.find(([url]) => url.endsWith(suffix));
    expect(call[0]).toContain('/tasks/task-a/');
    expect(JSON.parse(call[1].body).session_id).toBe(session);
  }
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('/query'))).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Clear', exact: true }));
  expect(screen.queryByRole('region', { name: 'Active intelligence task' })).not.toBeInTheDocument();
  view.unmount();
  render(<IntelligenceBarShell context="dispatch" />);
  await screen.findByText('Saved requests');
  fireEvent.click(screen.getByText('Saved requests'));
  fireEvent.click(screen.getByRole('button', { name: /Synthetic Selected · completed/ }));
  expect(await screen.findByText('Saved outcome.')).toBeInTheDocument();
  expect(fetch.mock.calls.filter(([url]) => url.includes('/tasks/task-a?')).every(([url]) => url.includes(session))).toBe(true);
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/cancel-action'))).toBe(false);
});

it('keeps the known task when status retrieval fails and ignores a response after unmount', async () => {
  let settle;
  const fetch = vi.fn(async url => {
    if (url.endsWith('/query')) return ok({ taskId: 'task-a', taskTarget: target, response: 'Known task', pendingActions: [action] });
    if (url.includes('/tasks/task-a?')) return new Promise(resolve => { settle = resolve; });
    return ok({ actions: [], tasks: [] });
  });
  vi.stubGlobal('fetch', fetch);
  const view = render(<IntelligenceBarShell context="dispatch" />);
  fireEvent.change(screen.getByPlaceholderText(/Questions/), { target: { value: 'Update this customer' } });
  fireEvent.keyDown(screen.getByPlaceholderText(/Questions/), { key: 'Enter' });
  fireEvent.click(await screen.findByRole('button', { name: 'Refresh status' }));
  await act(async () => settle({ ok: false, status: 503, json: async () => ({ error: 'Unavailable' }) }));
  expect(await screen.findByText('Status unavailable: Unavailable')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Synthetic Selected' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Confirm', exact: true })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  view.unmount();
  render(<IntelligenceBarShell context="dispatch" />);
  await act(async () => settle(ok({ taskId: 'task-a', response: 'Late unmounted task' })));
  await waitFor(() => expect(screen.queryByText('Late unmounted task')).not.toBeInTheDocument());
});

it.each([['Confirm', '✓ Done'], ['Cancel', 'Cancelled']])('retains %s after the subsequent task read fails', async (decision, label) => {
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (url.endsWith('/query')) return ok({ taskId: 'task-a', taskState: 'awaiting_approval', taskTarget: target, pendingActions: [action] });
    if (url.endsWith('/confirm-action')) return ok({ success: true, outcome: 'completed' });
    if (url.endsWith('/cancel-action')) return ok({ cancelled: true });
    if (url.includes('/tasks/task-a?')) return { ok: false, status: 503, json: async () => ({ error: 'Unavailable' }) };
    return ok({ actions: [], tasks: [] });
  }));
  render(<IntelligenceBarShell context="dispatch" />);
  fireEvent.change(screen.getByPlaceholderText(/Questions/), { target: { value: 'Update this customer' } });
  fireEvent.keyDown(screen.getByPlaceholderText(/Questions/), { key: 'Enter' });
  fireEvent.click(await screen.findByRole('button', { name: decision, exact: true }));
  await screen.findByText('Status unavailable: Unavailable');
  expect(screen.getByText(label, { exact: true })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Confirm', exact: true })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Cancel', exact: true })).not.toBeInTheDocument();
});

it('offers recovery retry after an initial history outage', async () => {
  let unavailable = true;
  vi.stubGlobal('fetch', vi.fn(async url => url.includes('/tasks?')
    ? unavailable ? { ok: false, status: 503, json: async () => ({ error: 'Unavailable' }) }
      : ok({ tasks: [{ id: 'task-a', target: { target }, state: 'completed' }] })
    : ok({ actions: [] })));
  render(<IntelligenceBarShell context="dispatch" />);
  fireEvent.click(await screen.findByText('Saved requests'));
  const retry = await screen.findByRole('button', { name: 'Retry saved requests' });
  unavailable = false;
  fireEvent.click(retry);
  expect(await screen.findByRole('button', { name: /Synthetic Selected · completed/ })).toBeInTheDocument();
});

// The admin shell hands the verified staff user to its pages (AdminLayoutV2's outlet).
function Where() { return <output data-testid="where">{useLocation().pathname}</output>; }
const renderAs = user => render(<MemoryRouter initialEntries={['/admin/dispatch']}>
  <Where />
  <Routes><Route element={<Outlet context={{ user }} />}><Route path="/admin/*" element={<IntelligenceBarShell context="dispatch" />} /></Route></Routes>
</MemoryRouter>);
const ask = text => {
  fireEvent.change(screen.getByPlaceholderText(/Questions/), { target: { value: text } });
  fireEvent.keyDown(screen.getByPlaceholderText(/Questions/), { key: 'Enter' });
};

it('answer links open records in the app and https pages in a new tab; other targets stay text', async () => {
  localStorage.clear();
  const record = '/admin/customers?customerId=customer-a';
  vi.stubGlobal('fetch', vi.fn(async url => (url.endsWith('/query') ? ok({ response: [
    `Open [the fixture customer](${record}).`,
    'Read **[the guide](https://example.invalid/guide)** for `INV-0001`.',
    '[run](javascript:alert(1)) [Pay at waves.invalid](https://evil.invalid/pay)',
  ].join('\n') }) : ok({ actions: [], tasks: [] }))));
  renderAs({ id: 'staff-a' });
  ask('Show the record and guide');
  const recordLink = await screen.findByRole('link', { name: 'the fixture customer' });
  expect(recordLink).toHaveAttribute('href', record);
  const guide = screen.getByRole('link', { name: 'the guide' });
  expect(guide).toHaveAttribute('target', '_blank');
  expect(guide).toHaveAttribute('rel', 'noopener noreferrer');
  expect(guide.closest('strong')).not.toBeNull();
  expect(screen.getByText('INV-0001').tagName).toBe('CODE');
  for (const name of ['run', 'Pay at waves.invalid']) expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
  expect(screen.getByText(/\[run\]\(javascript:alert\(1\)\)/)).toBeInTheDocument();
  fireEvent.click(recordLink);
  expect(screen.getByTestId('where')).toHaveTextContent('/admin/customers');
});

it('keeps pinned prompts per staff login and never shows the older list shared by every login', async () => {
  localStorage.clear();
  localStorage.setItem('ib.favorites.dispatch', JSON.stringify(['Older shared pin']));
  localStorage.setItem('ib.recents.dispatch', JSON.stringify(['Fixture recent question']));
  vi.stubGlobal('fetch', vi.fn(async () => ok({ actions: [], tasks: [] })));
  const open = user => {
    const view = renderAs(user);
    fireEvent.focus(screen.getByPlaceholderText(/Questions/));
    return view;
  };
  let view = open({ id: 'staff-a' });
  fireEvent.click(screen.getByRole('button', { name: 'Pin Fixture recent question' }));
  expect(screen.getByText('Pinned')).toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem('ib.pinned.staff-a.dispatch'))).toEqual(['Fixture recent question']);
  expect(screen.queryByText('Older shared pin')).not.toBeInTheDocument();
  view.unmount();
  view = open({ id: 'staff-b' });
  expect(screen.queryByText('Pinned')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Pin Fixture recent question' })).toBeInTheDocument();
  view.unmount();
  open({ id: 'staff-a' });
  expect(screen.getByText('Pinned')).toBeInTheDocument();
  // The Pinned chip's Unpin and the Recent row's toggle.
  expect(screen.getAllByRole('button', { name: 'Unpin Fixture recent question' })).toHaveLength(2);
});

it('answer text and controls are at least 14px', async () => {
  localStorage.clear();
  localStorage.setItem('ib.recents.dispatch', JSON.stringify(['Fixture recent question']));
  localStorage.setItem('ib.pinned.staff-a.dispatch', JSON.stringify(['Fixture pinned question']));
  vi.stubGlobal('fetch', vi.fn(async url => (url.endsWith('/query')
    ? ok({ response: '## Fixture heading\n1. **Bold** step with `CODE-1`\n- A bullet' })
    : ok({ actions: [{ id: 'qa', group: 'Today', label: 'Fixture quick action', prompt: 'Fixture quick prompt' }], tasks: [] }))));
  renderAs({ id: 'staff-a' });
  fireEvent.focus(screen.getByPlaceholderText(/Questions/));
  await screen.findByText('Fixture quick action');
  // tokens.css .u-label is 11px; the type scale classes under 14 are text-11/12/13.
  const small = () => [...document.querySelectorAll('[class]')]
    .filter(el => /(^|\s)(text-1[0-3]|sm:text-1[0-3]|u-label)(\s|$)/.test(el.getAttribute('class')));
  expect(small()).toEqual([]);
  ask('Fixture question');
  await screen.findByText('Fixture heading');
  expect(screen.getByRole('textbox', { name: 'Follow-up question' })).toBeInTheDocument();
  expect(small()).toEqual([]);
});
