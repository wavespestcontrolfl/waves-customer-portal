// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PayrollSettings from './PayrollSettings';
import { adminFetch } from '../../lib/adminFetch';

vi.mock('../../lib/adminFetch', () => ({ adminFetch: vi.fn() }));

const reply = (body, ok = true, status = ok ? 200 : 400) => Promise.resolve({ ok, status, json: async () => body });
const W4 = {
  id: 'w4-1', formYear: 2026, filingStatus: 'married_jointly', step2Checkbox: true, step3Amount: '2000.00',
  step4aOtherIncome: '0.00', step4bDeductions: '0.00', step4cExtraWithholding: '5.00', exempt: false,
  signedOn: '2026-10-20', effectiveOn: '2026-11-01', note: null,
};
const TECHS = [
  { id: 'tech-a', name: 'Sample Alpha', payRate: '22.00', payMethod: 'check', payMethodConsentOn: null, employmentStatus: 'active', currentW4: W4 },
  { id: 'tech-b', name: 'Sample Beta', payRate: '25.50', payMethod: 'bank_transfer', payMethodConsentOn: '2026-09-15', employmentStatus: 'active', currentW4: null },
];

let writes;
beforeEach(() => {
  writes = [];
  adminFetch.mockReset();
  adminFetch.mockImplementation((path, options = {}) => {
    if (options.method === 'POST' || options.method === 'PUT') {
      writes.push({ path, method: options.method, body: options.body });
      return reply(options.method === 'POST' ? { election: W4 } : { technician: {} });
    }
    if (path === '/admin/payroll/technicians') return reply({ technicians: TECHS });
    if (path === '/admin/payroll/runs') return reply({ runs: [] });
    if (path === '/admin/payroll/technicians/tech-a/w4') return reply({ elections: [W4, { ...W4, id: 'w4-0', filingStatus: 'single', step2Checkbox: false, step4cExtraWithholding: '0.00', formYear: 2025, effectiveOn: '2025-01-06', signedOn: '2025-01-02' }] });
    return reply({}, false, 404);
  });
});
afterEach(cleanup);

const rowFor = name => screen.getByText(name).closest('tr');

describe('Payroll tab table', () => {
  it('shows pay rate, pay method and the current W-4, or "No W-4 on file"', async () => {
    render(<PayrollSettings />);
    await screen.findByText('Sample Alpha');
    const alpha = within(rowFor('Sample Alpha'));
    expect(alpha.getByText('$22.00/hr')).toBeInTheDocument();
    expect(alpha.getByText('Paper check')).toBeInTheDocument();
    expect(alpha.getByText(/Married filing jointly/)).toBeInTheDocument();
    expect(alpha.getByText(/Step 2 box checked/)).toBeInTheDocument();
    expect(alpha.getByText(/extra withholding \$5\.00/)).toBeInTheDocument();
    expect(alpha.getByText(/Form 2026 · applies from Nov 1, 2026/)).toBeInTheDocument();
    const beta = within(rowFor('Sample Beta'));
    expect(beta.getByText('No W-4 on file')).toBeInTheDocument();
    expect(beta.getByText(/Written OK Sep 15, 2026/)).toBeInTheDocument();
  });
});

describe('Enter W-4 dialog', () => {
  async function open() {
    render(<PayrollSettings />);
    await screen.findByText('Sample Alpha');
    fireEvent.click(within(rowFor('Sample Alpha')).getByRole('button', { name: 'Enter W-4' }));
    return screen.findByRole('dialog');
  }

  it('shows the paper-form help line and every field in W-4 order, and asks for no SSN or bank number', async () => {
    const dialog = await open();
    const view = within(dialog);
    expect(view.getByText('Type the elections from the signed paper W-4. Keep the paper form for 4 years. The SSN stays on the paper.')).toBeInTheDocument();
    const labels = ['Form year', 'Step 1(c) filing status', 'Step 2(c) box checked', 'Step 3 total credits ($)', 'Step 4(a) other income ($)',
      'Step 4(b) deductions ($)', 'Step 4(c) extra withholding per pay period ($)', 'Exempt', 'Date the employee signed', 'First pay date it applies to', 'Note'];
    const found = labels.map(label => view.getByLabelText(new RegExp(`^${label.replace(/[()$]/g, '\\$&')}`)));
    const order = found.map(el => Array.prototype.indexOf.call(dialog.querySelectorAll('input, select, textarea'), el));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(Array.from(view.getByLabelText(/Step 1\(c\)/).querySelectorAll('option')).map(o => o.textContent))
      .toEqual(['Single or Married filing separately', 'Married filing jointly', 'Head of household']);
    expect(dialog.textContent).not.toMatch(/social security number|account number|routing/i);
  });

  it('keeps Save off until the signed date is typed, then posts the elections', async () => {
    const dialog = await open();
    const view = within(dialog);
    const save = view.getByRole('button', { name: 'Save W-4' });
    expect(save).toBeDisabled();
    fireEvent.change(view.getByLabelText(/Step 1\(c\)/), { target: { value: 'married_jointly' } });
    fireEvent.click(view.getByLabelText('Step 2(c) box checked'));
    fireEvent.change(view.getByLabelText(/Step 3 total credits/), { target: { value: '2000' } });
    fireEvent.change(view.getByLabelText(/Step 4\(c\)/), { target: { value: '5.25' } });
    fireEvent.change(view.getByLabelText(/Date the employee signed/), { target: { value: '2026-10-20' } });
    fireEvent.change(view.getByLabelText('Note'), { target: { value: ' From the paper form ' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].path).toBe('/admin/payroll/technicians/tech-a/w4');
    expect(writes[0].method).toBe('POST');
    expect(writes[0].body).toMatchObject({
      filingStatus: 'married_jointly', step2Checkbox: true, step3Amount: '2000', step4cExtraWithholding: '5.25',
      exempt: false, signedOn: '2026-10-20', note: 'From the paper form',
    });
    expect(writes[0].body).not.toHaveProperty('effectiveOn');
    await screen.findByText('W-4 saved for Sample Alpha.');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the server message and stays open when the save is refused', async () => {
    const dialog = await open();
    adminFetch.mockImplementationOnce(() => reply({ error: 'Step 3 credits must be a dollar amount with at most 2 decimal places' }, false, 400));
    fireEvent.change(within(dialog).getByLabelText(/Date the employee signed/), { target: { value: '2026-10-20' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save W-4' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Step 3 credits must be a dollar amount');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('W-4 history', () => {
  it('lists the elections newest first', async () => {
    render(<PayrollSettings />);
    await screen.findByText('Sample Alpha');
    fireEvent.click(within(rowFor('Sample Alpha')).getByRole('button', { name: 'History' }));
    const list = await screen.findByRole('list', { name: /newest first/ });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Form 2026');
    expect(items[1]).toHaveTextContent('Form 2025');
  });
});

describe('Pay method control', () => {
  async function open(name) {
    render(<PayrollSettings />);
    await screen.findByText(name);
    fireEvent.click(within(rowFor(name)).getByRole('button', { name: 'Pay method' }));
    return screen.findByRole('dialog');
  }

  it('offers paper check and bank transfer, with the bank-number help line', async () => {
    const dialog = await open('Sample Alpha');
    const view = within(dialog);
    expect(view.getByText('Bank account numbers stay off the portal.')).toBeInTheDocument();
    expect(view.getByLabelText('Paper check')).toBeChecked();
    expect(view.getByLabelText('Bank transfer')).not.toBeChecked();
    expect(view.queryByLabelText(/Written OK received on/)).toBeNull();
  });

  it('needs the written OK date before a bank transfer can be saved, then sends it', async () => {
    const dialog = await open('Sample Alpha');
    const view = within(dialog);
    fireEvent.click(view.getByLabelText('Bank transfer'));
    const save = view.getByRole('button', { name: 'Save pay method' });
    expect(save).toBeDisabled();
    fireEvent.change(view.getByLabelText(/Written OK received on/), { target: { value: '2026-10-22' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ path: '/admin/payroll/technicians/tech-a/pay-method', method: 'PUT', body: { payMethod: 'bank_transfer', consentOn: '2026-10-22' } });
    await screen.findByText('Pay method saved for Sample Alpha.');
  });

  it('sends no date for a paper check', async () => {
    const dialog = await open('Sample Beta');
    const view = within(dialog);
    expect(view.getByLabelText('Bank transfer')).toBeChecked();
    expect(view.getByLabelText(/Written OK received on/)).toHaveValue('2026-09-15');
    fireEvent.click(view.getByLabelText('Paper check'));
    expect(view.queryByLabelText(/Written OK received on/)).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Save pay method' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body).toEqual({ payMethod: 'check', consentOn: null });
  });
});
