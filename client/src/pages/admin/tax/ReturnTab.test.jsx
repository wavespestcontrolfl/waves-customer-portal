// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ReturnTab from './ReturnTab.jsx';
import { etParts } from '../../../lib/timezone';

// Locked-down behaviors: hidden (and silent) while the gate is off; the
// server's lines on screen with each carry-in's source; Save year, Mark filed
// and Unmark post what they should; a failed return shows its message.

// the form renders after two fetches: a loaded machine needs more than the 1s default
configure({ asyncUtilTimeout: 10000 });

const YEAR = etParts().year;

let calls;
let status;
let detail;
let ret;
let retError;

function json(body, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body };
}

const baseRow = { tax_year: YEAR, filing_status: 'single', status: 'draft', filed_on: null, other_income: 0, estimates_paid: 0, nol_in: null, qbi_loss_in: null, sec179_carry_in: 1500, home_office_carry_in: null, notes: null };

beforeEach(() => {
  calls = [];
  status = { enabled: true };
  retError = null;
  detail = {
    year: YEAR, exists: true, row: baseRow,
    carry_in: {
      nol: { value: 26000, source: 'prior_year', from_year: YEAR - 1, default_value: 26000, default_source: 'prior_year', default_from_year: YEAR - 1 },
      qbi_loss: { value: 0, source: 'none', from_year: null, default_value: 0, default_source: 'none', default_from_year: null },
      sec179: { value: 1500, source: 'entered', from_year: null, default_value: 700, default_source: 'prior_year', default_from_year: YEAR - 1 },
      home_office: { value: 0, source: 'none', from_year: null, default_value: 0, default_source: 'none', default_from_year: null },
    },
  };
  ret = {
    year: YEAR, filing_status: 'single', standard_deduction: 15750,
    schedule_c: [
      { line: '1', label: 'Gross receipts', amount: 150000 },
      { line: '8', label: 'Advertising', amount: 3000 },
      { line: '13', label: 'Section 179 deduction', amount: 61000 },
      { line: '31', label: 'Net profit or (loss)', amount: 65000 },
    ],
    se_tax: 9184.21, half_se_deduction: 4592.11, agi: 60407.89, nol_used: 26000, qbi_deduction: 3731.58,
    taxable_income: 14926.31, income_tax: 1552.66, additional_medicare_tax: 0, total_tax: 10736.87, estimates_paid: 2000, owed: 8736.87,
    carry_out: { nol: 0, qbi_loss: 0, sec179: 1000, home_office: 250 },
    estimates: { note: 'To be safe from the underpayment penalty, pay 100% of this year.' },
    reserve: { amount: 8736.87, months_left: 3, monthly: 2912.29, basis: 'the months left in the year' },
    warnings: [{ code: 'year_in_progress', message: 'This year is not over. These figures are to date.' }],
  };
  localStorage.setItem('waves_admin_token', 'test-token');
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || 'GET';
    calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (u.includes('/return-engine/status')) return json(status);
    if (u.endsWith('/return')) return retError ? json({ error: retError }, false) : json(ret);
    if (u.includes('/tax-years/') && method === 'GET') return json(detail);
    return json(detail);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('renders nothing and reads nothing else while the gate is off', async () => {
  status = { enabled: false };
  const { container } = render(<ReturnTab />);
  await waitFor(() => expect(calls.length).toBeGreaterThan(0));
  expect(container).toBeEmptyDOMElement();
  expect(calls.some((c) => c.url.includes('/tax-years'))).toBe(false);
});

it('shows the Schedule C lines, the tax, the carryovers, the warnings and each carry-in source', async () => {
  render(<ReturnTab />);
  await screen.findByText('Schedule C line 8: Advertising');
  expect(screen.getByText('Schedule C line 13: Section 179 deduction')).toBeInTheDocument();
  expect(screen.getByText('Schedule C line 31: Net profit or (loss)')).toBeInTheDocument();
  expect(screen.getByTestId('total-tax')).toHaveTextContent('$10,736.87');
  expect(screen.getByTestId('owed')).toHaveTextContent('$8,736.87');
  expect(screen.getByText('Balance due')).toBeInTheDocument();
  expect(screen.getByTestId('carry-out')).toHaveTextContent(`Carried to ${YEAR + 1}`);
  expect(screen.getByTestId('carry-out')).toHaveTextContent('Section 179: $1,000.00');
  expect(screen.getByTestId('warnings')).toHaveTextContent('These figures are to date.');
  expect(screen.getByText(/Set aside about \$2,912.29 a month/)).toBeInTheDocument();
  await waitFor(() => expect(screen.getByTestId('source-nol')).toHaveTextContent(`Default: $26,000.00 from the ${YEAR - 1} filed return`));
  expect(screen.getByLabelText('Net operating loss carried in')).toHaveValue('');
  expect(screen.getByLabelText('Net operating loss carried in')).toHaveAttribute('placeholder', expect.stringContaining('default $26,000.00'));
  expect(screen.getByTestId('source-sec179')).toHaveTextContent(`Your number. Clear the box to use the default: $700.00 from the ${YEAR - 1} filed return.`);
  expect(screen.getByLabelText('Section 179 carried in')).toHaveValue('1500');
  expect(screen.getByTestId('source-qbi_loss')).toHaveTextContent('Default: $0.00 (no filed return for last year)');
});

it('shows a refund as a refund', async () => {
  ret = { ...ret, owed: -150 };
  render(<ReturnTab />);
  await screen.findByText('Refund');
  expect(screen.getByTestId('owed')).toHaveTextContent('$150.00');
});

it('Save year posts the typed amounts: a blank amount as 0, a blank carry-in as null (the default), a typed 0 kept', async () => {
  render(<ReturnTab />);
  await screen.findByLabelText('Other income');
  fireEvent.change(screen.getByLabelText('Other income'), { target: { value: '1200.50' } });
  fireEvent.change(screen.getByLabelText('Filing status'), { target: { value: 'mfj' } });
  fireEvent.change(screen.getByLabelText('QBI loss carried in'), { target: { value: '0' } });
  fireEvent.change(screen.getByLabelText('Section 179 carried in'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save year' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true), { timeout: 5000 });
  const put = calls.find((c) => c.method === 'PUT');
  expect(put.url).toContain(`/tax-years/${YEAR}`);
  expect(put.body).toEqual({
    filing_status: 'mfj', other_income: '1200.50', estimates_paid: '0', nol_in: null, qbi_loss_in: '0',
    sec179_carry_in: null, home_office_carry_in: null, notes: '',
  });
});

it('Mark filed posts to the file route and reloads the year', async () => {
  render(<ReturnTab />);
  const button = await screen.findByRole('button', { name: 'Mark filed' });
  const before = calls.length;
  fireEvent.click(button);
  await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith(`/tax-years/${YEAR}/file`))).toBe(true));
  await waitFor(() => expect(calls.length).toBeGreaterThan(before + 1));
  expect(calls.filter((c) => c.url.endsWith('/return')).length).toBeGreaterThan(1);
});

it('a filed year shows its date, locks the form, and Unmark filed posts to unfile', async () => {
  detail = { ...detail, row: { ...baseRow, status: 'filed', filed_on: '2026-04-10' } };
  render(<ReturnTab />);
  await screen.findByText('Filed 2026-04-10');
  expect(screen.getByLabelText('Other income')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Save year' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Mark filed' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Unmark filed' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith(`/tax-years/${YEAR}/unfile`))).toBe(true));
});

it('a year with no constants shows the server message instead of a return', async () => {
  retError = 'tax constants for 2027 are not loaded';
  render(<ReturnTab />);
  await screen.findByText('tax constants for 2027 are not loaded');
  expect(screen.queryByRole('button', { name: 'Mark filed' })).toBeNull();
});

it('a save the server refuses shows its message', async () => {
  const base = fetch.getMockImplementation();
  fetch.mockImplementation(async (url, opts = {}) => {
    if (opts.method === 'PUT') return json({ error: 'other_income must be an amount from 0 to 1000000000' }, false);
    return base(url, opts);
  });
  render(<ReturnTab />);
  await screen.findByLabelText('Other income');
  fireEvent.change(screen.getByLabelText('Other income'), { target: { value: '50junk' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save year' }));
  await screen.findByText(/other_income must be an amount/);
});
