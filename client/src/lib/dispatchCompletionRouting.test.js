import { describe, expect, it } from "vitest";

import {
  mergePostPaymentService,
  fastCompleteSheetFor,
  shouldOpenLawnReserviceFastComplete,
  shouldOpenPestFastComplete,
  shouldOpenSpecialtyFastComplete,
  shouldReopenCompletionAfterPayment,
} from "./dispatchCompletionRouting";
import { stationMapKnownOff } from "./pest-fast-complete";

describe("post-payment completion routing", () => {
  it.each(["completed", "cancelled", "no_show", "skipped"])(
    "does not reopen completion for a %s visit",
    (status) => {
      expect(shouldReopenCompletionAfterPayment({ status })).toBe(false);
    },
  );

  it.each(["pending", "confirmed", "rescheduled", "en_route", "on_site"])(
    "reopens completion for an active %s visit",
    (status) => {
      expect(shouldReopenCompletionAfterPayment({ status })).toBe(true);
    },
  );

  it("keeps fresh terminal status while carrying paid invoice state", () => {
    expect(
      mergePostPaymentService(
        { id: "svc-1", status: "completed", checkoutInvoiceStatus: "draft" },
        { id: "svc-1", status: "confirmed", checkoutInvoiceStatus: "paid" },
      ),
    ).toMatchObject({ status: "completed", checkoutInvoiceStatus: "paid" });
  });
});

describe("shouldOpenPestFastComplete (owner 2026-10-05)", () => {
  const pest = (overrides = {}) => ({
    id: "svc-1",
    status: "on_site",
    propertyId: null,
    fastCompleteReportEnabled: true,
    completionProfile: { category: "pest_control", serviceKey: "pest_control_quarterly", findingsType: null },
    ...overrides,
  });

  it("opens for a regular pest visit and a pest re-service while the report gate is on", () => {
    expect(shouldOpenPestFastComplete(pest())).toBe(true);
    expect(shouldOpenPestFastComplete(pest({ completionProfile: { category: "pest_control", serviceKey: "pest_re_service", findingsType: null } }))).toBe(true);
  });

  it("stays off with the gate off, for other service lines, and for closed visits", () => {
    expect(shouldOpenPestFastComplete(pest({ fastCompleteReportEnabled: false }))).toBe(false);
    expect(shouldOpenPestFastComplete(pest({ fastCompleteReportEnabled: undefined }))).toBe(false);
    expect(shouldOpenPestFastComplete(pest({ completionProfile: { category: "lawn_care", findingsType: null } }))).toBe(false);
    for (const status of ["completed", "cancelled", "skipped", "no_show"]) {
      expect(shouldOpenPestFastComplete(pest({ status }))).toBe(false);
    }
  });

  it("stays off for typed and combined profiles, outline traces and a failed project lookup", () => {
    expect(shouldOpenPestFastComplete(pest({ completionProfile: { category: "pest_control", findingsType: "cockroach" } }))).toBe(false);
    expect(shouldOpenPestFastComplete(pest({ completionProfile: { category: "pest_control", findingsType: null, companions: [{ type: "rodent_bait" }] } }))).toBe(false);
    expect(shouldOpenPestFastComplete(pest({ traceVariant: "outline" }))).toBe(false);
    expect(shouldOpenPestFastComplete(pest({ linkedProjectLookupFailed: true }))).toBe(false);
  });

  it("keeps the full form for a row with no premise key and for a visit returning from payment", () => {
    const { propertyId: _omit, ...weekRow } = pest();
    expect(shouldOpenPestFastComplete(weekRow)).toBe(false);
    expect(shouldOpenPestFastComplete(pest({ completionInvoiceAlreadySent: true }))).toBe(false);
    expect(shouldOpenPestFastComplete(pest({ checkoutInvoiceId: "inv-fixture" }))).toBe(false);
    expect(shouldOpenPestFastComplete(pest({ checkoutInvoiceToken: "tok-fixture" }))).toBe(false);
  });
});

describe("shouldOpenSpecialtyFastComplete (owner 2026-10-08)", () => {
  const typed = (overrides = {}) => ({
    id: "svc-typed",
    status: "on_site",
    propertyId: null,
    typedReportFlowEnabled: true,
    completionProfile: { category: "pest_control", serviceKey: "cockroach_control", findingsType: "cockroach" },
    findingsSchema: { type: "cockroach" },
    ...overrides,
  });
  const lane = (overrides = {}) => ({
    id: "svc-lane",
    status: "on_site",
    propertyId: null,
    laneVoiceFillEnabled: true,
    fastCompleteReportEnabled: true,
    completionProfile: { category: "pest_control", serviceKey: "bed_bug_treatment", findingsType: null },
    ...overrides,
  });

  it("opens the sheet for a typed visit the reader reads and for a lane visit", () => {
    expect(shouldOpenSpecialtyFastComplete(typed())).toBe(true);
    expect(shouldOpenSpecialtyFastComplete(lane())).toBe(true);
  });

  it("stays off with the row's flag off, and for a plain pest visit", () => {
    expect(shouldOpenSpecialtyFastComplete(typed({ typedReportFlowEnabled: false }))).toBe(false);
    expect(shouldOpenSpecialtyFastComplete(typed({ findingsSchema: null }))).toBe(false);
    expect(shouldOpenSpecialtyFastComplete(lane({ laneVoiceFillEnabled: false }))).toBe(false);
    expect(shouldOpenSpecialtyFastComplete(lane({ fastCompleteReportEnabled: false }))).toBe(false);
    expect(shouldOpenSpecialtyFastComplete({ id: "svc-1", status: "on_site", propertyId: null, fastCompleteReportEnabled: true, completionProfile: { category: "pest_control", findingsType: null } })).toBe(false);
  });

  it("a visit that completes through a project (a WDO inspection, a pre-treat) keeps its own path", () => {
    expect(shouldOpenSpecialtyFastComplete(typed({ completionProfile: { ...typed().completionProfile, projectBacked: true } }))).toBe(false);
    expect(shouldOpenSpecialtyFastComplete(typed({ completionProfile: { ...typed().completionProfile, requiresProject: true } }))).toBe(false);
    expect(shouldOpenSpecialtyFastComplete(lane({ linkedProject: { id: "proj-1" } }))).toBe(false);
    expect(shouldOpenSpecialtyFastComplete(typed({ linkedProjectLookupFailed: true }))).toBe(false);
    expect(shouldOpenSpecialtyFastComplete(typed({ completionProfileLookupFailed: true }))).toBe(false);
  });

  it("a station visit opens the sheet only once the station map is known to be off", () => {
    const station = typed({ completionProfile: { category: "termite", serviceKey: "termite_bait_monitoring", findingsType: "termite_bait_station" }, findingsSchema: { type: "termite_bait_station" } });
    expect(shouldOpenSpecialtyFastComplete(station)).toBe(false);
    expect(shouldOpenSpecialtyFastComplete(station, { stationMapOff: true })).toBe(true);
  });

  it("keeps this page's guards: closed visits, whole-visit closeouts, combined visits, the payment return and rows with no propertyId key", () => {
    for (const status of ["completed", "cancelled", "skipped", "no_show"]) {
      expect(shouldOpenSpecialtyFastComplete(typed({ status }))).toBe(false);
    }
    expect(shouldOpenSpecialtyFastComplete(typed({ visitCloseoutPacket: { id: "pkt" } }))).toBe(false);
    expect(shouldOpenSpecialtyFastComplete(typed({ visitId: "v1", visitCloseoutEnabled: true }))).toBe(false);
    expect(shouldOpenSpecialtyFastComplete(typed({ completionProfile: { ...typed().completionProfile, companions: [{ type: "rodent_bait" }] } }))).toBe(false);
    expect(shouldOpenSpecialtyFastComplete(typed({ completionInvoiceAlreadySent: true }))).toBe(false);
    expect(shouldOpenSpecialtyFastComplete(typed({ checkoutInvoiceId: "inv-1" }))).toBe(false);
    const { propertyId: _dropped, ...noKey } = typed();
    expect(shouldOpenSpecialtyFastComplete(noKey)).toBe(false);
  });
});

describe("shouldOpenLawnReserviceFastComplete (owner 2026-10-08)", () => {
  const reservice = (overrides = {}) => ({
    id: "svc-lawn-re",
    status: "on_site",
    propertyId: null,
    lawnReserviceFastCompleteEnabled: true,
    completionProfile: { category: "lawn_care", serviceKey: "lawn_re_service", findingsType: "one_time_lawn_treatment" },
    ...overrides,
  });

  it("opens the sheet for an open lawn re-service under its gate", () => {
    expect(shouldOpenLawnReserviceFastComplete(reservice())).toBe(true);
  });

  it("stays off with the gate off, for another lawn visit, and for closed visits", () => {
    expect(shouldOpenLawnReserviceFastComplete(reservice({ lawnReserviceFastCompleteEnabled: false }))).toBe(false);
    expect(shouldOpenLawnReserviceFastComplete(reservice({ lawnReserviceFastCompleteEnabled: undefined }))).toBe(false);
    expect(shouldOpenLawnReserviceFastComplete(reservice({ completionProfile: { category: "lawn_care", serviceKey: "lawn_care_recurring", findingsType: null } }))).toBe(false);
    for (const status of ["completed", "cancelled", "skipped", "no_show"]) {
      expect(shouldOpenLawnReserviceFastComplete(reservice({ status }))).toBe(false);
    }
  });

  it("keeps this page's guards: the payment return and rows with no propertyId key", () => {
    expect(shouldOpenLawnReserviceFastComplete(reservice({ completionInvoiceAlreadySent: true }))).toBe(false);
    expect(shouldOpenLawnReserviceFastComplete(reservice({ checkoutInvoiceToken: "tok" }))).toBe(false);
    const { propertyId: _dropped, ...noKey } = reservice();
    expect(shouldOpenLawnReserviceFastComplete(noKey)).toBe(false);
  });
});

describe("fastCompleteSheetFor", () => {
  it("names the sheet each visit opens, and null for the full form", () => {
    const base = { id: "svc", status: "on_site", propertyId: null };
    expect(fastCompleteSheetFor({ ...base, fastCompleteReportEnabled: true, completionProfile: { category: "pest_control", findingsType: null } })).toBe("pest");
    expect(fastCompleteSheetFor({ ...base, typedReportFlowEnabled: true, completionProfile: { category: "pest_control", findingsType: "cockroach" }, findingsSchema: { type: "cockroach" } })).toBe("pest");
    expect(fastCompleteSheetFor({ ...base, lawnFastCompleteEnabled: true, completionProfile: { category: "lawn_care", serviceKey: "lawn_care_recurring", findingsType: null } })).toBe("lawn");
    expect(fastCompleteSheetFor({ ...base, completionProfile: { category: "inspection", serviceKey: "wdo_inspection", projectBacked: true } })).toBeNull();
    expect(fastCompleteSheetFor(null)).toBeNull();
  });

  it("a lawn re-service opens its own sheet before the typed rule can claim it", () => {
    expect(fastCompleteSheetFor({
      id: "svc", status: "on_site", propertyId: null,
      lawnReserviceFastCompleteEnabled: true, typedReportFlowEnabled: true, lawnFastCompleteEnabled: true,
      completionProfile: { category: "lawn_care", serviceKey: "lawn_re_service", findingsType: "one_time_lawn_treatment" },
      findingsSchema: { type: "one_time_lawn_treatment" },
    })).toBe("lawn_reservice");
  });
});

describe("stationMapKnownOff (Codex P1 on #6140)", () => {
  it("is true only when the server said the flag is off", () => {
    expect(stationMapKnownOff({ enabled: false, ready: true, known: true })).toBe(true);
    expect(stationMapKnownOff({ enabled: true, ready: true, known: true })).toBe(false);
    expect(stationMapKnownOff({ enabled: false, ready: false, known: false })).toBe(false);
    // A failed load answers off (fail closed): not the server's answer.
    expect(stationMapKnownOff({ enabled: false, ready: true, known: false })).toBe(false);
    expect(stationMapKnownOff({ enabled: false, ready: true })).toBe(false);
    expect(stationMapKnownOff(undefined)).toBe(false);
  });
});
