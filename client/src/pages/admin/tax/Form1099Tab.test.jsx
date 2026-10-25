// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Form1099Tab from './Form1099Tab.jsx';
import { etParts } from '../../../lib/timezone';

// Locked-down behaviors: hidden (and silent) while the gate is off; payees with
// their status, how-paid words and the footers; a payee expands to its
// payments; a changed year re-reads; a failed read shows the server's message.

configure({ asyncUtilTimeout: 10000 });

const LAST_YEAR = etParts().year - 1;

let calls;
let status;
let list;
let listError;

function json(body, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body };
}

beforeEach(() => {
  calls = [];
  status = { enabled: true };
  listError = null;
  list = {
    year: LAST_YEAR, threshold: 2000, due_date: `${LAST_YEAR + 1}-02-01`,
    payees: [
      {
        key: 'pat-example', name: 'Pat Example', total: 3500, count: 2, channels: ['zelle', 'check'], lines: ['11'], needs_1099: true, unclear_method: false,
        payments: [
          { expense_id: 'e1', date: `${LAST_YEAR}-03-04`, amount: 2000, channel: 'zelle', line: '11', category: 'contract_labor', text: 'ZELLE TO PAT EXAMPLE' },
          { expense_id: 'e2', date: `${LAST_YEAR}-05-09`, amount: 1500, channel: 'check', line: '11', category: 'contract_labor', text: 'CHECK 1042' },
        ],
      },
      {
        key: 'lee-sample', name: 'Lee Sample', total: 900, count: 1, channels: ['unknown'], lines: ['17'], needs_1099: false, unclear_method: true,
        payments: [{ expense_id: 'e3', date: `${LAST_YEAR}-07-15`, amount: 900, channel: 'unknown', line: '17', category: 'legal_professional', text: 'CONSULT FEE' }],
      },
    ],
    left_out: { count: 3, total: 410.5, by_channel: { card: { count: 2, total: 300 }, debit_card: { count: 1, total: 110.5 }, platform: { count: 0, total: 0 } } },
    inbox_pending: { count: 2, total: 640 },
    notes: ['Payments to corporations are usually exempt.'],
  };
  localStorage.setItem('waves_admin_token', 'test-token');
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET' });
    if (u.includes('/worksheets/status')) return json(status);
    if (u.includes('/worksheets/1099')) return listError ? json({ error: listError }, false) : json(list);
    return json({});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const listCalls = () => calls.filter((c) => c.url.includes('/worksheets/1099'));

it('renders nothing and makes only the status request while the gate is off', async () => {
  status = { enabled: false };
  const { container } = render(<Form1099Tab />);
  await waitFor(() => expect(calls.length).toBe(1));
  expect(calls[0].url).toContain('/admin/tax/worksheets/status');
  expect(container).toBeEmptyDOMElement();
});

it('reads last year by default and shows the payees, statuses, how paid words and footers', async () => {
  render(<Form1099Tab />);
  await screen.findByText('Pat Example');
  expect(listCalls()[0].url).toContain(`year=${LAST_YEAR}`);
  expect(screen.getByTestId('summary')).toHaveTextContent(`Threshold $2,000.00 per person · 1099-NEC due Feb 1, ${LAST_YEAR + 1}`);
  const pat = screen.getByText('Pat Example').closest('tr');
  expect(pat).toHaveTextContent('$3,500.00');
  expect(pat).toHaveTextContent('Zelle, Check');
  expect(pat).toHaveTextContent('Needs a 1099-NEC');
  const lee = screen.getByText('Lee Sample').closest('tr');
  expect(lee).toHaveTextContent('Not clear');
  expect(lee).toHaveTextContent('Under $2,000.00');
  expect(lee).toHaveTextContent('Check how you paid');
  expect(lee).not.toHaveTextContent('Needs a 1099-NEC');
  expect(screen.getByText('Left out: 3 card, debit card or platform payments ($410.50). The card network or the platform files a 1099-K for those.')).toBeInTheDocument();
  expect(screen.getByText('2 Zelle, Venmo, Cash App or Wise payments ($640.00) still wait in the Inbox. Book the helper payments as contract labor to complete this list.')).toBeInTheDocument();
  expect(screen.getByText('Payments to corporations are usually exempt.')).toBeInTheDocument();
});

it('omits the left-out and Inbox lines when their counts are 0', async () => {
  list = { ...list, left_out: { count: 0, total: 0, by_channel: {} }, inbox_pending: { count: 0, total: 0 }, notes: [] };
  render(<Form1099Tab />);
  await screen.findByText('Pat Example');
  expect(screen.queryByText(/Left out:/)).toBeNull();
  expect(screen.queryByText(/still wait in the Inbox/)).toBeNull();
});

it('expanding a payee lists its payments and hiding closes them', async () => {
  render(<Form1099Tab />);
  await screen.findByText('Pat Example');
  expect(screen.queryByTestId('payments-pat-example')).toBeNull();
  fireEvent.click(screen.getAllByRole('button', { name: 'Show payments' })[0]);
  const box = await screen.findByTestId('payments-pat-example');
  expect(box).toHaveTextContent('Mar 4, ' + LAST_YEAR);
  expect(box).toHaveTextContent('$2,000.00');
  expect(box).toHaveTextContent('Zelle');
  expect(box).toHaveTextContent('Contract labor');
  expect(box).toHaveTextContent('ZELLE TO PAT EXAMPLE');
  expect(box).toHaveTextContent('CHECK 1042');
  fireEvent.click(screen.getByRole('button', { name: 'Hide payments' }));
  expect(screen.queryByTestId('payments-pat-example')).toBeNull();
  fireEvent.click(screen.getAllByRole('button', { name: 'Show payments' })[1]);
  expect(await screen.findByTestId('payments-lee-sample')).toHaveTextContent('Legal and professional');
});

it('changing the year reads the new year', async () => {
  render(<Form1099Tab />);
  await screen.findByText('Pat Example');
  fireEvent.change(screen.getByLabelText('Year'), { target: { value: String(LAST_YEAR - 1) } });
  await waitFor(() => expect(listCalls().some((c) => c.url.includes(`year=${LAST_YEAR - 1}`))).toBe(true));
});

it('shows the empty state when no payee needs a check', async () => {
  list = { ...list, payees: [] };
  render(<Form1099Tab />);
  await screen.findByText(`No contract labor or legal and professional payments for ${LAST_YEAR} that need a 1099 check.`);
});

it('a failed read shows the server error text', async () => {
  listError = 'the 1099 list needs a year from 2024';
  render(<Form1099Tab />);
  await screen.findByText('the 1099 list needs a year from 2024');
  expect(screen.queryByText('Pat Example')).toBeNull();
});
