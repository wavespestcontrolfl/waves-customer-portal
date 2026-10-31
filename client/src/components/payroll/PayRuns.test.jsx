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
      blocked: [{ technicianId: 't3', name: 'Sample NoRate', reason: 'No pay rate set' }],
    });
    const view = within(detail);
    expect(view.getByRole('list', { name: 'Waiting for approval' })).toHaveTextContent('Sample WaitingTimesheet for this week is not approved yet');
    expect(view.getByRole('list', { name: 'Blocked' })).toHaveTextContent('Sample NoRateNo pay rate set');
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

  it('shows each final check its bank status only when the server sends one', async () => {
    let detail = await openFinal();
    expect(within(detail).queryByRole('columnheader', { name: 'Bank' })).toBeNull();
    cleanup();
    current = finalRun({
      checks: [
        check({ status: 'finalized', bank: { state: 'matched', date: '2026-10-28' } }),
        check({ id: 'check-b', technicianId: 'tech-b', name: 'Sample Beta', payMethod: 'bank_transfer', status: 'finalized', bank: { state: 'needs_pick' } }),
        check({ id: 'check-c', technicianId: 'tech-c', name: 'Sample Gamma', status: 'finalized', bank: { state: 'not_seen' } }),
      ],
    });
    render(<PayrollSettings />);
    const section = await screen.findByRole('region', { name: 'Pay runs' });
    fireEvent.click(await within(section).findByRole('button', { name: /Open pay run for/ }));
    detail = await screen.findByLabelText(/Pay run for/);
    const view = within(detail);
    expect(view.getByRole('columnheader', { name: 'Bank' })).toBeInTheDocument();
    expect(view.getByText('Bank: matched Oct 28, 2026')).toBeInTheDocument();
    expect(view.getByText('Bank: needs your pick (Tax page, Bank Import)')).toBeInTheDocument();
    expect(view.getByText('Bank: not seen yet')).toBeInTheDocument();
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

  it('says so on a check drafted with no W-4 on file (the IRS default)', async () => {
    const detail = await startRun({ checks: [check({ w4Default: true }), check({ id: 'check-b', name: 'Sample Beta' })] });
    const rows = within(detail).getByRole('table', { name: 'Paychecks' }).querySelectorAll('tbody tr');
    expect(rows[0]).toHaveTextContent('No W-4 on file: withheld as single, no adjustments (IRS default)');
    expect(rows[1]).not.toHaveTextContent('No W-4 on file');
  });

  it('says so on the stub only when the check had no W-4 election', async () => {
    const detail = await openFinal();
    fireEvent.click(within(detail).getByRole('button', { name: 'Stub for Sample Alpha' }));
    expect(await within(await screen.findByRole('dialog')).findByLabelText('Pay stub')).not.toHaveTextContent('No W-4 on file');
  });

  it('shows the no-W-4 note on the stub when the stub says so', async () => {
    STUB.w4Default = true;
    try {
      const detail = await openFinal();
      fireEvent.click(within(detail).getByRole('button', { name: 'Stub for Sample Alpha' }));
      const stub = await within(await screen.findByRole('dialog')).findByLabelText('Pay stub');
      expect(stub).toHaveTextContent('No W-4 on file: withheld as single, no adjustments (IRS default)');
    } finally {
      delete STUB.w4Default;
    }
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

describe('Mercury paychecks', () => {
  const pay = (patch = {}) => ({ state: 'none', canPaper: true, canSendAgain: null, ...patch });
  const info = (patch = {}) => ({ payEnabled: true, configured: true, eligibleCount: 1, missingRecipient: [], canSend: true, ...patch });
  const mercuryRun = (checks, mercury) => run({
    status: 'finalized',
    checks: checks.map(([id, name, patch]) => check({ id, technicianId: `tech-${id}`, name, payMethod: 'bank_transfer', status: 'finalized', ...patch })),
    ...(mercury ? { mercury } : {}),
  });
  const PREVIEW = {
    eligible: [{ checkId: 'check-a', name: 'Sample Alpha', netCents: 81263 }], skipped: [],
    funding: { short: true, text: 'Mercury shows $10.00 available. This run needs $812.63: $812.63 in all.' },
    key: { stale: true, text: 'First payment: check the Mercury key still allows payment requests.' },
    approveBy: { text: 'Approve in Mercury by Wed, Oct 21 at 5 PM ET so the pay lands on Fri, Oct 23.' },
  };

  async function openFinal(checks, mercury = info()) {
    current = mercuryRun(checks, mercury);
    runs = [listItem({ status: 'finalized' })];
    render(<PayrollSettings />);
    const section = await screen.findByRole('region', { name: 'Pay runs' });
    fireEvent.click(await within(section).findByRole('button', { name: /Open pay run for/ }));
    return within(await screen.findByLabelText(/Pay run for/));
  }

  it('shows nothing about Mercury when the server sends no payment (gates off)', async () => {
    const view = await openFinal([['check-a', 'Sample Alpha', {}]], null);
    expect(view.queryByRole('columnheader', { name: 'Mercury' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Send to Mercury' })).toBeNull();
  });

  it.each([
    [{ state: 'requested' }, 'Waiting for your approval in Mercury'],
    [{ state: 'approved' }, 'Approved'],
    [{ state: 'sent', postedOn: '2026-10-23' }, 'Sent Oct 23, 2026'],
    [{ state: 'failed', error: 'Mercury refused the request (HTTP 400)' }, 'Failed'],
    [{ state: 'rejected' }, 'Rejected'],
    [{ state: 'cancelled' }, 'Cancelled'],
    [{ state: 'returned' }, 'Returned'],
    [{ state: 'unknown' }, 'Outcome unknown'],
    [{ state: 'paper', checkNumber: '1001' }, 'Paid by check #1001'],
    [{ state: 'none' }, 'Not sent'],
  ])('shows the chip for %j', async (payment, words) => {
    const view = await openFinal([['check-a', 'Sample Alpha', { payment: pay(payment) }]], info({ canSend: false }));
    expect(view.getByRole('columnheader', { name: 'Mercury' })).toBeInTheDocument();
    expect(view.getByText(words)).toBeInTheDocument();
    if (payment.error) expect(view.getByText(payment.error)).toBeInTheDocument();
  });

  it('Send to Mercury shows the three warnings first, sends nothing until confirmed, then reports each check', async () => {
    writeReply = (path) => reply({ results: [{ checkId: 'check-a', name: 'Sample Alpha', outcome: 'requested' }, { checkId: 'check-b', name: 'Sample Beta', outcome: 'skipped', reason: 'no_recipient' }], run: current });
    const base = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options) => (path === '/admin/payroll/runs/run-1/send-preview' ? (calls.push({ path, method: 'GET' }), reply({ preview: PREVIEW })) : base(path, options)));
    const view = await openFinal([['check-a', 'Sample Alpha', { payment: pay() }]]);
    fireEvent.click(view.getByRole('button', { name: 'Send to Mercury' }));
    const confirm = within(await screen.findByRole('group', { name: 'Confirm send to Mercury' }));
    expect(confirm.getByText(/Nothing is paid until you approve each one in the Mercury app/)).toBeInTheDocument();
    expect(confirm.getByText(PREVIEW.funding.text)).toBeInTheDocument();
    expect(confirm.getByText(PREVIEW.key.text)).toBeInTheDocument();
    expect(confirm.getByText(PREVIEW.approveBy.text)).toBeInTheDocument();
    expect(writes()).toHaveLength(0);
    fireEvent.click(confirm.getByRole('button', { name: 'Yes, send to Mercury' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ path: '/admin/payroll/runs/run-1/send', method: 'POST' });
    await screen.findByText('Asked Mercury for 1 payment. Approve them in the Mercury app.');
    const results = within(await screen.findByRole('list', { name: 'Send results' }));
    expect(results.getByText(/Sample Beta: no Mercury recipient id/)).toBeInTheDocument();
  });

  it.each([
    [['unknown'], 'We cannot tell if Mercury got 1 request. Look in Mercury before you send again.'],
    [['requested', 'unknown', 'unknown'], 'Asked Mercury for 1 payment. Approve them in the Mercury app. We cannot tell if Mercury got 2 requests. Look in Mercury before you send again.'],
    [['failed'], 'Mercury did not take 1 request. Look at the payments below.'],
    [['skipped'], 'Nothing was sent to Mercury.'],
  ])('after Send, %j: never "nothing was sent" when a request may have reached Mercury', async (outcomes, message) => {
    writeReply = () => reply({ results: outcomes.map((outcome, i) => ({ checkId: `check-${i}`, name: `Sample ${i}`, outcome, ...(outcome === 'skipped' ? { reason: 'no_recipient' } : {}) })), run: current });
    const base = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options) => (path.endsWith('/send-preview') ? reply({ preview: PREVIEW }) : base(path, options)));
    const view = await openFinal([['check-a', 'Sample Alpha', { payment: pay() }]]);
    fireEvent.click(view.getByRole('button', { name: 'Send to Mercury' }));
    fireEvent.click(within(await screen.findByRole('group', { name: 'Confirm send to Mercury' })).getByRole('button', { name: 'Yes, send to Mercury' }));
    await screen.findByText(message);
  });

  it('can be cancelled at the confirm step without a write, and names who has no recipient id', async () => {
    const base = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options) => (path.endsWith('/send-preview') ? reply({ preview: PREVIEW }) : base(path, options)));
    const view = await openFinal([['check-a', 'Sample Alpha', { payment: pay() }]], info({ missingRecipient: ['Sample Beta'] }));
    expect(view.getByText(/No Mercury recipient id yet for Sample Beta/)).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Send to Mercury' }));
    fireEvent.click(within(await screen.findByRole('group', { name: 'Confirm send to Mercury' })).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Confirm send to Mercury' })).toBeNull();
    expect(writes()).toHaveLength(0);
  });

  it('has no Send button when the pay gate is off, or nothing can be sent', async () => {
    let view = await openFinal([['check-a', 'Sample Alpha', { payment: pay() }]], info({ payEnabled: false }));
    expect(view.queryByRole('button', { name: 'Send to Mercury' })).toBeNull();
    cleanup();
    view = await openFinal([['check-a', 'Sample Alpha', { payment: pay({ state: 'requested', canPaper: false }) }]], info({ canSend: false, eligibleCount: 0 }));
    expect(view.queryByRole('button', { name: 'Send to Mercury' })).toBeNull();
  });

  it('Send again after a failure asks first, then posts', async () => {
    const view = await openFinal([['check-a', 'Sample Alpha', { payment: pay({ state: 'failed', canSendAgain: 'yes' }) }]], info({ canSend: false }));
    fireEvent.click(view.getByRole('button', { name: 'Send again for Sample Alpha' }));
    expect(writes()).toHaveLength(0);
    fireEvent.click(within(screen.getByRole('group', { name: 'Confirm send again for Sample Alpha' })).getByRole('button', { name: 'Yes, send again' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ path: '/admin/payroll/checks/check-a/send-again', method: 'POST', body: {} });
  });

  it('Send again after an unknown outcome needs the "Nothing is waiting in Mercury" box', async () => {
    const view = await openFinal([['check-a', 'Sample Alpha', { payment: pay({ state: 'unknown', canSendAgain: 'confirm' }) }]], info({ canSend: false }));
    expect(view.getByText(/Look in Mercury for a request of this amount before you send again/)).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Send again for Sample Alpha' }));
    const group = within(screen.getByRole('group', { name: 'Confirm send again for Sample Alpha' }));
    const go = group.getByRole('button', { name: 'Yes, send again' });
    expect(go).toBeDisabled();
    fireEvent.click(group.getByLabelText('Nothing is waiting in Mercury'));
    expect(go).toBeEnabled();
    fireEvent.click(go);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ path: '/admin/payroll/checks/check-a/send-again', body: { confirmNothingWaiting: true } });
  });

  it('records a paper check instead, and offers neither action while a payment is open', async () => {
    let view = await openFinal([['check-a', 'Sample Alpha', { payment: pay({ state: 'requested', canPaper: false }) }]], info({ canSend: false }));
    expect(view.queryByRole('button', { name: /Paid by paper check instead/ })).toBeNull();
    expect(view.queryByRole('button', { name: /Send again/ })).toBeNull();
    cleanup();
    view = await openFinal([['check-a', 'Sample Alpha', { payment: pay({ state: 'failed', canSendAgain: 'yes' }) }]], info({ canSend: false }));
    fireEvent.click(view.getByRole('button', { name: 'Paid by paper check instead for Sample Alpha' }));
    const form = within(screen.getByRole('form', { name: 'Paper check for Sample Alpha' }));
    const save = form.getByRole('button', { name: 'Save paper check' });
    expect(save).toBeDisabled();
    fireEvent.change(form.getByLabelText('Paper check number for Sample Alpha'), { target: { value: '2001' } });
    fireEvent.click(save);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ path: '/admin/payroll/checks/check-a/paper', method: 'POST', body: { checkNumber: '2001' } });
    await screen.findByText('Recorded a paper check for Sample Alpha.');
  });

  it('Send again says so when Mercury did not take the new request', async () => {
    writeReply = () => reply({ result: { outcome: 'failed' }, run: current });
    const view = await openFinal([['check-a', 'Sample Alpha', { payment: pay({ state: 'failed', canSendAgain: 'yes' }) }]], info({ canSend: false }));
    fireEvent.click(view.getByRole('button', { name: 'Send again for Sample Alpha' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Confirm send again for Sample Alpha' })).getByRole('button', { name: 'Yes, send again' }));
    await screen.findByText('Mercury did not take the new request for Sample Alpha. Look at the payment below.');
    expect(screen.queryByText(/Approve it in the Mercury app/)).toBeNull();
  });

  it('an unknown outcome can be linked to the Mercury request by its id', async () => {
    const view = await openFinal([['check-a', 'Sample Alpha', { payment: pay({ id: 'pay-1', state: 'unknown', canSendAgain: 'confirm' }) }]], info({ canSend: false }));
    fireEvent.click(view.getByRole('button', { name: 'Link the Mercury request for Sample Alpha' }));
    const form = within(screen.getByRole('form', { name: 'Link request for Sample Alpha' }));
    const save = form.getByRole('button', { name: 'Link request' });
    expect(save).toBeDisabled();
    fireEvent.change(form.getByLabelText('Mercury request id for Sample Alpha'), { target: { value: 'req-123' } });
    fireEvent.click(save);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ path: '/admin/payroll/payments/pay-1/link-request', method: 'POST', body: { requestId: 'req-123' } });
    await screen.findByText('Linked the Mercury request for Sample Alpha.');
  });

  it('offers the link only for an unknown outcome', async () => {
    const view = await openFinal([['check-a', 'Sample Alpha', { payment: pay({ id: 'pay-1', state: 'failed', canSendAgain: 'yes' }) }]], info({ canSend: false }));
    expect(view.queryByRole('button', { name: /Link the Mercury request/ })).toBeNull();
  });

  it('shows the server message when an action is refused', async () => {
    writeReply = () => reply({ error: 'Confirm that nothing is waiting in Mercury first.' }, false, 409);
    const view = await openFinal([['check-a', 'Sample Alpha', { payment: pay({ state: 'failed', canSendAgain: 'yes' }) }]], info({ canSend: false }));
    fireEvent.click(view.getByRole('button', { name: 'Send again for Sample Alpha' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Confirm send again for Sample Alpha' })).getByRole('button', { name: 'Yes, send again' }));
    await screen.findByText('Confirm that nothing is waiting in Mercury first.');
  });
});
