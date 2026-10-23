// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import LedgerInboxTab from './LedgerInboxTab.jsx';

const categories = [
  { id: 'cat-1', name: 'Supplies', irsLine: '22' },
  { id: 'cat-2', name: 'Tools', irsLine: '22' },
];
const row = {
  id: 'row-1',
  txn_date: '2026-10-01',
  description: 'ACME HARDWARE 123',
  amount: '42.50',
  direction: 'debit',
  account_label: 'test-checking',
  account_type: 'bank',
  suggestion: {
    categoryId: 'cat-2',
    categoryName: 'Tools',
    irsLine: '22',
    rule: { id: 'r1', kind: 'expense', note: 'Hardware store', source: 'seed' },
  },
};

let calls;
let status;

function json(body, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body };
}

beforeEach(() => {
  calls = [];
  status = { enabled: true, rules: 3, inbox: 1 };
  localStorage.setItem('waves_admin_token', 'test-token');
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || 'GET';
    calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (u.includes('/ledger/status')) return json(status);
    if (u.includes('/ledger/inbox')) return json({ rows: [row], total: 1 });
    if (u.includes('/expense-categories')) return json({ categories });
    if (u.includes('/ledger/decide')) return json({ success: true, action: 'x', ruleCreated: false, createExpense: true });
    if (u.includes('/create-expense')) return json({ success: true, expense: { id: 'e1' } });
    return json({});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = () => calls.filter((c) => c.method === 'POST');

it('renders only the off line when the ledger gate is off', async () => {
  status = { enabled: false, rules: 0, inbox: 0 };
  render(<LedgerInboxTab />);
  expect(await screen.findByText('The tax ledger is off (GATE_TAX_LEDGER).')).toBeInTheDocument();
  expect(calls.some((c) => c.url.includes('/ledger/inbox'))).toBe(false);
});

it('renders a row with its suggestion chip and signed amount', async () => {
  render(<LedgerInboxTab />);
  expect(await screen.findByText('ACME HARDWARE 123')).toBeInTheDocument();
  expect(screen.getByText('expense · Tools')).toBeInTheDocument();
  expect(screen.getByText('Hardware store')).toBeInTheDocument();
  expect(screen.getByText('-$42.50')).toBeInTheDocument();
  expect(screen.getByText('1 rows to review · 3 rules')).toBeInTheDocument();
});

it('posts a personal decision and removes the row', async () => {
  render(<LedgerInboxTab />);
  await screen.findByText('ACME HARDWARE 123');
  fireEvent.click(screen.getByRole('button', { name: 'Personal' }));
  await waitFor(() => expect(screen.queryByText('ACME HARDWARE 123')).not.toBeInTheDocument());
  const p = posts();
  expect(p).toHaveLength(1);
  expect(p[0].url).toMatch(/\/admin\/tax\/bank-import\/ledger\/decide$/);
  expect(p[0].body).toEqual({ id: 'row-1', decision: 'personal', always: false });
});

it('Business with Always posts decide, then create-expense with the chosen category', async () => {
  render(<LedgerInboxTab />);
  const card = await screen.findByTestId('ledger-row-row-1');
  fireEvent.change(within(card).getByLabelText('Category'), { target: { value: 'cat-1' } });
  fireEvent.click(within(card).getByLabelText('Always treat this payee this way'));
  fireEvent.click(within(card).getByRole('button', { name: 'Business' }));
  await waitFor(() => expect(screen.queryByText('ACME HARDWARE 123')).not.toBeInTheDocument());
  const p = posts();
  expect(p).toHaveLength(2);
  expect(p[0].url).toMatch(/\/ledger\/decide$/);
  expect(p[0].body).toEqual({ id: 'row-1', decision: 'expense', categoryId: 'cat-1' });
  expect(p[1].url).toMatch(/\/admin\/tax\/bank-import\/row-1\/create-expense$/);
  expect(p[1].body).toEqual({ categoryId: 'cat-1', fromLedger: true, always: true });
});

it('Business without Always still posts decide first, then create-expense marked fromLedger', async () => {
  render(<LedgerInboxTab />);
  const card = await screen.findByTestId('ledger-row-row-1');
  fireEvent.click(within(card).getByRole('button', { name: 'Business' }));
  await waitFor(() => expect(screen.queryByText('ACME HARDWARE 123')).not.toBeInTheDocument());
  const p = posts();
  expect(p.map((c) => c.url.replace(/^.*\/admin\/tax\/bank-import/, ''))).toEqual(['/ledger/decide', '/row-1/create-expense']);
  expect(p[0].body).toEqual({ id: 'row-1', decision: 'expense', categoryId: 'cat-2' });
  expect(p[1].body).toEqual({ categoryId: 'cat-2', fromLedger: true, always: false });
});

it('a refused decide leaves the row in place with the server reason', async () => {
  const base = fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    if (String(url).includes('/ledger/decide')) return json({ error: 'this row may match an expense or payout that is already booked: decide it in Bank Import' }, false);
    return base(url, opts);
  }));
  render(<LedgerInboxTab />);
  const card = await screen.findByTestId('ledger-row-row-1');
  fireEvent.click(within(card).getByRole('button', { name: 'Business' }));
  expect(await within(card).findByRole('alert')).toHaveTextContent(/decide it in Bank Import/);
  expect(screen.getByText('ACME HARDWARE 123')).toBeInTheDocument();
  expect(posts().some((c) => c.url.includes('/create-expense'))).toBe(false);
});

it('the Income view loads view=income and explains that nothing counts it as revenue', async () => {
  status = { enabled: true, rules: 3, inbox: 1, income: 2 };
  render(<LedgerInboxTab />);
  expect(await screen.findByText('1 rows to review · 3 rules · 2 income')).toBeInTheDocument();
  // the view switch and the row's decision button both read "Income"; the view carries its own name
  fireEvent.click(screen.getByRole('button', { name: 'Income view' }));
  await waitFor(() => expect(calls.some((c) => c.url.includes('/ledger/inbox') && c.url.includes('view=income'))).toBe(true));
  expect(await screen.findByText(/not in the P&L or any report/)).toBeInTheDocument();
});

it('Apply rules now follows the continuation cursor until the server has no more', async () => {
  let applyCalls = 0;
  const base = fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/ledger/rules/apply')) {
      applyCalls += 1;
      calls.push({ url: u, method: 'POST', body: opts.body ? JSON.parse(opts.body) : undefined });
      return applyCalls === 1
        ? json({ success: true, examined: 5000, suggested: 40, cleared: 1, more: true, cursor: { txn_date: '2026-03-01', id: '11111111-1111-4111-8111-111111111111' } })
        : json({ success: true, examined: 120, suggested: 2, cleared: 0, more: false, cursor: null });
    }
    return base(url, opts);
  }));
  render(<LedgerInboxTab />);
  await screen.findByText('ACME HARDWARE 123');
  fireEvent.click(screen.getByRole('button', { name: 'Apply rules now' }));
  expect(await screen.findByText('Examined 5120, suggested 42, cleared 1.')).toBeInTheDocument();
  const applies = calls.filter((c) => c.url.includes('/ledger/rules/apply'));
  expect(applies).toHaveLength(2);
  expect(applies[0].body).toEqual({});
  expect(applies[1].body).toEqual({ after: { txn_date: '2026-03-01', id: '11111111-1111-4111-8111-111111111111' } });
});

it('a money-out row offers no Income button', async () => {
  render(<LedgerInboxTab />);
  const card = await screen.findByTestId('ledger-row-row-1');
  expect(within(card).queryByRole('button', { name: 'Income' })).not.toBeInTheDocument();
  expect(within(card).getByRole('button', { name: 'Business' })).toBeInTheDocument();
});

it('a money-in row offers no Business button', async () => {
  const base = fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    if (String(url).includes('/ledger/inbox')) return json({ rows: [{ ...row, id: 'row-2', direction: 'credit', description: 'ZELLE FROM SOMEONE', suggestion: null }], total: 1 });
    return base(url, opts);
  }));
  render(<LedgerInboxTab />);
  const card = await screen.findByTestId('ledger-row-row-2');
  expect(within(card).queryByRole('button', { name: 'Business' })).not.toBeInTheDocument();
  expect(within(card).getByRole('button', { name: 'Income' })).toBeInTheDocument();
  expect(within(card).getByText('+$42.50')).toBeInTheDocument();
});
