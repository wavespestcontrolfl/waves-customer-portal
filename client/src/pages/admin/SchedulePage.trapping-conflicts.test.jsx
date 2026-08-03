import { describe, expect, it } from "vitest";

import { typedFieldValueConflicts } from "./SchedulePage.jsx";

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
