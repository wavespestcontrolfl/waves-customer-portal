// @vitest-environment jsdom
// The tech's marks on the stations and the counts they give (hooks/useStationMarks.js).
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import useStationMarks from "./useStationMarks";

const READY = (ids) => ({ state: "ready", stations: ids.map((id, i) => ({ id, number: i + 1, pinned: true })) });
const mount = (initial, program = "termite") => {
  const registryRef = { current: initial };
  const hook = renderHook(({ registry }) => { registryRef.current = registry; return useStationMarks({ program, registry, registryRef }); }, { initialProps: { registry: initial } });
  return { ...hook, registryRef };
};

describe("useStationMarks", () => {
  it("taps and flags stations, and counts them with the shared rule", () => {
    const { result } = mount(READY(["a", "b", "c"]));
    act(() => { result.current.flag("a"); });
    act(() => { result.current.tap("b"); result.current.tap("b"); result.current.tap("b"); });
    expect(result.current.marks.statuses).toEqual({ a: "activity", b: "inaccessible" });
    expect(result.current.countsFor(result.current.marks)).toEqual({ total_stations: "3", stations_checked: "2", stations_inaccessible: "1", stations_with_activity: "1" });
    expect(result.current.countsFor({ statuses: {} }).stations_checked).toBe("3");
  });

  it("lands what a note named on stations the tech has not tapped", () => {
    const { result } = mount(READY(["a", "b"]));
    act(() => { result.current.tap("a"); });
    act(() => { result.current.applyHeard([{ id: "a", status: "serviced", quote: "replaced a" }, { id: "b", status: "inaccessible", quote: "could not get to b" }]); });
    expect(result.current.marks.statuses).toEqual({ a: "activity", b: "inaccessible" });
    expect(result.current.marks.quotes).toEqual({ b: "could not get to b" });
  });

  it("a station that left the registry takes its mark with it", () => {
    const { result, rerender } = mount(READY(["a", "b"]));
    act(() => { result.current.flag("a"); result.current.flag("b"); });
    rerender({ registry: READY(["a"]) });
    expect(result.current.marks.statuses).toEqual({ a: "activity" });
  });

  it("answers no counts until the registry is ready", () => {
    const { result } = mount({ state: "loading", stations: [] });
    expect(result.current.countsFor({ statuses: {} })).toBeNull();
  });
});
