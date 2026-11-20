// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Scoreboard, { ScoreboardPreview } from './Scoreboard';
import useTechScoreboard from '../../hooks/useTechScoreboard';
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
  commission: { year: 2026, yearToDateCents: 30000, paidCents: 20000, pendingCents: 10000 },
  multiplier: { multiplierE4: 15833, parts: { baseE4: 10000, tenureE4: 2500, reviewRateE4: 3333, levelE4: 0 }, tenureYears: 1, level: 1, levelSource: 'entry_default' },
  seasonBonus: { grossCents: 1000000, estimate: true, estimateCents: 63332, rateBps: 400, multiplierE4: 15833 },
  stayBonus: { dueDate: '2027-01-05', years: 1, rateBps: 200, estimateCents: 40000, estimate: true },
};

beforeEach(() => { adminFetch.mockReset(); });
afterEach(cleanup);

describe('Tech scoreboard tab', () => {
  it('loads the caller own board in one request and shows score, parts, review rate, commission and estimates', async () => {
    adminFetch.mockImplementation(() => reply({ scoreboard: BOARD }));
    const { result } = renderHook(() => useTechScoreboard());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(adminFetch.mock.calls.map(c => c[0])).toEqual(['/tech/rewards-scoreboard']);
    render(<Scoreboard board={result.current} />);
    expect(screen.getByText(/2026 season.*over\. These are its final figures; the bonus is paid Sep 25, 2026/)).toBeInTheDocument();
    expect(screen.getByText('91.5%')).toBeInTheDocument();
    const parts = screen.getByRole('table', { name: 'Score parts' });
    expect(within(parts).getByText('Reports on time')).toBeInTheDocument();
    expect(within(parts).getByText('95%')).toBeInTheDocument();
    expect(screen.getByText('20.0%')).toBeInTheDocument();
    expect(screen.getByText('6 Google reviews from 30 asks this season.')).toBeInTheDocument();
    expect(screen.getByText('$300.00')).toBeInTheDocument();
    expect(screen.getByText('$200.00 paid, $100.00 waiting for the next pay run.')).toBeInTheDocument();
    expect(screen.getByText('$633.32')).toBeInTheDocument();
    expect(screen.getByText(/Estimate, final at season end\. 4\.0% of \$10,000\.00 pay x 1\.58x multiplier\./)).toBeInTheDocument();
    expect(screen.getByText('Jan 5, 2027')).toBeInTheDocument();
    expect(screen.getByText(/1-year bonus, about \$400\.00\. Estimate, final at season end\./)).toBeInTheDocument();
    expect(screen.getByText(/your level is not recorded yet/)).toBeInTheDocument();
  });

  it('reads a 404 as off: nothing renders and no other request is made', async () => {
    adminFetch.mockImplementation(() => reply({ enabled: false }, false, 404));
    const { result } = renderHook(() => useTechScoreboard());
    await waitFor(() => expect(result.current.status).toBe('off'));
    const { container } = render(<Scoreboard board={result.current} />);
    expect(container).toBeEmptyDOMElement();
    expect(adminFetch).toHaveBeenCalledTimes(1);
  });

  it('fails closed on an error', async () => {
    adminFetch.mockImplementation(() => reply({ error: 'boom' }, false, 500));
    const { result } = renderHook(() => useTechScoreboard());
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(render(<Scoreboard board={result.current} />).container).toBeEmptyDOMElement();
  });

  it('says what is missing when the score is incomplete and gives no bonus number', () => {
    const board = {
      ...BOARD,
      season: { ...BOARD.season, status: 'running' },
      score: { complete: false, value: null, missing: ['audit', 'ownerRating'], band: null, settingsVersion: 0, parts: { ...BOARD.score.parts, audit: { value: null, weight: 25 }, ownerRating: { value: null, weight: 20 } } },
      reviews: { count: 0, asks: 0, rateBps: null, multiplierPartE4: 0 },
      seasonBonus: { grossCents: 500000, estimate: true, estimateCents: null, reason: 'score_incomplete' },
      stayBonus: null,
    };
    render(<Scoreboard board={{ status: 'ready', scoreboard: board }} />);
    expect(screen.getByText(/Not complete: Protocol audit, Owner rating have no data yet\./)).toBeInTheDocument();
    expect(screen.getAllByText('No data yet')).toHaveLength(2);
    expect(screen.getByText('Not estimated yet')).toBeInTheDocument();
    expect(screen.getByText('No estimate yet: a score part has no data so far.')).toBeInTheDocument();
    expect(screen.getByText('No asks yet')).toBeInTheDocument();
    expect(screen.getByText('None left')).toBeInTheDocument();
    expect(screen.getByText(/running, the numbers so far/)).toBeInTheDocument();
  });

  it('shows no customer data', () => {
    render(<Scoreboard board={{ status: 'ready', scoreboard: BOARD }} />);
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
