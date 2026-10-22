// Gmail's Schedule send choices, computed in Eastern time whatever the
// browser's zone: late Thursday night ET is already Friday in UTC.
import { describe, expect, it } from "vitest";
import { earliestPick, formatSendAt, schedulePresets } from "./scheduleSend";

describe("schedulePresets", () => {
  it("offers tomorrow 8 AM, tomorrow 1 PM and Monday 8 AM in Eastern time", () => {
    const thursdayLateEt = new Date("2026-10-23T03:30:00Z"); // Thu Oct 22, 11:30 PM EDT
    expect(schedulePresets(thursdayLateEt).map((p) => p.sendAt)).toEqual(["2026-10-23T08:00", "2026-10-23T13:00", "2026-10-26T08:00"]);
  });

  it("drops Monday morning when tomorrow is Monday", () => {
    const sundayEt = new Date("2026-10-25T16:00:00Z"); // Sun Oct 25, noon EDT
    expect(schedulePresets(sundayEt).map((p) => p.key)).toEqual(["tomorrow_morning", "tomorrow_afternoon"]);
  });

  it("crosses the fall-back change without losing an hour", () => {
    const saturdayEt = new Date("2026-10-31T16:00:00Z"); // Sat Oct 31; clocks fall back Nov 1
    expect(schedulePresets(saturdayEt).map((p) => p.sendAt)).toEqual(["2026-11-01T08:00", "2026-11-01T13:00", "2026-11-02T08:00"]);
  });
});

describe("formatSendAt and earliestPick", () => {
  it("reads an Eastern wall-clock string and a stored instant the same way", () => {
    expect(formatSendAt("2026-10-23T09:00")).toBe("Fri, Oct 23, 9:00 AM");
    expect(formatSendAt("2026-10-23T13:00:00.000Z")).toBe("Fri, Oct 23, 9:00 AM");
  });

  it("starts the picker at least two full minutes out, in Eastern time", () => {
    expect(earliestPick(new Date("2026-10-23T13:00:00Z"))).toBe("2026-10-23T09:02");
    expect(earliestPick(new Date("2026-10-23T13:00:59Z"))).toBe("2026-10-23T09:03");
  });

  it("moves the picker minimum past the repeated fall-back hour", () => {
    expect(earliestPick(new Date("2026-11-01T04:59:00Z"))).toBe("2026-11-01T02:00");
  });
});
