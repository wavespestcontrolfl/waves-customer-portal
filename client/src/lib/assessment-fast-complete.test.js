import { describe, expect, it } from "vitest";

import { isAssessmentFastCompleteEligible } from "./assessment-fast-complete";
import { fastCompleteSheetFor, shouldOpenAssessmentFastComplete } from "./dispatchCompletionRouting";

// A Waves Assessment row as the schedule payload carries it with the gate on.
const assessment = (overrides = {}) => ({
  id: "svc-a",
  status: "confirmed",
  propertyId: "prop-1",
  serviceType: "Waves Assessment",
  assessmentFastCompleteEnabled: true,
  inspectionCreditAvailable: true,
  completionProfile: { category: "inspection", serviceKey: "lawn_inspection", companions: [] },
  ...overrides,
});

describe("assessment Fast Complete routing (GATE_ASSESSMENT_FAST_COMPLETE)", () => {
  it("an eligible assessment opens its own sheet with the gate flag on", () => {
    expect(isAssessmentFastCompleteEligible(assessment())).toBe(true);
    expect(shouldOpenAssessmentFastComplete(assessment())).toBe(true);
    expect(fastCompleteSheetFor(assessment())).toBe("assessment");
  });

  it("with the gate flag off or missing the assessment keeps the full form, as before", () => {
    expect(fastCompleteSheetFor(assessment({ assessmentFastCompleteEnabled: false }))).toBeNull();
    expect(fastCompleteSheetFor(assessment({ assessmentFastCompleteEnabled: undefined }))).toBeNull();
    // Only an exact true counts.
    expect(fastCompleteSheetFor(assessment({ assessmentFastCompleteEnabled: "true" }))).toBeNull();
  });

  it("another service never opens it, even with the flag set", () => {
    const pestVisit = assessment({
      serviceType: "Pest Control",
      completionProfile: { category: "pest_control", serviceKey: "pest_control_quarterly", companions: [] },
    });
    expect(isAssessmentFastCompleteEligible(pestVisit)).toBe(false);
    expect(fastCompleteSheetFor(pestVisit)).not.toBe("assessment");
  });

  it.each([
    ["a closed visit", { status: "completed" }],
    ["a cancelled visit", { status: "cancelled" }],
    ["a no-show visit", { status: "no_show" }],
    ["a failed profile read", { completionProfileLookupFailed: true }],
    ["a failed linked-project read", { linkedProjectLookupFailed: true }],
    ["a visit that completes through a project", { linkedProject: { id: "proj-1" } }],
    ["a visit with companion sections", { completionProfile: { category: "inspection", serviceKey: "lawn_inspection", companions: [{ type: "rodent_bait" }] } }],
    ["a visit closed out as a whole (packet)", { visitId: "visit-1", visitCloseoutPacket: { id: "pkt-1" } }],
    ["a grouped stop", { visitId: "visit-1", visitCloseoutEnabled: true }],
    ["a visit returning from the payment flow (invoice sent)", { completionInvoiceAlreadySent: true }],
    ["a visit returning from the payment flow (checkout invoice)", { checkoutInvoiceId: "inv-1" }],
    ["a visit returning from the payment flow (checkout token)", { checkoutInvoiceToken: "tok" }],
  ])("%s stays on the full form", (_label, overrides) => {
    expect(fastCompleteSheetFor(assessment(overrides))).not.toBe("assessment");
  });

  it("a row with no propertyId key (the mobile week list) stays on the full form", () => {
    const { propertyId: _omit, ...weekRow } = assessment();
    expect(isAssessmentFastCompleteEligible(weekRow)).toBe(true);
    expect(shouldOpenAssessmentFastComplete(weekRow)).toBe(false);
    expect(fastCompleteSheetFor(weekRow)).toBeNull();
    // A key that is present and null (never stamped with a property) is fine.
    expect(fastCompleteSheetFor(assessment({ propertyId: null }))).toBe("assessment");
  });

  it("an assessment known only by its booked name is still an assessment, once the server flags the row", () => {
    expect(fastCompleteSheetFor(assessment({ completionProfile: { category: "inspection", companions: [] } }))).toBe("assessment");
  });

  it("a missing service answers null", () => {
    expect(fastCompleteSheetFor(null)).toBeNull();
    expect(isAssessmentFastCompleteEligible(undefined)).toBe(false);
  });
});
