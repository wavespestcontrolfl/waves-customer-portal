import { describe, expect, it } from "vitest";
import { PIPELINE_FILTERS, PIPELINE_PRESETS, activePipelinePresetKey } from "./pipelineStages";

const FILTER_KEYS = new Set(PIPELINE_FILTERS.map((filter) => filter.key));

describe("pipeline presets", () => {
  it("only references valid pipeline filter keys", () => {
    expect(PIPELINE_PRESETS.length).toBeGreaterThan(0);

    for (const preset of PIPELINE_PRESETS) {
      expect(FILTER_KEYS.has(preset.filters.filter)).toBe(true);
      expect(preset.filters.page).toBeUndefined();
    }
  });

  it("detects the active preset from URL-backed filter state", () => {
    expect(activePipelinePresetKey({
      filter: "needs_action",
      search: "",
      sort: "default",
      dateRange: "all",
      source: "",
    })).toBe("needs_action");

    expect(activePipelinePresetKey({
      filter: "all",
      search: "",
      sort: "default",
      dateRange: "all",
      source: "Google",
    })).toBe("google_leads");
  });

  it("marks edited preset state as custom", () => {
    expect(activePipelinePresetKey({
      filter: "viewed",
      search: "smith",
      sort: "default",
      dateRange: "all",
      source: "",
    })).toBe("custom");
  });
});
