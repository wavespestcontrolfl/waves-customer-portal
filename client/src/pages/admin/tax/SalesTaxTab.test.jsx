// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SalesTaxTab from './SalesTaxTab.jsx';

// Locked-down behaviors: hidden (and silent) while the gate is off; the nine
// DR-15 lines, the due date and the Late badge; a changed period re-reads the
// sheet; Mark filed puts the right body on the filing row and reloads; a filed
// row shows its facts and no button; a failed read shows the server's message.

configure({ asyncUtilTimeout: 10000 });

let calls;
let status;
let sheet;
let sheetError;

function json(body, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body };
}

const openFiling = { id: 'f-1', status: 'upcoming', period_label: 'Oct 2026', due_date: '2026-11-20', filed_date: null, paid_date: null, amount_paid: null, confirmation_number: null };

beforeEach(() => {
  calls = [];
  status = { enabled: true };
  sheetError = null;
  sheet = {
    period: { kind: 'month', year: 2026, index: 9, label: 'Sep 2026', start: '2026-09-01', end: '2026-09-30', in_progress: false },
    due_date: '2026-11-20',
    late: true,
    lines: { gross_sales: 12000, exempt_sales: 9000, taxable_amount: 3000, tax_collected: 210, surtax_collected: 30, collection_allowance: 0.33, penalty: 15.5, amount_due: 225.17 },
    allowance_note: 'The allowance is 2.5% of the first $1,200 of tax.',
    penalty_note: 'Late returns pay 10% of the tax due.',
    filing: openFiling,
    warnings: [{ code: 'unbooked_sales', text: 'Two invoices have no tax rate.' }],
  };
  localStorage.setItem('waves_admin_token', 'test-token');
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || 'GET';
    calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (u.includes('/worksheets/status')) return json(status);
    if (u.includes('/worksheets/sales-tax')) return sheetError ? json({ error: sheetError }, false) : json(sheet);
    if (method === 'PUT') return json({ success: true });
    return json({});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const sheetCalls = () => calls.filter((c) => c.url.includes('/worksheets/sales-tax'));

it('renders nothing and makes only the status request while the gate is off', async () => {
  status = { enabled: false };
  const { container } = render(<SalesTaxTab />);
  await waitFor(() => expect(calls.length).toBe(1));
  expect(calls[0].url).toContain('/admin/tax/worksheets/status');
  expect(container).toBeEmptyDOMElement();
  expect(calls.length).toBe(1);
});

it('shows the nine DR-15 lines with their values, the due date, the Late badge and the warnings', async () => {
  render(<SalesTaxTab />);
  await screen.findByText('Sep 2026');
  const row = (label) => screen.getByText(label).closest('tr');
  expect(row('Line A, column 1 — Gross sales')).toHaveTextContent('$12,000.00');
  expect(row('Line A, column 2 — Exempt sales (residential work)')).toHaveTextContent('$9,000.00');
  expect(row('Line A, column 3 — Taxable amount (commercial work)')).toHaveTextContent('$3,000.00');
  expect(row('Line A, column 4 — Tax collected')).toHaveTextContent('$210.00');
  expect(row('Line 15(d) — Surtax collected (part of column 4)')).toHaveTextContent('$30.00');
  expect(row('Line 11 — Collection allowance')).toHaveTextContent('-$0.33');
  expect(row('Line 11 — Collection allowance')).toHaveTextContent('The allowance is 2.5% of the first $1,200 of tax.');
  expect(row('Line 12 — Penalty')).toHaveTextContent('$15.50');
  expect(row('Line 12 — Penalty')).toHaveTextContent('Late returns pay 10% of the tax due.');
  expect(row('Line 13 — Interest')).toHaveTextContent('DOR works it out when the return is late');
  expect(screen.getByTestId('amount-due')).toHaveTextContent('$225.17');
  expect(screen.getByText('Due Nov 20, 2026')).toBeInTheDocument();
  expect(screen.getByText('Late')).toBeInTheDocument();
  expect(screen.queryByText('In progress')).toBeNull();
  expect(screen.getByText('Two invoices have no tax rate.')).toBeInTheDocument();
  expect(screen.getByText('File on the Florida Department of Revenue site and copy these numbers across.')).toBeInTheDocument();
});

it('reads the previous month by default and re-reads with kind=quarter when the kind changes', async () => {
  render(<SalesTaxTab />);
  await screen.findByText('Sep 2026');
  expect(sheetCalls()[0].url).toContain('kind=month');
  expect(sheetCalls()[0].url).toContain('index=');
  fireEvent.change(screen.getByLabelText('Period type'), { target: { value: 'quarter' } });
  await waitFor(() => expect(sheetCalls().some((c) => c.url.includes('kind=quarter') && c.url.includes('index='))).toBe(true));
  fireEvent.change(screen.getByLabelText('Period type'), { target: { value: 'year' } });
  await waitFor(() => expect(sheetCalls().some((c) => c.url.includes('kind=year') && !c.url.includes('index='))).toBe(true));
  expect(screen.queryByLabelText('Period')).toBeNull();
});

it('Mark filed puts the paid body on the filing row and reads the sheet again', async () => {
  render(<SalesTaxTab />);
  const button = await screen.findByRole('button', { name: 'Mark filed' });
  expect(screen.getByLabelText('Amount paid')).toHaveValue('225.17');
  fireEvent.change(screen.getByLabelText('Filed date'), { target: { value: '2026-11-18' } });
  fireEvent.change(screen.getByLabelText('Confirmation number'), { target: { value: 'ABC123' } });
  const before = sheetCalls().length;
  fireEvent.click(button);
  await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
  const put = calls.find((c) => c.method === 'PUT');
  expect(put.url).toContain('/api/admin/tax/filings/f-1');
  expect(put.body).toEqual({ status: 'paid', filedDate: '2026-11-18', paidDate: '2026-11-18', amountPaid: 225.17, confirmationNumber: 'ABC123' });
  await waitFor(() => expect(sheetCalls().length).toBeGreaterThan(before));
});

it('Mark filed with no amount sends status filed', async () => {
  render(<SalesTaxTab />);
  await screen.findByRole('button', { name: 'Mark filed' });
  fireEvent.change(screen.getByLabelText('Amount paid'), { target: { value: '0' } });
  fireEvent.change(screen.getByLabelText('Filed date'), { target: { value: '2026-11-18' } });
  fireEvent.click(screen.getByRole('button', { name: 'Mark filed' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
  expect(calls.find((c) => c.method === 'PUT').body).toMatchObject({ status: 'filed', paidDate: null, amountPaid: 0 });
});

it('a filed row shows the filed facts and no Mark filed button', async () => {
  sheet = { ...sheet, filing: { ...openFiling, status: 'paid', filed_date: '2026-11-18', paid_date: '2026-11-18', amount_paid: 225.17, confirmation_number: 'XYZ789' } };
  render(<SalesTaxTab />);
  await screen.findByText('Filed 2026-11-18');
  expect(screen.getByTestId('filing-done')).toHaveTextContent('$225.17');
  expect(screen.getByTestId('filing-done')).toHaveTextContent('XYZ789');
  expect(screen.queryByRole('button', { name: 'Mark filed' })).toBeNull();
});

it('a period with no filing row says it cannot be marked filed', async () => {
  sheet = { ...sheet, filing: null };
  render(<SalesTaxTab />);
  await screen.findByText('No filing calendar row for this period, so it cannot be marked filed here.');
  expect(screen.queryByRole('button', { name: 'Mark filed' })).toBeNull();
});

it('a failed Mark filed shows the server message', async () => {
  const base = fetch.getMockImplementation();
  fetch.mockImplementation(async (url, opts = {}) => {
    if (opts.method === 'PUT') return json({ error: 'filing is locked' }, false);
    return base(url, opts);
  });
  render(<SalesTaxTab />);
  fireEvent.click(await screen.findByRole('button', { name: 'Mark filed' }));
  await screen.findByText('filing is locked');
});

it('a failed sheet read shows the server error text', async () => {
  sheetError = 'sales tax periods start in 2024';
  render(<SalesTaxTab />);
  await screen.findByText('sales tax periods start in 2024');
  expect(screen.queryByText('Line A, column 1 — Gross sales')).toBeNull();
});

it('shows the In progress badge for a period that is not over', async () => {
  sheet = { ...sheet, late: false, period: { ...sheet.period, in_progress: true } };
  render(<SalesTaxTab />);
  await screen.findByText('In progress');
  expect(screen.queryByText('Late')).toBeNull();
});
