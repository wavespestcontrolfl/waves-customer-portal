import { describe, expect, it } from "vitest";

import {
  completionAreasForTypedFindings,
  labelsPresentInMarkerNotes,
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
  it("keeps migrated controlled area chips but drops free text from pre-chip drafts", () => {
    const field = { key: "areas_treated", type: "chips", options: ["Foundation perimeter"] };
    expect(pruneRestoredFindingsValues(
      { areas_treated: "Garage, Foundation perimeter, Rear addition slab" }, [field],
    )).toEqual({ areas_treated: "Garage, Foundation perimeter" });
    expect(pruneRestoredFindingsValues({ areas_treated: "Rear addition slab" }, [field])).toEqual({});
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
