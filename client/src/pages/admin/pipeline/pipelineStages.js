export const PIPELINE_STAGES = {
  NEW_LEAD: "new_lead",
  CONTACTED: "contacted",
  QUALIFIED: "qualified",
  ESTIMATE_NEEDED: "estimate_needed",
  ESTIMATE_DRAFT: "estimate_draft",
  ESTIMATE_SENT: "estimate_sent",
  ESTIMATE_VIEWED: "estimate_viewed",
  WON: "won",
  LOST: "lost",
};

export const PIPELINE_STAGE_LABELS = {
  [PIPELINE_STAGES.NEW_LEAD]: "New Lead",
  [PIPELINE_STAGES.CONTACTED]: "Contacted",
  [PIPELINE_STAGES.QUALIFIED]: "Qualified",
  [PIPELINE_STAGES.ESTIMATE_NEEDED]: "Estimate Needed",
  [PIPELINE_STAGES.ESTIMATE_DRAFT]: "Estimate Draft",
  [PIPELINE_STAGES.ESTIMATE_SENT]: "Estimate Sent",
  [PIPELINE_STAGES.ESTIMATE_VIEWED]: "Estimate Viewed",
  [PIPELINE_STAGES.WON]: "Won",
  [PIPELINE_STAGES.LOST]: "Lost",
};

export const PIPELINE_FILTERS = [
  { key: "all", label: "All" },
  { key: "needs_action", label: "Needs Action" },
  { key: "new", label: "New" },
  { key: "estimate_needed", label: "Estimate Needed" },
  { key: "draft", label: "Draft" },
  { key: "sent", label: "Sent" },
  { key: "viewed", label: "Viewed" },
  { key: "follow_up", label: "Follow Up" },
  { key: "duplicate_risk", label: "Duplicate Risk" },
  { key: "won", label: "Won" },
  { key: "lost", label: "Lost" },
];

export const PIPELINE_PRESETS = [
  {
    key: "needs_action",
    label: "Needs Action",
    filters: { filter: "needs_action", search: "", sort: "default", dateRange: "all", source: "" },
  },
  {
    key: "google_leads",
    label: "Google Leads",
    filters: { filter: "all", search: "", sort: "default", dateRange: "all", source: "google" },
  },
  {
    key: "viewed_estimates",
    label: "Viewed Estimates",
    filters: { filter: "viewed", search: "", sort: "default", dateRange: "all", source: "" },
  },
  {
    key: "follow_up",
    label: "Follow Up",
    filters: { filter: "follow_up", search: "", sort: "next_follow_up", dateRange: "all", source: "" },
  },
  {
    key: "duplicate_risk",
    label: "Duplicate Risk",
    filters: { filter: "duplicate_risk", search: "", sort: "default", dateRange: "all", source: "" },
  },
];

export function pipelineStageLabel(stage) {
  return PIPELINE_STAGE_LABELS[stage] || "New Lead";
}

export function activePipelinePresetKey(state) {
  const normalized = {
    filter: state.filter || "needs_action",
    search: String(state.search || "").trim(),
    sort: state.sort || "default",
    dateRange: state.dateRange || "all",
    source: String(state.source || "").trim().toLowerCase(),
  };

  const preset = PIPELINE_PRESETS.find(({ filters }) => (
    filters.filter === normalized.filter
    && filters.search === normalized.search
    && filters.sort === normalized.sort
    && filters.dateRange === normalized.dateRange
    && filters.source.toLowerCase() === normalized.source
  ));

  return preset?.key || "custom";
}
