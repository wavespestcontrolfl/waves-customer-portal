import { normalizeTableColumns } from "../../lib/adminTableViewStorage";

export const CUSTOMER_TABLE_COLUMNS = [
  { id: "customer", label: "Customer", required: true },
  { id: "property", label: "Property" },
  { id: "tier", label: "WaveGuard Tier" },
  { id: "nextService", label: "Next service" },
  { id: "attention", label: "Attention" },
  { id: "actions", label: "Actions", required: true },
];

export const ALL_CUSTOMER_TABLE_COLUMNS = CUSTOMER_TABLE_COLUMNS.map(({ id }) => id);

const STAGES = new Set([
  "all",
  "new_lead",
  "contacted",
  "estimate_sent",
  "estimate_viewed",
  "follow_up",
  "won",
  "active_customer",
  "at_risk",
  "churned",
  "past_customer",
  "lost",
]);
const TIERS = new Set(["all", "Platinum", "Gold", "Silver", "Bronze", "One-Time", "none"]);
const LAST_VISITED = new Set(["all", "30", "90", "180", "never"]);
const CARDS = new Set(["all", "has", "none"]);
const SORTS = new Set([
  "name",
  "lastName",
  "firstName",
  "lifetimeRevenue",
  "leadScore",
  "monthlyRate",
  "lastContactDate",
]);
const HEALTH_GRADES = new Set(["", "A", "B", "C", "D", "F", "ungraded"]);
export const CUSTOMER_HEALTH_RISKS = new Set(["low", "moderate", "high", "critical", "at_risk"]);
const HEALTH_RISKS = new Set(["", ...CUSTOMER_HEALTH_RISKS]);
const CHURN_PROBABILITIES = new Set(["", "0", "25", "50", "75"]);
const RETENTION_OUTCOMES = new Set([
  "",
  "outreach_sent",
  "saved",
  "revenue_saved",
  "upsell_accepted",
  "upsell_revenue",
]);
const PAGE_SIZES = new Set([25, 50, 100, 500]);

function fromSet(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function score(value) {
  if (value === "" || value === null || value === undefined) return "";
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 ? String(parsed) : "";
}

function normalizeHealthFilters(value) {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const minHealthScore = score(candidate.minHealthScore);
  // Normalize each bound independently: during typing, the first digit of a
  // valid maximum can temporarily be lower than the minimum.
  const maxHealthScore = score(candidate.maxHealthScore);
  return {
    healthGrade: fromSet(candidate.healthGrade, HEALTH_GRADES, ""),
    healthRisk: fromSet(candidate.healthRisk, HEALTH_RISKS, ""),
    minHealthScore,
    maxHealthScore,
    minChurnProbability: fromSet(String(candidate.minChurnProbability ?? ""), CHURN_PROBABILITIES, ""),
    retention: fromSet(candidate.retention, RETENTION_OUTCOMES, ""),
  };
}

export const CUSTOMER_TABLE_VIEW_DEFAULTS = {
  search: "",
  filterStage: "all",
  filterTier: "all",
  healthFilters: normalizeHealthFilters({}),
  sortBy: "lastName",
  sortDir: "asc",
  filterHasBalance: false,
  filterLastVisited: "all",
  filterCards: "all",
  pageSize: 100,
  visibleColumns: ALL_CUSTOMER_TABLE_COLUMNS,
  page: 1,
  scrollTop: 0,
};

export function normalizeCustomerTableViewState(value) {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    search: typeof candidate.search === "string" ? candidate.search.slice(0, 160) : "",
    filterStage: fromSet(candidate.filterStage, STAGES, "all"),
    filterTier: fromSet(candidate.filterTier, TIERS, "all"),
    healthFilters: normalizeHealthFilters(candidate.healthFilters),
    sortBy: fromSet(candidate.sortBy, SORTS, "lastName"),
    sortDir: candidate.sortDir === "desc" ? "desc" : "asc",
    filterHasBalance: candidate.filterHasBalance === true,
    filterLastVisited: fromSet(candidate.filterLastVisited, LAST_VISITED, "all"),
    filterCards: fromSet(candidate.filterCards, CARDS, "all"),
    pageSize: PAGE_SIZES.has(Number(candidate.pageSize)) ? Number(candidate.pageSize) : 100,
    visibleColumns: normalizeTableColumns(candidate.visibleColumns, CUSTOMER_TABLE_COLUMNS),
  };
}
