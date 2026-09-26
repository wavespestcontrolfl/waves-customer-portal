// Target resolution + tone for the KPI tiles.
//
// DEFAULT_KPI_TARGETS and kpiTargetTone live in shared/kpi-targets.cjs (the
// @kpi-targets alias below) so the server (bi-agent-tools.js
// get_operations_snapshot) reads the exact same defaults and tone rule the
// dashboard tiles do — same precedent as @lawn-scores / @proposal-bid.
// Import DEFAULT_KPI_TARGETS from '@kpi-targets' directly rather than from
// this module — every caller does (AGENTS.md: no re-export shims for callers
// this repo controls).
import { DEFAULT_KPI_TARGETS } from '@kpi-targets';

// Owner-facing labels for the Settings tab + tile tooltips, in dashboard
// section order. Metrics without a default target still appear so the owner
// can set one — but ONLY metrics some tile actually reads (metricKey) are
// listed: tech_utilization and stops_per_hour are snapshot-only today (no
// tile), so an editable target for them would silently do nothing. Add them
// back here when their tiles exist.
export const KPI_METRIC_LABELS = {
  completion_rate: "Completion rate (%)",
  callback_rate: "Callback rate (%)",
  revenue_per_job: "Revenue per job ($)",
  revenue_per_man_hour: "Revenue per man-hour ($)",
  gross_margin: "Gross margin (%)",
  ar_days: "AR days",
  lead_conversion: "Lead conversion (%)",
  response_speed_min: "Response speed (min)",
  csat_avg: "CSAT (0-10)",
  retention_pct: "Retention (%)",
  collection_rate: "Collection rate (%)",
  autopay_pct: "Autopay coverage (%)",
  net_customers: "Net customers (month)",
  net_mrr: "Net MRR (month, $)",
};

// `targets` is the store fetch reshaped to { [metric]: row } (DashboardPageV2
// wave3); null/undefined while unfetched.
export function resolveTargetDef(metricKey, targets) {
  if (!metricKey) return null;
  return targets?.[metricKey] || DEFAULT_KPI_TARGETS[metricKey] || null;
}
