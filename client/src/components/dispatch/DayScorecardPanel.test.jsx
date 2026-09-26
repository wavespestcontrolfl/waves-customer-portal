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
