import { describe, expect, it } from "vitest";
import { customerPanelHistory, PANEL_HISTORY_LIMIT } from "./SchedulePage";

describe("customerPanelHistory", () => {
  it("shows the selected visit + recent past, never a 24-visit series' farthest-future rows", () => {
    const future = Array.from({ length: 24 }, (_, i) => ({
      id: `f${i}`,
      scheduled_date: `2099-${String(1 + (i % 12)).padStart(2, "0")}-${i < 12 ? "05" : "20"}`,
      status: "pending",
    }));
    const past = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`, scheduled_date: `2020-0${8 - i}-10`, status: "completed",
    }));
    const current = { id: "cur", scheduled_date: "2098-12-31", status: "confirmed" };
    const ids = customerPanelHistory({ scheduled: [...future, ...past, current] }, "cur").map((s) => s.id);
    expect(ids[0]).toBe("cur");
    expect(ids).toHaveLength(PANEL_HISTORY_LIMIT);
    expect(ids.slice(1)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect(ids.some((id) => id.startsWith("f"))).toBe(false);
  });

  it("is empty-safe when the customer payload has not loaded", () => {
    expect(customerPanelHistory(null, "x")).toEqual([]);
    expect(customerPanelHistory({ scheduled: "nope" }, undefined)).toEqual([]);
  });
});
