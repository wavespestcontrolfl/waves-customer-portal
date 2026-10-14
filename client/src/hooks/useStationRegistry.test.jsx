// @vitest-environment jsdom
// The station registry for one visit (hooks/useStationRegistry.js).
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import useStationRegistry, { registryHold, registryOf } from "./useStationRegistry";

const circle = { type: "circle", cx: 0.4, cy: 0.5, r: 0.03 };
const row = (n, extra = {}) => ({ id: `s${n}`, number: n, program: "termite", geometryImage: circle, staleMark: false, ...extra });
const MAP = { available: true, stationsLoaded: true, stations: [row(3), row(1), row(2, { program: "rodent" })] };

describe("registryOf", () => {
  it("keeps the program's stations in number order, pinned or not", () => {
    expect(registryOf(MAP, "termite")).toEqual({ state: "ready", stations: [{ id: "s1", number: 1, pinned: true }, { id: "s3", number: 3, pinned: true }] });
    expect(registryOf({ ...MAP, stations: [row(1, { geometryImage: null })] }, "termite").stations[0].pinned).toBe(false);
  });

  it("an unavailable map or a failed station query is a failure, not an empty roster", () => {
    expect(registryOf({ available: false }, "termite").state).toBe("failed");
    expect(registryOf({ available: true, stationsLoaded: false, stations: [] }, "termite").state).toBe("failed");
    expect(registryOf(undefined, "termite").state).toBe("failed");
  });
});

describe("registryHold", () => {
  it("names what stops the sheet, with the Full form where only it helps", () => {
    expect(registryHold({ state: "loading", stations: [] })).toBe("Loading the stations…");
    expect(registryHold({ state: "failed", stations: [] })).toMatch(/Use the Full form/);
    expect(registryHold({ state: "ready", stations: [] })).toMatch(/No stations are on record/);
    expect(registryHold({ state: "ready", stations: [{ id: "a", number: 5, pinned: false }] })).toBe("Station 5 has no pin on the map. Use the Full form.");
    expect(registryHold({ state: "ready", stations: [{ id: "a", number: 5, pinned: false }, { id: "b", number: 6, pinned: false }] })).toBe("2 stations have no pin on the map. Use the Full form.");
    expect(registryHold({ state: "ready", stations: [{ id: "a", number: 5, pinned: true }] })).toBe("");
  });
});

describe("useStationRegistry", () => {
  const mount = (request) => renderHook(() => useStationRegistry({ serviceId: "svc", request, program: "termite", active: true }));

  it("loads once, then loads again on reload", async () => {
    const request = vi.fn(async () => MAP);
    const { result } = mount(request);
    expect(result.current.registry.state).toBe("loading");
    await waitFor(() => expect(result.current.registry.state).toBe("ready"));
    expect(request).toHaveBeenCalledWith("/admin/dispatch/svc/property-map");
    act(() => { result.current.reload(); });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.registry.state).toBe("ready"));
  });

  it("a request that throws is a failure; an inactive hook asks nothing", async () => {
    const { result } = mount(vi.fn(async () => { throw new Error("down"); }));
    await waitFor(() => expect(result.current.registry.state).toBe("failed"));
    const request = vi.fn(async () => MAP);
    renderHook(() => useStationRegistry({ serviceId: "svc", request, program: null, active: false }));
    expect(request).not.toHaveBeenCalled();
  });
});
