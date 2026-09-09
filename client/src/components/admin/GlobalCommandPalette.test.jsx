// @vitest-environment jsdom
import React, { createRef } from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import GlobalCommandPalette from './GlobalCommandPalette';
import useIsMobile from '../../hooks/useIsMobile';
import { AdminNavigationProvider } from '../../hooks/useAdminNavigation';
import { markUsageSource } from '../../lib/adminUsage';

vi.mock('../../lib/adminUsage', () => ({ markUsageSource: vi.fn(), trackAdminPageView: vi.fn() }));

vi.mock('../../hooks/useIsMobile', () => ({ default: vi.fn(() => false) }));
vi.mock('../tech/DictationButton', () => ({ default: () => null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

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
