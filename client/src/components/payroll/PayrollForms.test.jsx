// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PayrollForms from './PayrollForms';
import PayrollSettings from './PayrollSettings';
import { adminFetch } from '../../lib/adminFetch';

vi.mock('../../lib/adminFetch', () => ({ adminFetch: vi.fn() }));

const reply = (body, ok = true, status = ok ? 200 : 400) => Promise.resolve({ ok, status, json: async () => body });

const FIGURES = {
  year: 2026,
  quarter: 4,
  employer: { name: 'Sample Business, LLC', address: '1 Example Way, Testville, FL 00000', ein: 'Enter from your records' },
  f941: {
    form: '941',
    rows: [
      { line: '1', label: 'Number of employees', kind: 'count', value: 2 },
      { line: '2', label: 'Wages, tips, and other compensation', kind: 'cents', value: 123456 },
      { line: '5a', label: 'Taxable social security wages', kind: 'cents', value: 100000, rate: '12.4%', value2: 12400 },
      { line: '7', label: 'Adjustment for fractions of cents', kind: 'cents', value: -1 },
      { line: '16', label: 'Deposit schedule', kind: 'text', value: 'Line 12 is less than $2,500: no schedule is needed' },
    ],
    notes: ['Line 13 counts only deposits you marked paid on the Tax page.'],
  },
  rt6: {
    form: 'RT-6',
    rows: [{ line: '2', label: 'Gross wages', kind: 'cents', value: 123456 }],
    employees: [{ name: 'Sample Alpha', grossCents: 123456, taxableCents: 100000, ssn: 'Enter from your records' }],
    notes: [],
  },
  f940: { form: '940', rows: [{ line: '3', label: 'Total payments to all employees', kind: 'cents', value: 500000 }], notes: ['Part 5 is not needed because line 12 is $500 or less.'] },
  w2: [
    {
      technicianId: 'tech-a', name: 'Sample Alpha', address: null, ssn: 'Enter from your records', box1: 123456, box2: 10000, box3: 123456, box4: 7654,
      box5: 123456, box6: 1790, box12TT: 2500, state: 'Florida has no state income tax: boxes 15 to 17 stay empty.',
    },
    {
      technicianId: 'tech-b', name: 'Sample Beta', address: '2 Example Way, Testville, FL 00000', ssn: 'Enter from your records', box1: 1000, box2: 0, box3: 1000, box4: 62,
      box5: 1000, box6: 15, box12TT: null, state: 'Florida has no state income tax: boxes 15 to 17 stay empty.',
    },
  ],
  w3: { boxC: 2, box1: 124456, box2: 10000, box3: 124456, box4: 7716, box5: 124456, box6: 1805 },
};

let writeText;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-05T15:00:00Z'));
  adminFetch.mockReset();
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const callWith = (handler) => vi.fn(async (path) => handler(path));

describe('Tax forms section', () => {
  it('renders nothing while the gate is off (the server answers 404)', async () => {
    const call = vi.fn(() => Promise.reject(Object.assign(new Error('Payroll request failed (404).'), { status: 404 })));
    const { container } = render(<PayrollForms call={call} />);
    await waitFor(() => expect(call).toHaveBeenCalled());
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('Tax forms')).toBeNull();
  });

  it('asks for the current year and quarter, then shows the four forms with their own line labels', async () => {
    const call = callWith(() => FIGURES);
    render(<PayrollForms call={call} />);
    await screen.findByRole('heading', { name: 'Tax forms' });
    expect(call).toHaveBeenCalledWith('/forms?year=2026&quarter=4');
    for (const name of ['Form 941, Q4 2026', 'Florida RT-6, Q4 2026', 'Form 940, 2026', 'W-2 and W-3, 2026']) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
    const f941 = within(screen.getByRole('table', { name: 'Form 941 Q4 2026' }));
    expect(f941.getByText('Wages, tips, and other compensation')).toBeInTheDocument();
    expect(f941.getByText('$1,234.56')).toBeInTheDocument();
    expect(f941.getByText('-$0.01')).toBeInTheDocument();
    expect(f941.getByText('Rate 12.4%')).toBeInTheDocument();
    expect(f941.getByText('$124.00')).toBeInTheDocument(); // 5a tax column
    expect(f941.getByText(/no schedule is needed/)).toBeInTheDocument();
    expect(screen.getByText(/Line 13 counts only deposits/)).toBeInTheDocument();
    // The count has no dollar sign.
    expect(within(f941.getByText('Number of employees').closest('tr')).getByText('2')).toBeInTheDocument();
  });

  it('shows each W-2 and the W-3 totals; the SSN and a missing address read "Enter from your records"', async () => {
    render(<PayrollForms call={callWith(() => FIGURES)} />);
    await screen.findByRole('heading', { name: 'Tax forms' });
    const alpha = screen.getByRole('table', { name: 'W-2 for Sample Alpha' });
    expect(within(alpha).getByText('Qualified overtime compensation')).toBeInTheDocument();
    const beta = screen.getByRole('table', { name: 'W-2 for Sample Beta' });
    expect(within(beta).queryByText('Qualified overtime compensation')).toBeNull();
    expect(screen.getByText(/Social Security number: Enter from your records\. Address: Enter from your records\./)).toBeInTheDocument();
    expect(screen.getByText(/Address: 2 Example Way, Testville, FL 00000/)).toBeInTheDocument();
    expect(screen.getAllByText(/Florida has no state income tax/)).toHaveLength(2);
    const w3 = within(screen.getByRole('table', { name: 'W-3 totals' }));
    expect(w3.getByText('Total number of Forms W-2')).toBeInTheDocument();
    expect(w3.getAllByText('$1,244.56')).toHaveLength(3);
    // No box 12 TT total on the W-3: TT stays on each W-2 (IRS W-2/W-3 instructions).
    expect(w3.queryByText('Qualified overtime compensation')).toBeNull();
    expect(screen.getByText(/EIN: Enter from your records/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
  });

  it('lists the RT-6 employees with the SSN left to your records', async () => {
    render(<PayrollForms call={callWith(() => FIGURES)} />);
    await screen.findByRole('heading', { name: 'Tax forms' });
    const list = within(screen.getByRole('table', { name: 'RT-6 employee list' }));
    expect(list.getByText('Sample Alpha')).toBeInTheDocument();
    expect(list.getByText('Enter from your records')).toBeInTheDocument();
  });

  it('a copy button puts the plain amount on the clipboard', async () => {
    render(<PayrollForms call={callWith(() => FIGURES)} />);
    await screen.findByRole('heading', { name: 'Tax forms' });
    fireEvent.click(screen.getByRole('button', { name: 'Copy Form 941 Q4 2026 line 2 amount' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('1234.56'));
    expect(await screen.findByRole('button', { name: 'Copy Form 941 Q4 2026 line 2 amount' })).toHaveTextContent('Copied');
    fireEvent.click(screen.getByRole('button', { name: 'Copy Form 941 Q4 2026 line 7 amount' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('-0.01'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy Form 941 Q4 2026 line 1 count' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('2'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy Form 941 Q4 2026 line 5a tax' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('124.00'));
  });

  it('when the clipboard refuses, the number is selected instead', async () => {
    writeText.mockImplementation(() => Promise.reject(new Error('denied')));
    render(<PayrollForms call={callWith(() => FIGURES)} />);
    await screen.findByRole('heading', { name: 'Tax forms' });
    fireEvent.click(screen.getByRole('button', { name: 'Copy Form 941 Q4 2026 line 2 amount' }));
    await screen.findByText(/Selected\. Press Ctrl\+C or Cmd\+C\./);
    expect(window.getSelection().toString()).toBe('$1,234.56');
  });

  it('asks again when the quarter or the year changes', async () => {
    const call = callWith(() => FIGURES);
    render(<PayrollForms call={call} />);
    await screen.findByRole('heading', { name: 'Tax forms' });
    fireEvent.change(screen.getByLabelText('Quarter'), { target: { value: '2' } });
    await waitFor(() => expect(call).toHaveBeenCalledWith('/forms?year=2026&quarter=2'));
    expect(Array.from(screen.getByLabelText('Year').querySelectorAll('option')).map(o => o.textContent)).toEqual(['2026']);
  });

  it('asks again when the page says the pay runs changed (refreshKey)', async () => {
    const call = callWith(() => FIGURES);
    const { rerender } = render(<PayrollForms call={call} refreshKey={0} />);
    await screen.findByRole('heading', { name: 'Tax forms' });
    expect(call).toHaveBeenCalledTimes(1);
    rerender(<PayrollForms call={call} refreshKey={1} />);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call).toHaveBeenLastCalledWith('/forms?year=2026&quarter=4');
  });

  it('shows the server message when the figures cannot load', async () => {
    const call = vi.fn(() => Promise.reject(Object.assign(new Error('Payroll failed. Try again.'), { status: 500 })));
    render(<PayrollForms call={call} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Payroll failed. Try again.');
  });

  it('says so when a year has no final pay checks', async () => {
    const empty = { ...FIGURES, w2: [], w3: { boxC: 0, box1: 0, box2: 0, box3: 0, box4: 0, box5: 0, box6: 0 } };
    render(<PayrollForms call={callWith(() => empty)} />);
    expect(await screen.findByText('No final pay checks in 2026.')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'W-3 totals' })).toBeNull();
  });
});

describe('Payroll tab wiring', () => {
  const mockAdmin = (forms) => adminFetch.mockImplementation((path) => {
    if (path === '/admin/payroll/technicians') return reply({ technicians: [] });
    if (path === '/admin/payroll/runs') return reply({ runs: [] });
    if (path.startsWith('/admin/payroll/forms')) return forms();
    return reply({}, false, 404);
  });

  it('shows the section under the pay runs when the gate is on', async () => {
    mockAdmin(() => reply(FIGURES));
    render(<PayrollSettings />);
    expect(await screen.findByRole('heading', { name: 'Tax forms' })).toBeInTheDocument();
    expect(adminFetch).toHaveBeenCalledWith('/admin/payroll/forms?year=2026&quarter=4', {});
  });

  it('shows nothing of it when the gate is off', async () => {
    mockAdmin(() => reply({ enabled: false }, false, 404));
    render(<PayrollSettings />);
    await screen.findByRole('heading', { name: 'Payroll' });
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith('/admin/payroll/forms?year=2026&quarter=4', {}));
    await Promise.resolve();
    expect(screen.queryByText('Tax forms')).toBeNull();
  });
});
