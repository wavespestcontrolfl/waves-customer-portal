// @vitest-environment jsdom
// Payroll layer 2: marking a filing filed or paid asks for an optional
// confirmation number (Cancel aborts the change, blank sends none), and a
// completed row shows it.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FilingCalendarTab } from './TaxPage.jsx';

const filings = [
  { id: 'f-open', sourceKey: null, filingType: 'payroll_941', title: 'Form 941 — Q1 2099', periodLabel: 'Q1 2099', dueDate: '2099-04-30', status: 'upcoming', amountDue: 120.5, amountPaid: null, filedDate: null, paidDate: null, confirmationNumber: null, notes: 'Pay on EFTPS by 8 PM ET the day before the due date.' },
  { id: 'f-done', filingType: 'payroll_941', title: 'Form 941 — Q4 2098', periodLabel: 'Q4 2098', dueDate: '2099-01-31', status: 'filed', amountDue: null, amountPaid: null, filedDate: '2099-01-20', paidDate: null, confirmationNumber: 'EFT-998877', notes: 'A pay run changed after this was marked done.' },
];
let puts;
let seenInBank;
let list;

beforeEach(() => {
  puts = [];
  seenInBank = false;
  list = filings;
  localStorage.setItem('waves_admin_token', 'test-token');
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    if (options.method === 'PUT') {
      puts.push({ url: String(url), body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ success: true }) };
    }
    return { ok: true, json: async () => ({ filings: seenInBank ? list.map(f => ({ ...f, bankSeenOn: '2099-04-28' })) : list }) };
  }));
});
afterEach(() => { filings[0].sourceKey = null; cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const markFiled = async () => {
  render(<FilingCalendarTab />);
  await waitFor(() => expect(screen.getByText('Form 941 — Q1 2099')).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('Filing status'), { target: { value: 'filed' } });
};

it('shows the confirmation number on a completed row', async () => {
  render(<FilingCalendarTab />);
  await waitFor(() => expect(screen.getByText('Conf. EFT-998877')).toBeInTheDocument());
});

it('shows the date a payment was seen in the bank on both cards, and nothing without it', async () => {
  const first = render(<FilingCalendarTab />);
  await waitFor(() => expect(screen.getByText('Form 941 — Q1 2099')).toBeInTheDocument());
  expect(screen.queryByText(/Seen in the bank on/)).toBeNull();
  first.unmount();
  seenInBank = true;
  render(<FilingCalendarTab />);
  await waitFor(() => expect(screen.getAllByText(/Seen in the bank on/)).toHaveLength(2));
});

it('shows the notes on both the upcoming and the completed cards', async () => {
  render(<FilingCalendarTab />);
  await waitFor(() => expect(screen.getByText('Pay on EFTPS by 8 PM ET the day before the due date.')).toBeInTheDocument());
  expect(screen.getByText('A pay run changed after this was marked done.')).toBeInTheDocument();
});

it('sends the trimmed confirmation number when marking filed', async () => {
  vi.spyOn(window, 'prompt').mockReturnValue('  EFT-555  ');
  await markFiled();
  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0].url).toContain('/admin/tax/filings/f-open');
  expect(puts[0].body).toMatchObject({ status: 'filed', confirmationNumber: 'EFT-555' });
});

it('sends no confirmation number when the prompt is left blank', async () => {
  vi.spyOn(window, 'prompt').mockReturnValue('   ');
  await markFiled();
  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0].body.status).toBe('filed');
  expect(puts[0].body).not.toHaveProperty('confirmationNumber');
});

it('a payroll row requires the confirmation number: a blank answer sends nothing', async () => {
  filings[0].sourceKey = 'payroll:941:2099-Q1';
  const prompt = vi.spyOn(window, 'prompt').mockReturnValue('   ');
  const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  await markFiled();
  await waitFor(() => expect(alertSpy).toHaveBeenCalled());
  expect(prompt).toHaveBeenCalledWith('Confirmation number (required):', '');
  expect(puts).toHaveLength(0);
});

it('cancelling the prompt aborts the status change', async () => {
  vi.spyOn(window, 'prompt').mockReturnValue(null);
  await markFiled();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(puts).toHaveLength(0);
});

it('asks for the amount first, then the confirmation number, when marking paid', async () => {
  const prompt = vi.spyOn(window, 'prompt').mockReturnValueOnce('120.50').mockReturnValueOnce('PAY-1');
  render(<FilingCalendarTab />);
  await waitFor(() => expect(screen.getByText('Form 941 — Q1 2099')).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('Filing status'), { target: { value: 'paid' } });
  await waitFor(() => expect(puts).toHaveLength(1));
  expect(prompt.mock.calls[0][0]).toMatch(/Amount paid/);
  expect(prompt.mock.calls[1][0]).toMatch(/Confirmation number/);
  expect(puts[0].body).toMatchObject({ status: 'paid', amountPaid: 120.5, confirmationNumber: 'PAY-1' });
});

it('keeps a Late filing in the open list with its status control; All caught up only when none is open', async () => {
  list = [{ ...filings[0], status: 'late' }, filings[1]];
  const first = render(<FilingCalendarTab />);
  await waitFor(() => expect(screen.getByText('Form 941 — Q1 2099')).toBeInTheDocument());
  expect(screen.getByLabelText('Filing status')).toHaveValue('late');
  expect(screen.queryByText('All caught up!')).toBeNull();
  expect(screen.getByText('Completed (1)')).toBeInTheDocument();
  first.unmount();
  list = [filings[1]];
  render(<FilingCalendarTab />);
  await waitFor(() => expect(screen.getByText('All caught up!')).toBeInTheDocument());
});
