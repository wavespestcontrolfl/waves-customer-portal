// client/src/components/dispatch/DayScorecardPanel.jsx
// Admin-only per-day drive-vs-stops scorecard (GATE_ROUTE_SCORECARD). Rendered
// by AdminDispatchPage only after its own /status check reports the gate on.
// Read-only: one GET, no writes, no customer surface. V2 monochrome tokens,
// same alert-fg-for-genuine-alerts rule as InsightsPanelV2 — this panel
// raises no alerts of its own, it just reports numbers.
import { useState, useEffect } from 'react';
import { Button, Card, CardBody, Table, THead, TBody, TR, TH, TD, cn } from '../ui';
import { adminFetch } from '../../lib/adminFetch';
import { etDateString, addETDays } from '../../lib/timezone';

const DEFAULT_FROM = () => etDateString(addETDays(new Date(), -7));
const DEFAULT_TO = () => etDateString(addETDays(new Date(), 7));

function fmtMinutes(value) {
  if (!Number.isFinite(value)) return 'unknown';
  // Round the TOTAL once before splitting hours/minutes — rounding each
  // piece separately (Math.floor on the raw total, Math.round on the raw
  // remainder) can carry a fractional minute past 59 on its own and print
  // "1h 60m" instead of "2h 0m" (Codex P2).
  const total = Math.round(Math.abs(value));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  const sign = value < 0 ? '-' : '';
  return hours > 0 ? `${sign}${hours}h ${mins}m` : `${sign}${mins}m`;
}

function fmtClock(minuteOfDay) {
  if (!Number.isFinite(minuteOfDay)) return 'unknown';
  const hour24 = Math.floor(minuteOfDay / 60) % 24;
  const mins = Math.round(minuteOfDay % 60);
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(mins).padStart(2, '0')} ${hour24 < 12 ? 'AM' : 'PM'}`;
}

function fmtPercent(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : 'unknown';
}

function fmtRate(value) {
  return Number.isFinite(value) ? value.toFixed(1) : 'unknown';
}

function fmtCount(value) {
  return Number.isFinite(value) ? value : 'unknown';
}

// On-site minutes, ACTUAL side: the sum is only ever over the recorded rows
// (RECORDED_EVIDENCE on the server), so it's shown with its own coverage
// rather than as a plain total that could pass for a complete day. No
// recorded stop at all reads as fully unknown, never "0m". `unbaselined` is
// a job added to the route after the saved snapshot and completed the same
// day — it's real work the covered/total pair can't see at all (the
// snapshot never named it), so it always marks the day partial too.
function fmtOnSite(m) {
  if (!m?.onSiteCoverage) return fmtMinutes(m?.onSiteMinutes); // planned side — no coverage concept
  const { covered, total, unbaselined = 0 } = m.onSiteCoverage;
  const addedNote = unbaselined > 0 ? ` +${unbaselined} added same day not counted` : '';
  if (!covered) return unbaselined > 0 ? `unknown${addedNote} (partial)` : 'unknown';
  const text = `${fmtMinutes(m.onSiteMinutes)} · ${covered}/${total} recorded`;
  return (covered < total || unbaselined > 0) ? `${text}${addedNote} (partial)` : text;
}

// Actual drive and span (Codex P2, round 7) carry their own coverage the
// same way on-site does: a trip with no recorded duration, or a completed
// stop missing an arrival/completion, leaves the value a lower bound, so
// it's marked partial rather than passed off as the whole day.
function fmtWithCoverage(value, coverage, covered, noun) {
  if (!coverage || covered >= coverage.total) return fmtMinutes(value);
  return `${fmtMinutes(value)} · ${covered}/${coverage.total} ${noun} (partial)`;
}

// Physical stops when the server could prove them; an explicit null
// physicalStops means it couldn't (a saved snapshot or recorded rows that
// can't rule out an unrecognized co-visit/allocation — Codex P2, round 9),
// so the raw row count is shown and labeled rather than passed off as
// physical stops.
function fmtStops(m) {
  if (m?.physicalStops === null && Number.isFinite(m?.stops)) return `${m.stops} rows · physical unknown`;
  return fmtCount(m?.physicalStops ?? m?.stops);
}

// One metric column shared by the planned and actual sub-rows so the two
// never drift into different formatting.
const METRICS = [
  { key: 'stops', label: 'Stops', format: fmtStops },
  { key: 'onSiteMinutes', label: 'On-site', format: fmtOnSite },
  { key: 'driveMinutes', label: 'Drive', format: (m) => fmtWithCoverage(m?.driveMinutes, m?.driveCoverage, m?.driveCoverage?.timed, 'trips timed') },
  { key: 'driveShare', label: 'Drive share', format: (m) => fmtPercent(m?.driveShare) },
  { key: 'stopsPerHour', label: 'Stops/hr', format: (m) => fmtRate(m?.stopsPerHour) },
  { key: 'waitMinutes', label: 'Wait', format: (m) => fmtMinutes(m?.waitMinutes) },
  // Planned only (day-scorecard.js never sets this on an actual row) —
  // unknown, not 0, on every Actual sub-row and on any planned row with no
  // simulation to count lateness from (e.g. a past PLANNED snapshot).
  { key: 'lateVisits', label: 'Late', format: (m) => fmtCount(m?.lateVisits) },
  { key: 'returnMinute', label: 'Return', format: (m) => fmtClock(m?.returnMinute) },
  // Actual only (first recorded arrival to last recorded completion) — no
  // planned-side equivalent, so a Planned sub-row always reads "unknown"
  // here rather than a fabricated span.
  { key: 'spanMinutes', label: 'Span', format: (m) => fmtWithCoverage(m?.spanMinutes, m?.spanCoverage, m?.spanCoverage?.covered, 'stops timed') },
];

// row.driveModel is THIS row's own saved/current drive model, not the
// footer's single global value — a past row's snapshot can have been
// captured under a different drive-time model than the one live today.
function modelLabel(value) {
  if (value === 'calibrated') return 'calibrated';
  if (value === 'legacy') return 'legacy';
  return 'unknown';
}

// The Planned/Board basis label names its OWN row's drive model (past rows
// use the model the saved snapshot was captured under, never the footer's
// current-day value). A null planned row says which of the two distinct
// reasons applies — a definite no_saved_plan, or the newest-500-planner-
// runs cap that may have evicted a real one (see day-scorecard.js).
// Today's row (Codex P2, round 7) names which of the two it shows: the
// saved pre-service plan, or — with none saved — the live board's
// REMAINING route, which drops each visit as it completes.
function basisLabel(row, isPast) {
  if (!isPast && row.plannedBasis === 'saved_plan') return `Planned (${modelLabel(row.driveModel)})`;
  if (!isPast && row.plannedBasis === 'remaining_route') return `Remaining route (${modelLabel(row.driveModel)})`;
  if (!isPast) return `Board (${modelLabel(row.driveModel)})`;
  if (row.planned) return `Planned (${modelLabel(row.driveModel)})`;
  // Completed work with no technician at all has no route to plan.
  if (row.plannedUnavailableReason === 'unassigned') return 'Unassigned (no plan)';
  return row.plannedUnavailableReason === 'may_be_truncated' ? 'Planned (baseline may be truncated)' : 'Planned (no saved plan)';
}

// Two stacked sub-rows (Planned / Actual) for a past tech-day, one row for a
// future/today tech-day (nothing recorded yet). Date and, when more than one
// technician is in range, the technician name are rowSpan'd across both.
function TechDayRows({ date, row, isPast, showTechName }) {
  const span = isPast ? 2 : 1;
  return (
    <>
      <TR>
        <TD className="font-medium text-ink-primary" rowSpan={span}>{date}</TD>
        {showTechName && <TD className="text-ink-secondary" rowSpan={span}>{row.technician || row.technicianId}</TD>}
        <TD className="text-11 text-ink-tertiary">{basisLabel(row, isPast)}</TD>
        {METRICS.map((metric) => <TD key={metric.key} nums align="right">{metric.format(row.planned)}</TD>)}
      </TR>
      {isPast && (
        <TR>
          <TD className="text-11 text-ink-tertiary">Actual</TD>
          {METRICS.map((metric) => <TD key={metric.key} nums align="right">{metric.format(row.actual)}</TD>)}
        </TR>
      )}
    </>
  );
}

export default function DayScorecardPanel() {
  const [range] = useState({ from: DEFAULT_FROM(), to: DEFAULT_TO() });
  const [request, setRequest] = useState({ loading: true, data: null, error: false });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setRequest({ loading: true, data: null, error: false });
    adminFetch(`/admin/route-scorecard?from=${range.from}&to=${range.to}`)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load the scorecard');
        return res.json();
      })
      .then((data) => { if (active) setRequest({ loading: false, data, error: false }); })
      .catch(() => { if (active) setRequest({ loading: false, data: null, error: true }); });
    return () => { active = false; };
  }, [range.from, range.to, reload]);

  if (request.loading) {
    return <div role="status" className="text-14 text-ink-secondary py-6 text-center">Loading scorecard…</div>;
  }
  if (request.error) {
    return (
      <Card><CardBody className="p-4 text-center">
        <div role="alert" className="text-14 text-alert-fg mb-3">Failed to load the scorecard</div>
        <Button variant="secondary" onClick={() => setReload((value) => value + 1)}>Retry</Button>
      </CardBody></Card>
    );
  }

  const days = request.data?.days || [];
  // Distinct technicianIds across the WHOLE result, not the busiest single
  // day (Codex P2): two different technicians on two different days each
  // have a per-day max of 1 and would otherwise never get a Technician
  // column to tell their rows apart.
  const technicianIds = new Set(days.flatMap((day) => day.byTech.map((row) => row.technicianId)));
  const showTechName = technicianIds.size > 1;
  const rows = days.flatMap((day) => day.byTech.map((row) => ({ date: day.date, row })));
  // The server's own caveat for past PLANNED on-site minutes (a saved
  // snapshot can't detect a co-visit and may double-count one — see
  // day-scorecard.js PLANNED_ONSITE_NOTE). Shown whenever a saved-plan
  // value (a past row, or today's saved plan) is on screen, so an inflated
  // number never reads as authoritative (Codex P2).
  const plannedOnSiteNote = rows.some(({ row }) => row.planned != null && (row.actual != null || row.plannedBasis === 'saved_plan'))
    ? request.data?.assumptions?.plannedOnSiteMinutes : null;

  return (
    <div>
      <div className="text-11 text-ink-tertiary mb-3">
        {range.from} – {range.to}. Future/today rows are planned only; today shows its saved plan when one
        exists, else the remaining route. Past rows compare the saved
        pre-service plan with recorded work — a null shows as "unknown", never 0.
      </div>
      <Card>
        <CardBody className="p-0">
          <Table>
            <THead>
              <TR>
                <TH>Date</TH>
                {showTechName && <TH>Technician</TH>}
                <TH>Basis</TH>
                {METRICS.map((metric) => <TH key={metric.key} align="right">{metric.label}</TH>)}
              </TR>
            </THead>
            <TBody>
              {rows.map(({ date, row }) => (
                <TechDayRows
                  key={`${date}|${row.technicianId}`}
                  date={date}
                  row={row}
                  isPast={row.actual != null}
                  showTechName={showTechName}
                />
              ))}
              {!rows.length && (
                // A day can exist with an empty byTech array (e.g. a closed
                // day) and render zero rows — days.length alone would miss
                // that and leave a blank table with no empty-state message
                // (Codex P2).
                <TR><TD colSpan={2 + METRICS.length + (showTechName ? 1 : 0)} className="text-13 text-ink-tertiary py-6 text-center">No scheduled days in range</TD></TR>
              )}
            </TBody>
          </Table>
        </CardBody>
      </Card>
      {days.some((day) => day.unallocated?.visits > 0) && (
        <div className="text-11 text-ink-tertiary mt-3">
          Not shown per technician (unassigned, or assigned to an ineligible/offboarding technician): {days
            .filter((day) => day.unallocated?.visits > 0)
            .map((day) => `${day.date} (${day.unallocated.visits} stop${day.unallocated.visits === 1 ? '' : 's'}, ${fmtMinutes(day.unallocated.serviceMinutes)})`)
            .join('; ')}.
        </div>
      )}
      <div className={cn('text-11 text-ink-tertiary mt-3')}>
        Future/today drive model: {request.data?.driveModel === 'calibrated' ? 'calibrated (fitted from real trips)' : 'legacy (straight-line estimate)'}.
        {' '}Past rows label their own saved model instead. Actual drive minutes exclude personal and commute trips; unclassified trips are counted as day driving.
      </div>
      {plannedOnSiteNote && <div className="text-11 text-ink-tertiary mt-3">{plannedOnSiteNote}</div>}
    </div>
  );
}
