// The station rules the full form and the Fast Complete sheet share
// (lib/station-checks.js, GATE_STATION_FAST_COMPLETE).
import { describe, expect, it } from "vitest";
import {
  EMPTY_STATION_MARKS, flagStationMark, mergeHeardStationExceptions, nextStationStatus, rodentConsumptionHold,
  stationAutoCounts, stationCheckEntry, stationSheetProgram, stationStatusLabel, tapStationMark,
} from "./station-checks";

describe("stationSheetProgram", () => {
  it("takes the two bait station forms and leaves the trap check on the full form", () => {
    expect(stationSheetProgram("termite_bait_station")).toBe("termite");
    expect(stationSheetProgram("rodent_bait_station")).toBe("rodent");
    expect(stationSheetProgram("rodent_trapping")).toBeNull();
    expect(stationSheetProgram("cockroach")).toBeNull();
    expect(stationSheetProgram(undefined)).toBeNull();
  });
});

describe("stationAutoCounts (the full form's count rule, extracted)", () => {
  const activeKeys = ["a", "b", "c", "d"];
  const statuses = { b: "activity", c: "inaccessible", d: "serviced" };

  it("termite: the roster, the checked stations less the ones nobody could reach, and the activity count", () => {
    expect(stationAutoCounts({ program: "termite", activeKeys, statuses })).toEqual({
      total_stations: "4", stations_checked: "3", stations_inaccessible: "1", stations_with_activity: "1",
    });
  });

  it("rodent writes no total and no activity count (its schema owns neither)", () => {
    expect(stationAutoCounts({ program: "rodent", activeKeys, statuses })).toEqual({ stations_checked: "3", stations_inaccessible: "1" });
  });

  it("trapping owns traps_checked only", () => {
    expect(stationAutoCounts({ program: "trapping", activeKeys, statuses })).toEqual({ traps_checked: "3" });
  });

  it("a customer-declined visit checked nothing; an inspection-only visit counts only explicit taps", () => {
    expect(stationAutoCounts({ program: "termite", activeKeys, statuses, visitOutcome: "customer_declined" })).toEqual({
      total_stations: "4", stations_checked: "0", stations_inaccessible: "0", stations_with_activity: "0",
    });
    expect(stationAutoCounts({ program: "termite", activeKeys, statuses, visitOutcome: "inspection_only", isExplicit: (key) => key === "b" || key === "c" })).toEqual({
      total_stations: "4", stations_checked: "1", stations_inaccessible: "1", stations_with_activity: "1",
    });
  });
});

describe("station chips", () => {
  it("cycle ok, activity, serviced, no access and back to ok", () => {
    expect(["ok", "activity", "serviced", "inaccessible"].map(nextStationStatus)).toEqual(["activity", "serviced", "inaccessible", "ok"]);
    expect(nextStationStatus(undefined)).toBe("activity");
  });

  it("read Activity for termite and Consumption for rodent", () => {
    expect(stationStatusLabel("activity", "termite")).toBe("Activity");
    expect(stationStatusLabel("activity", "rodent")).toBe("Consumption");
    expect(stationStatusLabel("inaccessible", "rodent")).toBe("No access");
  });

  it("a tap steps the status, back to ok leaves the station unmarked, and every tap is the tech's word", () => {
    let marks = tapStationMark(EMPTY_STATION_MARKS, "s1");
    expect(marks.statuses).toEqual({ s1: "activity" });
    marks = tapStationMark(marks, "s1");
    expect(marks.statuses).toEqual({ s1: "serviced" });
    marks = tapStationMark(tapStationMark(marks, "s1"), "s1");
    expect(marks.statuses).toEqual({});
    expect(marks.picked).toEqual({ s1: true });
    expect(flagStationMark(EMPTY_STATION_MARKS, "s2").statuses).toEqual({ s2: "activity" });
  });
});

describe("mergeHeardStationExceptions", () => {
  const ids = ["s1", "s2", "s3"];
  const heard = [
    { id: "s1", number: 1, status: "activity", quote: "station 1 had activity" },
    { id: "s3", number: 3, status: "serviced", quote: "replaced the bait in 3" },
  ];

  it("marks the stations the note named, with their words", () => {
    const marks = mergeHeardStationExceptions(EMPTY_STATION_MARKS, heard, ids);
    expect(marks.statuses).toEqual({ s1: "activity", s3: "serviced" });
    expect(marks.quotes).toEqual({ s1: "station 1 had activity", s3: "replaced the bait in 3" });
  });

  it("never marks a station the sheet does not show, nor a status it does not read", () => {
    const marks = mergeHeardStationExceptions(EMPTY_STATION_MARKS, [
      { id: "other", status: "activity", quote: "station 9 had activity" },
      { id: "s2", status: "ok", quote: "station 2 was fine" },
      { id: "s2", status: "activity" },
    ], ids);
    expect(marks.statuses).toEqual({});
  });

  it("a later read replaces what an earlier read heard but never a station the tech tapped", () => {
    let marks = mergeHeardStationExceptions(EMPTY_STATION_MARKS, heard, ids);
    marks = tapStationMark(marks, "s1"); // s1: activity -> serviced, the tech's word
    marks = mergeHeardStationExceptions(marks, [{ id: "s2", number: 2, status: "inaccessible", quote: "could not get to station 2" }], ids);
    expect(marks.statuses).toEqual({ s1: "serviced", s2: "inaccessible" });
    expect(marks.quotes).toEqual({ s2: "could not get to station 2" });
  });

  it("an answer that is not a list leaves the marks as they are", () => {
    expect(mergeHeardStationExceptions(EMPTY_STATION_MARKS, undefined, ids)).toBe(EMPTY_STATION_MARKS);
  });
});

describe("stationCheckEntry", () => {
  it("is the full form's entry: untouched ok by default, touched on a tap", () => {
    expect(stationCheckEntry("s1", {})).toEqual({ id: "s1", status: "ok" });
    expect(stationCheckEntry("s1", { s1: "activity" })).toEqual({ id: "s1", status: "activity", touched: true });
  });
});

describe("rodentConsumptionHold", () => {
  it("holds a consumption mark beside a bait consumption level of None, for the rodent program only", () => {
    expect(rodentConsumptionHold({ program: "rodent", statuses: { s1: "activity" }, values: { bait_consumption: "None" } })).toMatch(/bait consumption/i);
    expect(rodentConsumptionHold({ program: "rodent", statuses: { s1: "activity" }, values: { bait_consumption: "Light" } })).toBeNull();
    expect(rodentConsumptionHold({ program: "rodent", statuses: { s1: "serviced" }, values: { bait_consumption: "None" } })).toBeNull();
    expect(rodentConsumptionHold({ program: "termite", statuses: { s1: "activity" }, values: { bait_consumption: "None" } })).toBeNull();
  });
});
