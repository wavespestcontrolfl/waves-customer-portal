// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DashboardJumpNav from "./DashboardJumpNav";

const SECTIONS = [
  { id: "today", label: "Today" },
  { id: "growth", label: "Growth" },
  { id: "profit", label: "Profit" },
];

// jsdom has no layout, so each test states the geometry a browser would
// report: the sticky nav's bottom edge and each section's top and height,
// all relative to a 1000px viewport, plus where the scroll pane stands.
const NAV_BOTTOM = 272;
let geometry;
let frames;
let savedInnerHeight;

function rect(top, height) {
  return { top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} };
}

function flushFrames() {
  act(() => {
    const queued = frames;
    frames = [];
    queued.forEach((cb) => cb());
  });
}

function pane() {
  return document.querySelector(".scroll-pane");
}

// Scroll the pane to `next`; `atEnd` puts it at the bottom of its range.
function scrollTo(next, { atEnd = false } = {}) {
  geometry = next;
  Object.defineProperty(pane(), "scrollTop", { configurable: true, value: atEnd ? 3000 : 1000 });
  fireEvent.scroll(pane());
  flushFrames();
}

function tab(name) {
  return within(screen.getByRole("navigation", { name: "Dashboard sections" }))
    .getByRole("button", { name });
}

function renderNav() {
  render(
    <div className="scroll-pane" style={{ overflowY: "auto" }}>
      <DashboardJumpNav
        title="Dashboard"
        dateLabel="Friday"
        sections={SECTIONS}
        period="mtd"
        todayISO="2026-10-30"
        onSelectPeriod={() => {}}
        onApplyCustomRange={() => {}}
      />
      {SECTIONS.map((s) => <section key={s.id} id={s.id} />)}
    </div>,
  );
  Object.defineProperty(pane(), "scrollHeight", { configurable: true, value: 4000 });
  Object.defineProperty(pane(), "clientHeight", { configurable: true, value: 1000 });
  flushFrames();
}

beforeEach(() => {
  frames = [];
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (cb) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  savedInnerHeight = window.innerHeight;
  window.innerHeight = 1000;
  Element.prototype.scrollIntoView = vi.fn();
  geometry = { today: [300, 900], growth: [1224, 1500], profit: [2748, 1200] };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function measure() {
    if (this.dataset.qa === "dashboard-jump-nav") return rect(0, NAV_BOTTOM);
    if (geometry[this.id]) return rect(...geometry[this.id]);
    return rect(0, 0);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.innerHeight = savedInnerHeight;
  delete Element.prototype.scrollIntoView;
});

describe("DashboardJumpNav scroll tracking", () => {
  it("highlights the section whose heading sits just under the sticky nav", () => {
    renderNav();
    expect(tab("Today")).toHaveAttribute("aria-current", "page");

    // Where a jump to Growth settles at md–lg: heading ~28px under a 272px nav.
    scrollTo({ today: [-624, 900], growth: [300, 1500], profit: [1824, 1200] });
    expect(tab("Growth")).toHaveAttribute("aria-current", "page");
    expect(tab("Today")).not.toHaveAttribute("aria-current");
  });

  it("keeps a clicked tab lit while its smooth scroll passes other sections", () => {
    renderNav();
    fireEvent.click(tab("Profit"));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(tab("Profit")).toHaveAttribute("aria-current", "page");

    // Mid-scroll Growth crosses the line; the requested section keeps the highlight.
    scrollTo({ today: [-624, 900], growth: [300, 1500], profit: [1824, 1200] });
    act(() => { vi.advanceTimersByTime(150); });
    scrollTo({ today: [-2148, 900], growth: [-1224, 1500], profit: [300, 1200] });
    expect(tab("Profit")).toHaveAttribute("aria-current", "page");

    // Once the scroll is quiet the hold ends with Profit's heading in place...
    act(() => { vi.advanceTimersByTime(200); });
    expect(tab("Profit")).toHaveAttribute("aria-current", "page");

    // ...and the next scroll by the user is tracked again.
    scrollTo({ today: [-624, 900], growth: [300, 1500], profit: [1824, 1200] });
    expect(tab("Growth")).toHaveAttribute("aria-current", "page");
  });

  it("follows the user when they scroll a jump's section away before it settles", () => {
    renderNav();
    fireEvent.click(tab("Profit"));
    // The user wheels back up mid-flight: Profit ends below the viewport.
    scrollTo({ today: [-624, 900], growth: [300, 1500], profit: [1824, 1200] });
    act(() => { vi.advanceTimersByTime(200); });
    flushFrames();
    expect(tab("Growth")).toHaveAttribute("aria-current", "page");
  });

  it("gives a short last section the highlight once the pane is scrolled to its end", () => {
    renderNav();
    // Profit's top never reaches the line (272 + 728/4 = 454).
    scrollTo({ today: [-1900, 900], growth: [-976, 1500], profit: [548, 400] }, { atEnd: true });
    expect(tab("Profit")).toHaveAttribute("aria-current", "page");
  });

  it("does not hand the last section the highlight before the pane reaches its end", () => {
    renderNav();
    // Profit is wholly on screen, but the pane can still scroll.
    scrollTo({ today: [-1900, 900], growth: [-976, 1500], profit: [548, 400] });
    expect(tab("Growth")).toHaveAttribute("aria-current", "page");
  });
});
