// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AdminInvoicesPage from './AdminInvoicesPage';

vi.mock('../../hooks/useRenderedTabBeacon', () => ({ default: () => {} }));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const invoice = { id: 'synthetic-invoice', invoice_number: 'SYNTHETIC-PLAN-DATES', customer_id: 'synthetic-customer', first_name: 'Synthetic', last_name: 'Customer', email: 'synthetic@example.invalid', status: 'sent', total: 300, amount_paid: 0, line_items: [{ description: 'Synthetic service', quantity: 1, unit_price: 300, amount: 300 }] };
const BEFORE_START = 'Next payment cannot be before the start date.';
const START_PAST = 'Start date cannot be in the past.';
const NEXT_PAST = 'Next payment cannot be in the past.';

let writes;
const addDays = (ymd, days) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const createButton = () => screen.getByRole('button', { name: 'Create plan', exact: true });

beforeEach(async () => {
  localStorage.setItem('waves_admin_token', 'synthetic-token');
  localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'synthetic-admin', role: 'admin' }));
  writes = [];
  vi.stubGlobal('fetch', vi.fn(async (input, options = {}) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (options.method === 'POST' && path.endsWith('/payment-plan')) { writes.push(JSON.parse(options.body)); return json({ ok: true }, 201); }
    if (path === '/api/admin/feature-flags') return json({ flags: {} });
    if (path === '/api/admin/invoices') return json({ invoices: [invoice], total: 1, page: 1 });
    if (path === '/api/admin/invoices/stats') return json({ paid: 0, outstanding: 1, overdue: 0 });
    if (path.endsWith('/payment-notices')) return json({ notices: [] });
    if (path.endsWith('/attachments')) return json({ attachments: [] });
    if (path.endsWith('/followup')) return json({ sequence: null, steps: [] });
    if (path.endsWith('/synthetic-invoice')) return json(invoice);
    throw new Error(`Unexpected synthetic request ${path}`);
  }));
  render(<MemoryRouter initialEntries={['/admin/invoices']}><AdminInvoicesPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: /Synthetic Customer.*SYNTHETIC-PLAN-DATES/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Payment plan', exact: true }));
  await screen.findByLabelText('Next payment');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

it('blocks a first payment that falls before a later start date, and allows it again once fixed', async () => {
  const defaultNext = screen.getByLabelText('Next payment').value;
  const start = addDays(defaultNext, 60);
  expect(createButton()).toBeEnabled();
  expect(screen.queryByText(BEFORE_START)).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Start date'), { target: { value: start } });
  expect(screen.getByLabelText('Next payment')).toHaveValue(defaultNext);
  expect(screen.getByText(BEFORE_START)).toBeInTheDocument();
  expect(createButton()).toBeDisabled();
  fireEvent.click(createButton());
  expect(writes).toHaveLength(0);

  // The first payment's earliest date follows the start date.
  expect(screen.getByLabelText('Next payment')).toHaveAttribute('min', start);
  fireEvent.change(screen.getByLabelText('Next payment'), { target: { value: start } });
  expect(screen.queryByText(BEFORE_START)).not.toBeInTheDocument();
  expect(createButton()).toBeEnabled();
  fireEvent.click(createButton());
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ planStartDate: start, nextPaymentDate: start });
});

it('blocks a start date in the past', async () => {
  const today = screen.getByLabelText('Start date').value;
  expect(screen.getByLabelText('Start date')).toHaveAttribute('min', today);
  fireEvent.change(screen.getByLabelText('Start date'), { target: { value: addDays(today, -3) } });
  expect(screen.getByText(START_PAST)).toBeInTheDocument();
  expect(createButton()).toBeDisabled();
  fireEvent.click(createButton());
  expect(writes).toHaveLength(0);
});

it('blocks a first payment date in the past', async () => {
  const today = screen.getByLabelText('Start date').value;
  fireEvent.change(screen.getByLabelText('Next payment'), { target: { value: addDays(today, -2) } });
  expect(screen.getByText(NEXT_PAST)).toBeInTheDocument();
  expect(createButton()).toBeDisabled();
  fireEvent.click(createButton());
  expect(writes).toHaveLength(0);
});
