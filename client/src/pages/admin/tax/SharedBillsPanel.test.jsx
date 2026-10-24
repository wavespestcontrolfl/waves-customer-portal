// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SharedBillsPanel from './SharedBillsPanel.jsx';

const categories = [{ id: 'cat-1', name: 'Utilities' }];
const bill = { id: 'b-1', pattern: 'VERIZON', label: 'Phone plan', business_pct: '50.00', category_id: null, enabled: true };

let calls;
let status;
let bills;
let home;

function json(body, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body };
}

beforeEach(() => {
  calls = [];
  status = { enabled: true };
  bills = [bill];
  home = { year: 2026, row: null, deduction: 0 };
  localStorage.setItem('waves_admin_token', 'test-token');
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || 'GET';
    calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (u.includes('/shared-bills/status')) return json(status);
    if (u.includes('/expense-categories')) return json({ categories });
    if (u.includes('/home-office/')) {
      if (method === 'PUT') return json({ year: 2026, row: { tax_year: 2026, sq_ft: 300, months: 12 }, deduction: 1500 });
      return json(home);
    }
    if (u.endsWith('/shared-bills') && method === 'POST') return json({ bill }, true);
    if (u.endsWith('/shared-bills')) return json({ bills });
    return json({ success: true });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('renders nothing and reads nothing else while the gate is off', async () => {
  status = { enabled: false };
  const { container } = render(<SharedBillsPanel />);
  await waitFor(() => expect(calls.length).toBeGreaterThan(0));
  expect(container).toBeEmptyDOMElement();
  expect(calls.some((c) => c.url.endsWith('/shared-bills') || c.url.includes('/home-office/'))).toBe(false);
});

it('lists the bills and adds one with the typed values', async () => {
  render(<SharedBillsPanel />);
  expect(await screen.findByText('Phone plan')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Bill name'), { target: { value: 'Home internet' } });
  fireEvent.change(screen.getByLabelText('Bank text'), { target: { value: 'SPECTRUM' } });
  fireEvent.change(screen.getByLabelText('Business percent'), { target: { value: '60' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add shared bill' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
  expect(calls.find((c) => c.method === 'POST').body).toEqual({ label: 'Home internet', pattern: 'SPECTRUM', business_pct: '60' });
});

it('does not post a bill with no percent', async () => {
  render(<SharedBillsPanel />);
  await screen.findByText('Phone plan');
  fireEvent.change(screen.getByLabelText('Bill name'), { target: { value: 'Home internet' } });
  fireEvent.change(screen.getByLabelText('Bank text'), { target: { value: 'SPECTRUM' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add shared bill' }));
  expect(await screen.findByText('Enter the business share, from 0 to 100.')).toBeInTheDocument();
  expect(calls.some((c) => c.method === 'POST')).toBe(false);
});

it('toggles and removes a bill', async () => {
  render(<SharedBillsPanel />);
  await screen.findByText('Phone plan');
  fireEvent.click(screen.getByRole('switch', { name: 'Enable Phone plan' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
  expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ url: expect.stringContaining('/shared-bills/b-1'), body: { enabled: false } });
  fireEvent.click(screen.getByRole('button', { name: 'Remove Phone plan' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
});

it('previews the home office deduction, caps it at 300 sq ft, and saves it', async () => {
  render(<SharedBillsPanel />);
  await screen.findByText('Phone plan');
  const out = screen.getByTestId('home-office-deduction');
  fireEvent.change(screen.getByLabelText('Square feet'), { target: { value: '300' } });
  fireEvent.change(screen.getByLabelText('Months used'), { target: { value: '5' } });
  expect(out).toHaveTextContent('$625.00');
  fireEvent.change(screen.getByLabelText('Square feet'), { target: { value: '400' } });
  fireEvent.change(screen.getByLabelText('Months used'), { target: { value: '12' } });
  expect(out).toHaveTextContent('$1,500.00');
  fireEvent.click(screen.getByRole('button', { name: 'Save home office' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url.includes('/home-office/'))).toBe(true));
  // the server refuses 400 sq ft: what was typed goes up as typed, never silently changed
  expect(calls.find((c) => c.method === 'PUT').body).toMatchObject({ sq_ft: '400', months: '12' });
});

it('keeps the newer year when an older year answers late, and blocks Save until the year loads', async () => {
  let releaseThisYear;
  const base = fetch.getMockImplementation();
  const thisYear = new Date().getFullYear();
  fetch.mockImplementation(async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith(`/home-office/${thisYear}`) && !opts.method) {
      calls.push({ url: u, method: 'GET' });
      await new Promise((r) => { releaseThisYear = r; });
      return json({ year: thisYear, row: { tax_year: thisYear, sq_ft: 100, months: 12 }, deduction: 500 });
    }
    if (u.endsWith(`/home-office/${thisYear - 1}`) && !opts.method) {
      calls.push({ url: u, method: 'GET' });
      return json({ year: thisYear - 1, row: { tax_year: thisYear - 1, sq_ft: 250, months: 12 }, deduction: 1250 });
    }
    return base(url, opts);
  });
  render(<SharedBillsPanel />);
  await screen.findByText('Phone plan');
  await waitFor(() => expect(releaseThisYear).toBeTypeOf('function'));
  expect(screen.getByRole('button', { name: 'Save home office' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Home office year'), { target: { value: String(thisYear - 1) } });
  await waitFor(() => expect(screen.getByLabelText('Square feet')).toHaveValue('250'));
  releaseThisYear();
  await new Promise((r) => setTimeout(r, 0));
  expect(screen.getByLabelText('Square feet')).toHaveValue('250');
  expect(screen.getByRole('button', { name: 'Save home office' })).not.toBeDisabled();
});
