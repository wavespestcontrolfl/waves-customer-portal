// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PayrollSettings from './PayrollSettings';
import { defaultPayDate, lastFinishedWeekStart, weekLabel } from './payrollFormat';
import { adminFetch } from '../../lib/adminFetch';

vi.mock('../../lib/adminFetch', () => ({ adminFetch: vi.fn() }));

const reply = (body, ok = true, status = ok ? 200 : 400) => Promise.resolve({
  ok, status, json: async () => body, blob: async () => new Blob([String(body)], { type: 'text/csv' }),
});

const check = (patch = {}) => ({
  id: 'check-a', technicianId: 'tech-a', name: 'Sample Alpha', status: 'draft', hourlyRate: '22.00',
  regularHours: '40.00', overtimeHours: '2.00', payMethod: 'check', checkNumber: null,
  grossCents: 94600, federalIncomeTaxCents: 6100, socialSecurityCents: 5865, medicareCents: 1372,
  additionalMedicareCents: 0, netCents: 81263, ...patch,
});
const totals = { checkCount: 1, grossCents: 94600, employeeTaxesCents: 13337, netCents: 81263, employerTaxesCents: 10359 };
const run = (patch = {}) => ({
  id: 'run-1', weekStart: '2026-10-12', weekEnd: '2026-10-18', payDate: '2026-10-23', status: 'draft',
  checks: [check()], blocked: [], waiting: [], stale: false, token: 'token-1', totals, voidReason: null, ...patch,
});
const listItem = (patch = {}) => ({ id: 'run-1', weekStart: '2026-10-12', weekEnd: '2026-10-18', payDate: '2026-10-23', status: 'draft', totals, ...patch });
const STUB = {
  checkId: 'check-a', runId: 'run-1',
  employer: { name: 'Waves Pest Control, LLC', addressLine: '13649 Luxe Ave #110, Bradenton, FL 34211' },
  employee: { name: 'Sample Alpha', ssnLast4: '4321' },
  payPeriod: { start: '2026-10-12', end: '2026-10-18' }, payDate: '2026-10-23',
  hours: { regular: '40.00', overtime: '2.00' }, hourlyRate: '22.00',
  earnings: { regularPayCents: 88000, overtimePayCents: 6600, grossCents: 94600 },
  taxes: { federalIncomeTaxCents: 6100, socialSecurityCents: 5865, medicareCents: 1372, additionalMedicareCents: 0, totalCents: 13337 },
  netCents: 81263, payMethod: 'check', checkNumber: '1001',
  ytd: { grossCents: 189200, federalIncomeTaxCents: 12200, socialSecurityCents: 11730, medicareCents: 2744, additionalMedicareCents: 0, netCents: 162526 },
};

let calls;
let runs;
let current;
let writeReply;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-25T15:00:00Z'));
  calls = [];
  runs = [];
  current = run();
  writeReply = null;
  adminFetch.mockReset();
  adminFetch.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ path, method, body: options.body });
    if (method !== 'GET') {
      if (writeReply) return writeReply(path, method, options);
      if (path.endsWith('/check-number')) return reply({ check: check({ status: 'finalized', checkNumber: options.body.checkNumber }) });
      return reply({ run: current });
    }
    if (path === '/admin/payroll/technicians') return reply({ technicians: [] });
    if (path === '/admin/payroll/runs') return reply({ runs });
    if (path === '/admin/payroll/runs/run-1') return reply({ run: current });
    if (path === '/admin/payroll/runs/run-1/export.csv') return reply('Employee\nSample Alpha');
    if (path === '/admin/payroll/checks/check-a/stub') return reply({ stub: STUB });
    return reply({}, false, 404);
  });
  URL.createObjectURL = vi.fn(() => 'blob:csv');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const writes = () => calls.filter(c => c.method !== 'GET');
async function startRun(patch) {
  if (patch) current = run(patch);
  render(<PayrollSettings />);
  const section = await screen.findByRole('region', { name: 'Pay runs' });
  fireEvent.click(within(section).getByRole('button', { name: 'New pay run' }));
  return screen.findByLabelText(/Pay run for/);
}

describe('Pay runs section', () => {
  it('shows the plain copy, the finished weeks, and the Friday after as the default pay date', async () => {
    runs = [listItem({ status: 'finalized' }), listItem({ id: 'run-0', weekStart: '2026-10-05', payDate: '2026-10-16', status: 'voided' })];
    render(<PayrollSettings />);
    const section = await screen.findByRole('region', { name: 'Pay runs' });
    expect(within(section).getByText('The portal works out each paycheck from the approved hours. You pay the tech and make the tax payments yourself.')).toBeInTheDocument();
    const week = within(section).getByLabelText('Week');
    expect(week).toHaveValue('2026-10-12');
    expect(Array.from(week.querySelectorAll('option'))[0].textContent).toBe('Oct 12, 2026 to Oct 18, 2026');
    expect(within(section).getByLabelText('Pay date')).toHaveValue('2026-10-23');
    fireEvent.change(week, { target: { value: '2026-10-05' } });
    expect(within(section).getByLabelText('Pay date')).toHaveValue('2026-10-16');
    const list = within(section).getByRole('table', { name: 'Pay runs list' });
    expect(within(list).getByText('Final')).toBeInTheDocument();
    expect(within(list).getByText('Voided')).toBeInTheDocument();
    expect(within(list).getAllByText('$946.00')).toHaveLength(2);
  });

  it('works out the default week and pay date from the calendar, not the clock zone', () => {
    expect(lastFinishedWeekStart('2026-10-25')).toBe('2026-10-12');
    expect(lastFinishedWeekStart('2026-10-26')).toBe('2026-10-19');
    expect(defaultPayDate('2026-12-28')).toBe('2027-01-08');
    expect(weekLabel('2026-12-28')).toBe('Dec 28, 2026 to Jan 3, 2027');
  });

  it('starts a pay run for the picked week and pay date, and shows one row per tech', async () => {
    const detail = await startRun();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ path: '/admin/payroll/runs', method: 'POST', body: { weekStart: '2026-10-12', payDate: '2026-10-23' } });
    const table = within(detail).getByRole('table', { name: 'Paychecks' });
    const row = within(table.querySelector('tbody tr'));
    for (const text of ['Sample Alpha', '40.00 h', '2.00 h', '$22.00', '$946.00', '$61.00', '$58.65', '$13.72', '$812.63']) {
      expect(row.getByText(text)).toBeInTheDocument();
    }
    const totalsList = within(detail).getByLabelText('Run totals');
    expect(totalsList).toHaveTextContent('Gross pay$946.00');
    expect(totalsList).toHaveTextContent('Employer taxes (you pay these)$103.59');
    expect(within(detail).queryByRole('columnheader', { name: 'Check' })).toBeNull();
  });

  it('shows who is blocked or waiting with the reason, and keeps Finalize off', async () => {
    const detail = await startRun({
      waiting: [{ technicianId: 't2', name: 'Sample Waiting', reason: 'Timesheet for this week is not approved yet' }],
      blocked: [{ technicianId: 't3', name: 'Sample NoW4', reason: 'No Form W-4 on file' }],
    });
    const view = within(detail);
    expect(view.getByRole('list', { name: 'Waiting for approval' })).toHaveTextContent('Sample WaitingTimesheet for this week is not approved yet');
    expect(view.getByRole('list', { name: 'Blocked' })).toHaveTextContent('Sample NoW4No Form W-4 on file');
    expect(view.getByRole('button', { name: 'Finalize' })).toBeDisabled();
  });

  it('asks for confirmation in the page before it finalizes, and sends the token it showed', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockImplementation(() => true);
    const detail = await startRun();
    const view = within(detail);
    await waitFor(() => expect(writes()).toHaveLength(1));
    fireEvent.click(view.getByRole('button', { name: 'Finalize' }));
    expect(writes()).toHaveLength(1);
    const group = view.getByRole('group', { name: 'Confirm finalize' });
    expect(group).toHaveTextContent('Finalize this pay run?');
    current = run({ status: 'finalized', checks: [check({ status: 'finalized' })] });
    fireEvent.click(within(group).getByRole('button', { name: 'Yes, finalize' }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toMatchObject({ path: '/admin/payroll/runs/run-1/finalize', method: 'POST', body: { token: 'token-1' } });
    await screen.findByText('Pay run finalized.');
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('can be cancelled at the confirm step without a write', async () => {
    const detail = await startRun();
    const view = within(detail);
    fireEvent.click(view.getByRole('button', { name: 'Finalize' }));
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    expect(view.queryByRole('group', { name: 'Confirm finalize' })).toBeNull();
    expect(writes()).toHaveLength(1);
  });

  it('shows the server message and the new numbers when the hours changed', async () => {
    const detail = await startRun();
    const view = within(detail);
    writeReply = (path) => (path.endsWith('/finalize')
      ? reply({ error: 'Hours or settings changed. Review the new numbers.' }, false, 409)
      : reply({ run: current }));
    fireEvent.click(view.getByRole('button', { name: 'Finalize' }));
    current = run({ token: 'token-2', checks: [check({ regularHours: '41.00' })] });
    fireEvent.click(view.getByRole('button', { name: 'Yes, finalize' }));
    expect(await view.findByRole('alert')).toHaveTextContent('Hours or settings changed. Review the new numbers.');
    await waitFor(() => expect(view.getByText('41.00 h')).toBeInTheDocument());
    expect(view.queryByRole('group', { name: 'Confirm finalize' })).toBeNull();
  });

  it('turns Finalize off and asks for a recompute when the draft is out of date', async () => {
    const detail = await startRun({ stale: true });
    const view = within(detail);
    expect(view.getByRole('status')).toHaveTextContent('Press Recompute');
    expect(view.getByRole('button', { name: 'Finalize' })).toBeDisabled();
    fireEvent.click(view.getByRole('button', { name: 'Recompute' }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toMatchObject({ path: '/admin/payroll/runs/run-1/recompute', method: 'POST' });
  });

  // Pre-push audit P1: the tax form figures below the pay runs went stale after a finalize or a void.
  it('asks for the tax form figures again after it finalizes, and after a void, even a failed one', async () => {
    const formReads = () => calls.filter(c => c.path.startsWith('/admin/payroll/forms')).length;
    const detail = await startRun();
    const view = within(detail);
    await waitFor(() => expect(formReads()).toBe(1));
    fireEvent.click(view.getByRole('button', { name: 'Recompute' }));
    await screen.findByText('Pay run recomputed.');
    expect(formReads()).toBe(1);
    fireEvent.click(view.getByRole('button', { name: 'Finalize' }));
    current = run({ status: 'finalized', checks: [check({ status: 'finalized' })] });
    fireEvent.click(within(view.getByRole('group', { name: 'Confirm finalize' })).getByRole('button', { name: 'Yes, finalize' }));
    await screen.findByText('Pay run finalized.');
    await waitFor(() => expect(formReads()).toBe(2));
    writeReply = () => reply({ error: 'Network trouble' }, false, 502);
    fireEvent.click(view.getByRole('button', { name: 'Void' }));
    const form = view.getByRole('form', { name: 'Void pay run' });
    fireEvent.change(within(form).getByLabelText(/Why are you voiding/), { target: { value: 'Wrong hours' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Void pay run' }));
    await waitFor(() => expect(formReads()).toBe(3));
  });

  it('needs a reason before it voids, then sends it', async () => {
    const detail = await startRun();
    const view = within(detail);
    fireEvent.click(view.getByRole('button', { name: 'Void' }));
    const form = view.getByRole('form', { name: 'Void pay run' });
    const submit = within(form).getByRole('button', { name: 'Void pay run' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(form).getByLabelText(/Why are you voiding/), { target: { value: '   ' } });
    expect(submit).toBeDisabled();
    fireEvent.change(within(form).getByLabelText(/Why are you voiding/), { target: { value: ' Wrong hours ' } });
    expect(submit).toBeEnabled();
    current = run({ status: 'voided', voidReason: 'Wrong hours', checks: [check({ status: 'voided' })] });
    fireEvent.click(submit);
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toMatchObject({ path: '/admin/payroll/runs/run-1/void', method: 'POST', body: { reason: 'Wrong hours' } });
    await screen.findByText('Pay run voided.');
    await waitFor(() => expect(view.getByText('Voided: Wrong hours')).toBeInTheDocument());
    expect(view.queryByRole('button', { name: 'Void' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Export CSV' })).toBeNull();
  });
});

describe('Finalized run', () => {
  const finalRun = (patch) => run({
    status: 'finalized',
    checks: [
      check({ status: 'finalized' }),
      check({ id: 'check-b', technicianId: 'tech-b', name: 'Sample Beta', payMethod: 'bank_transfer', status: 'finalized' }),
    ],
    ...patch,
  });

  async function openFinal() {
    current = finalRun();
    runs = [listItem({ status: 'finalized' })];
    render(<PayrollSettings />);
    const section = await screen.findByRole('region', { name: 'Pay runs' });
    fireEvent.click(await within(section).findByRole('button', { name: /Open pay run for/ }));
    return screen.findByLabelText(/Pay run for/);
  }

  it('offers a check number for paper checks only, and saves it', async () => {
    const detail = await openFinal();
    const view = within(detail);
    expect(view.queryByRole('button', { name: 'Finalize' })).toBeNull();
    expect(view.getByText('Bank transfer')).toBeInTheDocument();
    expect(view.queryByLabelText('Check number for Sample Beta')).toBeNull();
    const input = view.getByLabelText('Check number for Sample Alpha');
    const save = view.getByRole('button', { name: 'Save number' });
    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: ' 1001 ' } });
    fireEvent.click(save);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ path: '/admin/payroll/checks/check-a/check-number', method: 'PUT', body: { checkNumber: ' 1001 ' } });
    await screen.findByText('Check number saved for Sample Alpha.');
  });

  it('opens a printable stub with the year-to-date column and no employer taxes', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    const detail = await openFinal();
    fireEvent.click(within(detail).getByRole('button', { name: 'Stub for Sample Alpha' }));
    const dialog = await screen.findByRole('dialog');
    const stub = await within(dialog).findByLabelText('Pay stub');
    const fieldDocument = stub.querySelector('.waves-field-document-body');
    expect(fieldDocument).toHaveClass('field-document-scroll', 'pay-stub');
    expect(within(fieldDocument).getByRole('heading', { level: 1, name: 'Pay stub' })).toBeInTheDocument();
    expect(within(fieldDocument).getByText('Controlled staff document')).toBeInTheDocument();
    expect(fieldDocument.querySelector('img')).toBeNull();
    expect(stub).toHaveTextContent('Waves Pest Control, LLC');
    expect(stub).toHaveTextContent('SSN ending 4321');
    expect(stub).toHaveTextContent('Pay period Oct 12, 2026 to Oct 18, 2026');
    const table = within(stub).getByRole('table', { name: 'Pay stub amounts' });
    expect(within(table).getByText('This pay')).toBeInTheDocument();
    expect(within(table).getByText('Year to date')).toBeInTheDocument();
    const gross = within(table).getByText('Gross pay').closest('tr');
    expect(gross).toHaveTextContent('$946.00$1,892.00');
    expect(within(table).getByText('Net pay').closest('tr')).toHaveTextContent('$812.63$1,625.26');
    expect(stub.textContent).not.toMatch(/employer tax|FUTA|reemployment/i);
    expect(stub).toHaveTextContent('Check number1001');
    const printButton = within(dialog).getByRole('button', { name: 'Print' });
    expect(fieldDocument).not.toContainElement(printButton);
    expect(printButton.closest('.waves-field-no-print')).not.toBeNull();
    fireEvent.click(printButton);
    expect(print).toHaveBeenCalledTimes(1);
    print.mockRestore();
  });

  it('downloads the CSV from the export route', async () => {
    const detail = await openFinal();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(within(detail).getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(calls.some(c => c.path === '/admin/payroll/runs/run-1/export.csv' && c.method === 'GET')).toBe(true);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });
});
