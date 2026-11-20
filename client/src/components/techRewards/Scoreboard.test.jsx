// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Scoreboard, { ScoreboardPreview } from './Scoreboard';
import useTechScoreboardAvailability from '../../hooks/useTechScoreboardAvailability';
import { adminFetch } from '../../lib/adminFetch';

vi.mock('../../lib/adminFetch', () => ({ adminFetch: vi.fn() }));

const reply = (body, ok = true, status = ok ? 200 : 400) => Promise.resolve({ ok, status, json: async () => body });

const BOARD = {
  technician: { id: 'tech-1', name: 'Sample Alpha' },
  asOf: '2026-11-20',
  season: { year: 2026, start: '2026-03-01', end: '2026-08-31', status: 'final', payDate: '2026-09-25' },
  score: {
    complete: true, value: 91.5, missing: [], settingsVersion: 0,
    band: { rateBps: 400, cutLines: { top: 90, mid: 80, low: 70 } },
    parts: {
      onTime: { value: 95, weight: 25 }, audit: { value: 90, weight: 25 }, callbacks: { value: 88, weight: 20 },
      truck: { value: 100, weight: 10 }, ownerRating: { value: 85, weight: 20 },
    },
  },
  reviews: { count: 6, asks: 30, rateBps: 2000, multiplierPartE4: 3333 },
  commission: { year: 2026, yearToDateCents: 30000, paidCents: 20000, unpaidCents: 10000, recordedThrough: { weekEnd: '2026-11-08' } },
  multiplier: { multiplierE4: 15833, parts: { baseE4: 10000, tenureE4: 2500, reviewRateE4: 3333, levelE4: 0 }, tenureYears: 1, level: 1, levelSource: 'entry_default' },
  seasonBonus: { grossCents: 1000000, estimate: true, estimateCents: 63332, rateBps: 400, multiplierE4: 15833 },
  stayBonus: { dueDate: '2027-01-05', years: 1, rateBps: 200, estimateCents: 40000, estimate: true, earningsStart: '2026-01-05', earningsEnd: '2027-01-04' },
};

beforeEach(() => { adminFetch.mockReset(); });

// Open the Scoreboard tab with the server answering `board`; resolves once the board has rendered.
async function showBoard(board) {
  adminFetch.mockImplementation(() => reply({ scoreboard: board }));
  render(<Scoreboard />);
  await screen.findByLabelText(`Scoreboard for ${board.technician.name}`);
}
afterEach(cleanup);

describe('Tech scoreboard tab', () => {
  it('loads the caller own board when the tab opens, in one request, and shows score, parts, review rate, commission and estimates', async () => {
    await showBoard(BOARD);
    expect(adminFetch.mock.calls.map(c => c[0])).toEqual(['/tech/rewards-scoreboard']);
    expect(screen.getByText(/2026 season.*over\. Bonus pay is scheduled for Sep 25, 2026\. Figures stay estimates until the office finalizes the pay\./)).toBeInTheDocument();
    expect(screen.getByText('91.5%')).toBeInTheDocument();
    const parts = screen.getByRole('table', { name: 'Score parts' });
    expect(within(parts).getByText('Reports on time')).toBeInTheDocument();
    expect(within(parts).getByText('95%')).toBeInTheDocument();
    expect(screen.getByText('20.0%')).toBeInTheDocument();
    expect(screen.getByText('6 Google reviews from 30 asks this season.')).toBeInTheDocument();
    expect(screen.getByText('$300.00')).toBeInTheDocument();
    expect(screen.getByText('Commission recorded, 2026')).toBeInTheDocument();
    expect(screen.getByText(/Payments through Nov 8, 2026\. \$200\.00 paid, \$100\.00 not paid yet\. A later payment is not counted until a pay run records it\./)).toBeInTheDocument();
    expect(screen.getByText('$633.32')).toBeInTheDocument();
    expect(screen.getByText(/Estimate, final at season end\. 4\.0% of \$10,000\.00 pay x 1\.58x multiplier\./)).toBeInTheDocument();
    expect(screen.getByText('Jan 5, 2027')).toBeInTheDocument();
    expect(screen.getByText(/1-year bonus, about \$400\.00\. Estimate from pay recorded so far; pay earned through Jan 4, 2027 counts\. Payroll confirms the final amount\./)).toBeInTheDocument();
    expect(screen.getByText(/your level is not recorded yet/)).toBeInTheDocument();
  });

  it('the Staff page check asks only whether the tab shows: no board request', async () => {
    adminFetch.mockImplementation(() => reply({ available: true }));
    const { result } = renderHook(() => useTechScoreboardAvailability());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(adminFetch.mock.calls.map(c => c[0])).toEqual(['/tech/rewards-scoreboard/availability']);
  });

  it.each([[{ available: false }, true, 'off'], [{}, false, 'error']])('the availability check %j fails closed', async (body, ok, status) => {
    adminFetch.mockImplementation(() => reply(body, ok, ok ? 200 : 500));
    const { result } = renderHook(() => useTechScoreboardAvailability());
    await waitFor(() => expect(result.current.status).toBe(status));
  });

  it('a 404 when the tab opens renders nothing', async () => {
    adminFetch.mockImplementation(() => reply({ enabled: false }, false, 404));
    const { container } = render(<Scoreboard />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(adminFetch).toHaveBeenCalledTimes(1);
  });

  it('shows the server error when the board fails to load', async () => {
    adminFetch.mockImplementation(() => reply({ error: 'boom' }, false, 500));
    render(<Scoreboard />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });

  it('says what is missing when the score is incomplete and gives no bonus number', async () => {
    const board = {
      ...BOARD,
      season: { ...BOARD.season, status: 'running' },
      score: { complete: false, value: null, missing: ['audit', 'ownerRating'], band: null, settingsVersion: 0, parts: { ...BOARD.score.parts, audit: { value: null, weight: 25 }, ownerRating: { value: null, weight: 20 } } },
      reviews: { count: 0, asks: 0, rateBps: null, multiplierPartE4: 0 },
      seasonBonus: { grossCents: 500000, estimate: true, estimateCents: null, reason: 'score_incomplete' },
      stayBonus: null,
    };
    await showBoard(board);
    expect(screen.getByText(/Not complete: Protocol audit, Owner rating have no data yet\./)).toBeInTheDocument();
    expect(screen.getAllByText('No data yet')).toHaveLength(2);
    expect(screen.getByText('Not estimated yet')).toBeInTheDocument();
    expect(screen.getByText('No estimate yet: a score part has no data so far.')).toBeInTheDocument();
    expect(screen.getByText('No asks yet')).toBeInTheDocument();
    expect(screen.getByText('None left')).toBeInTheDocument();
    expect(screen.getByText(/running, the numbers so far/)).toBeInTheDocument();
  });

  it('shows the stay bonus date but no amount while its 12 months of pay have not begun', async () => {
    const board = { ...BOARD, stayBonus: { dueDate: '2028-04-01', years: 3, rateBps: 400, estimateCents: null, estimate: true, earningsStart: '2027-04-01' } };
    await showBoard(board);
    expect(screen.getByText('Apr 1, 2028')).toBeInTheDocument();
    expect(screen.getByText(/3-year bonus\. Estimate starts Apr 1, 2027/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/about \$0\.00/);
  });

  it('shows the score and bonus as unavailable when no score settings are in force, with the rest intact', async () => {
    const board = {
      ...BOARD,
      score: { complete: false, value: null, missing: [], parts: {}, band: null, settingsVersion: null, unavailable: 'no_settings' },
      seasonBonus: { grossCents: 1000000, estimate: true, estimateCents: null, reason: 'no_settings' },
    };
    await showBoard(board);
    expect(screen.getByText('Not available yet: the score settings for this season are not set.')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Score parts' })).not.toBeInTheDocument();
    expect(screen.getByText('No estimate yet: the score settings for this season are not set.')).toBeInTheDocument();
    expect(screen.getByText('20.0%')).toBeInTheDocument();
    expect(screen.getByText('$300.00')).toBeInTheDocument();
    expect(screen.getByText('Jan 5, 2027')).toBeInTheDocument();
  });

  it('shows the cutoff with its year, including a year after the commission year', async () => {
    const board = { ...BOARD, commission: { ...BOARD.commission, recordedThrough: { weekEnd: '2027-01-03' } } };
    await showBoard(board);
    expect(screen.getByText(/Payments through Jan 3, 2027\./)).toBeInTheDocument();
  });

  it('shows no cutoff date when none can be established', async () => {
    const board = { ...BOARD, commission: { year: 2026, yearToDateCents: 0, paidCents: 0, unpaidCents: 0, recordedThrough: null } };
    await showBoard(board);
    expect(screen.getByText(/^Recorded through the last pay run\. \$0\.00 paid/)).toBeInTheDocument();
  });

  it('shows no customer data', async () => {
    await showBoard(BOARD);
    expect(document.body.textContent).not.toMatch(/customer name|address|@/i);
  });
});

describe('Admin scoreboard preview', () => {
  it('lists technicians and opens one board through the admin route', async () => {
    adminFetch.mockImplementation(path => {
      if (path === '/admin/tech-rewards-scoreboard') return reply({ technicians: [{ id: 'tech-1', name: 'Sample Alpha' }, { id: 'tech-2', name: 'Sample Beta' }] });
      if (path === '/admin/tech-rewards-scoreboard/tech-2') return reply({ scoreboard: { ...BOARD, technician: { id: 'tech-2', name: 'Sample Beta' } } });
      return reply({}, false, 404);
    });
    render(<ScoreboardPreview />);
    const select = await screen.findByLabelText('Technician');
    await waitFor(() => expect(select).not.toBeDisabled());
    fireEvent.change(select, { target: { value: 'tech-2' } });
    expect(await screen.findByLabelText('Scoreboard for Sample Beta')).toBeInTheDocument();
    expect(adminFetch.mock.calls.map(c => c[0])).toEqual(['/admin/tech-rewards-scoreboard', '/admin/tech-rewards-scoreboard/tech-2']);
  });

  it('shows a server error', async () => {
    adminFetch.mockImplementation(() => reply({ error: 'Technician not found.' }, false, 404));
    render(<ScoreboardPreview />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Technician not found.');
  });
});
