import { describe, expect, it } from "vitest";
import {
  DEFAULT_KPI_TARGETS,
  KPI_METRIC_LABELS,
  kpiTargetTone,
  resolveTargetDef,
} from "./kpi-targets";

describe("resolveTargetDef", () => {
  it("prefers a store row over the built-in default", () => {
    const store = { gross_margin: { target: 50, lowerIsBetter: false, amberBandPct: 5 } };
    expect(resolveTargetDef("gross_margin", store).target).toBe(50);
  });

  it("falls back to DEFAULT_KPI_TARGETS while the store is unfetched or missing the metric", () => {
    expect(resolveTargetDef("gross_margin", null)).toEqual(DEFAULT_KPI_TARGETS.gross_margin);
    expect(resolveTargetDef("gross_margin", {})).toEqual(DEFAULT_KPI_TARGETS.gross_margin);
  });

  it("returns null for metrics without any target and for missing keys", () => {
    expect(resolveTargetDef("net_mrr", null)).toBeNull();
    expect(resolveTargetDef(null, {})).toBeNull();
  });
});

describe("kpiTargetTone", () => {
  const def = { target: 85, lowerIsBetter: false, amberBandPct: 10 };

  it("meets target → good; miss within the amber band → warn; beyond → bad", () => {
    expect(kpiTargetTone(85, def)).toBe("good");
    expect(kpiTargetTone(90, def)).toBe("good");
    // band = 8.5, so 76.5 is the amber floor
    expect(kpiTargetTone(80, def)).toBe("warn");
    expect(kpiTargetTone(76.5, def)).toBe("warn");
    expect(kpiTargetTone(76, def)).toBe("bad");
  });

  it("lowerIsBetter flips the comparison", () => {
    const lower = { target: 30, lowerIsBetter: true, amberBandPct: 10 };
    expect(kpiTargetTone(28, lower)).toBe("good");
    expect(kpiTargetTone(32, lower)).toBe("warn"); // band = 3
    expect(kpiTargetTone(34, lower)).toBe("bad");
  });

  it("null when the value or target is absent/non-numeric — callers keep their own fallback", () => {
    expect(kpiTargetTone(null, def)).toBeNull();
    expect(kpiTargetTone("", def)).toBeNull();
    expect(kpiTargetTone("n/a", def)).toBeNull();
    expect(kpiTargetTone(50, null)).toBeNull();
    expect(kpiTargetTone(50, { lowerIsBetter: true })).toBeNull();
  });

  it("every default target's metric has an owner-facing label (Settings tab renders them all)", () => {
    for (const metric of Object.keys(DEFAULT_KPI_TARGETS)) {
      expect(KPI_METRIC_LABELS[metric]).toBeTruthy();
    }
  });
});
