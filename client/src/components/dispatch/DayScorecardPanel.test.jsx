// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mockAdminFetch = vi.fn();
vi.mock('../../lib/adminFetch', () => ({ adminFetch: (...args) => mockAdminFetch(...args) }));

import DayScorecardPanel from './DayScorecardPanel';

const ok = (body) => ({ ok: true, json: async () => body });

beforeEach(() => { mockAdminFetch.mockReset(); });
afterEach(() => { cleanup(); });

it('shows loading, then an error with a working retry', async () => {
  mockAdminFetch.mockResolvedValueOnce({ ok: false });
  render(<DayScorecardPanel />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading scorecard');
  await screen.findByRole('alert');
  mockAdminFetch.mockResolvedValueOnce(ok({ driveModel: 'legacy', days: [] }));
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('No scheduled days in range');
});

it('renders an empty range distinctly from a loading or error state', async () => {
  mockAdminFetch.mockResolvedValue(ok({ driveModel: 'legacy', days: [] }));
  render(<DayScorecardPanel />);
  expect(await screen.findByText('No scheduled days in range')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('a future/today row labels its own row.driveModel, shows a physical-stop count, and has no Actual row', async () => {
  mockAdminFetch.mockResolvedValue(ok({
    driveModel: 'calibrated',
    days: [{
      date: '2026-10-01',
      byTech: [{
        technicianId: 'tech1', technician: 'Adam', driveModel: 'calibrated',
        planned: { stops: 3, physicalStops: 2, onSiteMinutes: 90, driveMinutes: 30, waitMinutes: 5, driveShare: 0.25, stopsPerHour: 1, returnMinute: 600, lateVisits: 0 },
        actual: null,
      }],
    }],
  }));
  render(<DayScorecardPanel />);
  const row = (await screen.findByText('2026-10-01')).closest('tr');
  expect(within(row).getByText('Board (calibrated)')).toBeInTheDocument();
  expect(within(row).getByText('2')).toBeInTheDocument(); // physicalStops, not the 3 raw rows
  expect(within(row).getByText('1h 30m')).toBeInTheDocument(); // on-site
  expect(screen.queryByText('Actual')).not.toBeInTheDocument();
});

it('the footer drive-model label is scoped to future/today rows only', async () => {
  mockAdminFetch.mockResolvedValue(ok({ driveModel: 'calibrated', days: [] }));
  render(<DayScorecardPanel />);
  await screen.findByText('No scheduled days in range');
  expect(screen.getByText(/Future\/today drive model: calibrated/)).toBeInTheDocument();
});

function pastPayload(actual, rowOverrides = {}) {
  return {
    driveModel: 'legacy',
    days: [{
      date: '2026-09-01',
      byTech: [{
        technicianId: 'tech1', technician: 'Adam', driveModel: 'legacy',
        planned: { stops: 2, physicalStops: null, onSiteMinutes: 90, driveMinutes: 25, waitMinutes: 5, driveShare: null, stopsPerHour: null, returnMinute: 600, lateVisits: null },
        actual,
        ...rowOverrides,
      }],
    }],
  };
}

it('a past row labels its own saved driveModel, which can differ from the current global one', async () => {
  // The saved snapshot was captured under the calibrated model even though
  // the CURRENT (top-level, future-facing) value is legacy — the row must
  // report its own, not the footer's.
  mockAdminFetch.mockResolvedValue(ok(pastPayload(
    { onSiteMinutes: 90, onSiteCoverage: { covered: 2, total: 2 }, driveMinutes: 20, driveTrips: 2, spanMinutes: 130 },
    { driveModel: 'calibrated' },
  )));
  render(<DayScorecardPanel />);
  await screen.findByText('2026-09-01');
  expect(screen.getByText('Planned (calibrated)')).toBeInTheDocument();
});

it('a null planned row says WHY: a definite no-saved-plan vs. a possibly-truncated baseline', async () => {
  mockAdminFetch.mockResolvedValueOnce(ok(pastPayload(
    { onSiteMinutes: null, driveMinutes: null }, { planned: null, driveModel: null, plannedUnavailableReason: 'no_saved_plan' },
  )));
  const { unmount } = render(<DayScorecardPanel />);
  await screen.findByText('2026-09-01');
  expect(screen.getByText('Planned (no saved plan)')).toBeInTheDocument();
  unmount();

  mockAdminFetch.mockResolvedValueOnce(ok(pastPayload(
    { onSiteMinutes: null, driveMinutes: null }, { planned: null, driveModel: null, plannedUnavailableReason: 'may_be_truncated' },
  )));
  render(<DayScorecardPanel />);
  await screen.findByText('2026-09-01');
  expect(screen.getByText('Planned (baseline may be truncated)')).toBeInTheDocument();
});

it('a partial actual on-site sum shows its coverage and is marked partial', async () => {
  mockAdminFetch.mockResolvedValue(ok(pastPayload({
    onSiteMinutes: 45, onSiteCoverage: { covered: 1, total: 2 }, driveMinutes: null, driveTrips: null, spanMinutes: null,
  })));
  render(<DayScorecardPanel />);
  await screen.findByText('2026-09-01');
  expect(screen.getByText('Planned (legacy)')).toBeInTheDocument();
  const actualRow = screen.getByText('Actual').closest('tr');
  expect(within(actualRow).getByText('45m · 1/2 recorded (partial)')).toBeInTheDocument();
  // Drive share, stops-per-hour and (no longer sent at all) idle must never
  // be derived from that partial sum — they read "unknown" on the actual
  // side regardless (Codex P1).
  expect(within(actualRow).getAllByText('unknown').length).toBeGreaterThan(0);
  expect(screen.queryByText(/idle/i)).not.toBeInTheDocument();
});

it('full actual coverage shows the count with no "(partial)" marker', async () => {
  mockAdminFetch.mockResolvedValue(ok(pastPayload({
    onSiteMinutes: 90, onSiteCoverage: { covered: 2, total: 2 }, driveMinutes: 20, driveTrips: 2, spanMinutes: 130,
  })));
  render(<DayScorecardPanel />);
  await screen.findByText('2026-09-01');
  const actualRow = screen.getByText('Actual').closest('tr');
  expect(within(actualRow).getByText('1h 30m · 2/2 recorded')).toBeInTheDocument();
  expect(within(actualRow).queryByText(/partial/)).not.toBeInTheDocument();
});

it('full baseline coverage still marks the day partial when a same-day added job was completed outside it', async () => {
  mockAdminFetch.mockResolvedValue(ok(pastPayload({
    onSiteMinutes: 90, onSiteCoverage: { covered: 2, total: 2, unbaselined: 1 }, driveMinutes: 20, driveTrips: 2, spanMinutes: 130,
  })));
  render(<DayScorecardPanel />);
  await screen.findByText('2026-09-01');
  const actualRow = screen.getByText('Actual').closest('tr');
  expect(within(actualRow).getByText('1h 30m · 2/2 recorded +1 added same day not counted (partial)')).toBeInTheDocument();
});

it('zero baseline coverage with an unbaselined completed job still says so, not just "unknown"', async () => {
  mockAdminFetch.mockResolvedValue(ok(pastPayload({
    onSiteMinutes: null, onSiteCoverage: { covered: 0, total: 1, unbaselined: 1 }, driveMinutes: null, driveTrips: null, spanMinutes: null,
  })));
  render(<DayScorecardPanel />);
  await screen.findByText('2026-09-01');
  const actualRow = screen.getByText('Actual').closest('tr');
  expect(within(actualRow).getByText('unknown +1 added same day not counted (partial)')).toBeInTheDocument();
});

it('surfaces day-level unallocated workload instead of a fabricated per-tech row', async () => {
  mockAdminFetch.mockResolvedValue(ok({
    driveModel: 'calibrated',
    days: [{
      date: '2026-10-01', unallocated: { visits: 2, serviceMinutes: 90 },
      byTech: [{ technicianId: 'tech1', technician: 'Adam', driveModel: 'calibrated',
        planned: { stops: 1, physicalStops: 1, onSiteMinutes: 60, driveMinutes: 10, waitMinutes: 0, driveShare: 0.14, stopsPerHour: 1, returnMinute: 540, lateVisits: 0 },
        actual: null }],
    }],
  }));
  render(<DayScorecardPanel />);
  await screen.findByText('2026-10-01');
  expect(screen.getByText(/2026-10-01 \(2 stops, 1h 30m\)/)).toBeInTheDocument();
});

it('zero recorded coverage reads as fully unknown, never "0m"', async () => {
  mockAdminFetch.mockResolvedValue(ok(pastPayload({
    onSiteMinutes: null, onSiteCoverage: { covered: 0, total: 3 }, driveMinutes: null, driveTrips: null, spanMinutes: null,
  })));
  render(<DayScorecardPanel />);
  await screen.findByText('2026-09-01');
  const actualRow = screen.getByText('Actual').closest('tr');
  expect(within(actualRow).queryByText(/recorded/)).not.toBeInTheDocument();
  expect(within(actualRow).getAllByText('unknown').length).toBeGreaterThan(0);
});

it('a Late column renders the planned count, and unknown when day-scorecard has no count to give', async () => {
  mockAdminFetch.mockResolvedValueOnce(ok({
    driveModel: 'calibrated',
    days: [{
      date: '2026-10-01',
      byTech: [{ technicianId: 'tech1', technician: 'Adam', driveModel: 'calibrated',
        planned: { stops: 3, physicalStops: 2, onSiteMinutes: 90, driveMinutes: 30, waitMinutes: 5, driveShare: 0.25, stopsPerHour: 1, returnMinute: 600, lateVisits: 1 },
        actual: null }],
    }],
  }));
  const { unmount } = render(<DayScorecardPanel />);
  const row = (await screen.findByText('2026-10-01')).closest('tr');
  // physicalStops (Stops column) is 2; lateVisits (Late column) is 1 — kept
  // distinct so this proves the "1" is really the Late cell, not a stray match.
  expect(within(row).getByText('1')).toBeInTheDocument();
  unmount();

  // A past PLANNED row never sets lateVisits at all (day-scorecard.js's
  // plannedPastRow) — the Late cell must read "unknown", never 0.
  mockAdminFetch.mockResolvedValueOnce(ok(pastPayload({ onSiteMinutes: 90, onSiteCoverage: { covered: 2, total: 2 }, driveMinutes: 20, driveTrips: 2, spanMinutes: 130 })));
  render(<DayScorecardPanel />);
  await screen.findByText('2026-09-01');
  const plannedRow = screen.getByText('Planned (legacy)').closest('tr');
  // driveShare/stopsPerHour are also null in this fixture, so several cells
  // read "unknown" — assert at least one (Late) rather than a single exact
  // match, which would throw on the genuine ambiguity.
  expect(within(plannedRow).getAllByText('unknown').length).toBeGreaterThan(0);
});

it('a Span column renders actual.spanMinutes on the Actual row; the Planned row always reads unknown', async () => {
  mockAdminFetch.mockResolvedValue(ok(pastPayload({
    onSiteMinutes: 90, onSiteCoverage: { covered: 2, total: 2 }, driveMinutes: 20, driveTrips: 2, spanMinutes: 130,
  })));
  render(<DayScorecardPanel />);
  await screen.findByText('2026-09-01');
  const actualRow = screen.getByText('Actual').closest('tr');
  expect(within(actualRow).getByText('2h 10m')).toBeInTheDocument(); // 130 minutes
  const plannedRow = screen.getByText('Planned (legacy)').closest('tr');
  expect(within(plannedRow).getAllByText('unknown').length).toBeGreaterThan(0); // no planned-side span concept
});

it('shows the Technician column when >1 distinct technicianId appears ANYWHERE in the result, not just on one busy day', async () => {
  // Each individual day has exactly one technician (a per-day max of 1), but
  // the two days name DIFFERENT technicians — the column must still appear
  // so the two rows aren't ambiguous (Codex P2).
  mockAdminFetch.mockResolvedValue(ok({
    driveModel: 'calibrated',
    days: [
      { date: '2026-10-01', byTech: [{ technicianId: 'tech1', technician: 'Adam', driveModel: 'calibrated',
        planned: { stops: 1, physicalStops: 1, onSiteMinutes: 60, driveMinutes: 10, waitMinutes: 0, driveShare: 0.14, stopsPerHour: 1, returnMinute: 540, lateVisits: 0 }, actual: null }] },
      { date: '2026-10-02', byTech: [{ technicianId: 'tech2', technician: 'Ben', driveModel: 'calibrated',
        planned: { stops: 1, physicalStops: 1, onSiteMinutes: 60, driveMinutes: 10, waitMinutes: 0, driveShare: 0.14, stopsPerHour: 1, returnMinute: 540, lateVisits: 0 }, actual: null }] },
    ],
  }));
  render(<DayScorecardPanel />);
  await screen.findByText('2026-10-01');
  expect(screen.getByRole('columnheader', { name: 'Technician' })).toBeInTheDocument();
  expect(screen.getByText('Adam')).toBeInTheDocument();
  expect(screen.getByText('Ben')).toBeInTheDocument();
});

it('does not show the Technician column when every day names the same one technician', async () => {
  mockAdminFetch.mockResolvedValue(ok({
    driveModel: 'calibrated',
    days: [
      { date: '2026-10-01', byTech: [{ technicianId: 'tech1', technician: 'Adam', driveModel: 'calibrated',
        planned: { stops: 1, physicalStops: 1, onSiteMinutes: 60, driveMinutes: 10, waitMinutes: 0, driveShare: 0.14, stopsPerHour: 1, returnMinute: 540, lateVisits: 0 }, actual: null }] },
      { date: '2026-10-02', byTech: [{ technicianId: 'tech1', technician: 'Adam', driveModel: 'calibrated',
        planned: { stops: 1, physicalStops: 1, onSiteMinutes: 60, driveMinutes: 10, waitMinutes: 0, driveShare: 0.14, stopsPerHour: 1, returnMinute: 540, lateVisits: 0 }, actual: null }] },
    ],
  }));
  render(<DayScorecardPanel />);
  await screen.findByText('2026-10-01');
  expect(screen.queryByRole('columnheader', { name: 'Technician' })).not.toBeInTheDocument();
});

it('shows the empty state when every day has zero rendered rows, even though days.length > 0', async () => {
  // A closed day (or one whose entire roster was filtered) still exists as
  // a `day` object with an empty byTech array — days.length alone would
  // miss this and render a blank table with no message (Codex P2).
  mockAdminFetch.mockResolvedValue(ok({
    driveModel: 'calibrated',
    days: [{ date: '2026-10-01', closed: true, byTech: [] }],
  }));
  render(<DayScorecardPanel />);
  expect(await screen.findByText('No scheduled days in range')).toBeInTheDocument();
  expect(screen.queryByText('2026-10-01')).not.toBeInTheDocument();
});

it('rounds the total minutes once, never carrying a fractional minute into "60m" (119.6 -> "2h 0m")', async () => {
  mockAdminFetch.mockResolvedValue(ok({
    driveModel: 'calibrated',
    days: [{
      date: '2026-10-01',
      byTech: [{ technicianId: 'tech1', technician: 'Adam', driveModel: 'calibrated',
        planned: { stops: 1, physicalStops: 1, onSiteMinutes: 119.6, driveMinutes: 10, waitMinutes: 0, driveShare: 0.14, stopsPerHour: 1, returnMinute: 540, lateVisits: 0 },
        actual: null }],
    }],
  }));
  render(<DayScorecardPanel />);
  const row = (await screen.findByText('2026-10-01')).closest('tr');
  expect(within(row).getByText('2h 0m')).toBeInTheDocument();
  expect(within(row).queryByText(/60m/)).not.toBeInTheDocument();
});

// Codex P2 (round 6): the server excludes BOTH personal and commute mileage
// (EXCLUDED_MILEAGE_PURPOSES); a footer naming only personal trips left a
// commute-heavy day's lower drive total looking unexplained.
it('the drive-model footer discloses that commute trips are excluded along with personal ones', async () => {
  mockAdminFetch.mockResolvedValue(ok({ driveModel: 'legacy', days: [] }));
  render(<DayScorecardPanel />);
  await screen.findByText('No scheduled days in range');
  expect(screen.getByText(/exclude personal and commute trips/)).toBeInTheDocument();
});

// Codex P2 (round 6): a past PLANNED on-site value comes from a snapshot
// that can't detect a co-visit and may double-count one — the server's own
// assumptions.plannedOnSiteMinutes caveat must be on screen next to it.
it('shows the planned on-site caveat whenever a past planned value is displayed, and not otherwise', async () => {
  const caveat = 'Past PLANNED on-site minutes may double-count a co-visit.';
  mockAdminFetch.mockResolvedValueOnce(ok({
    ...pastPayload({ onSiteMinutes: 90, onSiteCoverage: { covered: 2, total: 2 }, driveMinutes: 20, driveTrips: 2, spanMinutes: 130 }),
    assumptions: { plannedOnSiteMinutes: caveat },
  }));
  const { unmount } = render(<DayScorecardPanel />);
  await screen.findByText('2026-09-01');
  expect(screen.getByText(caveat)).toBeInTheDocument();
  unmount();

  // Future/today rows only (no past planned snapshot on screen): no caveat.
  mockAdminFetch.mockResolvedValueOnce(ok({
    driveModel: 'legacy', assumptions: { plannedOnSiteMinutes: caveat },
    days: [{ date: '2026-10-01', byTech: [{ technicianId: 'tech1', technician: 'Adam', driveModel: 'legacy',
      planned: { stops: 1, physicalStops: 1, onSiteMinutes: 60, driveMinutes: 10, waitMinutes: 0, driveShare: 0.14, stopsPerHour: 1, returnMinute: 540, lateVisits: 0 },
      actual: null }] }],
  }));
  render(<DayScorecardPanel />);
  await screen.findByText('2026-10-01');
  expect(screen.queryByText(caveat)).not.toBeInTheDocument();
});

// Codex P2 (round 7): an actual drive total with untimed trips, or a span
// missing a completed stop's boundary, is a lower bound — marked partial.
it('marks actual drive and span partial when some trips or completed stops are untimed', async () => {
  mockAdminFetch.mockResolvedValue(ok(pastPayload({
    onSiteMinutes: 90, onSiteCoverage: { covered: 2, total: 2 },
    driveMinutes: 20, driveTrips: 2, driveCoverage: { timed: 1, total: 2 },
    spanMinutes: 50, spanCoverage: { covered: 1, total: 2 },
  })));
  render(<DayScorecardPanel />);
  await screen.findByText('2026-09-01');
  expect(screen.getByText('20m · 1/2 trips timed (partial)')).toBeInTheDocument();
  expect(screen.getByText('50m · 1/2 stops timed (partial)')).toBeInTheDocument();
});

it('fully timed drive and span read as plain totals; no timed trip at all reads unknown (partial), never 0m', async () => {
  mockAdminFetch.mockResolvedValueOnce(ok(pastPayload({
    onSiteMinutes: 90, onSiteCoverage: { covered: 2, total: 2 },
    driveMinutes: 25, driveTrips: 2, driveCoverage: { timed: 2, total: 2 },
    spanMinutes: 130, spanCoverage: { covered: 2, total: 2 },
  })));
  const { unmount } = render(<DayScorecardPanel />);
  const row = (await screen.findByText('Actual')).closest('tr');
  expect(within(row).getByText('25m')).toBeInTheDocument();
  expect(within(row).getByText('2h 10m')).toBeInTheDocument();
  unmount();

  mockAdminFetch.mockResolvedValueOnce(ok(pastPayload({
    onSiteMinutes: null, driveMinutes: null, driveTrips: 1, driveCoverage: { timed: 0, total: 1 },
  })));
  render(<DayScorecardPanel />);
  const untimed = (await screen.findByText('Actual')).closest('tr');
  expect(within(untimed).getByText('unknown · 0/1 trips timed (partial)')).toBeInTheDocument();
  expect(within(untimed).queryByText('0m')).not.toBeInTheDocument();
});

// Codex P2 (round 7): today's row says whether it is the saved pre-service
// plan or the live board's remaining route (which drops completed visits).
it("labels today's row as the saved plan or the remaining route, and future rows as the board", async () => {
  const planned = { stops: 1, physicalStops: 1, onSiteMinutes: 60, driveMinutes: 10, waitMinutes: 0, driveShare: 0.14, stopsPerHour: 1, returnMinute: 540, lateVisits: 0 };
  mockAdminFetch.mockResolvedValue(ok({
    driveModel: 'calibrated', assumptions: { plannedOnSiteMinutes: 'Saved-plan caveat.' },
    days: [
      { date: '2026-10-01', byTech: [
        { technicianId: 'tech1', technician: 'Adam', driveModel: 'legacy', plannedBasis: 'saved_plan', planned, actual: null },
        { technicianId: 'tech2', technician: 'Bea', driveModel: 'calibrated', plannedBasis: 'remaining_route', planned, actual: null },
      ] },
      { date: '2026-10-02', byTech: [
        { technicianId: 'tech1', technician: 'Adam', driveModel: 'calibrated', plannedBasis: 'board', planned, actual: null },
      ] },
    ],
  }));
  render(<DayScorecardPanel />);
  expect(await screen.findByText('Planned (legacy)')).toBeInTheDocument();
  expect(screen.getByText('Remaining route (calibrated)')).toBeInTheDocument();
  expect(screen.getByText('Board (calibrated)')).toBeInTheDocument();
  // Today's saved-plan value comes from the snapshot, so its caveat shows.
  expect(screen.getByText('Saved-plan caveat.')).toBeInTheDocument();
});

// Codex P2 (round 9): an explicit null physicalStops means the server
// couldn't prove the physical count — show the raw rows, labeled.
it('labels a raw row count when the physical stop count is unknown', async () => {
  mockAdminFetch.mockResolvedValue(ok(pastPayload(
    { stops: 3, physicalStops: null, onSiteMinutes: 90, onSiteCoverage: { covered: 3, total: 3 }, driveMinutes: 20, driveTrips: 2, spanMinutes: 130 },
    { planned: { stops: 4, physicalStops: null, onSiteMinutes: 120, driveMinutes: 25, waitMinutes: 5, driveShare: null, stopsPerHour: null, returnMinute: 600, lateVisits: null } },
  )));
  render(<DayScorecardPanel />);
  await screen.findByText('2026-09-01');
  expect(screen.getByText('4 rows · physical unknown')).toBeInTheDocument();
  expect(screen.getByText('3 rows · physical unknown')).toBeInTheDocument();
});

// Codex P2 (round 10): past completed work with no technician renders as
// its own Unassigned row instead of vanishing.
it('renders an Unassigned past row with its own basis label', async () => {
  mockAdminFetch.mockResolvedValue(ok({
    driveModel: 'legacy',
    days: [{ date: '2026-09-01', byTech: [
      { technicianId: 'tech1', technician: 'Adam', driveModel: 'legacy', plannedUnavailableReason: 'no_saved_plan', planned: null,
        actual: { stops: 1, onSiteMinutes: 30, onSiteCoverage: { covered: 1, total: 1 }, driveMinutes: null, spanMinutes: 30 } },
      { technicianId: null, technician: 'Unassigned', driveModel: null, plannedUnavailableReason: 'unassigned', planned: null,
        actual: { stops: 2, onSiteMinutes: 70, onSiteCoverage: { covered: 2, total: 2 }, driveMinutes: null, spanMinutes: 120 } },
    ] }],
  }));
  render(<DayScorecardPanel />);
  const label = await screen.findByText('Unassigned (no plan)');
  expect(within(label.closest('tr')).getByText('Unassigned')).toBeInTheDocument();
});

// Codex P2 (round 11): a closed date keeps its flag through flattening — it
// is labeled, and the planned metrics that simulate an ordinary workday
// (return, wait, late, stops/hr) read unknown.
it('labels a closed date and suppresses its simulated planned metrics', async () => {
  mockAdminFetch.mockResolvedValue(ok({
    driveModel: 'legacy',
    days: [{ date: '2026-10-01', closed: true, byTech: [{ technicianId: 'tech1', technician: 'Adam', driveModel: 'legacy', plannedBasis: 'board',
      planned: { stops: 2, physicalStops: 2, onSiteMinutes: 90, driveMinutes: 20, waitMinutes: 15, driveShare: 0.18, stopsPerHour: 1.3, returnMinute: 630, lateVisits: 2 },
      actual: null }] }],
  }));
  render(<DayScorecardPanel />);
  const row = (await screen.findByText('Closed')).closest('tr');
  expect(within(row).getByText('2026-10-01')).toBeInTheDocument();
  expect(within(row).getByText('1h 30m')).toBeInTheDocument(); // on-site stands
  expect(within(row).queryByText('10:30 AM')).not.toBeInTheDocument();
  expect(within(row).queryByText('1.3')).not.toBeInTheDocument();
  expect(within(row).queryByText('15m')).not.toBeInTheDocument();
  expect(within(row).getAllByText('unknown').length).toBeGreaterThanOrEqual(4);
});

// Codex P2 (round 11): a return past midnight must show the day offset
// instead of dropping it (`% 24` alone reads 1500 as 1:00 AM with no hint
// it's the next calendar day).
it('shows the day offset for a return time past midnight', async () => {
  mockAdminFetch.mockResolvedValue(ok({
    driveModel: 'legacy',
    days: [{ date: '2026-10-01', byTech: [{ technicianId: 'tech1', technician: 'Adam', driveModel: 'legacy', plannedBasis: 'board',
      planned: { stops: 3, physicalStops: 3, onSiteMinutes: 90, driveMinutes: 30, waitMinutes: 5, driveShare: 0.25, stopsPerHour: 1, returnMinute: 1500, lateVisits: 0 },
      actual: null }] }],
  }));
  render(<DayScorecardPanel />);
  const row = (await screen.findByText('2026-10-01')).closest('tr');
  expect(within(row).getByText('1:00 AM (+1 day)')).toBeInTheDocument();
});

// A return exactly at midnight (1440) is still "+1 day", and an ordinary
// same-day return (< 1440) never gets a day note.
it('shows no day offset for a same-day return, and +1 day at exactly midnight', async () => {
  mockAdminFetch.mockResolvedValue(ok({
    driveModel: 'legacy',
    days: [{ date: '2026-10-01', byTech: [
      { technicianId: 'tech1', technician: 'Adam', driveModel: 'legacy', plannedBasis: 'board',
        planned: { stops: 1, physicalStops: 1, onSiteMinutes: 60, driveMinutes: 10, waitMinutes: 0, driveShare: 0.14, stopsPerHour: 1, returnMinute: 630, lateVisits: 0 },
        actual: null },
      { technicianId: 'tech2', technician: 'Beth', driveModel: 'legacy', plannedBasis: 'board',
        planned: { stops: 1, physicalStops: 1, onSiteMinutes: 60, driveMinutes: 10, waitMinutes: 0, driveShare: 0.14, stopsPerHour: 1, returnMinute: 1440, lateVisits: 0 },
        actual: null },
    ] }],
  }));
  render(<DayScorecardPanel />);
  await screen.findByText('Adam');
  expect(screen.getByText('10:30 AM')).toBeInTheDocument();
  expect(screen.getByText('12:00 AM (+1 day)')).toBeInTheDocument();
});

// Codex P2 (round 11): span coverage names its unit — rows when the
// physical stop count is unknown, never "stops" that disagree with Stops.
it('labels span coverage in rows when the server counted rows', async () => {
  mockAdminFetch.mockResolvedValue(ok(pastPayload({
    stops: 2, physicalStops: null, onSiteMinutes: 90, onSiteCoverage: { covered: 2, total: 2 }, driveMinutes: 20, driveTrips: 2,
    spanMinutes: 65, spanCoverage: { covered: 1, total: 2, unit: 'rows' },
  })));
  render(<DayScorecardPanel />);
  expect(await screen.findByText('1h 5m · 1/2 rows timed (partial)')).toBeInTheDocument();
});

// Codex P2 (round 11): the portal's 14px minimum for readable copy.
it('renders no scorecard copy below the 14px text size', async () => {
  mockAdminFetch.mockResolvedValue(ok({ ...pastPayload({ onSiteMinutes: 90, onSiteCoverage: { covered: 2, total: 2 }, driveMinutes: 20, driveTrips: 2, spanMinutes: 130 }),
    assumptions: { plannedOnSiteMinutes: 'Caveat.' } }));
  const { container } = render(<DayScorecardPanel />);
  await screen.findByText('2026-09-01');
  // Column headers come from the shared ui/Table TH (its own density-driven
  // heading style), not this panel's copy.
  expect(container.querySelector(':not(th).text-11, :not(th).text-12, :not(th).text-13')).toBeNull();
});
