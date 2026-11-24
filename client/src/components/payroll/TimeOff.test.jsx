// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
// Sample Alpha has yearly hours set, so the server sends a time-off bank; Sample Beta has none.
const BANK = { balanceHours: '12.50', waitingHours: '8.00', fullWeekHours: '1.54', capHours: 120, usableFrom: '2026-04-05' };
const balanceFor = (id, patch = {}) => ({
  technicianId: id, year: 2026, allowanceHours: id === 'tech-a' ? 80 : null, ptoHoursBooked: id === 'tech-a' ? '20.00' : '4.00',
  ptoHoursPaid: '0.00', holidayDaysBooked: 0, ...(id === 'tech-a' ? { bank: BANK } : {}), ...patch,
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

// The employee list: the settings table reads it plain, the Time off panel with the employees who have left.
const TECH_LIST = ['/admin/payroll/technicians', '/admin/payroll/technicians?formerBank=1'];

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
    if (TECH_LIST.includes(path)) {
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
  it('lists the week and upcoming days, with the bank of an employee who has one and the year line of one who has not', async () => {
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
    expect(lines).toHaveTextContent('Sample Alpha: Time-off bank: 12.5 hours. Waiting for a pay run: 8 hours. Earns 1.54 hours for a full week, up to 120 hours');
    expect(lines).toHaveTextContent('Sample Beta: Paid time off booked in 2026: 4 hours');
    expect(lines).not.toHaveTextContent('does not hold all the waiting hours');
    expect(lines).not.toHaveTextContent('illness days only');
    const listCall = calls.find(c => c.path.startsWith('/admin/payroll/time-off?'));
    expect(listCall.path).toBe('/admin/payroll/time-off?from=2026-10-12&to=2027-02-22');
  });

  it('says so when the bank does not hold the waiting hours, and names the first 90 days and a missing hire date', async () => {
    const original = adminFetch.getMockImplementation();
    let bank = { ...BANK, balanceHours: '2.00', waitingHours: '10.00', usableFrom: '2026-12-01' };
    adminFetch.mockImplementation((path, options) => (path.includes('balance?technicianId=tech-a')
      ? reply({ balance: balanceFor('tech-a', { bank }) })
      : original(path, options)));
    const first = render(<PayrollSettings />);
    const lines = within(await panel()).getByRole('list', { name: 'Paid time off in 2026' });
    await waitFor(() => expect(lines).toHaveTextContent('Time-off bank: 2 hours. Waiting for a pay run: 10 hours'));
    expect(lines).toHaveTextContent('Until Dec 1, 2026 the bank pays illness days only');
    expect(lines).toHaveTextContent('The bank does not hold all the waiting hours today. A pay run pays only the hours the bank holds then.');
    first.unmount();
    bank = { ...BANK, waitingHours: '0.00', usableFrom: null };
    render(<PayrollSettings />);
    const again = within(await panel()).getByRole('list', { name: 'Paid time off in 2026' });
    await waitFor(() => expect(again).toHaveTextContent('Time-off bank: 12.5 hours. Earns 1.54 hours for a full week, up to 120 hours. No hire date on file'));
    expect(again).not.toHaveTextContent('Waiting for a pay run');
  });

  it('adds a day and sends the typed values, then shows the bank warning from the server', async () => {
    writeReply = () => reply({ entry: entry({ id: 'off-9' }), warning: 'Sample Alpha has 1.54 hours in the time-off bank today and 9.50 hours of paid time off waiting for a pay run. A pay run pays only the hours the bank holds then. The day is saved.' }, true, 201);
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
      body: { technicianId: 'tech-a', workDate: '2026-10-15', kind: 'holiday', hours: '7.5', note: 'Day off', illness: false },
    });
    expect(await screen.findByText('Time off saved.')).toBeInTheDocument();
    expect(screen.getByText(/A pay run pays only the hours the bank holds then\. The day is saved\./)).toBeInTheDocument();
  });

  it('marks a paid-time-off day as illness with a checkbox that a holiday does not have', async () => {
    entries = [entry({ illness: true })];
    render(<PayrollSettings />);
    const view = within(await panel());
    expect(within(view.getByRole('table', { name: 'Time off this week' })).getByText('Paid time off (illness)')).toBeInTheDocument();
    const form = view.getByRole('form', { name: 'Add time off' });
    fireEvent.change(within(form).getByLabelText(/Employee/), { target: { value: 'tech-a' } });
    fireEvent.change(within(form).getByLabelText(/Date/), { target: { value: '2026-10-15' } });
    fireEvent.change(within(form).getByLabelText(/Hours/), { target: { value: '10' } });
    fireEvent.click(within(form).getByLabelText('Illness'));
    // A holiday has no illness mark: the checkbox goes, and a mark set before is not sent.
    fireEvent.change(within(form).getByLabelText(/Kind/), { target: { value: 'holiday' } });
    expect(within(form).queryByLabelText('Illness')).toBeNull();
    fireEvent.change(within(form).getByLabelText(/Kind/), { target: { value: 'pto' } });
    expect(within(form).getByLabelText('Illness')).toBeChecked();
    fireEvent.click(within(form).getByRole('button', { name: 'Add time off' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toMatchObject({ kind: 'pto', hours: '10', illness: true });
    // Editing a day loads its mark.
    fireEvent.click(view.getByRole('button', { name: 'Edit time off for Sample Alpha on Oct 14, 2026' }));
    expect(within(view.getByRole('form', { name: 'Change time off' })).getByLabelText('Illness')).toBeChecked();
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

  // The server keeps the payout instruction of Sample Alpha; `payout` is what the balance answers with.
  const withPayout = (state) => {
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options = {}) => {
      if (path.includes('balance?technicianId=tech-a')) return reply({ balance: balanceFor('tech-a', { bank: { ...BANK, payout: state.payout } }) });
      if (path === '/admin/payroll/technicians/tech-a/pto-payout-week') {
        calls.push({ path, method: options.method, body: options.body });
        state.payout = options.body.weekStart ? { weekStart: options.body.weekStart, final: false } : null;
        return reply({ technician: { id: 'tech-a', ptoPayoutWeekStart: options.body.weekStart } });
      }
      return original(path, options);
    });
  };

  it('sets a bank payout for the week on screen, says what happens, and takes it back', async () => {
    withPayout({ payout: null });
    render(<PayrollSettings />);
    const view = within(await panel());
    const lines = view.getByRole('list', { name: 'Paid time off in 2026' });
    fireEvent.click(await within(lines).findByRole('button', { name: 'Pay out the bank of Sample Alpha in the week of Oct 12, 2026' }));
    // Only an employee with a bank has the button.
    expect(within(lines).queryByRole('button', { name: /Sample Beta/ })).toBeNull();
    expect(await view.findByText('The pay run for the week of Oct 12, 2026 pays out the time-off bank of Sample Alpha. Nothing is paid until that pay run is final.')).toBeInTheDocument();
    // The page sends the payout the line showed (none here), so a stale page changes nothing.
    expect(writes()).toEqual([{ path: '/admin/payroll/technicians/tech-a/pto-payout-week', method: 'PUT', body: { weekStart: '2026-10-12', shownWeekStart: null, shownState: 'none' } }]);
    // The banks are read again: the line names the week, and the button now takes the payout back.
    await waitFor(() => expect(lines).toHaveTextContent('Bank payout: on the pay run for the week of Oct 12, 2026.'));
    expect(within(lines).queryByRole('button', { name: /Pay out the bank of/ })).toBeNull();
    fireEvent.click(within(lines).getByRole('button', { name: 'Do not pay out the bank of Sample Alpha' }));
    expect(await view.findByText('The time-off bank of Sample Alpha is not paid out.')).toBeInTheDocument();
    expect(writes()[1]).toEqual({ path: '/admin/payroll/technicians/tech-a/pto-payout-week', method: 'PUT', body: { weekStart: null, shownWeekStart: '2026-10-12', shownState: 'set' } });
    expect(await within(lines).findByRole('button', { name: 'Pay out the bank of Sample Alpha in the week of Oct 12, 2026' })).toBeInTheDocument();
    expect(lines).not.toHaveTextContent('Bank payout:');
  });

  it('shows a payout set for another week with the button that takes it back, and no second payout button', async () => {
    withPayout({ payout: { weekStart: '2026-10-05', final: false } });
    render(<PayrollSettings />);
    const lines = within(await panel()).getByRole('list', { name: 'Paid time off in 2026' });
    await waitFor(() => expect(lines).toHaveTextContent('Bank payout: on the pay run for the week of Oct 5, 2026.'));
    expect(within(lines).getByRole('button', { name: 'Do not pay out the bank of Sample Alpha' })).toBeInTheDocument();
    expect(within(lines).queryByRole('button', { name: /Pay out the bank of/ })).toBeNull();
  });

  it('offers no change of a payout whose pay run is final in its own week, and a new payout in another week', async () => {
    const state = { payout: { weekStart: '2026-10-12', final: true, hours: '3.08' } };
    withPayout(state);
    const first = render(<PayrollSettings />);
    const lines = within(await panel()).getByRole('list', { name: 'Paid time off in 2026' });
    await waitFor(() => expect(lines).toHaveTextContent('Bank payout: 3.08 h on the pay run for the week of Oct 12, 2026, which is final.'));
    expect(within(lines).queryByRole('button')).toBeNull();
    first.unmount();
    // The week on screen is a later one: the old payout is history, and the employee can leave a second time.
    state.payout = { weekStart: '2026-10-05', final: true, hours: '3.08' };
    render(<PayrollSettings />);
    const again = within(await panel()).getByRole('list', { name: 'Paid time off in 2026' });
    expect(await within(again).findByRole('button', { name: 'Pay out the bank of Sample Alpha in the week of Oct 12, 2026' })).toBeInTheDocument();
    expect(again).not.toHaveTextContent('Bank payout:');
    expect(within(again).queryByRole('button', { name: /Do not pay out/ })).toBeNull();
    // The new payout says which one the line showed: the final payout of the other week.
    fireEvent.click(within(again).getByRole('button', { name: 'Pay out the bank of Sample Alpha in the week of Oct 12, 2026' }));
    await waitFor(() => expect(writes()).toEqual([{ path: '/admin/payroll/technicians/tech-a/pto-payout-week', method: 'PUT', body: { weekStart: '2026-10-12', shownWeekStart: '2026-10-05', shownState: 'paid' } }]));
  });

  it('warns when a final pay run closed the payout week without paying the bank out, and takes the payout back', async () => {
    withPayout({ payout: { weekStart: '2026-10-05', final: false, missed: true } });
    render(<PayrollSettings />);
    const lines = within(await panel()).getByRole('list', { name: 'Paid time off in 2026' });
    await waitFor(() => expect(lines).toHaveTextContent(
      'Bank payout: set for the week of Oct 5, 2026, but that pay run is final and did not pay the bank out. Void that pay run and make it again, or press "Do not pay out" and pick another week.',
    ));
    expect(lines).not.toHaveTextContent('which is final');
    expect(within(lines).queryByRole('button', { name: /Pay out the bank of/ })).toBeNull();
    fireEvent.click(within(lines).getByRole('button', { name: 'Do not pay out the bank of Sample Alpha' }));
    await waitFor(() => expect(writes()).toEqual([{ path: '/admin/payroll/technicians/tech-a/pto-payout-week', method: 'PUT', body: { weekStart: null, shownWeekStart: '2026-10-05', shownState: 'missed' } }]));
    expect(await within(lines).findByRole('button', { name: 'Pay out the bank of Sample Alpha in the week of Oct 12, 2026' })).toBeInTheDocument();
  });

  it('lists an employee who has left while the server sends them (a yearly-hours setting), and never in the time-off form', async () => {
    const former = (id, name) => ({ ...TECHS[0], id, name, employmentStatus: 'inactive' });
    const banks = {
      'tech-c': { ...BANK, balanceHours: '3.08' }, // hours in the bank
      'tech-d': { ...BANK, balanceHours: '0.00', payout: { weekStart: '2026-10-05', final: true, hours: '3.08' } }, // paid out
      'tech-e': { ...BANK, balanceHours: '0.00', payout: { weekStart: '2026-10-19', final: false } }, // a payout set, not paid yet
      'tech-f': { ...BANK, balanceHours: '0.00' }, // nothing in the bank and no payout: the last check can still earn hours
      'tech-g': { ...BANK, balanceHours: '1.54', payout: { weekStart: '2026-10-05', final: true, hours: '3.08' } }, // paid out, then earned again
    };
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options = {}) => {
      // Only the panel asks for the employees who have left; the settings table reads the plain list.
      if (path === '/admin/payroll/technicians?formerBank=1') {
        return reply({ technicians: [...TECHS, former('tech-c', 'Sample Gamma'), former('tech-d', 'Sample Delta'), former('tech-e', 'Sample Epsilon'), former('tech-f', 'Sample Zeta'), former('tech-g', 'Sample Eta')] });
      }
      const id = path.includes('balance?') ? new URL(`http://x${path}`).searchParams.get('technicianId') : null;
      if (banks[id]) return reply({ balance: balanceFor(id, { bank: banks[id] }) });
      return original(path, options);
    });
    render(<PayrollSettings />);
    const view = within(await panel());
    const lines = view.getByRole('list', { name: 'Paid time off in 2026' });
    await waitFor(() => expect(lines).toHaveTextContent('Sample Gamma (left)'));
    expect(within(lines).getByRole('button', { name: 'Pay out the bank of Sample Gamma in the week of Oct 12, 2026' })).toBeInTheDocument();
    expect(lines).toHaveTextContent('Sample Epsilon (left)');
    expect(within(lines).getByRole('button', { name: 'Do not pay out the bank of Sample Epsilon' })).toBeInTheDocument();
    expect(lines).toHaveTextContent('Sample Zeta (left)');
    expect(lines).toHaveTextContent('Sample Eta (left)');
    expect(within(lines).getByRole('button', { name: 'Pay out the bank of Sample Zeta in the week of Oct 12, 2026' })).toBeInTheDocument();
    // One whose empty bank a final pay run paid out stays too: after coming back and leaving again, the last
    // check can earn hours, and the owner sets that payout here.
    expect(lines).toHaveTextContent('Sample Delta (left)');
    expect(within(lines).getByRole('button', { name: 'Pay out the bank of Sample Delta in the week of Oct 12, 2026' })).toBeInTheDocument();
    expect(lines).not.toHaveTextContent('Sample Alpha (left)');
    // Time off is recorded for the employees of today only.
    const names = within(view.getByRole('form', { name: 'Add time off' })).getAllByRole('option').map(option => option.textContent);
    expect(names).toEqual(expect.arrayContaining(['Sample Alpha', 'Sample Beta']));
    expect(names.filter(name => /Gamma|Delta|Epsilon|Zeta|Eta/.test(name))).toEqual([]);
  });

  it('shows the server message when a payout is refused, and keeps the button', async () => {
    writeReply = () => reply({ error: "That week's pay run is final. Void it first, or pick a later pay run." }, false, 409);
    render(<PayrollSettings />);
    const view = within(await panel());
    fireEvent.click(await view.findByRole('button', { name: 'Pay out the bank of Sample Alpha in the week of Oct 12, 2026' }));
    expect(await view.findByRole('alert')).toHaveTextContent("That week's pay run is final. Void it first, or pick a later pay run.");
    expect(view.getByRole('button', { name: 'Pay out the bank of Sample Alpha in the week of Oct 12, 2026' })).toBeEnabled();
    expect(view.queryByText(/pays out the time-off bank/)).toBeNull();
  });

  it('reads the banks again when a payout change is refused: the line shows the payout another tab set, with the server message', async () => {
    const CHANGED = 'The bank payout of this employee changed after this page was read. Check it, then press again.';
    // Another tab set a payout for the week of Oct 5 after this page was read.
    let payout = null;
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options = {}) => {
      if (path.includes('balance?technicianId=tech-a')) return reply({ balance: balanceFor('tech-a', { bank: { ...BANK, payout } }) });
      if (path === '/admin/payroll/technicians/tech-a/pto-payout-week') {
        calls.push({ path, method: options.method, body: options.body });
        payout = { weekStart: '2026-10-05', final: false };
        return reply({ error: CHANGED }, false, 409);
      }
      return original(path, options);
    });
    render(<PayrollSettings />);
    const view = within(await panel());
    const lines = view.getByRole('list', { name: 'Paid time off in 2026' });
    fireEvent.click(await within(lines).findByRole('button', { name: 'Pay out the bank of Sample Alpha in the week of Oct 12, 2026' }));
    await waitFor(() => expect(lines).toHaveTextContent('Bank payout: on the pay run for the week of Oct 5, 2026.'));
    expect(await view.findByRole('alert')).toHaveTextContent(CHANGED);
    expect(view.queryByText(/pays out the time-off bank/)).toBeNull();
    expect(writes().map(c => c.body)).toEqual([{ weekStart: '2026-10-12', shownWeekStart: null, shownState: 'none' }]);
  });

  it('shows the lock message from the server in plain words', async () => {
    writeReply = () => reply({ error: "This week's pay run is final. Void it first to change its pay." }, false, 409);
    render(<PayrollSettings />);
    const view = within(await panel());
    fireEvent.click(view.getByRole('button', { name: 'Remove time off for Sample Alpha on Oct 14, 2026' }));
    expect(await view.findByRole('alert')).toHaveTextContent("This week's pay run is final. Void it first to change its pay.");
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

  it('shows the last day box as soon as minimum hours are typed, and sends both in one save', async () => {
    render(<PayrollSettings />);
    expect(screen.queryByLabelText('Last day for Sample Beta')).toBeNull();
    const hours = await screen.findByLabelText('Minimum paid hours a week for Sample Beta');
    fireEvent.change(hours, { target: { value: '40' } });
    const day = screen.getByLabelText('Last day for Sample Beta');
    fireEvent.change(day, { target: { value: '2026-10-14' } });
    fireEvent.click(within(day.closest('form')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find(c => c.path === '/admin/payroll/technicians/tech-b/week-minimum')).toMatchObject({ method: 'PUT', body: { hours: '40', lastDay: '2026-10-14' } }));
  });

  it('shows a person who is no longer W-2 with the minimum only, and no W-2 action', async () => {
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options = {}) => {
      if (TECH_LIST.includes(path)) return reply({ technicians: TECHS.map(tech => ({ ...tech, paidWeekMinimumHours: 40, paidWeekMinimumLastDay: null, ...(tech.id === 'tech-b' ? { notW2: true } : {}) })) });
      return original(path, options);
    });
    render(<PayrollSettings />);
    const row = (await screen.findByText('Not W-2 now: clear the minimum')).closest('tr');
    expect(within(row).getByLabelText('Minimum paid hours a week for Sample Beta')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Enter W-4' })).toBeNull();
    expect(within(row).queryByLabelText('Paid time off hours per year for Sample Beta')).toBeNull();
  });

  it('does not send a last day typed and then hidden by clearing the hours', async () => {
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options = {}) => {
      if (TECH_LIST.includes(path)) return reply({ technicians: TECHS.map(tech => ({ ...tech, paidWeekMinimumHours: tech.id === 'tech-a' ? 40 : null, paidWeekMinimumLastDay: null })) });
      return original(path, options);
    });
    render(<PayrollSettings />);
    const day = await screen.findByLabelText('Last day for Sample Alpha');
    fireEvent.change(day, { target: { value: '2026-10-13' } });
    const hours = screen.getByLabelText('Minimum paid hours a week for Sample Alpha');
    fireEvent.change(hours, { target: { value: '' } });
    expect(screen.queryByLabelText('Last day for Sample Alpha')).toBeNull();
    fireEvent.click(within(hours.closest('form')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find(c => c.path === '/admin/payroll/technicians/tech-a/week-minimum')).toBeDefined());
    expect(calls.find(c => c.path === '/admin/payroll/technicians/tech-a/week-minimum').body).not.toHaveProperty('lastDay');
  });

  it('sends the last day typed next to a minimum', async () => {
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options = {}) => {
      if (TECH_LIST.includes(path)) return reply({ technicians: TECHS.map(tech => ({ ...tech, paidWeekMinimumHours: tech.id === 'tech-a' ? 40 : null, paidWeekMinimumLastDay: null })) });
      if (path === '/admin/payroll/technicians/tech-a/week-minimum') {
        calls.push({ path, method: options.method, body: options.body });
        return reply({ technician: { id: 'tech-a', paidWeekMinimumHours: 40, paidWeekMinimumLastDay: '2026-10-13' } });
      }
      return original(path, options);
    });
    render(<PayrollSettings />);
    expect(screen.queryByLabelText('Last day for Sample Beta')).toBeNull();
    const day = await screen.findByLabelText('Last day for Sample Alpha');
    fireEvent.change(day, { target: { value: '2026-10-13' } });
    fireEvent.click(within(day.closest('form')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find(c => c.path === '/admin/payroll/technicians/tech-a/week-minimum')).toMatchObject({ body: { hours: '40', lastDay: '2026-10-13', shown: { hours: 40, lastDay: null } } }));
  });

  it('adds a minimum week column only when a check has one, and its line on the stub', async () => {
    const withMinimum = { ...RUN, checks: [check({ minimumWeekHours: '10.00', minimumWeekMinutes: 600, minimumWeekPayCents: 22000 })] };
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options) => {
      if (path === '/admin/payroll/runs/run-1') return reply({ run: withMinimum });
      if (path === '/admin/payroll/checks/check-a/stub') {
        return reply({ stub: { ...STUB, hours: { ...STUB.hours, minimumWeek: '10.00' }, earnings: { ...STUB.earnings, minimumWeekPayCents: 22000 } } });
      }
      return original(path, options);
    });
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open pay run for Oct 12, 2026 to Oct 18, 2026' }));
    const detail = await screen.findByLabelText(/Pay run for/);
    const table = within(detail).getByRole('table', { name: 'Paychecks' });
    expect(within(table).getByRole('columnheader', { name: 'Minimum week' })).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole('button', { name: 'Stub for Sample Alpha' }));
    const stub = await screen.findByLabelText('Pay stub');
    expect(within(stub).getByText('Minimum week pay (10.00 h at $22.00/h, not hours worked)')).toBeInTheDocument();
  });

  it('adds a holiday work premium column only when a check has one, and its line on the stub', async () => {
    const withPremium = { ...RUN, checks: [check({ holidayWorkHours: '4.00', holidayWorkMinutes: 240, holidayWorkPremiumCents: 4400 })] };
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options) => {
      if (path === '/admin/payroll/runs/run-1') return reply({ run: withPremium });
      if (path === '/admin/payroll/checks/check-a/stub') {
        return reply({ stub: { ...STUB, hours: { ...STUB.hours, holidayWork: '4.00' }, earnings: { ...STUB.earnings, holidayWorkPremiumCents: 4400 } } });
      }
      return original(path, options);
    });
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open pay run for Oct 12, 2026 to Oct 18, 2026' }));
    const detail = await screen.findByLabelText(/Pay run for/);
    const table = within(detail).getByRole('table', { name: 'Paychecks' });
    expect(within(table).getByRole('columnheader', { name: 'Holiday work premium' })).toBeInTheDocument();
    expect(within(table).getByText(/4\.00 h · \$44\.00/)).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole('button', { name: 'Stub for Sample Alpha' }));
    const stub = await screen.findByLabelText('Pay stub');
    expect(within(stub).getByText('Holiday work premium (extra half on 4.00 h worked on a holiday; the hours are paid above)')).toBeInTheDocument();
  });

  it('shows no holiday work premium column on a run without one', async () => {
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open pay run for Oct 12, 2026 to Oct 18, 2026' }));
    const table = within(await screen.findByLabelText(/Pay run for/)).getByRole('table', { name: 'Paychecks' });
    expect(within(table).queryByRole('columnheader', { name: 'Holiday work premium' })).toBeNull();
  });

  it('shows no minimum week column on a run without one', async () => {
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open pay run for Oct 12, 2026 to Oct 18, 2026' }));
    const table = within(await screen.findByLabelText(/Pay run for/)).getByRole('table', { name: 'Paychecks' });
    expect(within(table).queryByRole('columnheader', { name: 'Minimum week' })).toBeNull();
  });

  it('shows the time-off bank on the check and the stub, and lists time off the bank did not pay', async () => {
    const bank = { earnedHours: '7.25', usedHours: '7.69', unpaidHours: '2.31', balanceHours: '7.25' };
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options) => {
      if (path === '/admin/payroll/runs/run-1') {
        return reply({ run: { ...RUN, checks: [check({ timeOffBank: bank })], unpaidTimeOff: [{ technicianId: 'tech-a', name: 'Sample Alpha', hours: '2.31', reason: '2.31 hours of time off are not paid, because the time-off bank does not hold them.' }] } });
      }
      if (path === '/admin/payroll/checks/check-a/stub') return reply({ stub: { ...STUB, timeOffBank: bank } });
      return original(path, options);
    });
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open pay run for Oct 12, 2026 to Oct 18, 2026' }));
    const detail = await screen.findByLabelText(/Pay run for/);
    expect(within(detail).getByText('Time-off bank: earned 7.25 h, used 7.69 h, balance 7.25 h')).toBeInTheDocument();
    const notPaid = within(detail).getByRole('list', { name: 'Time off not paid' });
    expect(notPaid).toHaveTextContent('Sample Alpha');
    expect(notPaid).toHaveTextContent('2.31 hours of time off are not paid, because the time-off bank does not hold them.');
    fireEvent.click(within(detail).getByRole('button', { name: 'Stub for Sample Alpha' }));
    const stub = await screen.findByLabelText('Pay stub');
    expect(within(stub).getByText('Time-off bank')).toBeInTheDocument();
    expect(within(stub).getByText('Earned this pay').parentElement).toHaveTextContent('7.25 h');
    expect(within(stub).getByText('Used this pay').parentElement).toHaveTextContent('7.69 h');
    expect(within(stub).getByText('Time off not paid').parentElement).toHaveTextContent('2.31 h');
    expect(within(stub).getByText('Balance after this pay').parentElement).toHaveTextContent('7.25 h');
    expect(within(stub).queryByText('Paid out at leaving')).toBeNull();
  });

  it('shows the hours a check paid out at leaving on the check line and the stub', async () => {
    const bank = { earnedHours: '1.54', usedHours: '0.00', unpaidHours: '0.00', balanceHours: '0.00', paidOutHours: '3.08' };
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options) => {
      if (path === '/admin/payroll/runs/run-1') {
        // The run lists the payouts it decided: Sample Beta's bank was empty, so no paycheck shows that one.
        const bankPayouts = [{ technicianId: 'tech-a', name: 'Sample Alpha', hours: '3.08' }, { technicianId: 'tech-b', name: 'Sample Beta', hours: '0.00' }];
        return reply({ run: { ...RUN, checks: [check({ timeOffBank: bank })], bankPayouts } });
      }
      if (path === '/admin/payroll/checks/check-a/stub') return reply({ stub: { ...STUB, timeOffBank: bank } });
      return original(path, options);
    });
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open pay run for Oct 12, 2026 to Oct 18, 2026' }));
    const detail = await screen.findByLabelText(/Pay run for/);
    expect(within(detail).getByText('Time-off bank: earned 1.54 h, used 0.00 h, paid out 3.08 h, balance 0.00 h')).toBeInTheDocument();
    expect(within(detail).queryByText(/paid after the bank was paid out/)).toBeNull();
    const paidOut = within(detail).getByRole('list', { name: 'Time-off bank paid out' });
    expect(within(paidOut).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'Sample Alpha3.08 hours, on the paycheck.', 'Sample BetaThe bank is empty: nothing is paid out.',
    ]);
    fireEvent.click(within(detail).getByRole('button', { name: 'Stub for Sample Alpha' }));
    const stub = await screen.findByLabelText('Pay stub');
    expect(within(stub).getByText('Paid out at leaving').parentElement).toHaveTextContent('3.08 h');
    expect(within(stub).getByText('Balance after this pay').parentElement).toHaveTextContent('0.00 h');
  });

  it('shows on a catch-up check the time-off hours it did not pay out, and nothing on any other check', async () => {
    const bank = { earnedHours: '0.00', usedHours: '0.00', unpaidHours: '0.00', balanceHours: '0.00', notPaidOutHours: '1.54' };
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options) => {
      if (path === '/admin/payroll/runs/run-1') return reply({ run: { ...RUN, checks: [check({ timeOffBank: bank })] } });
      return original(path, options);
    });
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open pay run for Oct 12, 2026 to Oct 18, 2026' }));
    const detail = await screen.findByLabelText(/Pay run for/);
    expect(within(detail).getByText('This week was paid after the bank was paid out. It would have earned up to 1.54 h of time off (less if the bank was near the 120 h cap). They are not on this check: pay them by hand if you choose.')).toBeInTheDocument();
  });

  it('shows no bank and no list on a run without them', async () => {
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open pay run for Oct 12, 2026 to Oct 18, 2026' }));
    const detail = await screen.findByLabelText(/Pay run for/);
    expect(within(detail).queryByText(/Time-off bank:/)).toBeNull();
    expect(within(detail).queryByRole('list', { name: 'Time-off bank paid out' })).toBeNull();
    expect(within(detail).queryByRole('list', { name: 'Time off not paid' })).toBeNull();
    fireEvent.click(within(detail).getByRole('button', { name: 'Stub for Sample Alpha' }));
    expect(within(await screen.findByLabelText('Pay stub')).queryByText('Time-off bank')).toBeNull();
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

describe('The banks on the time off panel stay current', () => {
  const balanceCalls = () => calls.filter(c => c.path.startsWith('/admin/payroll/time-off/balance?technicianId=tech-a')).length;

  it('reloads the banks when the open pay run is finalized, and again when it is voided', async () => {
    let status = 'draft';
    const original = adminFetch.getMockImplementation();
    const runNow = () => ({ ...RUN, status, checks: [check({ status })] });
    adminFetch.mockImplementation((path, options = {}) => {
      const method = options.method || 'GET';
      if (path === '/admin/payroll/runs') return reply({ runs: [{ id: 'run-1', weekStart: '2026-10-12', weekEnd: '2026-10-18', payDate: '2026-10-23', status, totals }] });
      if (path === '/admin/payroll/runs/run-1') { calls.push({ path, method }); return reply({ run: runNow() }); }
      if (path === '/admin/payroll/runs/run-1/finalize' && method === 'POST') { status = 'finalized'; return reply({ run: runNow() }); }
      if (path === '/admin/payroll/runs/run-1/void' && method === 'POST') { status = 'voided'; return reply({ run: runNow() }); }
      return original(path, options);
    });
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /Open pay run for/ }));
    await screen.findByRole('button', { name: 'Finalize' });
    await waitFor(() => expect(balanceCalls()).toBeGreaterThan(0));
    const drafted = balanceCalls();
    fireEvent.click(screen.getByRole('button', { name: 'Finalize' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, finalize' }));
    await waitFor(() => expect(balanceCalls()).toBe(drafted + 1));
    fireEvent.click(await screen.findByRole('button', { name: 'Void' }));
    fireEvent.change(screen.getByLabelText(/Why are you voiding this pay run/), { target: { value: 'Redo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Void pay run' }));
    await waitFor(() => expect(balanceCalls()).toBe(drafted + 2));
  });

  it('shows a void the server saved when its answer was lost, and reloads the banks', async () => {
    let status = 'finalized';
    const original = adminFetch.getMockImplementation();
    const runNow = () => ({ ...RUN, status, checks: [check({ status })], ...(status === 'voided' ? { voidReason: 'Redo' } : {}) });
    adminFetch.mockImplementation((path, options = {}) => {
      const method = options.method || 'GET';
      if (path === '/admin/payroll/runs') return reply({ runs: [{ id: 'run-1', weekStart: '2026-10-12', weekEnd: '2026-10-18', payDate: '2026-10-23', status, totals }] });
      if (path === '/admin/payroll/runs/run-1') { calls.push({ path, method }); return reply({ run: runNow() }); }
      // The server voids the run. The answer does not reach the page.
      if (path === '/admin/payroll/runs/run-1/void' && method === 'POST') { status = 'voided'; return reply({ error: 'The connection dropped.' }, false, 502); }
      return original(path, options);
    });
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /Open pay run for/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Void' }));
    await waitFor(() => expect(balanceCalls()).toBeGreaterThan(0));
    const before = balanceCalls();
    fireEvent.change(screen.getByLabelText(/Why are you voiding this pay run/), { target: { value: 'Redo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Void pay run' }));
    // The run is read again: it shows as voided, with the failure still on screen, and the banks reload.
    expect(await screen.findByText('Voided: Redo')).toBeInTheDocument();
    expect(screen.getByText('The connection dropped.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Void pay run' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Void' })).toBeNull();
    await waitFor(() => expect(balanceCalls()).toBe(before + 1));
  });

  it('finalizes a run that has no paycheck when it lists time off not paid, and says what that does', async () => {
    let status = 'draft';
    const notPaid = [{ technicianId: 'tech-a', name: 'Sample Alpha', hours: '10.00', reason: '10.00 hours of time off are not paid, because the time-off bank does not hold them.' }];
    let list = notPaid;
    const original = adminFetch.getMockImplementation();
    const runNow = () => ({ ...RUN, status, checks: [], totals: { ...totals, checkCount: 0 }, ...(list.length ? { unpaidTimeOff: list } : {}) });
    adminFetch.mockImplementation((path, options = {}) => {
      const method = options.method || 'GET';
      if (path === '/admin/payroll/runs') return reply({ runs: [{ id: 'run-1', weekStart: '2026-10-12', weekEnd: '2026-10-18', payDate: '2026-10-23', status, totals }] });
      if (path === '/admin/payroll/runs/run-1') return reply({ run: runNow() });
      if (path === '/admin/payroll/runs/run-1/finalize' && method === 'POST') { calls.push({ path, method, body: options.body }); status = 'finalized'; return reply({ run: runNow() }); }
      return original(path, options);
    });
    // With nothing to pay and nothing left unpaid, the run cannot be finalized.
    list = [];
    const first = render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /Open pay run for/ }));
    expect(await screen.findByRole('button', { name: 'Finalize' })).toBeDisabled();
    first.unmount();
    list = notPaid;
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /Open pay run for/ }));
    const finalize = await screen.findByRole('button', { name: 'Finalize' });
    expect(finalize).toBeEnabled();
    expect(screen.getByText('No paychecks in this run yet.')).toBeInTheDocument();
    fireEvent.click(finalize);
    expect(await screen.findByText(/It has no paycheck\. The week closes and the time off above stays unpaid\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, finalize' }));
    await waitFor(() => expect(writes().map(c => c.path)).toEqual(['/admin/payroll/runs/run-1/finalize']));
    expect(await screen.findByText('No paychecks in this run.')).toBeInTheDocument();
    expect(screen.getByText(/10\.00 hours of time off are not paid/)).toBeInTheDocument();
  });

  it('puts "Do not pay out" on the blocked row of a payout whose bank is gone, and reads the run again after it', async () => {
    const goneRow = { technicianId: 'tech-a', name: 'Sample Alpha', reason: 'A time-off bank payout is set for this week, but the employee has no time-off bank now.', payoutWeek: '2026-10-12' };
    const noRate = { technicianId: 'tech-b', name: 'Sample Beta', reason: 'No pay rate set' };
    let blocked = [goneRow, noRate];
    let refuse = true;
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options = {}) => {
      if (path === '/admin/payroll/runs') return reply({ runs: [{ id: 'run-1', weekStart: '2026-10-12', weekEnd: '2026-10-18', payDate: '2026-10-23', status: 'draft', totals }] });
      if (path === '/admin/payroll/runs/run-1') return reply({ run: { ...RUN, status: 'draft', checks: [check({ status: 'draft' })], blocked } });
      if (path === '/admin/payroll/technicians/tech-a/pto-payout-week') {
        calls.push({ path, method: options.method, body: options.body });
        if (refuse) return reply({ error: 'This action is limited to the owner account.' }, false, 403);
        blocked = [noRate];
        return reply({ technician: { id: 'tech-a', ptoPayoutWeekStart: null } });
      }
      return original(path, options);
    });
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /Open pay run for/ }));
    const detail = await screen.findByLabelText(/Pay run for/);
    const rows = within(detail).getByRole('list', { name: 'Blocked' });
    // Only the row of the payout has the button.
    expect(within(rows).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Do not pay out the bank of Sample Alpha']);
    // Another admin is refused: the run is read again, and the row stays, with the server's words.
    const runReads = () => adminFetch.mock.calls.filter(([path, options = {}]) => path === '/admin/payroll/runs/run-1' && !options.method).length;
    const before = runReads();
    fireEvent.click(within(rows).getByRole('button', { name: 'Do not pay out the bank of Sample Alpha' }));
    expect(await within(detail).findByText('This action is limited to the owner account.')).toBeInTheDocument();
    await waitFor(() => expect(runReads()).toBe(before + 1));
    expect(within(detail).getByRole('list', { name: 'Blocked' })).toHaveTextContent('Sample Alpha');
    // The owner: the payout is taken back and the run is read again, without that row.
    refuse = false;
    fireEvent.click(within(rows).getByRole('button', { name: 'Do not pay out the bank of Sample Alpha' }));
    await waitFor(() => expect(within(detail).getByRole('list', { name: 'Blocked' })).not.toHaveTextContent('Sample Alpha'));
    expect(writes().map(c => [c.path, c.method, c.body])).toEqual([
      ['/admin/payroll/technicians/tech-a/pto-payout-week', 'PUT', { weekStart: null, shownWeekStart: '2026-10-12', shownState: 'set' }],
      ['/admin/payroll/technicians/tech-a/pto-payout-week', 'PUT', { weekStart: null, shownWeekStart: '2026-10-12', shownState: 'set' }],
    ]);
    expect(await screen.findByText('The time-off bank of Sample Alpha is not paid out.')).toBeInTheDocument();
    expect(within(detail).getByRole('list', { name: 'Blocked' })).toHaveTextContent('Sample Beta');
  });

  it('finalizes a run with no paycheck whose only decision is the payout of an empty bank, and says so in the prompt', async () => {
    let status = 'draft';
    let lists = {};
    const emptyBank = [{ technicianId: 'tech-a', name: 'Sample Alpha', hours: '0.00' }];
    const notPaid = [{ technicianId: 'tech-b', name: 'Sample Beta', hours: '8.00', reason: '8.00 hours of time off are not paid.' }];
    const original = adminFetch.getMockImplementation();
    let checks = [];
    const runNow = () => ({ ...RUN, status, checks, totals: { ...totals, checkCount: checks.length }, ...lists });
    adminFetch.mockImplementation((path, options = {}) => {
      const method = options.method || 'GET';
      if (path === '/admin/payroll/runs') return reply({ runs: [{ id: 'run-1', weekStart: '2026-10-12', weekEnd: '2026-10-18', payDate: '2026-10-23', status, totals }] });
      if (path === '/admin/payroll/runs/run-1') return reply({ run: runNow() });
      if (path === '/admin/payroll/runs/run-1/finalize' && method === 'POST') { calls.push({ path, method, body: options.body }); status = 'finalized'; return reply({ run: runNow() }); }
      return original(path, options);
    });
    // A run with a paycheck and both lists: the prompt is the one for paychecks.
    lists = { unpaidTimeOff: notPaid, bankPayouts: emptyBank };
    checks = [check({ status: 'draft' })];
    const withCheck = render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /Open pay run for/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finalize' }));
    expect(await screen.findByText('Finalize this pay run? The paychecks become final. You can void the run later to redo the week.')).toBeInTheDocument();
    withCheck.unmount();
    // The payout and time off not paid, on one run with no paycheck: the prompt names both.
    checks = [];
    const first = render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /Open pay run for/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finalize' }));
    expect(await screen.findByText('Finalize this pay run? It has no paycheck. The week closes and the time off above stays unpaid, and the empty time-off bank above is settled with nothing paid out. You can void the run later to redo the week.')).toBeInTheDocument();
    first.unmount();
    // The payout alone.
    lists = { bankPayouts: emptyBank };
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /Open pay run for/ }));
    const finalize = await screen.findByRole('button', { name: 'Finalize' });
    expect(finalize).toBeEnabled();
    expect(within(screen.getByRole('list', { name: 'Time-off bank paid out' })).getByRole('listitem')).toHaveTextContent('Sample AlphaThe bank is empty: nothing is paid out.');
    fireEvent.click(finalize);
    expect(await screen.findByText('Finalize this pay run? It has no paycheck. The week closes and the empty time-off bank above is settled with nothing paid out. You can void the run later to redo the week.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, finalize' }));
    await waitFor(() => expect(writes().map(c => c.path)).toEqual(['/admin/payroll/runs/run-1/finalize']));
    expect(await screen.findByText('No paychecks in this run.')).toBeInTheDocument();
  });

  it('closes the finalize prompt when the numbers under it change, and then finalizes the numbers the owner confirmed', async () => {
    let status = 'draft';
    let hoursNotPaid = '10.00';
    const original = adminFetch.getMockImplementation();
    // The list of time off not paid is in the review token, and a change of it does not make the draft out of date.
    const runNow = () => ({
      ...RUN, status, checks: [], totals: { ...totals, checkCount: 0 }, token: `token-${hoursNotPaid}`,
      unpaidTimeOff: [{
        technicianId: 'tech-a', name: 'Sample Alpha', hours: hoursNotPaid,
        reason: `${hoursNotPaid} hours of time off are not paid, because the time-off bank does not hold them.`,
      }],
    });
    adminFetch.mockImplementation((path, options = {}) => {
      const method = options.method || 'GET';
      if (path === '/admin/payroll/runs') return reply({ runs: [{ id: 'run-1', weekStart: '2026-10-12', weekEnd: '2026-10-18', payDate: '2026-10-23', status, totals }] });
      if (path === '/admin/payroll/runs/run-1') return reply({ run: runNow() });
      if (path === '/admin/payroll/runs/run-1/finalize' && method === 'POST') { calls.push({ path, method, body: options.body }); status = 'finalized'; return reply({ run: runNow() }); }
      if (path.startsWith('/admin/payroll/time-off/') && method === 'DELETE') hoursNotPaid = '2.00';
      return original(path, options);
    });
    const CHANGED = 'The numbers changed. Review them, then press Finalize again.';
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /Open pay run for/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finalize' }));
    expect(await screen.findByRole('group', { name: 'Confirm finalize' })).toBeInTheDocument();
    // A day off is removed while the prompt is open. The run is read again and lists other hours.
    fireEvent.click(within(await panel()).getByRole('button', { name: 'Remove time off for Sample Alpha on Oct 14, 2026' }));
    expect(await screen.findByText(/2\.00 hours of time off are not paid/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Confirm finalize' })).toBeNull());
    expect(screen.getByText(CHANGED)).toBeInTheDocument();
    expect(writes().map(c => c.path)).toEqual(['/admin/payroll/time-off/off-1']);
    // The owner presses Finalize again: the prompt is for the numbers on screen now.
    fireEvent.click(screen.getByRole('button', { name: 'Finalize' }));
    expect(screen.queryByText(CHANGED)).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, finalize' }));
    await waitFor(() => expect(writes().map(c => c.path)).toEqual(['/admin/payroll/time-off/off-1', '/admin/payroll/runs/run-1/finalize']));
    expect(writes()[1].body).toEqual({ token: 'token-2.00' });
    expect(await screen.findByText('No paychecks in this run.')).toBeInTheDocument();
    expect(screen.queryByText(CHANGED)).toBeNull();
  });

  it('keeps the newest banks when an older request answers last', async () => {
    let hours = 80;
    let asked = 0;
    let answerOld;
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options = {}) => {
      if (TECH_LIST.includes(path)) {
        return reply({ technicians: TECHS.map(tech => (tech.id === 'tech-a' ? { ...tech, ptoHoursPerYear: hours } : tech)) });
      }
      if (path === '/admin/payroll/technicians/tech-a/pto-allowance') hours = 96;
      if (path.startsWith('/admin/payroll/time-off/balance?technicianId=tech-a')) {
        asked += 1;
        // The first answer is held back; the answer after the save comes at once, with the new bank.
        if (asked === 1) return new Promise(resolve => { answerOld = () => resolve(reply({ balance: balanceFor('tech-a') })); });
        return reply({ balance: balanceFor('tech-a', { bank: { ...BANK, balanceHours: '20.00', waitingHours: '0.00' } }) });
      }
      return original(path, options);
    });
    render(<PayrollSettings />);
    const input = await screen.findByLabelText('Paid time off hours per year for Sample Alpha');
    await waitFor(() => expect(asked).toBe(1));
    fireEvent.change(input, { target: { value: '96' } });
    fireEvent.click(within(input.closest('form')).getByRole('button', { name: 'Save' }));
    const view = await panel();
    await waitFor(() => expect(view).toHaveTextContent('Time-off bank: 20 hours'));
    // The held answer arrives now. It is the bank from before the save, and it must not come back.
    await act(async () => { answerOld(); await Promise.resolve(); await Promise.resolve(); });
    await waitFor(() => expect(asked).toBe(2));
    expect(view).toHaveTextContent('Time-off bank: 20 hours');
    expect(view).not.toHaveTextContent('Time-off bank: 12.5 hours');
  });

  it('reads the open draft again when a yearly-hours setting is saved, so it shows as out of date', async () => {
    let hours = 80;
    const original = adminFetch.getMockImplementation();
    const runReads = () => calls.filter(c => c.path === '/admin/payroll/runs/run-1' && c.method === 'GET').length;
    adminFetch.mockImplementation((path, options = {}) => {
      if (TECH_LIST.includes(path)) {
        return reply({ technicians: TECHS.map(tech => (tech.id === 'tech-a' ? { ...tech, ptoHoursPerYear: hours } : tech)) });
      }
      if (path === '/admin/payroll/runs') return reply({ runs: [{ id: 'run-1', weekStart: '2026-10-12', weekEnd: '2026-10-18', payDate: '2026-10-23', status: 'draft', totals }] });
      if (path === '/admin/payroll/runs/run-1') {
        calls.push({ path, method: 'GET' });
        // The server compares the draft with today's settings: after the save it is out of date.
        return reply({ run: { ...RUN, status: 'draft', checks: [check({ status: 'draft' })], stale: hours !== 80 } });
      }
      if (path === '/admin/payroll/technicians/tech-a/pto-allowance') hours = 96;
      return original(path, options);
    });
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /Open pay run for/ }));
    expect(await screen.findByRole('button', { name: 'Finalize' })).toBeEnabled();
    const before = runReads();
    const input = await screen.findByLabelText('Paid time off hours per year for Sample Alpha');
    fireEvent.change(input, { target: { value: '96' } });
    fireEvent.click(within(input.closest('form')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(runReads()).toBe(before + 1));
    expect(await screen.findByText('Hours or settings changed since this draft. Press Recompute.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finalize' })).toBeDisabled();
  });

  it('saves the minimum paid week and reads the open draft again, so it shows as out of date', async () => {
    let minimum = null;
    const original = adminFetch.getMockImplementation();
    const runReads = () => calls.filter(c => c.path === '/admin/payroll/runs/run-1' && c.method === 'GET').length;
    adminFetch.mockImplementation((path, options = {}) => {
      if (TECH_LIST.includes(path)) {
        return reply({ technicians: TECHS.map(tech => ({ ...tech, paidWeekMinimumHours: tech.id === 'tech-a' ? minimum : null })) });
      }
      if (path === '/admin/payroll/runs') return reply({ runs: [{ id: 'run-1', weekStart: '2026-10-12', weekEnd: '2026-10-18', payDate: '2026-10-23', status: 'draft', totals }] });
      if (path === '/admin/payroll/runs/run-1') {
        calls.push({ path, method: 'GET' });
        return reply({ run: { ...RUN, status: 'draft', checks: [check({ status: 'draft' })], stale: minimum !== null } });
      }
      if (path === '/admin/payroll/technicians/tech-a/week-minimum') {
        calls.push({ path, method: options.method, body: options.body });
        minimum = 40;
        return reply({ technician: { id: 'tech-a', paidWeekMinimumHours: 40 } });
      }
      return original(path, options);
    });
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /Open pay run for/ }));
    expect(await screen.findByRole('button', { name: 'Finalize' })).toBeEnabled();
    const before = runReads();
    const input = await screen.findByLabelText('Minimum paid hours a week for Sample Alpha');
    fireEvent.change(input, { target: { value: '40' } });
    fireEvent.click(within(input.closest('form')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(runReads()).toBe(before + 1));
    expect(calls.find(c => c.path === '/admin/payroll/technicians/tech-a/week-minimum')).toMatchObject({ method: 'PUT', body: { hours: '40', lastDay: null, shown: { hours: null, lastDay: null } } });
    expect(await screen.findByText('Minimum paid hours a week saved for Sample Alpha.')).toBeInTheDocument();
    expect(await screen.findByText('Hours or settings changed since this draft. Press Recompute.')).toBeInTheDocument();
  });

  it('reads the open draft again when a bank payout is set, so it shows as out of date', async () => {
    let payout = null;
    const original = adminFetch.getMockImplementation();
    const runReads = () => calls.filter(c => c.path === '/admin/payroll/runs/run-1' && c.method === 'GET').length;
    adminFetch.mockImplementation((path, options = {}) => {
      if (path === '/admin/payroll/runs') return reply({ runs: [{ id: 'run-1', weekStart: '2026-10-12', weekEnd: '2026-10-18', payDate: '2026-10-23', status: 'draft', totals }] });
      if (path === '/admin/payroll/runs/run-1') {
        calls.push({ path, method: 'GET' });
        // The server compares the draft with today's settings: with a payout set it is out of date.
        return reply({ run: { ...RUN, status: 'draft', checks: [check({ status: 'draft' })], stale: payout !== null } });
      }
      if (path.includes('balance?technicianId=tech-a')) return reply({ balance: balanceFor('tech-a', { bank: { ...BANK, payout } }) });
      if (path === '/admin/payroll/technicians/tech-a/pto-payout-week') {
        payout = { weekStart: options.body.weekStart, final: false };
        return reply({ technician: { id: 'tech-a', ptoPayoutWeekStart: options.body.weekStart } });
      }
      return original(path, options);
    });
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /Open pay run for/ }));
    expect(await screen.findByRole('button', { name: 'Finalize' })).toBeEnabled();
    const before = runReads();
    fireEvent.click(await screen.findByRole('button', { name: 'Pay out the bank of Sample Alpha in the week of Oct 12, 2026' }));
    await waitFor(() => expect(runReads()).toBe(before + 1));
    expect(await screen.findByText('Hours or settings changed since this draft. Press Recompute.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finalize' })).toBeDisabled();
  });

  it('reads the open draft again when a payout change is refused: another tab set the payout the draft does not hold', async () => {
    const CHANGED = 'The bank payout of this employee changed after this page was read. Check it, then press again.';
    let payout = null;
    const original = adminFetch.getMockImplementation();
    const runReads = () => calls.filter(c => c.path === '/admin/payroll/runs/run-1' && c.method === 'GET').length;
    adminFetch.mockImplementation((path, options = {}) => {
      if (path === '/admin/payroll/runs') return reply({ runs: [{ id: 'run-1', weekStart: '2026-10-12', weekEnd: '2026-10-18', payDate: '2026-10-23', status: 'draft', totals }] });
      if (path === '/admin/payroll/runs/run-1') {
        calls.push({ path, method: 'GET' });
        return reply({ run: { ...RUN, status: 'draft', checks: [check({ status: 'draft' })], stale: payout !== null } });
      }
      if (path.includes('balance?technicianId=tech-a')) return reply({ balance: balanceFor('tech-a', { bank: { ...BANK, payout } }) });
      if (path === '/admin/payroll/technicians/tech-a/pto-payout-week') {
        // Another tab set the payout for this week after this page was read: the server refuses this change.
        payout = { weekStart: '2026-10-12', final: false };
        return reply({ error: CHANGED }, false, 409);
      }
      return original(path, options);
    });
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /Open pay run for/ }));
    expect(await screen.findByRole('button', { name: 'Finalize' })).toBeEnabled();
    const before = runReads();
    fireEvent.click(await screen.findByRole('button', { name: 'Pay out the bank of Sample Alpha in the week of Oct 12, 2026' }));
    await waitFor(() => expect(runReads()).toBe(before + 1));
    expect(await screen.findByText('Hours or settings changed since this draft. Press Recompute.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finalize' })).toBeDisabled();
    expect(await screen.findByText(CHANGED)).toBeInTheDocument();
  });

  it('reloads the week on screen when a removal ends after the week changed', async () => {
    let release;
    writeReply = () => new Promise(resolve => { release = () => resolve(reply({ deleted: true })); });
    const PREFIX = '/admin/payroll/time-off?from=';
    const weeksLoaded = () => calls.filter(c => c.method === 'GET' && c.path.startsWith(PREFIX)).map(c => c.path.slice(PREFIX.length, PREFIX.length + 10));
    render(<PayrollSettings />);
    const view = within(await panel());
    fireEvent.click(view.getByRole('button', { name: 'Remove time off for Sample Alpha on Oct 14, 2026' }));
    await waitFor(() => expect(release).toBeTypeOf('function'));
    // The owner picks another week while the removal is on its way.
    fireEvent.change(within(screen.getByRole('form', { name: 'New pay run' })).getByLabelText('Week'), { target: { value: '2026-10-05' } });
    await waitFor(() => expect(weeksLoaded().at(-1)).toBe('2026-10-05'));
    const loads = weeksLoaded().length;
    await act(async () => { release(); await new Promise(resolve => { setTimeout(resolve, 0); }); });
    await waitFor(() => expect(weeksLoaded().length).toBe(loads + 1));
    expect(weeksLoaded().at(-1)).toBe('2026-10-05');
  });

  it('reloads the banks when a yearly-hours setting is saved', async () => {
    let hours = 80;
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options = {}) => {
      if (TECH_LIST.includes(path)) {
        calls.push({ path, method: 'GET' });
        return reply({ technicians: TECHS.map(tech => (tech.id === 'tech-a' ? { ...tech, ptoHoursPerYear: hours } : tech)) });
      }
      if (path === '/admin/payroll/technicians/tech-a/pto-allowance') hours = 96;
      return original(path, options);
    });
    render(<PayrollSettings />);
    const input = await screen.findByLabelText('Paid time off hours per year for Sample Alpha');
    await waitFor(() => expect(balanceCalls()).toBeGreaterThan(0));
    const before = balanceCalls();
    fireEvent.change(input, { target: { value: '96' } });
    fireEvent.click(within(input.closest('form')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(balanceCalls()).toBe(before + 1));
  });
});

describe('The open pay run stays the one the owner picked', () => {
  const OTHER = { id: 'run-2', weekStart: '2026-10-05', weekEnd: '2026-10-11', payDate: '2026-10-16' };
  const DRAFT = { ...RUN, status: 'draft', checks: [check({ status: 'draft' })] };
  const LIST = [
    { id: 'run-1', weekStart: '2026-10-12', weekEnd: '2026-10-18', payDate: '2026-10-23', status: 'draft', totals },
    { ...OTHER, status: 'finalized', totals },
  ];
  const FIRST = 'Pay run for Oct 12, 2026 to Oct 18, 2026';
  const SECOND = 'Pay run for Oct 5, 2026 to Oct 11, 2026';
  // A yearly-hours save makes the screen read draft run-1 again. That read is held back until release() runs.
  const holdTheReload = () => {
    let hours = 80;
    const held = { started: false, release: () => {} };
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options = {}) => {
      const method = options.method || 'GET';
      if (TECH_LIST.includes(path)) {
        return reply({ technicians: TECHS.map(tech => (tech.id === 'tech-a' ? { ...tech, ptoHoursPerYear: hours } : tech)) });
      }
      if (path === '/admin/payroll/runs' && method === 'GET') return reply({ runs: LIST });
      if (path === '/admin/payroll/runs' && method === 'POST') return reply({ run: { ...DRAFT, ...OTHER, id: 'run-9' } }, true, 201);
      if (path === '/admin/payroll/runs/run-1') {
        if (hours === 80) return reply({ run: DRAFT });
        held.started = true;
        return new Promise(resolve => { held.release = () => resolve(reply({ run: DRAFT })); });
      }
      if (path === '/admin/payroll/runs/run-2') return reply({ run: { ...RUN, ...OTHER } });
      if (path === '/admin/payroll/technicians/tech-a/pto-allowance') hours = 96;
      return original(path, options);
    });
    return held;
  };
  const openFirstThenSave = async () => {
    const held = holdTheReload();
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open pay run for Oct 12, 2026 to Oct 18, 2026' }));
    await screen.findByLabelText(FIRST);
    const input = await screen.findByLabelText('Paid time off hours per year for Sample Alpha');
    fireEvent.change(input, { target: { value: '96' } });
    fireEvent.click(within(input.closest('form')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(held.started).toBe(true));
    return held;
  };
  const afterTheOldReadLands = async (held) => {
    await act(async () => { held.release(); await new Promise(resolve => { setTimeout(resolve, 0); }); });
    expect(screen.getByLabelText(SECOND)).toBeInTheDocument();
    expect(screen.queryByLabelText(FIRST)).toBeNull();
  };

  it('keeps a run opened after a yearly-hours save when the older read of the draft answers last', async () => {
    const held = await openFirstThenSave();
    fireEvent.click(screen.getByRole('button', { name: 'Open pay run for Oct 5, 2026 to Oct 11, 2026' }));
    await screen.findByLabelText(SECOND);
    await afterTheOldReadLands(held);
  });

  it('does not read the draft again while the owner waits for another run, reads that run once more when it answers, and keeps reading the draft after a read that failed', async () => {
    let hours = 80;
    let releaseTechnicians;
    let releaseSecond;
    let secondReads = 0;
    let secondFails = false;
    const original = adminFetch.getMockImplementation();
    const firstReads = () => calls.filter(c => c.path === '/admin/payroll/runs/run-1').length;
    adminFetch.mockImplementation((path, options = {}) => {
      const method = options.method || 'GET';
      if (TECH_LIST.includes(path)) {
        const technicians = TECHS.map(tech => (tech.id === 'tech-a' ? { ...tech, ptoHoursPerYear: hours } : tech));
        if (hours === 80 || releaseTechnicians) return reply({ technicians });
        // The first reload after the save is held back: the settings change reaches the pay runs late.
        return new Promise(resolve => { releaseTechnicians = () => resolve(reply({ technicians })); });
      }
      if (path === '/admin/payroll/runs' && method === 'GET') return reply({ runs: LIST });
      if (path === '/admin/payroll/runs/run-1') { calls.push({ path, method }); return reply({ run: DRAFT }); }
      if (path === '/admin/payroll/runs/run-2') {
        if (secondFails) return reply({ error: 'Pay run not found.' }, false, 404);
        secondReads += 1;
        return new Promise(resolve => { releaseSecond = () => resolve(reply({ run: { ...RUN, ...OTHER } })); });
      }
      if (path === '/admin/payroll/technicians/tech-a/pto-allowance') hours = 96;
      return original(path, options);
    });
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open pay run for Oct 12, 2026 to Oct 18, 2026' }));
    await screen.findByLabelText(FIRST);
    const before = firstReads();
    const input = await screen.findByLabelText('Paid time off hours per year for Sample Alpha');
    fireEvent.change(input, { target: { value: '96' } });
    fireEvent.click(within(input.closest('form')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(releaseTechnicians).toBeTypeOf('function'));
    // The owner opens the other run before the settings reload lands.
    fireEvent.click(screen.getByRole('button', { name: 'Open pay run for Oct 5, 2026 to Oct 11, 2026' }));
    await waitFor(() => expect(releaseSecond).toBeTypeOf('function'));
    await act(async () => { releaseTechnicians(); await new Promise(resolve => { setTimeout(resolve, 0); }); });
    expect(firstReads()).toBe(before);
    // The read of the other run started before the settings change landed, so its answer can be from before
    // the change: it is not shown, and the run is read once more.
    await act(async () => { releaseSecond(); await new Promise(resolve => { setTimeout(resolve, 0); }); });
    expect(secondReads).toBe(2);
    expect(screen.queryByLabelText(SECOND)).toBeNull();
    await act(async () => { releaseSecond(); await new Promise(resolve => { setTimeout(resolve, 0); }); });
    expect(screen.getByLabelText(SECOND)).toBeInTheDocument();
    expect(screen.queryByLabelText(FIRST)).toBeNull();
    expect(secondReads).toBe(2);

    // Back on the draft, a read of the other run fails. The draft stays, and a change still reads it again.
    fireEvent.click(screen.getByRole('button', { name: 'Open pay run for Oct 12, 2026 to Oct 18, 2026' }));
    await screen.findByLabelText(FIRST);
    secondFails = true;
    fireEvent.click(screen.getByRole('button', { name: 'Open pay run for Oct 5, 2026 to Oct 11, 2026' }));
    await screen.findByText('Pay run not found.');
    const beforeChange = firstReads();
    fireEvent.click(within(await panel()).getByRole('button', { name: 'Remove time off for Sample Alpha on Oct 14, 2026' }));
    await waitFor(() => expect(firstReads()).toBe(beforeChange + 1));
    expect(screen.getByLabelText(FIRST)).toBeInTheDocument();
  });

  it('keeps a run the owner opened while a recompute of the first run was on its way, and still shows a recompute they waited for', async () => {
    const held = { started: 0, release: () => {} };
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options = {}) => {
      const method = options.method || 'GET';
      if (path === '/admin/payroll/runs' && method === 'GET') return reply({ runs: LIST });
      if (path === '/admin/payroll/runs/run-1/recompute' && method === 'POST') {
        held.started += 1;
        return new Promise(resolve => { held.release = () => resolve(reply({ run: DRAFT })); });
      }
      if (path === '/admin/payroll/runs/run-1') { calls.push({ path, method }); return reply({ run: DRAFT }); }
      if (path === '/admin/payroll/runs/run-2') return reply({ run: { ...RUN, ...OTHER } });
      return original(path, options);
    });
    const firstReads = () => calls.filter(c => c.path === '/admin/payroll/runs/run-1').length;
    const land = () => act(async () => { held.release(); await new Promise(resolve => { setTimeout(resolve, 0); }); });
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open pay run for Oct 12, 2026 to Oct 18, 2026' }));
    await screen.findByLabelText(FIRST);
    // The owner waits for the recompute: its answer reads the run again.
    const before = firstReads();
    fireEvent.click(screen.getByRole('button', { name: 'Recompute' }));
    await waitFor(() => expect(held.started).toBe(1));
    await land();
    await waitFor(() => expect(firstReads()).toBe(before + 1));
    expect(screen.getByLabelText(FIRST)).toBeInTheDocument();
    // The owner opens another run while a second recompute is on its way: its answer does not take the screen back.
    fireEvent.click(screen.getByRole('button', { name: 'Recompute' }));
    await waitFor(() => expect(held.started).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'Open pay run for Oct 5, 2026 to Oct 11, 2026' }));
    await screen.findByLabelText(SECOND);
    await land();
    expect(screen.getByLabelText(SECOND)).toBeInTheDocument();
    expect(screen.queryByLabelText(FIRST)).toBeNull();
    expect(firstReads()).toBe(before + 1);
  });

  it('reloads the banks and reads the run on screen again when a finalize of another run ends', async () => {
    const held = { started: false, release: () => {} };
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options = {}) => {
      const method = options.method || 'GET';
      if (path === '/admin/payroll/runs' && method === 'GET') return reply({ runs: LIST });
      if (path === '/admin/payroll/runs/run-1/finalize' && method === 'POST') {
        held.started = true;
        return new Promise(resolve => { held.release = () => resolve(reply({ run: { ...DRAFT, status: 'finalized' } })); });
      }
      if (path === '/admin/payroll/runs/run-1') return reply({ run: DRAFT });
      if (path === '/admin/payroll/runs/run-2') { calls.push({ path, method }); return reply({ run: { ...RUN, ...OTHER } }); }
      return original(path, options);
    });
    const balanceCalls = () => calls.filter(c => c.path.startsWith('/admin/payroll/time-off/balance?technicianId=tech-a')).length;
    const secondReads = () => calls.filter(c => c.path === '/admin/payroll/runs/run-2').length;
    const settle = () => act(async () => { await new Promise(resolve => { setTimeout(resolve, 0); }); });
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open pay run for Oct 12, 2026 to Oct 18, 2026' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finalize' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, finalize' }));
    await waitFor(() => expect(held.started).toBe(true));
    // The owner opens another run while the finalize is on its way: its banks load before the finalize is done.
    fireEvent.click(screen.getByRole('button', { name: 'Open pay run for Oct 5, 2026 to Oct 11, 2026' }));
    await screen.findByLabelText(SECOND);
    await settle();
    await settle();
    const [loaded, read] = [balanceCalls(), secondReads()];
    expect(loaded).toBeGreaterThan(0);
    await act(async () => { held.release(); await new Promise(resolve => { setTimeout(resolve, 0); }); });
    // The finalize changed a time-off bank: the panel reloads, and the run on screen is read again (a draft would show as out of date).
    await waitFor(() => expect(balanceCalls()).toBe(loaded + 1));
    expect(secondReads()).toBe(read + 1);
    expect(screen.getByLabelText(SECOND)).toBeInTheDocument();
    expect(screen.queryByLabelText(FIRST)).toBeNull();
  });

  it('reads a run once more when a finalize of another run ended while that run was being read', async () => {
    const held = { finalize: null, second: null, secondReads: 0 };
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options = {}) => {
      const method = options.method || 'GET';
      if (path === '/admin/payroll/runs' && method === 'GET') return reply({ runs: LIST });
      if (path === '/admin/payroll/runs/run-1/finalize' && method === 'POST') {
        return new Promise(resolve => { held.finalize = () => resolve(reply({ run: { ...DRAFT, status: 'finalized' } })); });
      }
      if (path === '/admin/payroll/runs/run-1') return reply({ run: DRAFT });
      if (path === '/admin/payroll/runs/run-2') {
        held.secondReads += 1;
        if (held.secondReads > 1) return reply({ run: { ...RUN, ...OTHER } });
        return new Promise(resolve => { held.second = () => resolve(reply({ run: { ...RUN, ...OTHER } })); });
      }
      return original(path, options);
    });
    const land = release => act(async () => { release(); await new Promise(resolve => { setTimeout(resolve, 0); }); });
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open pay run for Oct 12, 2026 to Oct 18, 2026' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finalize' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, finalize' }));
    await waitFor(() => expect(held.finalize).toBeTypeOf('function'));
    // The owner opens the other run. Its read starts before the finalize is done and answers after it.
    fireEvent.click(screen.getByRole('button', { name: 'Open pay run for Oct 5, 2026 to Oct 11, 2026' }));
    await waitFor(() => expect(held.second).toBeTypeOf('function'));
    await land(held.finalize);
    expect(held.secondReads).toBe(1);
    expect(screen.getByLabelText(FIRST)).toBeInTheDocument();
    await land(held.second);
    // That answer can be from before the finalize: the run is read once more, then shown.
    expect(await screen.findByLabelText(SECOND)).toBeInTheDocument();
    expect(held.secondReads).toBe(2);
    expect(screen.queryByLabelText(FIRST)).toBeNull();
  });

  it('reads the run on screen again when the run the owner asked for does not come after a change ended, and keeps that failure on screen', async () => {
    const held = { second: null, create: null };
    const original = adminFetch.getMockImplementation();
    const firstReads = () => calls.filter(c => c.path === '/admin/payroll/runs/run-1').length;
    adminFetch.mockImplementation((path, options = {}) => {
      const method = options.method || 'GET';
      if (path === '/admin/payroll/runs' && method === 'GET') return reply({ runs: LIST });
      if (path === '/admin/payroll/runs' && method === 'POST') {
        return new Promise(resolve => { held.create = () => resolve(reply({ error: 'No W-2 hours to pay for that week.' }, false, 409)); });
      }
      if (path === '/admin/payroll/runs/run-1') { calls.push({ path, method }); return reply({ run: DRAFT }); }
      if (path === '/admin/payroll/runs/run-2') {
        return new Promise(resolve => { held.second = () => resolve(reply({ error: 'Pay run not found.' }, false, 404)); });
      }
      return original(path, options);
    });
    const land = async (name) => {
      const answer = held[name];
      held[name] = null;
      await act(async () => { answer(); await new Promise(resolve => { setTimeout(resolve, 0); }); });
    };
    const removeADay = async () => {
      const view = within(await panel());
      fireEvent.click(view.getByRole('button', { name: 'Remove time off for Sample Alpha on Oct 14, 2026' }));
      await view.findByText('Time off removed.');
      await waitFor(() => expect(view.getByRole('button', { name: 'Remove time off for Sample Alpha on Oct 14, 2026' })).toBeEnabled());
    };
    const askForTheOther = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open pay run for Oct 5, 2026 to Oct 11, 2026' }));
      await waitFor(() => expect(held.second).toBeTypeOf('function'));
    };
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open pay run for Oct 12, 2026 to Oct 18, 2026' }));
    await screen.findByLabelText(FIRST);
    const before = firstReads();
    // The owner asks for the other run, and a day off is removed before it answers: the draft is not read yet.
    await askForTheOther();
    await removeADay();
    expect(firstReads()).toBe(before);
    // The other run does not come. The draft stays on screen and has not read the change: it is read now.
    await land('second');
    await waitFor(() => expect(firstReads()).toBe(before + 1));
    expect(screen.getByText('Pay run not found.')).toBeInTheDocument();
    expect(screen.getByLabelText(FIRST)).toBeInTheDocument();
    // The same when a new pay run is refused.
    fireEvent.click(screen.getByRole('button', { name: 'New pay run' }));
    await waitFor(() => expect(held.create).toBeTypeOf('function'));
    await removeADay();
    expect(firstReads()).toBe(before + 1);
    await land('create');
    await waitFor(() => expect(firstReads()).toBe(before + 2));
    expect(screen.getByText('No W-2 hours to pay for that week.')).toBeInTheDocument();
    expect(screen.getByLabelText(FIRST)).toBeInTheDocument();
    // With no change in between, a run that does not come starts no read of the draft.
    await askForTheOther();
    await land('second');
    expect(firstReads()).toBe(before + 2);
    expect(screen.getByLabelText(FIRST)).toBeInTheDocument();
  });

  it('shows the finalized run when its read after the finalize was dropped for a run that did not come', async () => {
    let status = 'draft';
    let heldRead = null;
    const original = adminFetch.getMockImplementation();
    const runNow = () => ({ ...DRAFT, status, checks: [check({ status })] });
    adminFetch.mockImplementation((path, options = {}) => {
      const method = options.method || 'GET';
      if (path === '/admin/payroll/runs' && method === 'GET') return reply({ runs: LIST });
      if (path === '/admin/payroll/runs/run-1/finalize' && method === 'POST') { status = 'finalized'; heldRead = 'next'; return reply({ run: runNow() }); }
      if (path === '/admin/payroll/runs/run-1') {
        if (heldRead !== 'next') return reply({ run: runNow() });
        // The read right after the finalize is slow.
        return new Promise(resolve => { heldRead = () => resolve(reply({ run: runNow() })); });
      }
      if (path === '/admin/payroll/runs/run-2') return reply({ error: 'Pay run not found.' }, false, 404);
      return original(path, options);
    });
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open pay run for Oct 12, 2026 to Oct 18, 2026' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finalize' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, finalize' }));
    await waitFor(() => expect(heldRead).toBeTypeOf('function'));
    // The owner asks for the other run before that read answers, and the other run does not come.
    fireEvent.click(screen.getByRole('button', { name: 'Open pay run for Oct 5, 2026 to Oct 11, 2026' }));
    // The draft on screen is from before the finalize: it is read again and shows as finalized.
    expect(await screen.findByRole('button', { name: 'Void' })).toBeInTheDocument();
    await act(async () => { heldRead(); await new Promise(resolve => { setTimeout(resolve, 0); }); });
    expect(screen.getByLabelText(FIRST)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Finalize' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Recompute' })).toBeNull();
  });

  it('says so and keeps Finalize off when the draft cannot be read again after a change, until a read of it succeeds', async () => {
    let fails = false;
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options = {}) => {
      const method = options.method || 'GET';
      if (path === '/admin/payroll/runs' && method === 'GET') return reply({ runs: LIST });
      if (path === '/admin/payroll/runs/run-1/recompute' && method === 'POST') { fails = false; return reply({ run: DRAFT }); }
      if (path === '/admin/payroll/runs/run-1') return fails ? reply({ error: 'Server error.' }, false, 500) : reply({ run: DRAFT });
      return original(path, options);
    });
    const NOT_READ = 'This draft could not be read again after a change. Press Recompute.';
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open pay run for Oct 12, 2026 to Oct 18, 2026' }));
    expect(await screen.findByRole('button', { name: 'Finalize' })).toBeEnabled();
    expect(screen.queryByText(NOT_READ)).toBeNull();
    // A day off is removed, and the read of the draft after it fails: its numbers can be from before the change.
    fails = true;
    fireEvent.click(within(await panel()).getByRole('button', { name: 'Remove time off for Sample Alpha on Oct 14, 2026' }));
    expect(await screen.findByText(NOT_READ)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finalize' })).toBeDisabled();
    // The list reload after the failure clears the failure message. The line on the draft stays.
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0); }); });
    await waitFor(() => expect(screen.queryByText('Server error.')).toBeNull());
    expect(screen.getByText(NOT_READ)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finalize' })).toBeDisabled();
    // Recompute works the numbers out again, and the read after it succeeds.
    fireEvent.click(screen.getByRole('button', { name: 'Recompute' }));
    await waitFor(() => expect(screen.queryByText(NOT_READ)).toBeNull());
    expect(screen.getByRole('button', { name: 'Finalize' })).toBeEnabled();
  });

  // A new pay run whose answer is held back until release() runs.
  const holdTheNewRun = () => {
    const NEW = { ...DRAFT, id: 'run-9', weekStart: '2026-09-28', weekEnd: '2026-10-04', payDate: '2026-10-09' };
    const held = { started: false, release: () => {} };
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options = {}) => {
      const method = options.method || 'GET';
      if (path === '/admin/payroll/runs' && method === 'GET') return reply({ runs: LIST });
      if (path === '/admin/payroll/runs' && method === 'POST') {
        held.started = true;
        return new Promise(resolve => { held.release = () => resolve(reply({ run: NEW }, true, 201)); });
      }
      if (path === '/admin/payroll/runs/run-1') { calls.push({ path, method }); return reply({ run: DRAFT }); }
      if (path === '/admin/payroll/runs/run-2') return reply({ run: { ...RUN, ...OTHER } });
      if (path === '/admin/payroll/runs/run-9') { calls.push({ path, method }); return reply({ run: NEW }); }
      return original(path, options);
    });
    return held;
  };
  const newReads = () => calls.filter(c => c.path === '/admin/payroll/runs/run-9').length;
  const NEWEST = 'Pay run for Sep 28, 2026 to Oct 4, 2026';
  const release = held => act(async () => { held.release(); await new Promise(resolve => { setTimeout(resolve, 0); }); });

  it('keeps a run the owner opened while a new pay run was being made', async () => {
    const held = holdTheNewRun();
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'New pay run' }));
    await waitFor(() => expect(held.started).toBe(true));
    fireEvent.click(await screen.findByRole('button', { name: 'Open pay run for Oct 5, 2026 to Oct 11, 2026' }));
    await screen.findByLabelText(SECOND);
    await release(held);
    expect(screen.getByLabelText(SECOND)).toBeInTheDocument();
    expect(screen.queryByLabelText(NEWEST)).toBeNull();
    expect(newReads()).toBe(0);
  });

  it('does not read the shown run again while a new pay run is being made, then shows the new run and reads it once more', async () => {
    const held = holdTheNewRun();
    const firstReads = () => calls.filter(c => c.path === '/admin/payroll/runs/run-1').length;
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open pay run for Oct 12, 2026 to Oct 18, 2026' }));
    await screen.findByLabelText(FIRST);
    const before = firstReads();
    fireEvent.click(screen.getByRole('button', { name: 'New pay run' }));
    await waitFor(() => expect(held.started).toBe(true));
    // A time-off change asks for a refresh of the shown run. That read would take the place of the new run.
    const view = within(await panel());
    fireEvent.click(view.getByRole('button', { name: 'Remove time off for Sample Alpha on Oct 14, 2026' }));
    await view.findByText('Time off removed.');
    await waitFor(() => expect(view.getByRole('button', { name: 'Remove time off for Sample Alpha on Oct 14, 2026' })).toBeEnabled());
    expect(firstReads()).toBe(before);
    await release(held);
    expect(await screen.findByLabelText(NEWEST)).toBeInTheDocument();
    expect(screen.queryByLabelText(FIRST)).toBeNull();
    // The time-off change ended while the run was being made, so its answer can lack it: one more read.
    await waitFor(() => expect(newReads()).toBe(1));
    expect(screen.getByLabelText(NEWEST)).toBeInTheDocument();
  });

  it('keeps a new pay run when the older read of the draft answers last', async () => {
    const held = await openFirstThenSave();
    fireEvent.click(screen.getByRole('button', { name: 'New pay run' }));
    await screen.findByLabelText(SECOND);
    await afterTheOldReadLands(held);
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
    expect(await screen.findByText('Paid time off hours per year saved for Sample Alpha.')).toBeInTheDocument();
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

describe('load failures', () => {
  it('keeps the panel hidden when the first time off request fails with a server error', async () => {
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options = {}) => (path.startsWith('/admin/payroll/time-off?')
      ? (calls.push({ path, method: 'GET' }), reply({ error: 'Server error' }, false, 500))
      : original(path, options)));
    render(<PayrollSettings />);
    await screen.findByText('Sample Alpha');
    await waitFor(() => expect(calls.some(c => c.path.startsWith('/admin/payroll/time-off?'))).toBe(true));
    expect(screen.queryByRole('region', { name: 'Time off' })).toBeNull();
    expect(writes()).toHaveLength(0);
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
