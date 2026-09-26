'use strict';

// Target resolution + tone for the KPI tiles — shared between the dashboard
// client (client/src/pages/admin/dashboard/kpi-targets.js, which re-exports
// these two) and the server (server/services/bi-agent-tools.js
// get_operations_snapshot), so the Weekly BI Briefing's tone can never
// disagree with the dashboard tile it is describing.
//
// DEFAULT_KPI_TARGETS mirrors the thresholds that were hardcoded in the
// section JSX before the kpi_targets store existed — an empty store or a
// failed /admin/kpi-targets fetch renders exactly the dashboard that shipped
// before the store. A store row (by metric key) always wins over the default.
// Keys are the SNAPSHOT_METRICS keys (server/services/kpi-snapshot.js) — the
// same keys the kpi-history sparkline series use.
const DEFAULT_KPI_TARGETS = {
  completion_rate: { target: 85, lowerIsBetter: false, amberBandPct: 10 },
  // The old guard was red AT >= 6, i.e. good requires < 6. The tile value is
  // server-rounded to one decimal, so 5.9 is the highest value that was good
  // — a target of 6 with <=-semantics would flip exactly-6.0 to green.
  callback_rate: { target: 5.9, lowerIsBetter: true, amberBandPct: 10 },
  lead_conversion: { target: 20, lowerIsBetter: false, amberBandPct: 10 },
  response_speed_min: { target: 60, lowerIsBetter: true, amberBandPct: 10 },
  gross_margin: { target: 40, lowerIsBetter: false, amberBandPct: 10 },
  // The old tile went red only below $90 against a $120 target — a deliberate
  // two-threshold design, translated as a 25% amber band.
  revenue_per_man_hour: { target: 120, lowerIsBetter: false, amberBandPct: 25 },
  retention_pct: { target: 85, lowerIsBetter: false, amberBandPct: 10 },
  csat_avg: { target: 8, lowerIsBetter: false, amberBandPct: 10 },
  collection_rate: { target: 70, lowerIsBetter: false, amberBandPct: 10 },
  ar_days: { target: 30, lowerIsBetter: true, amberBandPct: 10 },
};

// red / amber / green against the target: a miss beyond the amber band is
// 'bad', within it 'warn', met is 'good'. null when the metric has no value
// or no target — callers keep their own fallback behavior then.
function kpiTargetTone(value, def) {
  if (def?.target == null) return null;
  if (value == null || value === '' || !Number.isFinite(Number(value))) return null;
  const v = Number(value);
  const t = Number(def.target);
  const meets = def.lowerIsBetter ? v <= t : v >= t;
  if (meets) return 'good';
  const bandPct = def.amberBandPct == null ? 10 : Number(def.amberBandPct);
  const band = Math.abs(t) * (bandPct / 100);
  const missBy = def.lowerIsBetter ? v - t : t - v;
  return missBy <= band ? 'warn' : 'bad';
}

module.exports = { DEFAULT_KPI_TARGETS, kpiTargetTone };
