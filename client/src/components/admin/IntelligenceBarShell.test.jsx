// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
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
