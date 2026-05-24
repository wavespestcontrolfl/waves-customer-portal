import React from "react";
import { Badge } from "../../../components/ui";
import { PIPELINE_STAGES, pipelineStageLabel } from "./pipelineStages";

const TONES = {
  [PIPELINE_STAGES.NEW_LEAD]: "strong",
  [PIPELINE_STAGES.CONTACTED]: "neutral",
  [PIPELINE_STAGES.QUALIFIED]: "neutral",
  [PIPELINE_STAGES.ESTIMATE_NEEDED]: "strong",
  [PIPELINE_STAGES.ESTIMATE_DRAFT]: "neutral",
  [PIPELINE_STAGES.ESTIMATE_SENT]: "neutral",
  [PIPELINE_STAGES.ESTIMATE_VIEWED]: "strong",
  [PIPELINE_STAGES.WON]: "strong",
  [PIPELINE_STAGES.LOST]: "alert",
};

export default function OpportunityStageBadge({ stage, className }) {
  return (
    <Badge tone={TONES[stage] || "neutral"} dot className={className}>
      {pipelineStageLabel(stage)}
    </Badge>
  );
}
