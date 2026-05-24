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

export function pipelineStageLabel(stage) {
  return PIPELINE_STAGE_LABELS[stage] || "New Lead";
}
