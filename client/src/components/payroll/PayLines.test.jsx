// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PayrollSettings from './PayrollSettings';
import { dollarsToCents } from './PayLinesPanel';
import { adminFetch } from '../../lib/adminFetch';

vi.mock('../../lib/adminFetch', () => ({ adminFetch: vi.fn() }));

const reply = (body, ok = true, status = ok ? 200 : 400) => Promise.resolve({ ok, status, json: async () => body });

const TECHS = [
  { id: 'tech-a', name: 'Sample Alpha', payRate: '22.00', payMethod: 'check', payMethodConsentOn: null, employmentStatus: 'active', currentW4: null, flsaOvertimeCovered: null },
  { id: 'tech-b', name: 'Sample Beta', payRate: '25.00', payMethod: 'check', payMethodConsentOn: null, employmentStatus: 'active', currentW4: null, flsaOvertimeCovered: true },
];
const line = (patch = {}) => ({
  id: 'line-1', technicianId: 'tech-a', name: 'Sample Alpha', kind: 'commission', amountCents: 40000, earnedWeekStart: '2026-10-05',
  coversFrom: '2026-09-14', coversTo: '2026-10-11', note: 'Sample note', status: 'open', checkId: null, ...patch,
});
const check = (patch = {}) => ({
  id: 'check-a', technicianId: 'tech-a', name: 'Sample Alpha', status: 'finalized', hourlyRate: '23.00', regularHours: '40.00',
  overtimeHours: '2.00', payMethod: 'check', checkNumber: '1001', grossCents: 102696, federalIncomeTaxCents: 6100,
  socialSecurityCents: 5456, medicareCents: 1276, additionalMedicareCents: 0, netCents: 89864,
  reviewBonusCents: 3000, commissionCents: 0, healthAllowanceCents: 4615, hsaEmployerCents: 20000, lineOvertimePremiumCents: 181, payLines: [],
  ...patch,
});
const totals = { checkCount: 1, grossCents: 102696, employeeTaxesCents: 12832, netCents: 89864, employerTaxesCents: 7000 };
const RUN = {
  id: 'run-1', weekStart: '2026-10-12', weekEnd: '2026-10-18', payDate: '2026-10-23', status: 'finalized',
  checks: [check()], blocked: [], waiting: [], stale: false, token: 't1', totals, voidReason: null,
};
const STUB = {
  checkId: 'check-a', runId: 'run-1',
  employer: { name: 'Waves Pest Control, LLC', addressLine: '1 Sample Way' },
  employee: { name: 'Sample Alpha', ssnLast4: null },
  payPeriod: { start: '2026-10-12', end: '2026-10-18' }, payDate: '2026-10-23',
  hours: { regular: '40.00', overtime: '2.00' }, hourlyRate: '23.00',
  earnings: {
    regularPayCents: 92000, overtimePayCents: 6900, reviewBonusCents: 3000, commissionCents: 0, healthAllowanceCents: 4615,
    lineOvertimePremiumCents: 181, grossCents: 106696,
  },
  employerContributions: { hsaCents: 20000 },
  taxes: { federalIncomeTaxCents: 6100, socialSecurityCents: 5456, medicareCents: 1276, additionalMedicareCents: 0, totalCents: 12832 },
  netCents: 93864, payMethod: 'check', checkNumber: '1001',
  ytd: { grossCents: 106696, federalIncomeTaxCents: 6100, socialSecurityCents: 5456, medicareCents: 1276, additionalMedicareCents: 0, netCents: 93864 },
};

let calls;
let gateOn;
let open;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-25T15:00:00Z'));
  calls = [];
  gateOn = true;
  open = [line()];
  adminFetch.mockReset();
  adminFetch.mockImplementation((path, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ path, method, body: options.body });
    if (path.startsWith('/admin/payroll/pay-lines') && !gateOn) return reply({ enabled: false }, false, 404);
    if (path === '/admin/payroll/technicians') {
      return reply({ technicians: gateOn ? TECHS : TECHS.map(({ flsaOvertimeCovered, ...rest }) => rest) });
    }
    if (path === '/admin/payroll/runs') return reply({ runs: [] });
    if (path === '/admin/payroll/runs/run-1') return reply({ run: RUN });
    if (path === '/admin/payroll/pay-lines?status=open') return reply({ payLines: open });
    if (path === '/admin/payroll/pay-lines?status=paid') return reply({ payLines: [line({ id: 'line-0', kind: 'review_bonus', amountCents: 3000, status: 'paid', coversFrom: null, coversTo: null, note: null })] });
    if (path === '/admin/payroll/pay-lines' && method === 'POST') return reply({ payLine: line({ id: 'line-9' }) }, true, 201);
    if (path.startsWith('/admin/payroll/pay-lines/') && method === 'DELETE') return reply({ deleted: true });
    if (path === '/admin/payroll/technicians/tech-a/flsa-coverage') return reply({ technician: { id: 'tech-a', flsaOvertimeCovered: true } });
    if (path === '/admin/payroll/checks/check-a/stub') return reply({ stub: STUB });
    return reply({}, false, 404);
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const writes = () => calls.filter(c => c.method !== 'GET');
const panel = () => screen.findByRole('region', { name: 'Pay lines' });

describe('dollarsToCents', () => {
  it('reads dollars with at most 2 decimals and nothing else', () => {
    expect(dollarsToCents('46.15')).toBe(4615);
    expect(dollarsToCents(' 30 ')).toBe(3000);
    expect(dollarsToCents('0.5')).toBe(50);
    for (const bad of ['', 'abc', '1.234', '-5', '1e3', '$5']) expect(dollarsToCents(bad)).toBeNull();
  });
});

describe('Pay lines panel (GATE_PAYROLL_PAY_LINES on)', () => {
  it('lists the lines waiting for a pay run and the last paid ones', async () => {
    render(<PayrollSettings />);
    const view = within(await panel());
    const waiting = await view.findByRole('table', { name: 'Pay lines waiting' });
    expect(within(waiting).getByText('Commission')).toBeInTheDocument();
    expect(within(waiting).getByText('$400.00')).toBeInTheDocument();
    expect(within(waiting).getByText('Sep 14, 2026 to Oct 11, 2026')).toBeInTheDocument();
    expect(within(waiting).getByText('Sample note')).toBeInTheDocument();
    const paid = view.getByRole('table', { name: 'Pay lines paid' });
    expect(within(paid).getByText('Review bonus')).toBeInTheDocument();
    expect(within(paid).getByText('Earned week only')).toBeInTheDocument();
    expect(within(paid).queryByRole('button', { name: /Remove/ })).toBeNull();
  });

  it('adds a line and sends whole cents, the earned week and the span', async () => {
    render(<PayrollSettings />);
    const view = within(await panel());
    const form = await view.findByRole('form', { name: 'Add pay line' });
    expect(within(form).getByRole('button', { name: 'Add pay line' })).toBeDisabled();
    fireEvent.change(within(form).getByLabelText(/Employee/), { target: { value: 'tech-a' } });
    fireEvent.change(within(form).getByLabelText(/Kind/), { target: { value: 'health_allowance' } });
    fireEvent.change(within(form).getByLabelText(/Amount/), { target: { value: '46.15' } });
    fireEvent.change(within(form).getByLabelText('Covers from'), { target: { value: '2026-10-01' } });
    // A span with only one date stays closed.
    expect(within(form).getByRole('button', { name: 'Add pay line' })).toBeDisabled();
    fireEvent.change(within(form).getByLabelText('Covers to'), { target: { value: '2026-10-31' } });
    // The earned week follows the last covered date until the person picks one.
    expect(within(form).getByLabelText(/Earned in the week of/)).toHaveValue('2026-10-26');
    fireEvent.change(within(form).getByLabelText('Note'), { target: { value: ' Sample ' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add pay line' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ path: '/admin/payroll/pay-lines', method: 'POST' });
    expect(writes()[0].body).toEqual({
      kind: 'health_allowance', technicianId: 'tech-a', amountCents: 4615, earnedWeekStart: '2026-10-26',
      coversFrom: '2026-10-01', coversTo: '2026-10-31', note: 'Sample',
    });
    expect(await screen.findByText(/Pay line added/)).toBeInTheDocument();
  });

  it('removes a waiting line', async () => {
    render(<PayrollSettings />);
    const view = within(await panel());
    fireEvent.click(await view.findByRole('button', { name: 'Remove Commission for Sample Alpha' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ path: '/admin/payroll/pay-lines/line-1', method: 'DELETE' });
    expect(await screen.findByText('Pay line removed.')).toBeInTheDocument();
  });

  it('shows the server answer when a line is refused', async () => {
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options = {}) => (path === '/admin/payroll/pay-lines' && options.method === 'POST'
      ? reply({ error: 'Pay lines are for W-2 employees.' }, false, 409)
      : original(path, options)));
    render(<PayrollSettings />);
    const form = await within(await panel()).findByRole('form', { name: 'Add pay line' });
    fireEvent.change(within(form).getByLabelText(/Employee/), { target: { value: 'tech-a' } });
    fireEvent.change(within(form).getByLabelText(/Amount/), { target: { value: '30' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add pay line' }));
    expect(await screen.findByText('Pay lines are for W-2 employees.')).toBeInTheDocument();
  });
});

describe('with the gate off', () => {
  it('shows no pay lines panel and no overtime coverage column', async () => {
    gateOn = false;
    render(<PayrollSettings />);
    await screen.findByRole('table', { name: 'W-2 employees' });
    await waitFor(() => expect(calls.some(c => c.path.startsWith('/admin/payroll/pay-lines'))).toBe(true));
    expect(screen.queryByRole('region', { name: 'Pay lines' })).toBeNull();
    expect(screen.queryByText('Federal overtime law covers')).toBeNull();
  });

  it('does not open the panel on a failure that is not the gate answer', async () => {
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options) => {
      if (!path.startsWith('/admin/payroll/pay-lines')) return original(path, options);
      calls.push({ path, method: 'GET' });
      return reply({ error: 'Payroll failed. Try again.' }, false, 500);
    });
    render(<PayrollSettings />);
    await screen.findByRole('table', { name: 'W-2 employees' });
    await waitFor(() => expect(calls.some(c => c.path.startsWith('/admin/payroll/pay-lines'))).toBe(true));
    expect(screen.queryByRole('region', { name: 'Pay lines' })).toBeNull();
  });
});

describe('overtime coverage setting', () => {
  it('shows each employee, saves a change and sends yes, no or cleared', async () => {
    render(<PayrollSettings />);
    const table = await screen.findByRole('table', { name: 'W-2 employees' });
    expect(within(table).getByText('Federal overtime law covers')).toBeInTheDocument();
    const alpha = within(table).getByLabelText('Federal overtime law covers Sample Alpha');
    const beta = within(table).getByLabelText('Federal overtime law covers Sample Beta');
    expect(alpha).toHaveValue('unset');
    expect(beta).toHaveValue('yes');
    fireEvent.change(alpha, { target: { value: 'yes' } });
    const row = alpha.closest('form');
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ path: '/admin/payroll/technicians/tech-a/flsa-coverage', method: 'PUT' });
    expect(writes()[0].body).toEqual({ covered: true });
    expect(await screen.findByText('Overtime coverage saved for Sample Alpha.')).toBeInTheDocument();
  });
});

describe('pay run with pay lines', () => {
  async function openRun() {
    const original = adminFetch.getMockImplementation();
    adminFetch.mockImplementation((path, options) => (path === '/admin/payroll/runs'
      ? reply({ runs: [{ id: 'run-1', weekStart: '2026-10-12', payDate: '2026-10-23', status: 'finalized', totals }] })
      : original(path, options)));
    render(<PayrollSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /Open pay run for/ }));
    return screen.findByRole('table', { name: 'Paychecks' });
  }

  it('shows the lines and the HSA money on the check row', async () => {
    const table = await openRun();
    expect(within(table).getByText('Bonus, commission, allowance')).toBeInTheDocument();
    expect(within(table).getByText('$76.15')).toBeInTheDocument();
    expect(within(table).getByText('Overtime on those')).toBeInTheDocument();
    expect(within(table).getByText('$1.81')).toBeInTheDocument();
    expect(within(table).getByText('HSA from Waves')).toBeInTheDocument();
    expect(within(table).getByText('$200.00')).toBeInTheDocument();
  });

  it('shows the lines and the employer HSA contribution on the stub, outside gross pay', async () => {
    await openRun();
    fireEvent.click(await screen.findByRole('button', { name: 'Stub for Sample Alpha' }));
    const stub = within(await screen.findByLabelText('Pay stub'));
    const amounts = within(stub.getByRole('table', { name: 'Pay stub amounts' }));
    expect(amounts.getByText('Review bonus')).toBeInTheDocument();
    expect(amounts.getByText('Health allowance')).toBeInTheDocument();
    expect(amounts.getByText('Overtime on bonus, commission and allowance')).toBeInTheDocument();
    expect(amounts.queryByText('Commission')).toBeNull();
    expect(stub.getByText('Employer contributions')).toBeInTheDocument();
    expect(stub.getByText('HSA from Waves (not part of gross pay or taxes)')).toBeInTheDocument();
  });

  it('shows none of it when the checks carry no pay line figures', async () => {
    const original = adminFetch.getMockImplementation();
    const plain = check({ reviewBonusCents: 0, healthAllowanceCents: 0, hsaEmployerCents: 0, lineOvertimePremiumCents: 0 });
    adminFetch.mockImplementation((path, options) => (path === '/admin/payroll/runs/run-1'
      ? reply({ run: { ...RUN, checks: [plain] } })
      : original(path, options)));
    const table = await openRun();
    expect(within(table).queryByText('Bonus, commission, allowance')).toBeNull();
    expect(within(table).queryByText('HSA from Waves')).toBeNull();
  });
});
