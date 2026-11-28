// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../hooks/useIsMobile', () => ({ default: () => false }));
vi.mock('./useBestTimes', () => ({
  useBestTimes: () => ({ pickedByTech: [], availability: null, checking: false }),
}));
vi.mock('./AvailabilityStrip', () => ({ default: () => <div data-testid="open-times-box" /> }));
vi.mock('./ScheduleSaveNotice', () => ({ showScheduleSaveNotice: vi.fn() }));

import RainOutSheet from './RainOutSheet';

// GATE_TECH_SHIFT_HOURS (D4): the office's Quick Move sheet says, before the tap, how many later
// stops a "rest of route" move would land outside the technician's shift (routeShiftConflicts on
// an option and on the live target check). The shift hours do not block the office's move.
const json = (body) => ({ ok: true, json: async () => body });
const late = { windowStart: '17:00', windowEnd: '18:00' };
const later = { windowStart: '20:00', windowEnd: '21:00' };
const NOTICE = /With the rest of the route/;
let todayRow;
let liveAnswer;
let holdNewList;
let fetchMock;

beforeEach(() => {
  todayRow = { kind: 'same_day', date: '2099-01-01', window: { start: '14:00', end: '15:00' }, display: 'Today, 2:00 PM-3:00 PM' };
  liveAnswer = null;
  holdNewList = false;
  localStorage.setItem('waves_admin_token', 'fixture-only');
  fetchMock = vi.fn(async (url) => {
    const path = String(url);
    if (path.split('?')[0].endsWith('/rain-out-options')) {
      // The list for a reason that is not rain never answers while `holdNewList` is set.
      if (holdNewList && !path.includes('reasonCode=weather_rain')) return new Promise(() => {});
      return json({
        sameDay: [todayRow], days: [], service: { window: { start: '10:00', end: '11:00' } }, remainingRouteCount: 2, extraReasonsEnabled: true,
      });
    }
    // No live answer: the sheet keeps the option's own rows.
    if (path.endsWith('/rain-out/target-check')) return liveAnswer ? json(liveAnswer) : { ok: false, status: 500, json: async () => ({}) };
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const liveChecks = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/rain-out/target-check'));

async function open() {
  render(<RainOutSheet service={{ id: 'visit-1', customerName: 'Fixture Customer' }} onClose={vi.fn()} onDone={vi.fn()} />);
  await screen.findByText('Today, 2:00 PM-3:00 PM');
}
const restOfRoute = () => fireEvent.click(screen.getByRole('button', { name: /This \+ rest of route/ }));

describe('RainOutSheet: stops a rest-of-route move would land outside the shift', () => {
  it('says nothing for this stop only, and names the count and the first window for the rest of the route', async () => {
    todayRow.routeShiftConflicts = [late, later];
    await open();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    restOfRoute();
    expect(screen.getByText("⚠️ With the rest of the route, 2 stops land outside the technician's shift hours (first: 5:00 PM-6:00 PM). Shift hours alone do not block this move.")).toBeInTheDocument();
    // The office's move is allowed.
    expect(screen.getByRole('button', { name: /^Move/ })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'This stop' }));
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it('with an overlap on the same move, both lines show, and the shift line does not say the move is allowed', async () => {
    todayRow.routeShiftConflicts = [late];
    todayRow.routeConflicts = [{ isRouteSelfCollision: true, windowStart: '15:00', windowEnd: '16:00' }];
    await open();
    restOfRoute();
    expect(screen.getByText(/moving here will double-book this slot and still text the customer if checked\. Pick a different time to avoid stacking\./)).toBeInTheDocument();
    expect(screen.getByText("⚠️ With the rest of the route, 1 stop lands outside the technician's shift hours (5:00 PM-6:00 PM). Shift hours alone do not block this move.")).toBeInTheDocument();
    expect(screen.queryByText(/still allowed/)).not.toBeInTheDocument();
  });

  it('says nothing when the option has no such stop', async () => {
    await open();
    restOfRoute();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it('the live check of the picked time wins over the option: its rows, or none', async () => {
    todayRow.routeShiftConflicts = [late, later];
    liveAnswer = { ok: true, conflicts: [], routeConflicts: [], routeShiftConflicts: [later] };
    await open();
    restOfRoute();
    expect(await screen.findByText("⚠️ With the rest of the route, 1 stop lands outside the technician's shift hours (8:00 PM-9:00 PM). Shift hours alone do not block this move.")).toBeInTheDocument();
    expect(liveChecks().length).toBeGreaterThan(0);
  });

  it('says nothing while the route list of a new reason is loading: the rows are the old list\'s', async () => {
    todayRow.routeShiftConflicts = [late];
    holdNewList = true;
    await open();
    restOfRoute();
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'tech_emergency' } });
    expect(await screen.findByRole('button', { name: 'This + rest of route (…)' })).toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    // The time is still the picked one.
    expect(screen.getByText('Today, 2:00 PM-3:00 PM')).toBeInTheDocument();
  });

  it('a live check with no such stop takes the line away', async () => {
    todayRow.routeShiftConflicts = [late];
    liveAnswer = { ok: true, conflicts: [], routeConflicts: [] };
    await open();
    restOfRoute();
    await waitFor(() => expect(screen.queryByText(NOTICE)).not.toBeInTheDocument());
    expect(liveChecks().length).toBeGreaterThan(0);
  });
});

// The tapped stop's own picked hour (shiftWarning on an option and on the live target check).
describe('RainOutSheet: the shift line for the picked hour', () => {
  const LINE = "Synthetic Tech's shift is 8:00 AM to 1:00 PM. This visit is outside those hours.";
  const SHOWN = `⚠️ ${LINE} Shift hours alone do not block this move.`;

  it('shows the option\'s line for this stop only, with no rest-of-route line', async () => {
    todayRow.shiftWarning = LINE;
    await open();
    expect(await screen.findByText(SHOWN)).toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it('says nothing when neither the option nor the live check has a line', async () => {
    await open();
    await waitFor(() => expect(liveChecks().length).toBeGreaterThan(0));
    expect(screen.queryByTestId('quick-move-shift-warning')).not.toBeInTheDocument();
  });

  it('the live check of the picked time wins: its line, or none', async () => {
    liveAnswer = { ok: true, conflicts: [], routeConflicts: [], shiftWarning: LINE };
    await open();
    expect(await screen.findByText(SHOWN)).toBeInTheDocument();
    cleanup();
    todayRow.shiftWarning = LINE;
    liveAnswer = { ok: true, conflicts: [], routeConflicts: [] };
    await open();
    await waitFor(() => expect(screen.queryByTestId('quick-move-shift-warning')).not.toBeInTheDocument());
  });

  it('shows beside the rest-of-route line', async () => {
    todayRow.shiftWarning = LINE;
    todayRow.routeShiftConflicts = [late];
    await open();
    restOfRoute();
    expect(await screen.findByText(SHOWN)).toBeInTheDocument();
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
  });
});
