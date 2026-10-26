// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PayrollSettings from './PayrollSettings';
import { adminFetch } from '../../lib/adminFetch';

vi.mock('../../lib/adminFetch', () => ({ adminFetch: vi.fn() }));

const reply = (body, ok = true, status = ok ? 200 : 400) => Promise.resolve({ ok, status, json: async () => body });

const TECHS = [
  { id: 'tech-a', name: 'Sample Alpha', payRate: '22.00', payMethod: 'check', payMethodConsentOn: null, employmentStatus: 'active', currentW4: null, ptoHoursPerYear: 80 },
  { id: 'tech-b', name: 'Sample Beta', payRate: '25.00', payMethod: 'check', payMethodConsentOn: null, employmentStatus: 'active', currentW4: null, ptoHoursPerYear: null },
];
const entry = (patch = {}) => ({
  id: 'off-1', technicianId: 'tech-a', name: 'Sample Alpha', workDate: '2026-10-14', kind: 'pto', hours: '8.00', note: 'Vacation', ...patch,
});
const balanceFor = (id, patch = {}) => ({
  technicianId: id, year: 2026, allowanceHours: id === 'tech-a' ? 80 : null, ptoHoursBooked: id === 'tech-a' ? '20.00' : '4.00',
  ptoHoursPaid: '0.00', holidayDaysBooked: 0, ...patch,
});
const check = (patch = {}) => ({
  id: 'check-a', technicianId: 'tech-a', name: 'Sample Alpha', status: 'finalized', hourlyRate: '22.00', regularHours: '30.00',
  overtimeHours: '0.00', ptoHours: '0.00', holidayHours: '10.00', ptoPayCents: 0, holidayPayCents: 22000, ptoMinutes: 0, holidayMinutes: 600,
  payMethod: 'check', checkNumber: '1001', grossCents: 88000, federalIncomeTaxCents: 6100, socialSecurityCents: 5456,
  medicareCents: 1276, additionalMedicareCents: 0, netCents: 75168, ...patch,
});
const totals = { checkCount: 1, grossCents: 88000, employeeTaxesCents: 12832, netCents: 75168, employerTaxesCents: 7000 };
const RUN = {
  id: 'run-1', weekStart: '2026-10-12', weekEnd: '2026-10-18', payDate: '2026-10-23', status: 'finalized',
  checks: [check()], blocked: [], waiting: [], stale: false, token: 't1', totals, voidReason: null,
};
const STUB = {
  checkId: 'check-a', runId: 'run-1',
  employer: { name: 'Waves Pest Control, LLC', addressLine: '1 Sample Way' },
  employee: { name: 'Sample Alpha', ssnLast4: null },
  payPeriod: { start: '2026-10-12', end: '2026-10-18' }, payDate: '2026-10-23',
  hours: { regular: '30.00', overtime: '0.00', pto: '4.00', holiday: '10.00' }, hourlyRate: '22.00',
  earnings: { regularPayCents: 66000, overtimePayCents: 0, ptoPayCents: 8800, holidayPayCents: 22000, grossCents: 96800 },
  taxes: { federalIncomeTaxCents: 6100, socialSecurityCents: 5456, medicareCents: 1276, additionalMedicareCents: 0, totalCents: 12832 },
  netCents: 83968, payMethod: 'check', checkNumber: '1001',
  ytd: { grossCents: 96800, federalIncomeTaxCents: 6100, socialSecurityCents: 5456, medicareCents: 1276, additionalMedicareCents: 0, netCents: 83968 },
};

let calls;
let gateOn;
let entries;
let writeReply;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-25T15:00:00Z'));
  calls = [];
  gateOn = true;
  entries = [entry(), entry({ id: 'off-2', technicianId: 'tech-b', name: 'Sample Beta', workDate: '2026-11-26', kind: 'holiday', hours: '8.00', note: null })];
  writeReply = null;
  adminFetch.mockReset();
  adminFetch.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ path, method, body: options.body });
    if (method !== 'GET' && writeReply) return writeReply(path, method, options);
    if (path.startsWith('/admin/payroll/time-off') && !gateOn) return reply({ enabled: false }, false, 404);
    if (path === '/admin/payroll/technicians') {
      return reply({ technicians: gateOn ? TECHS : TECHS.map(({ ptoHoursPerYear, ...rest }) => rest) });
    }
    if (path === '/admin/payroll/runs') return reply({ runs: [] });
    if (path === '/admin/payroll/runs/run-1') return reply({ run: RUN });
    if (path.startsWith('/admin/payroll/time-off/balance')) {
      const id = new URL(`http://x${path}`).searchParams.get('technicianId');
      return reply({ balance: balanceFor(id) });
    }
    if (path.startsWith('/admin/payroll/time-off?')) return reply({ entries });
    if (path === '/admin/payroll/time-off' && method === 'POST') return reply({ entry: entry({ id: 'off-9' }), warning: null }, true, 201);
    if (path.startsWith('/admin/payroll/time-off/') && method === 'PUT') return reply({ entry: entry(), warning: null });
    if (path.startsWith('/admin/payroll/time-off/') && method === 'DELETE') return reply({ deleted: true });
    if (path === '/admin/payroll/technicians/tech-a/pto-allowance') return reply({ technician: { id: 'tech-a', ptoHoursPerYear: 96 } });
    if (path === '/admin/payroll/checks/check-a/stub') return reply({ stub: STUB });
    return reply({}, false, 404);
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const writes = () => calls.filter(c => c.method !== 'GET');
const panel = () => screen.findByRole('region', { name: 'Time off' });

describe('Time off panel (GATE_PAYROLL_TIME_OFF on)', () => {
  it('lists the week and upcoming days with the year line per employee', async () => {
    render(<PayrollSettings />);
    const view = within(await panel());
    const week = view.getByRole('table', { name: 'Time off this week' });
    expect(within(week).getByText('Sample Alpha')).toBeInTheDocument();
    expect(within(week).getByText('Paid time off')).toBeInTheDocument();
    expect(within(week).getByText('Vacation')).toBeInTheDocument();
    expect(within(week).getByText('Oct 14, 2026')).toBeInTheDocument();
    const upcoming = view.getByRole('table', { name: 'Upcoming time off' });
    expect(within(upcoming).getByText('Holiday')).toBeInTheDocument();
    const lines = view.getByRole('list', { name: 'Paid time off in 2026' });
    expect(lines).toHaveTextContent('Sample Alpha: Paid time off booked in 2026: 20 of 80 hours');
    expect(lines).toHaveTextContent('Sample Beta: Paid time off booked in 2026: 4 hours');
    expect(lines).not.toHaveTextContent('Over the yearly allowance');
    const listCall = calls.find(c => c.path.startsWith('/admin/payroll/time-off?'));
    expect(listCall.path).toBe('/admin/payroll/time-off?from=2026-10-12&to=2027-02-22');
  });

  it('says so when a person is over the yearly allowance', async () => {
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options) => (path.includes('balance?technicianId=tech-a')
      ? reply({ balance: balanceFor('tech-a', { ptoHoursBooked: '84.50' }) })
      : original(path, options)));
    render(<PayrollSettings />);
    const lines = within(await panel()).getByRole('list', { name: 'Paid time off in 2026' });
    await waitFor(() => expect(lines).toHaveTextContent('84.5 of 80 hours'));
    expect(lines).toHaveTextContent('Over the yearly allowance by 4.5 hours.');
  });

  it('adds a day and sends the typed values, then shows the allowance warning from the server', async () => {
    writeReply = () => reply({ entry: entry({ id: 'off-9' }), warning: 'Sample Alpha now has 84.00 hours of paid time off booked in 2026. The yearly allowance is 80 hours. The day is saved.' }, true, 201);
    render(<PayrollSettings />);
    const view = within(await panel());
    const form = view.getByRole('form', { name: 'Add time off' });
    expect(within(form).getByRole('button', { name: 'Add time off' })).toBeDisabled();
    fireEvent.change(within(form).getByLabelText(/Employee/), { target: { value: 'tech-a' } });
    fireEvent.change(within(form).getByLabelText(/Date/), { target: { value: '2026-10-15' } });
    fireEvent.change(within(form).getByLabelText(/Kind/), { target: { value: 'holiday' } });
    fireEvent.change(within(form).getByLabelText(/Hours/), { target: { value: ' 7.5 ' } });
    fireEvent.change(within(form).getByLabelText('Note'), { target: { value: ' Day off ' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add time off' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      path: '/admin/payroll/time-off', method: 'POST',
      body: { technicianId: 'tech-a', workDate: '2026-10-15', kind: 'holiday', hours: '7.5', note: 'Day off' },
    });
    expect(await screen.findByText('Time off saved.')).toBeInTheDocument();
    expect(screen.getByText(/The yearly allowance is 80 hours\. The day is saved\./)).toBeInTheDocument();
  });

  it('edits a day: employee and date are locked, kind, hours and note are sent', async () => {
    render(<PayrollSettings />);
    const view = within(await panel());
    fireEvent.click(view.getByRole('button', { name: 'Edit time off for Sample Alpha on Oct 14, 2026' }));
    const form = view.getByRole('form', { name: 'Change time off' });
    expect(within(form).getByLabelText(/Employee/)).toBeDisabled();
    expect(within(form).getByLabelText(/Date/)).toBeDisabled();
    expect(within(form).getByLabelText(/Hours/)).toHaveValue('8');
    fireEvent.change(within(form).getByLabelText(/Hours/), { target: { value: '4' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ path: '/admin/payroll/time-off/off-1', method: 'PUT', body: { kind: 'pto', hours: '4', note: 'Vacation' } });
    expect(await screen.findByText('Time off changed.')).toBeInTheDocument();
  });

  it('removes a day', async () => {
    render(<PayrollSettings />);
    const view = within(await panel());
    fireEvent.click(view.getByRole('button', { name: 'Remove time off for Sample Alpha on Oct 14, 2026' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ path: '/admin/payroll/time-off/off-1', method: 'DELETE' });
    expect(await screen.findByText('Time off removed.')).toBeInTheDocument();
  });

  it('shows the lock message from the server in plain words', async () => {
    writeReply = () => reply({ error: 'This week is already paid. Void the pay run first.' }, false, 409);
    render(<PayrollSettings />);
    const view = within(await panel());
    fireEvent.click(view.getByRole('button', { name: 'Remove time off for Sample Alpha on Oct 14, 2026' }));
    expect(await view.findByRole('alert')).toHaveTextContent('This week is already paid. Void the pay run first.');
  });
});

describe('Time off in the pay run table and stub', () => {
  const runs = [{ id: 'run-1', weekStart: '2026-10-12', weekEnd: '2026-10-18', payDate: '2026-10-23', status: 'finalized', totals }];
  beforeEach(() => {
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options) => (path === '/admin/payroll/runs' ? reply({ runs }) : original(path, options)));
  });

  it('adds columns for time off and holiday only when a check has them, and lines on the stub', async () => {
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open pay run for Oct 12, 2026 to Oct 18, 2026' }));
    const detail = await screen.findByLabelText(/Pay run for/);
    const table = within(detail).getByRole('table', { name: 'Paychecks' });
    expect(within(table).getByRole('columnheader', { name: 'Holiday' })).toBeInTheDocument();
    expect(within(table).queryByRole('columnheader', { name: 'Paid time off' })).toBeNull();
    expect(within(table).getByText('10.00 h · $220.00')).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole('button', { name: 'Stub for Sample Alpha' }));
    const stub = await screen.findByLabelText('Pay stub');
    expect(within(stub).getByText('Paid time off (4.00 h at $22.00/h)')).toBeInTheDocument();
    expect(within(stub).getByText('Holiday pay (10.00 h at $22.00/h)')).toBeInTheDocument();
    expect(within(stub).getByText('$220.00')).toBeInTheDocument();
    expect(within(stub).getByText('$88.00')).toBeInTheDocument();
  });

  it('reloads the open pay run after a time-off change, so a stale draft shows', async () => {
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open pay run for Oct 12, 2026 to Oct 18, 2026' }));
    await screen.findByLabelText(/Pay run for/);
    const before = calls.filter(c => c.path === '/admin/payroll/runs/run-1').length;
    const view = within(await panel());
    fireEvent.click(view.getByRole('button', { name: 'Remove time off for Sample Alpha on Oct 14, 2026' }));
    await waitFor(() => expect(calls.filter(c => c.path === '/admin/payroll/runs/run-1').length).toBe(before + 1));
  });
});

describe('Paid time off hours per year (settings)', () => {
  it('shows the allowance per employee and saves a typed value; empty clears it', async () => {
    render(<PayrollSettings />);
    await screen.findByRole('columnheader', { name: 'Paid time off hours per year' });
    const alpha = screen.getByLabelText('Paid time off hours per year for Sample Alpha');
    const beta = screen.getByLabelText('Paid time off hours per year for Sample Beta');
    expect(alpha).toHaveValue('80');
    expect(beta).toHaveValue('');
    const saveFor = input => within(input.closest('form')).getByRole('button', { name: 'Save' });
    expect(saveFor(alpha)).toBeDisabled();
    fireEvent.change(alpha, { target: { value: '96' } });
    fireEvent.click(saveFor(alpha));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ path: '/admin/payroll/technicians/tech-a/pto-allowance', method: 'PUT', body: { hoursPerYear: '96' } });
    expect(await screen.findByText('Paid time off allowance saved for Sample Alpha.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Paid time off hours per year for Sample Alpha'), { target: { value: '' } });
    fireEvent.click(saveFor(screen.getByLabelText('Paid time off hours per year for Sample Alpha')));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1].body).toEqual({ hoursPerYear: null });
  });

  it('shows the server message when the allowance is refused', async () => {
    writeReply = () => reply({ error: 'Hours per year must be 400 or fewer' }, false, 400);
    render(<PayrollSettings />);
    const input = await screen.findByLabelText('Paid time off hours per year for Sample Beta');
    fireEvent.change(input, { target: { value: '500' } });
    fireEvent.click(within(input.closest('form')).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Hours per year must be 400 or fewer')).toBeInTheDocument();
  });
});

describe('gate off', () => {
  beforeEach(() => { gateOn = false; });

  it('renders no time off panel, no allowance column and no allowance field', async () => {
    render(<PayrollSettings />);
    await screen.findByText('Sample Alpha');
    await waitFor(() => expect(calls.some(c => c.path.startsWith('/admin/payroll/time-off'))).toBe(true));
    expect(screen.queryByRole('region', { name: 'Time off' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Paid time off hours per year' })).toBeNull();
    expect(screen.queryByLabelText(/Paid time off hours per year/)).toBeNull();
    expect(screen.queryByText(/Time off/)).toBeNull();
    expect(writes()).toHaveLength(0);
  });
});
