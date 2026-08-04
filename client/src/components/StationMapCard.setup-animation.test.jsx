// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StationMapCard } from "./StationMapCard";

// Round 15 (codex P2, PR #3159): a setup map's pins carry the same 'ok'
// status an armed trap does, but the setup labels relabel that status "Set
// this visit" — nothing has been checked yet. The ambient rat cycle running
// on those pins visually contradicts the stage the report just declared.
//
// The rat only enters the DOM 1600ms into the cycle, so these drive fake
// timers past that point. A render-and-assert test would pass whether or
// not the cycle is disabled — the "fix that cannot fire" shape this PR's
// own companion-map suite calls out.
function stationMap(extra = {}) {
  return {
    available: true,
    program: "trapping",
    image: { url: "https://example.test/map.png", width: 640, height: 340 },
    stations: [
      { number: 1, status: "ok", shape: { cx: 0.3, cy: 0.4, r: 0.02 } },
      { number: 2, status: "ok", shape: { cx: 0.6, cy: 0.5, r: 0.02 } },
    ],
    summary: { total: 2, checked: 2, activity: 0, serviced: 0, inaccessible: 0 },
    ...extra,
  };
}

function renderAndRunCycle(map, props = {}) {
  const result = render(<StationMapCard stationMap={map} trapPins animate {...props} />);
  act(() => { vi.advanceTimersByTime(2000); });
  return result;
}

describe("ambient rat cycle vs. declared trap setups", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The cycle self-disables under prefers-reduced-motion; jsdom has no
    // matchMedia, so state it explicitly rather than depending on the throw.
    window.matchMedia = vi.fn().mockReturnValue({ matches: false });
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("a follow-up map runs the rat once the cycle starts", () => {
    const { container } = renderAndRunCycle(stationMap());
    expect(container.querySelector(".trap-rat")).not.toBeNull();
  });

  it("an initial-setup map never runs it", () => {
    const { container } = renderAndRunCycle(stationMap({ initialSetup: true }));
    expect(container.querySelector(".trap-rat")).toBeNull();
  });

  it("the setup map still renders its own labels and pins", () => {
    const { container } = renderAndRunCycle(stationMap({ initialSetup: true }));
    expect(container.textContent).toContain("Set this visit");
    expect(container.querySelectorAll(".trap-pin").length).toBe(2);
  });

  it("the 'plan' embed is never treated as a setup", () => {
    // initialSetup is a per-VISIT fact; the plan variant aggregates visits.
    const { container } = renderAndRunCycle(stationMap({ initialSetup: true }), { variant: "plan" });
    expect(container.textContent).not.toContain("Set this visit");
  });
});
