// client/src/components/lawn/LawnLastVisitScores.jsx
//
// The last confirmed lawn visit's four scores and overall score, read-only,
// at the top of the lawn assessment step (owner 2026-10-23: "I want the 4
// scores and the final score"). It shows on every lawn completion screen (the
// full form and the lawn sheet), so the technician sees where the lawn stood
// before scoring today. Nothing here is tapped or saved. The data is the
// `lastVisit` key of the step's own visit lookup
// (GET /admin/lawn-assessment/service/:id, server/services/lawn-last-visit-scores.js):
// undefined = not known (still loading, or the read failed) and nothing shows;
// null = no earlier confirmed visit.
import React from "react";

// Same four as the assessment step (LawnAssessmentCompletionBlock), kept here
// so this file does not import the block that renders it.
const METRICS = [
  { key: "turf_density", label: "Density" },
  { key: "weed_suppression", label: "Weed control" },
  { key: "color_health", label: "Color" },
  { key: "stress_damage", label: "Condition" },
];

function formatDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ""))) return "";
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

const display = (value) => (value == null || !Number.isFinite(Number(value)) ? "—" : `${Math.round(Number(value))}/100`);

export default function LawnLastVisitScores({ lastVisit }) {
  if (lastVisit === undefined) return null;
  return (
    <section aria-label="Last visit scores" data-testid="lawn-last-visit-scores" className="rounded-[16px] border border-[#E5E5E5] bg-white px-3 py-2">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-14 font-medium text-zinc-900">Last visit</div>
        {lastVisit && <div className="text-14 text-zinc-500">{formatDay(lastVisit.date)}</div>}
      </div>
      {!lastVisit ? (
        // True both at a lawn's first visit and at its first visit on a new score
        // scale (GATE_LAWN_SCORE_SCALE_V2), where the earlier scores do not compare.
        <div className="text-14 text-zinc-500">No earlier visit to compare. Today sets the baseline.</div>
      ) : (
        <>
          <div className="mt-1 flex items-baseline justify-between gap-3">
            <div className="text-14 text-zinc-900">Overall</div>
            <div data-testid="lawn-last-visit-overall" className="text-16 font-medium text-zinc-900">{display(lastVisit.overall)}</div>
          </div>
          <ul className="m-0 mt-1 grid list-none grid-cols-2 gap-x-3 gap-y-1 p-0">
            {METRICS.map((metric) => (
              <li key={metric.key} data-testid={`lawn-last-visit-${metric.key}`} className="flex items-baseline justify-between gap-2 text-14">
                <span className="text-zinc-500">{metric.label}</span>
                <span className="font-medium text-zinc-900">{display(lastVisit.scores?.[metric.key])}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
