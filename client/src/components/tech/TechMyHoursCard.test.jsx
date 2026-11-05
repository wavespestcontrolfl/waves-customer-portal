// @vitest-environment jsdom
// "My hours" on Today (owner 2026-11-04, D5 A): the technician's own week.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TechMyHoursCard from './TechMyHoursCard';

const WEEK = (overrides = {}) => ({
  weekStart: '2026-11-02', weekEnd: '2026-11-08', prevWeekStart: '2026-10-26', nextWeekStart: null,
  days: [{ date: '2026-11-02', shiftMinutes: 480, jobMinutes: 300, driveMinutes: 60, breakMinutes: 30, unpaidMealMinutes: 30, jobCount: 5, firstClockIn: '2026-11-02T12:00:00Z', lastClockOut: '2026-11-02T20:30:00Z', status: 'pending' }],
  totals: { shiftMinutes: 480, jobMinutes: 300, driveMinutes: 60, breakMinutes: 30, unpaidMealMinutes: 30, jobCount: 5 },
  week: { regularMinutes: 450, overtimeMinutes: 0, shiftMinutes: 480, daysWorked: 1, jobCount: 5, status: 'pending', signed: false },
  entries: [{ id: 'e-1', type: 'job', status: 'completed', clockIn: '2026-11-02T14:00:00Z', clockOut: '2026-11-02T15:00:00Z', minutes: 60, serviceType: 'Quarterly Pest Control', edited: false }],
  entriesTruncated: false,
  ...overrides,
});

describe('TechMyHoursCard', () => {
  let fetchMock;
  beforeEach(() => {
    localStorage.setItem('waves_admin_token', 'tech-token');
    fetchMock = vi.fn(async (url) => {
      const earlier = String(url).includes('weekStart=2026-10-26');
      return { ok: true, status: 200, json: async () => (earlier ? WEEK({ weekStart: '2026-10-26', weekEnd: '2026-11-01', prevWeekStart: '2026-10-19', nextWeekStart: '2026-11-02', days: [], entries: [], totals: { shiftMinutes: 0, jobMinutes: 0, driveMinutes: 0, breakMinutes: 0, unpaidMealMinutes: 0, jobCount: 0 }, week: null }) : WEEK()) };
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

  it('reads nothing until it is opened, then shows the week, the days and the entries', async () => {
    render(<TechMyHoursCard />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'My hours' }));
    expect(await screen.findByText(/Week total: 8h 00m on shift · 5 jobs/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/tech/timetracking/my-hours', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tech-token' }) }));
    expect(screen.getByText(/Regular 7h 30m · Overtime 0m/)).toBeInTheDocument();
    expect(screen.getByText(/Mon, Nov 2: 8h 00m · 5 jobs/)).toBeInTheDocument();
    expect(screen.getByText(/Job · Quarterly Pest Control: .* · 1h 00m/)).toBeInTheDocument();
    // No money word anywhere on the card.
    expect(document.body.textContent).not.toMatch(/revenue|\$|rate/i);
  });

  it('moves to an earlier week, and cannot go past this week', async () => {
    render(<TechMyHoursCard />);
    fireEvent.click(screen.getByRole('button', { name: 'My hours' }));
    await screen.findByText(/Week total/);
    expect(screen.getByRole('button', { name: 'Later week' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Earlier week' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/tech/timetracking/my-hours?weekStart=2026-10-26', expect.anything()));
    expect(await screen.findByText('No hours recorded this week.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Later week' })).toBeEnabled();
  });

  it('shows the error when the hours cannot be read', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 503, json: async () => ({ error: 'Hours unavailable now' }) }));
    render(<TechMyHoursCard />);
    fireEvent.click(screen.getByRole('button', { name: 'My hours' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Hours unavailable now');
  });
});
