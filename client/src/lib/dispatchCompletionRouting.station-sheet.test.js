// Bait station visits on the one-screen sheet with the station map on
// (GATE_STATION_FAST_COMPLETE, owner 2026-10-08). Gate off, routing is exactly
// today's (the map-off rule); gate on, a termite or rodent bait station visit
// resolves to the pest sheet while the map is KNOWN on.
import { describe, expect, it } from "vitest";
import { fastCompleteSheetFor, shouldOpenSpecialtyFastComplete } from "./dispatchCompletionRouting";
import { isTypedReportEligible, reportFlowFields, stationMapKnownOn } from "./pest-fast-complete";

const stationVisit = (findingsType, overrides = {}) => ({
  id: "svc-station",
  status: "on_site",
  propertyId: "prop-1",
  typedReportFlowEnabled: true,
  stationFastCompleteEnabled: true,
  completionProfile: { category: "termite", serviceKey: "bait_monitoring", findingsType },
  findingsSchema: { type: findingsType },
  ...overrides,
});
const termite = (overrides) => stationVisit("termite_bait_station", overrides);
const rodent = (overrides) => stationVisit("rodent_bait_station", overrides);
const trapping = (overrides) => stationVisit("rodent_trapping", overrides);
const MAP_ON = { stationMapOff: false, stationSheetOn: true };

describe("a station visit with the station map on and the gate on", () => {
  it("resolves to the pest sheet for a termite and a rodent bait station visit", () => {
    expect(fastCompleteSheetFor(termite(), MAP_ON)).toBe("pest");
    expect(fastCompleteSheetFor(rodent(), MAP_ON)).toBe("pest");
  });

  it("keeps the full form for a trap check, even with every flag on", () => {
    expect(fastCompleteSheetFor(trapping(), MAP_ON)).toBeNull();
    expect(isTypedReportEligible(trapping(), MAP_ON)).toBe(false);
  });

  it("keeps the full form for a combined visit", () => {
    const companions = { completionProfile: { ...termite().completionProfile, companions: [{ type: "rodent_bait_station" }] } };
    expect(fastCompleteSheetFor(termite(companions), MAP_ON)).toBeNull();
    expect(isTypedReportEligible(termite(companions), MAP_ON)).toBe(false);
  });

  it("keeps the full form while the row flag is off, the map is not known on, or the reader is off", () => {
    expect(fastCompleteSheetFor(termite({ stationFastCompleteEnabled: false }), MAP_ON)).toBeNull();
    expect(fastCompleteSheetFor(termite({ stationFastCompleteEnabled: undefined }), MAP_ON)).toBeNull();
    expect(fastCompleteSheetFor(termite(), { stationMapOff: false, stationSheetOn: false })).toBeNull();
    expect(fastCompleteSheetFor(termite({ typedReportFlowEnabled: false }), MAP_ON)).toBeNull();
  });

  it("keeps this page's guards and the shared ones", () => {
    expect(fastCompleteSheetFor(termite({ status: "completed" }), MAP_ON)).toBeNull();
    expect(fastCompleteSheetFor(termite({ visitCloseoutPacket: { id: "pkt" } }), MAP_ON)).toBeNull();
    expect(fastCompleteSheetFor(termite({ checkoutInvoiceId: "inv-1" }), MAP_ON)).toBeNull();
    const { propertyId: _dropped, ...noKey } = termite();
    expect(fastCompleteSheetFor(noKey, MAP_ON)).toBeNull();
    expect(shouldOpenSpecialtyFastComplete(termite(), MAP_ON)).toBe(true);
  });

  it("puts the sheet in the station flow, with no trace step", () => {
    expect(reportFlowFields(termite(), MAP_ON)).toMatchObject({
      reportFlow: true, typedFlow: true, typedType: "termite_bait_station", stationsFlow: true, traceEligible: false,
    });
    expect(reportFlowFields(rodent(), MAP_ON)).toMatchObject({ typedFlow: true, typedType: "rodent_bait_station", stationsFlow: true });
  });
});

describe("gate off is today's routing", () => {
  it("a station visit with the map on, or unread, keeps the full form without the new option", () => {
    expect(fastCompleteSheetFor(termite({ stationFastCompleteEnabled: false }))).toBeNull();
    expect(fastCompleteSheetFor(termite(), { stationMapOff: false })).toBeNull();
    expect(fastCompleteSheetFor(rodent({ stationFastCompleteEnabled: false }), { stationMapOff: false })).toBeNull();
  });

  it("with the map off the sheet opens as before, with no station section, whatever the new flags say", () => {
    expect(fastCompleteSheetFor(termite({ stationFastCompleteEnabled: false }), { stationMapOff: true })).toBe("pest");
    expect(fastCompleteSheetFor(trapping({ stationFastCompleteEnabled: false }), { stationMapOff: true })).toBe("pest");
    expect(reportFlowFields(termite(), { stationMapOff: true })).toMatchObject({ typedFlow: true, stationsFlow: false });
    expect(reportFlowFields(termite(), { stationMapOff: true, stationSheetOn: true })).toMatchObject({ stationsFlow: false });
  });

  it("a visit that is no station visit is untouched by the option", () => {
    const roach = { id: "svc", status: "on_site", propertyId: "p", typedReportFlowEnabled: true, completionProfile: { findingsType: "cockroach" }, findingsSchema: { type: "cockroach" } };
    expect(fastCompleteSheetFor(roach, MAP_ON)).toBe("pest");
    expect(reportFlowFields(roach, MAP_ON)).toMatchObject({ typedFlow: true, stationsFlow: false });
  });
});

describe("stationMapKnownOn (fail closed, as stationMapKnownOff)", () => {
  it("is true only when the server said the flag is on", () => {
    expect(stationMapKnownOn({ enabled: true, ready: true, known: true })).toBe(true);
    expect(stationMapKnownOn({ enabled: false, ready: true, known: true })).toBe(false);
    expect(stationMapKnownOn({ enabled: true, ready: false, known: false })).toBe(false);
    // A flag load that failed or is in flight never opens the sheet.
    expect(stationMapKnownOn({ enabled: true, ready: true, known: false })).toBe(false);
    expect(stationMapKnownOn(undefined)).toBe(false);
  });
});
