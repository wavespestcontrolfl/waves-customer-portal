import React from "react";
import { Button, cn } from "../../../components/ui";
import { PIPELINE_FILTERS } from "./pipelineStages";

export default function UnifiedPipelineFilters({ activeFilter, counts, onChange }) {
  return (
    <div className="flex flex-wrap gap-2">
      {PIPELINE_FILTERS.map((filter) => {
        const active = activeFilter === filter.key;
        const count = counts?.[filter.key] ?? 0;
        return (
          <Button
            key={filter.key}
            size="sm"
            variant={active ? "primary" : "secondary"}
            onClick={() => onChange(filter.key)}
            className={cn("gap-2", !active && "text-zinc-700")}
          >
            <span>{filter.label}</span>
            <span className={cn(
              "u-nums text-10 px-1.5 py-0.5 rounded-xs",
              active ? "bg-white/15 text-white" : "bg-zinc-100 text-zinc-600",
            )}>
              {count}
            </span>
          </Button>
        );
      })}
    </div>
  );
}
