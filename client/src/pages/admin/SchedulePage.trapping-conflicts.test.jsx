import { describe, expect, it } from "vitest";

import {
  completionAreasForTypedFindings,
  labelsPresentInMarkerNotes,
  entryLimitProblems,
  normalizedEntries,
  reconcileProtocolActions,
  withoutProtocolMarkerLines,
  offListTypedAreaValues,
  productAreaChoices,
  pruneRestoredFindingsValues,
  specialtyActionScope,
  typedTreatmentAreaField,
  typedFieldValueConflicts,
} from "./SchedulePage.jsx";

// Initial-setup constraints mirrored pre-submit (codex P2 r14, PR #3159):
// the server's validateTypedFindings rejections must surface as the inline
// prompt, not a post-submit 422. The caller runs typedFieldValueConflicts
// for the primary AND every companion section, so covering the helper
// covers both forms.
describe("rodent trapping initial-setup pre-submit mirror", () => {
  it("a setup with a blank, zero, or junk count blocks with the server's message", () => {
    for (const traps of ["", "0", "-2", "abc", undefined]) {
      const conflicts = typedFieldValueConflicts("rodent_trapping", {
        trap_visit_type: "Initial setup",
        traps_checked: traps,
      });
      expect(
        conflicts.some((c) => c.includes("initial setup must record")),
      ).toBe(true);
    }
  });

  it("follow-up-only trap actions on a setup block with the action named", () => {
    const conflicts = typedFieldValueConflicts("rodent_trapping", {
      trap_visit_type: "Initial setup",
      traps_checked: "6",
      trap_actions: "New traps added, Traps reset",
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain('"Traps reset"');
    expect(conflicts[0]).not.toContain('"New traps added"');
  });

  it("a valid setup and any follow-up pass untouched", () => {
    expect(
      typedFieldValueConflicts("rodent_trapping", {
        trap_visit_type: "Initial setup",
        traps_checked: "6",
        trap_actions: "New traps added",
      }),
    ).toEqual([]);
    expect(
      typedFieldValueConflicts("rodent_trapping", {
        trap_visit_type: "Follow-up check",
        traps_checked: "",
        trap_actions: "Traps reset",
      }),
    ).toEqual([]);
  });
});

describe("termite posted-notice pre-submit mirror", () => {
  it("treats rodding as a perimeter soil application", () => {
    const conflicts = typedFieldValueConflicts("termite_treatment", {
      treatment_method: "Rodding",
      posted_notice: "Not applicable",
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain("exterior/perimeter treatments require the posted notice");
  });
});

describe("typed area ownership", () => {
  it("keeps every restored treatment-area value visible instead of dropping documented scope", () => {
    const field = { key: "areas_treated", type: "chips", options: ["Foundation perimeter"] };
    expect(pruneRestoredFindingsValues(
      { areas_treated: "Bait stations, Foundation perimeter, Primary bedroom, Rear addition slab" }, [field], "termite_treatment",
    )).toEqual({ areas_treated: "Bait stations, Foundation perimeter, Primary bedroom, Rear addition slab" });
    // Inspection areas changed from free text to chips too: the legacy text stays visible.
    const inspected = { key: "areas_inspected", type: "chips", options: ["Kitchen"] };
    expect(pruneRestoredFindingsValues({ areas_inspected: "Kitchen, Behind the pool pump" }, [inspected], "one_time_pest_treatment"))
      .toEqual({ areas_inspected: "Kitchen, Behind the pool pump" });
    expect(typedFieldValueConflicts("one_time_pest_treatment", { areas_inspected: "Kitchen, Behind the pool pump" }, [inspected])[0])
      .toContain('"Behind the pool pump"');
    // Other chip fields still prune to the current options.
    const other = { key: "work_completed", type: "chips", options: ["Trenching"] };
    expect(pruneRestoredFindingsValues({ work_completed: "Trenching, Retired option" }, [other])).toEqual({ work_completed: "Trenching" });
  });
  it("flags off-list treatment areas pre-submit with the fix spelled out", () => {
    const palm = { key: "areas_treated", options: ["Front landscape palms", "Other"] };
    expect(offListTypedAreaValues(["Front yard", "Front landscape palms", "Kitchen"], palm, "palm_injection"))
      .toEqual(["Front yard", "Kitchen"]);
    const termite = { key: "areas_treated", options: ["Foundation perimeter"] };
    expect(offListTypedAreaValues(["Bait stations", "Kitchen"], termite, "termite_treatment")).toEqual(["Kitchen"]);
    const conflicts = typedFieldValueConflicts("termite_treatment", {
      areas_treated: "Bait stations, Rear addition slab",
      treatment_method: "Bait station setup",
    }, [termite, { key: "treatment_method", type: "select", options: ["Bait station setup"] }]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain('"Rear addition slab"');
    expect(conflicts[0]).not.toContain('"Bait stations"');
    expect(typedFieldValueConflicts("termite_treatment", { areas_treated: "Bait stations" }, [termite])).toEqual([]);
  });
  it("promotes the typed areas into the canonical completion scope", () => {
    expect(completionAreasForTypedFindings({
      typedAreaKey: "areas_treated",
      findingsValues: { areas_treated: "Exterior perimeter, Garage" },
      genericAreas: [],
    })).toEqual(["Exterior perimeter", "Garage"]);
  });

  it("recognizes the one-time lawn area field", () => {
    const schema = { fields: [{ key: "spot_treatment_areas", label: "Areas treated" }] };
    expect(typedTreatmentAreaField(schema)?.key).toBe("spot_treatment_areas");
    expect(completionAreasForTypedFindings({
      typedAreaKey: "spot_treatment_areas",
      findingsValues: { spot_treatment_areas: "Front yard, Side yards" },
      genericAreas: ["Back yard"],
    })).toEqual(["Front yard", "Side yards"]);
  });

  it("recognizes mosquito treatment zones as the canonical area field", () => {
    const schema = { fields: [{ key: "treatment_zones", label: "Treatment zones" }] };
    expect(typedTreatmentAreaField(schema)?.key).toBe("treatment_zones");
    expect(completionAreasForTypedFindings({
      typedAreaKey: "treatment_zones",
      findingsValues: { treatment_zones: "Lanai, Yard vegetation" },
      genericAreas: [],
    })).toEqual(["Lanai", "Yard vegetation"]);
  });

  it("preserves generic areas from drafts created before typed area fields existed", () => {
    expect(completionAreasForTypedFindings({
      typedAreaKey: "areas_treated",
      findingsValues: { areas_treated: "" },
      genericAreas: ["Exterior perimeter", "Garage"],
    })).toEqual(["Exterior perimeter", "Garage"]);
  });

  it("keeps product-specific mappings editable against typed areas", () => {
    expect(productAreaChoices(
      ["Exterior perimeter", "Garage"],
      "Garage, Legacy wall void",
    )).toEqual(["Exterior perimeter", "Garage", "Legacy wall void"]);
  });
});

describe("specialty treatment scope", () => {
  it("matches the server-side derivation for every classified area combination", async () => {
    const { specialtyActionScopeForAreas } = await import("../../../../shared/specialty-service-closeouts");
    const cases = [
      [["Attic"], "exterior"], [["Garage / carport"], "exterior"], [["Eaves / soffit", "Roofline"], "interior"],
      [["Attic", "Eaves / soffit"], "exterior"], [["Other"], "exterior"], [[], "interior"],
      [["Interior pet areas", "Furniture near pet areas"], "exterior"], [["Legacy free text"], "interior"],
    ];
    for (const [areas, defaultScope] of cases) {
      expect(specialtyActionScope({ areas, defaultScope })).toBe(specialtyActionScopeForAreas(areas, defaultScope));
    }
  });
  it("follows the treated areas when they all sit on one side", () => {
    expect(specialtyActionScope({ areas: ["Attic"], defaultScope: "exterior" })).toBe("interior");
    expect(specialtyActionScope({ areas: ["Attic / structural interior"], defaultScope: "exterior" })).toBe("interior");
    expect(specialtyActionScope({ areas: ["Garage / carport"], defaultScope: "exterior" })).toBe("interior");
    expect(specialtyActionScope({ areas: ["Interior pet areas", "Furniture near pet areas"], defaultScope: "exterior" })).toBe("interior");
    expect(specialtyActionScope({ areas: ["Eaves / soffit", "Roofline"], defaultScope: "interior" })).toBe("exterior");
  });
  it("keeps the default for mixed, unclassified or empty areas", () => {
    expect(specialtyActionScope({ areas: ["Attic", "Eaves / soffit"], defaultScope: "exterior" })).toBe("exterior");
    expect(specialtyActionScope({ areas: ["Other"], defaultScope: "exterior" })).toBe("exterior");
    expect(specialtyActionScope({ areas: [], defaultScope: "interior" })).toBe("interior");
  });
});

describe("structured note marker matching", () => {
  it("does not retain an active label through an overlapping inactive label", () => {
    expect(labelsPresentInMarkerNotes(
      "[Found] Inactive or abandoned nests",
      ["Active mud nests", "Inactive or abandoned nests"],
    )).toEqual(["Inactive or abandoned nests"]);
  });

  // The server accepts whitespace after "]" as optional; the client must
  // treat the same lines as live markers (codex P2 #5051).
  it("treats a no-space marker as active, like the server grammar", () => {
    for (const line of ["[Protocol]Treated the perimeter", "  [Action]Treated the perimeter  ", "[protocol optional]Treated the perimeter"]) {
      expect(labelsPresentInMarkerNotes(line, ["Treated the perimeter"])).toEqual(["Treated the perimeter"]);
    }
    expect(labelsPresentInMarkerNotes("[Protocol]", ["Treated the perimeter"])).toEqual([]);
  });
});

describe("submit reconciliation of protocol action markers", () => {
  const pestContext = {
    specialtyProtocolActions: [],
    protocolActions: [],
    protocolActionsLoaded: true,
    actionScopeByLabel: {},
    isLawn: false,
    completionImprovements: false,
  };
  const lawnContext = {
    ...pestContext,
    isLawn: true,
    protocolActions: [{ label: "Applied weed control" }],
  };

  it("keeps a completed action whose marker was edited to no-space", () => {
    const notes = "[Protocol]Treated the perimeter\n[Found] Ants";
    const result = reconcileProtocolActions({
      labels: ["Treated the perimeter"],
      notes,
      context: pestContext,
    });
    expect(result.reportProtocolActions).toEqual(["Treated the perimeter"]);
    expect(result.reportTechnicianNotes).toBe(notes);
    expect(result.completedActions).toEqual(["Treated the perimeter"]);
  });

  it("prunes markers of excluded labels, spaced or not, and nothing else", () => {
    const result = reconcileProtocolActions({
      labels: ["Applied weed control", "Stale scout task", "Other stale task"],
      notes: [
        "[Protocol] Applied weed control",
        "[Protocol]Stale scout task",
        "[Action] Other stale task",
        "[Action] Free typed action",
        "Plain prose stays",
      ].join("\n"),
      context: lawnContext,
    });
    expect(result.reportProtocolActions).toEqual(["Applied weed control"]);
    expect(result.reportTechnicianNotes).toBe(
      "[Protocol] Applied weed control\n[Action] Free typed action\nPlain prose stays",
    );
    expect(result.completedActions).toEqual(["Applied weed control", "Free typed action"]);
  });

  it("lets a saved scope stand only while the action source is empty", () => {
    const actionScopeByLabel = { "Saved label": { scope: "exterior", treatmentApplied: true } };
    const unavailable = { ...lawnContext, protocolActionsLoaded: false, actionScopeByLabel };
    const loaded = { ...lawnContext, actionScopeByLabel };
    const args = { labels: ["Saved label"], notes: "[Action]Saved label" };
    expect(reconcileProtocolActions({ ...args, context: unavailable }).reportProtocolActions).toEqual(["Saved label"]);
    const dropped = reconcileProtocolActions({ ...args, context: loaded });
    expect(dropped.reportProtocolActions).toEqual([]);
    expect(dropped.reportTechnicianNotes).toBe("");
  });

  it("counts a whitespace-variant duplicate marker once, like the server", () => {
    const labels = Array.from({ length: 20 }, (_, i) => `Action number ${i}`);
    const result = reconcileProtocolActions({
      labels,
      notes: "[Action]  action   NUMBER 3 \n[Protocol]Action\tnumber 4",
      context: pestContext,
    });
    expect(result.completedActions).toHaveLength(20);
    expect(result.completedActions.some((line) => line.length > 240)).toBe(false);
  });

  it("measures length after whitespace collapse, and still rejects a genuinely long entry", () => {
    const padded = `Treated ${" ".repeat(400)}the perimeter`;
    const collapsed = reconcileProtocolActions({ labels: [], notes: `[Action]${padded}`, context: pestContext });
    expect(collapsed.completedActions).toEqual(["Treated the perimeter"]);
    const long = reconcileProtocolActions({ labels: [], notes: `[Action]${"x".repeat(241)}`, context: pestContext });
    expect(long.completedActions.some((line) => line.length > 240)).toBe(true);
  });

  it("normalizes entries the way the server does", () => {
    expect(normalizedEntries(["  a   b ", "A B", "", "   ", "c"])).toEqual(["a b", "c"]);
  });

  it("counts observations and recommendations on the entries the server persists", () => {
    const labels = Array.from({ length: 19 }, (_, i) => `Finding ${i}`);
    // A whitespace/case variant of a chip label and of a free line is the same
    // persisted entry: 19 labels + 1 unique free line = 20, not blocked.
    const entries = normalizedEntries([...labels, "  finding   3 ", "Extra   sighting", "extra sighting"]);
    expect(entries).toHaveLength(20);
    expect(entryLimitProblems([["Observations", entries, entries]])).toEqual([]);
    const over = normalizedEntries([...entries, "One more"]);
    expect(entryLimitProblems([["Observations", over, over]])).toEqual([
      "Observations: at most 20 entries total (21 entered)",
    ]);
  });

  it("length-checks after whitespace collapse and rejects a genuinely long line", () => {
    const spaced = normalizedEntries([`Saw ${" ".repeat(300)}ants`]);
    expect(entryLimitProblems([["Recommendations", spaced, spaced]])).toEqual([]);
    const long = normalizedEntries(["y".repeat(241)]);
    expect(entryLimitProblems([["Recommendations", long, long]])).toEqual([
      "Recommendations: keep each line under 240 characters",
    ]);
  });

  it("limits specialty lanes to their own actions", () => {
    const context = { ...pestContext, specialtyProtocolActions: [{ label: "Preset action" }] };
    const result = reconcileProtocolActions({
      labels: ["Preset action", "Restored label"],
      notes: "[Protocol]Preset action\n[Protocol]Restored label",
      context,
    });
    expect(result.reportProtocolActions).toEqual(["Preset action"]);
    expect(withoutProtocolMarkerLines("[Protocol]Restored label", ["Restored label"])).toBe("");
  });
});

// Round 15: Number("1.0") and Number("1e1") are positive integers, but the
// server's count validator requires a digit-only string — so a
// coercion-only mirror still let through the 422 it exists to prevent.
describe("setup count shape mirrors the server's digit-only rule", () => {
  it("rejects numeric forms the server's count validator rejects", () => {
    for (const raw of ["1.0", "1e1", "0x8", " 8.5 ", "+8", "eight"]) {
      const conflicts = typedFieldValueConflicts("rodent_trapping", {
        trap_visit_type: "Initial setup",
        traps_checked: raw,
      });
      expect(conflicts.length).toBeGreaterThan(0);
    }
  });

  it("accepts the digit-only forms the server accepts", () => {
    for (const raw of ["8", "  8  ", "8 ", 8]) {
      expect(
        typedFieldValueConflicts("rodent_trapping", {
          trap_visit_type: "Initial setup",
          traps_checked: raw,
        }),
      ).toEqual([]);
    }
  });
});
