import { describe, expect, it } from "vitest";
import {
  dayLabel,
  deliveryLabel,
  describeEvent,
  eventExactLabel,
  eventTimeLabel,
  filterEvents,
  groupByDay,
} from "./activity";

const TODAY = "2026-09-06";

describe("activity time handling", () => {
  it("never renders a clock time for a date-only event and never says 'just now'", () => {
    const future = { type: "scheduled_service", date: "2026-09-30", dateKind: "date" };
    expect(eventTimeLabel(future)).toBe("");
    expect(eventExactLabel(future)).toBe("Wed, Sep 30, 2026");
    expect(dayLabel("2026-09-30", TODAY)).toBe("Sep 30");
  });

  it("renders timestamps in Eastern wall-clock", () => {
    const ev = { type: "sms", date: "2026-09-05T18:05:00.000Z", dateKind: "timestamp" };
    expect(eventTimeLabel(ev)).toBe("2:05 PM");
    expect(eventExactLabel(ev)).toBe("Sat, Sep 5, 2026, 2:05 PM ET");
  });

  it("labels today, yesterday, tomorrow, other years, and undated rows honestly", () => {
    expect(dayLabel("2026-09-06", TODAY)).toBe("Today");
    expect(dayLabel("2026-09-05", TODAY)).toBe("Yesterday");
    expect(dayLabel("2026-09-07", TODAY)).toBe("Tomorrow");
    expect(dayLabel("2027-01-04", TODAY)).toBe("Jan 4, 2027");
    expect(dayLabel(null, TODAY)).toBe("Date not recorded");
    expect(eventExactLabel({ type: "activity", date: null })).toBe("Date not recorded");
  });

  it("groups by Eastern day, keeping arrival order inside a group", () => {
    const groups = groupByDay([
      { id: "a", type: "sms", date: "2026-09-06T03:30:00.000Z", dateKind: "timestamp" }, // 11:30 PM ET Sep 5
      { id: "b", type: "payment", date: "2026-09-05", dateKind: "date" },
      { id: "c", type: "activity", date: null, dateKind: "timestamp" },
    ], TODAY);
    expect(groups.map((g) => [g.label, g.events.map((e) => e.id)])).toEqual([
      ["Yesterday", ["a", "b"]],
      ["Date not recorded", ["c"]],
    ]);
  });
});

describe("filters and descriptions", () => {
  const events = [
    { id: "1", type: "sms", metadata: { direction: "outbound", deliveryStatus: "queued" } },
    { id: "2", type: "call", metadata: { direction: "inbound", outcome: "No answer" } },
    { id: "3", type: "scheduled_service", metadata: { status: "no_show" } },
    { id: "4", type: "service", metadata: { status: "completed" } },
    { id: "5", type: "payment", metadata: { status: "paid", amount: 55, refundedAmount: 20 } },
    { id: "6", type: "interaction", metadata: { automated: true } },
    { id: "7", type: "activity", metadata: {} },
  ];

  it("slices the feed by kind", () => {
    expect(filterEvents(events, "visits").map((e) => e.id)).toEqual(["3", "4"]);
    expect(filterEvents(events, "notes").map((e) => e.id)).toEqual(["6", "7"]);
    expect(filterEvents(events, "all")).toHaveLength(7);
  });

  it("a queued text is not shown as delivered", () => {
    expect(describeEvent(events[0]).state).toEqual({ label: "Queued", tone: "neutral" });
    expect(deliveryLabel("accepted").label).toBe("Queued");
    expect(deliveryLabel("delivered").label).toBe("Delivered");
    expect(deliveryLabel("undelivered").tone).toBe("alert");
  });

  it("names call outcomes, visit states, refunds, and automated notes", () => {
    expect(describeEvent(events[1])).toMatchObject({ kind: "Call in", state: { label: "No answer", tone: "alert" } });
    expect(describeEvent(events[2]).state).toEqual({ label: "No-show", tone: "alert" });
    expect(describeEvent(events[3]).state.label).toBe("Completed");
    expect(describeEvent(events[4]).state.label).toBe("Partly refunded");
    expect(describeEvent(events[5])).toMatchObject({ kind: "Auto note", automated: true });
    expect(describeEvent(events[6])).toMatchObject({ kind: "System", automated: true });
  });
});
