// Cockroach Report V2 — section composer.
//
// Card order (owner-approved mock 2026-08-29, artifact ffec70e6):
//   1. Today's result (headline · body · metrics · treatment position)
//   2. Where we found activity (rooms · evidence · conducive conditions)
//   3. What we did today (work-completed chips in plain English)
//   4. How you can help (customer prep + the German cooperation warning)
//   5. Your cockroach treatment program (treatment N of M · next treatment
//      date on the live view · what we'll do · what to expect)
// The activity gauge (ActivityCard, 0–5 + history) still renders below the
// dashboard from ReportViewPage — owner kept it (07-14 typed ruling); the
// typed findings card renders minus the fields the dashboard already shows.
import {
  CockroachStatusHero,
  CockroachWhereFound,
  CockroachWorkDone,
  CockroachHowToHelp,
  CockroachProgram,
} from './CockroachReportV2';

export default function CockroachReportV2Section({
  data,
  print = false,
  token = null,
  mode = 'live',
  nextVisitLabel = null,
  // Tech-reviewed narrative, cleaned by the page (cleanVisitSummary).
  narrative = null,
  // Activity gauge payload (score / trend / isBaseline) — the hero prints
  // the cross-visit trend sentence; the reading itself is the hero status.
  activityTrend = null,
}) {
  if (!data) return null;
  return (
    <div style={{ marginTop: 20 }} data-print={print ? 'true' : undefined} data-mode={mode} data-token={token || undefined}>
      <CockroachStatusHero
        status={data.status}
        statusSummary={data.statusSummary}
        metrics={data.metrics}
        narrative={narrative}
        activityTrend={activityTrend}
        program={data.program}
      />
      <CockroachWhereFound
        locations={data.locations}
        evidence={data.evidence}
        conditions={data.conditions}
        statusKey={data.status?.key || null}
      />
      <CockroachWorkDone work={data.work} />
      <CockroachHowToHelp help={data.help} />
      <CockroachProgram whatsNext={data.whatsNext} nextVisitLabel={nextVisitLabel} />
    </div>
  );
}
