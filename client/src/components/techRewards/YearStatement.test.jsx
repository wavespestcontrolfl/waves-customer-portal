// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import YearStatement from './YearStatement';
import { adminFetch } from '../../lib/adminFetch';

vi.mock('../../lib/adminFetch', () => ({ adminFetch: vi.fn() }));

const reply = (body, ok = true, status = ok ? 200 : 400) => Promise.resolve({ ok, status, json: async () => body });
const PATH = '/tech/rewards-scoreboard/year-statement';

const STATEMENT = {
  technician: { id: 'tech-1', name: 'Sample Alpha' },
  year: 2027,
  years: [2027, 2026],
  checkCount: 3,
  firstPayDate: '2027-01-08',
  lastPayDate: '2027-12-24',
  pay: {
    regularPayCents: 700000, overtimePayCents: 50000, ptoPayCents: 20000, holidayPayCents: 0,
    commissionCents: 60000, reviewBonusCents: 4500, healthAllowanceCents: 30000,
    seasonBonusCents: 80000, stayBonusCents: 0, decemberGiftCents: 30000,
    lineOvertimePremiumCents: 5500, otherCents: 0, grossCents: 980000,
  },
  fromWaves: { simpleEmployerCents: 19600, hsaEmployerCents: 12000 },
  totalCents: 1011600,
  withheld: { federalIncomeTaxCents: 90000, socialSecurityCents: 60760, medicareCents: 14210, totalCents: 164970 },
  simpleSavingsCents: 29400,
  netCents: 785630,
};

const rowOf = (table, label) => within(table).getByText(label).closest('tr');

beforeEach(() => { adminFetch.mockReset(); });
afterEach(cleanup);

describe('Yearly pay statement', () => {
  it('asks for this year first (no year in the request) and shows each part of gross pay, the taxes, the savings and net pay', async () => {
    adminFetch.mockImplementation(() => reply({ statement: STATEMENT }));
    render(<YearStatement path={PATH} />);
    const pay = await screen.findByRole('table', { name: 'Pay in 2027' });
    expect(adminFetch.mock.calls.map(c => c[0])).toEqual([PATH]);
    expect(screen.getByText('3 paychecks, pay dates Jan 8, 2027 to Dec 24, 2027.')).toBeInTheDocument();
    for (const [label, amount] of [
      ['Regular pay', '$7,000.00'], ['Overtime pay', '$500.00'], ['Paid time off', '$200.00'], ['Review bonus', '$45.00'],
      ['Commission', '$600.00'], ['Health allowance', '$300.00'], ['Season bonus', '$800.00'], ['December gift', '$300.00'],
      ['Overtime on bonus, commission and allowance', '$55.00'], ['Gross pay', '$9,800.00'], ['Federal income tax', '$900.00'],
      ['Social Security', '$607.60'], ['Medicare', '$142.10'], ['SIMPLE IRA (pre-tax)', '$294.00'], ['Net pay', '$7,856.30'],
    ]) expect(rowOf(pay, label)).toHaveTextContent(amount);
    expect(screen.getByText(/Paid amounts from finalized paychecks, by pay date\. Not estimates\./)).toBeInTheDocument();
  });

  it('leaves out a part with nothing in the year', async () => {
    adminFetch.mockImplementation(() => reply({ statement: STATEMENT }));
    render(<YearStatement path={PATH} />);
    const pay = await screen.findByRole('table', { name: 'Pay in 2027' });
    for (const absent of ['Holiday pay', 'Stay bonus', 'Other pay']) expect(within(pay).queryByText(absent)).not.toBeInTheDocument();
  });

  it('shows the money from Waves on top of gross pay, and the two together', async () => {
    adminFetch.mockImplementation(() => reply({ statement: STATEMENT }));
    render(<YearStatement path={PATH} />);
    const waves = await screen.findByRole('table', { name: 'From Waves in 2027, on top of gross pay' });
    expect(rowOf(waves, 'SIMPLE IRA from Waves')).toHaveTextContent('$196.00');
    expect(rowOf(waves, 'HSA from Waves')).toHaveTextContent('$120.00');
    expect(rowOf(waves, 'Gross pay plus the money from Waves')).toHaveTextContent('$10,116.00');
  });

  it('shows no "from Waves" table when the paychecks hold no money from Waves on top', async () => {
    adminFetch.mockImplementation(() => reply({ statement: { ...STATEMENT, fromWaves: { simpleEmployerCents: 0, hsaEmployerCents: 0 }, totalCents: 980000, simpleSavingsCents: 0 } }));
    render(<YearStatement path={PATH} />);
    const pay = await screen.findByRole('table', { name: 'Pay in 2027' });
    expect(screen.queryByRole('table', { name: 'From Waves in 2027, on top of gross pay' })).not.toBeInTheDocument();
    expect(within(pay).queryByText('SIMPLE IRA (pre-tax)')).not.toBeInTheDocument();
  });

  it('shows pay no row names as "Other pay", so the rows still add up to gross pay', async () => {
    adminFetch.mockImplementation(() => reply({ statement: { ...STATEMENT, pay: { ...STATEMENT.pay, seasonBonusCents: 70000, otherCents: 10000 } } }));
    render(<YearStatement path={PATH} />);
    const pay = await screen.findByRole('table', { name: 'Pay in 2027' });
    expect(rowOf(pay, 'Other pay')).toHaveTextContent('$100.00');
  });

  it('picks another year from the years with a paycheck', async () => {
    adminFetch.mockImplementation(path => reply({ statement: path.endsWith('?year=2026')
      ? { ...STATEMENT, year: 2026, checkCount: 1, firstPayDate: '2026-12-18', lastPayDate: '2026-12-18' }
      : STATEMENT }));
    render(<YearStatement path={PATH} />);
    const select = await screen.findByLabelText('Year');
    expect(select).toHaveValue('2027');
    expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual(['2027', '2026']);
    fireEvent.change(select, { target: { value: '2026' } });
    expect(await screen.findByRole('table', { name: 'Pay in 2026' })).toBeInTheDocument();
    expect(screen.getByText('1 paycheck, pay dates Dec 18, 2026 to Dec 18, 2026.')).toBeInTheDocument();
    expect(adminFetch.mock.calls.map(c => c[0])).toEqual([PATH, `${PATH}?year=2026`]);
    expect(screen.getByLabelText('Year')).toHaveValue('2026');
  });

  it('says so when the year has no paycheck', async () => {
    adminFetch.mockImplementation(() => reply({ statement: { ...STATEMENT, checkCount: 0, firstPayDate: null, lastPayDate: null } }));
    render(<YearStatement path={PATH} />);
    expect(await screen.findByText('No paychecks with a pay date in 2027.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows the server error, and a plain one when the request fails', async () => {
    adminFetch.mockImplementation(() => reply({ error: 'Year must be a four-digit year, 2020 or later.' }, false, 400));
    render(<YearStatement path={PATH} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Year must be a four-digit year, 2020 or later.');
    cleanup();
    adminFetch.mockImplementation(() => Promise.reject(new Error('network')));
    render(<YearStatement path={PATH} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load the pay statement.');
  });

  it('loads the other person when the path changes', async () => {
    adminFetch.mockImplementation(path => reply({ statement: { ...STATEMENT, technician: { id: path, name: path } } }));
    const { rerender } = render(<YearStatement key="a" path="/admin/tech-rewards-scoreboard/a/year-statement" />);
    await screen.findByRole('table', { name: 'Pay in 2027' });
    rerender(<YearStatement key="b" path="/admin/tech-rewards-scoreboard/b/year-statement" />);
    await screen.findByRole('table', { name: 'Pay in 2027' });
    expect(adminFetch.mock.calls.map(c => c[0])).toEqual(['/admin/tech-rewards-scoreboard/a/year-statement', '/admin/tech-rewards-scoreboard/b/year-statement']);
  });

  it('shows no customer data', async () => {
    adminFetch.mockImplementation(() => reply({ statement: STATEMENT }));
    render(<YearStatement path={PATH} />);
    await screen.findByRole('table', { name: 'Pay in 2027' });
    expect(document.body.textContent).not.toMatch(/customer name|address|@/i);
  });
});
