// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TechPayStubs from './TechPayStubs';
import useTechPayStubs from '../../hooks/useTechPayStubs';
import { adminFetch } from '../../lib/adminFetch';

vi.mock('../../lib/adminFetch', () => ({ adminFetch: vi.fn() }));

const reply = (body, ok = true, status = ok ? 200 : 400) => Promise.resolve({ ok, status, json: async () => body });

const CHECKS = [
  { id: 'check-b', name: 'Sample Alpha', weekStart: '2026-10-12', payDate: '2026-10-23', grossCents: 94600, netCents: 81263, regularHours: '40.00', overtimeHours: '2.00', payMethod: 'check' },
  { id: 'check-a', name: 'Sample Alpha', weekStart: '2026-10-05', payDate: '2026-10-16', grossCents: 88000, netCents: 75000, regularHours: '40.00', overtimeHours: '0.00', payMethod: 'bank_transfer' },
];
const STUB = {
  checkId: 'check-b', runId: 'run-1',
  employer: { name: 'Waves Pest Control, LLC', addressLine: '13649 Luxe Ave #110, Bradenton, FL 34211' },
  employee: { name: 'Sample Alpha', ssnLast4: '4321' },
  payPeriod: { start: '2026-10-12', end: '2026-10-18' }, payDate: '2026-10-23',
  hours: { regular: '40.00', overtime: '2.00' }, hourlyRate: '22.00',
  earnings: { regularPayCents: 88000, overtimePayCents: 6600, grossCents: 94600 },
  taxes: { federalIncomeTaxCents: 6100, socialSecurityCents: 5865, medicareCents: 1372, additionalMedicareCents: 0, totalCents: 13337 },
  netCents: 81263, payMethod: 'check', checkNumber: '1001',
  ytd: { grossCents: 189200, federalIncomeTaxCents: 12200, socialSecurityCents: 11730, medicareCents: 2744, additionalMedicareCents: 0, netCents: 162526 },
};

beforeEach(() => { adminFetch.mockReset(); });
afterEach(cleanup);

describe('Pay stubs for a technician', () => {
  it('lists the own checks and opens a stub without employer taxes', async () => {
    adminFetch.mockImplementation(path => {
      if (path === '/tech/payroll/checks') return reply({ checks: CHECKS });
      if (path === '/tech/payroll/checks/check-b/stub') return reply({ stub: STUB });
      return reply({}, false, 404);
    });
    const { result } = renderHook(() => useTechPayStubs());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    render(<TechPayStubs stubs={result.current} />);
    const list = screen.getByRole('table', { name: 'Your pay stubs' });
    expect(within(list).getAllByRole('row')).toHaveLength(3);
    expect(within(list).getByText('Oct 23, 2026')).toBeInTheDocument();
    expect(within(list).getByText('$812.63')).toBeInTheDocument();
    expect(within(list).getByText('40.00 + 2.00 OT')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open pay stub for pay date Oct 23, 2026' }));
    const dialog = await screen.findByRole('dialog');
    const stub = await within(dialog).findByLabelText('Pay stub');
    expect(stub).toHaveTextContent('Waves Pest Control, LLC');
    expect(stub).toHaveTextContent('Pay period Oct 12, 2026 to Oct 18, 2026');
    expect(stub).toHaveTextContent('Check number1001');
    expect(stub.textContent).not.toMatch(/employer tax|FUTA|reemployment/i);
    expect(adminFetch.mock.calls.map(c => c[0])).toEqual(['/tech/payroll/checks', '/tech/payroll/checks/check-b/stub']);
  });

  it('says so when there are no stubs yet', async () => {
    render(<TechPayStubs stubs={{ status: 'ready', checks: [] }} />);
    expect(screen.getByText('No pay stubs yet.')).toBeInTheDocument();
  });

  it('gate off: the one request answers 404, the status is off and nothing renders', async () => {
    adminFetch.mockImplementation(() => reply({ enabled: false }, false, 404));
    const { result } = renderHook(() => useTechPayStubs());
    await waitFor(() => expect(result.current.status).toBe('off'));
    const { container } = render(<TechPayStubs stubs={result.current} />);
    expect(container).toBeEmptyDOMElement();
    expect(adminFetch).toHaveBeenCalledTimes(1);
  });

  it('a failed request hides the tab and keeps the reason; a pending request renders nothing', async () => {
    adminFetch.mockImplementation(() => reply({ error: 'Pay stubs failed. Try again.' }, false, 500));
    const { result } = renderHook(() => useTechPayStubs());
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('Pay stubs failed. Try again.');
    expect(render(<TechPayStubs stubs={result.current} />).container).toBeEmptyDOMElement();
    expect(render(<TechPayStubs stubs={{ status: 'loading', checks: [] }} />).container).toBeEmptyDOMElement();
  });
});
