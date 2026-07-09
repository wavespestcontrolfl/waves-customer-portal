// @vitest-environment jsdom
//
// Mobile scorecard mode: below md the five sections render ONE at a time
// behind the jump-nav pills (real tabs). Separate file from the desktop tests
// because vi.mock is hoisted per-module — useIsMobile is true for every test
// here and false over there.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DashboardPageV2 from "../DashboardPageV2";
import { adminFetch } from "../../../utils/admin-fetch";

vi.mock("../../../utils/admin-fetch", () => ({
  adminFetch: vi.fn(),
  isForbiddenError: () => false,
  isRateLimitError: () => false,
}));
vi.mock("../../../hooks/useIsMobile", () => ({ default: () => true }));
vi.mock("../../../hooks/useFeatureFlag", () => ({
  useFeatureFlag: () => false,
}));
vi.mock("../../../components/dashboard/AiChartsPanel", () => ({
  default: () => null,
}));

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// Minimal fixtures — enough for every section to mount without errors.
const FIXTURES = {
  "/admin/dashboard": {
    kpis: {
      revenueMTD: 497,
      revenueChangePercent: 10,
      activeCustomers: 725,
      newCustomersThisMonth: 2,
    },
    mrr: 9750,
    mrrBreakdown: { committed: 9374, atRisk: 376 },
    revenueChart: { daily: [{ date: "2026-07-01", total: 497 }] },
  },
  "/admin/dashboard/core-kpis": {
    periodLabel: "Month to Date",
    momentum: {
      mrr: { net: 100, new: 155, churned: 55 },
      customers: { net: 1, new: 2, lost: 1 },
    },
    sales: { conversion: 50, booked: 3, leads: 6, avgResponseMin: 12, callToBooking: 20, inboundCalls: 15 },
    service: { completionRate: 80, completed: 4, scheduled: 5, callbackRate: 0, callbacks: 0 },
    billing: { collectionRate: 90, issuedCount: 10, collectedCount: 9, collected: 900, billed: 1000, autopayPct: 40, autopayCount: 70, customerBase: 173 },
    financial: { grossMarginWeighted: 55, grossMarginAvg: 52, revPerJob: 120, jobsDone: 4, rpmh: 118 },
    retention: { pct: 98, lost: 1 },
    ar: { days: 12, open: 2660, overdueCount: 5 },
    quality: { nps: null, csatAvg: null, csatResponses: 0 },
    leaderboard: [],
    membershipsSold: 1,
  },
  "/admin/dashboard/alerts": { alerts: [] },
};

function mockFetch() {
  adminFetch.mockImplementation((url) => {
    const key = String(url).split("?")[0];
    if (key in FIXTURES) return Promise.resolve(FIXTURES[key]);
    return Promise.resolve({});
  });
}

const navButton = (label) => {
  const nav = screen.getByRole("navigation", { name: "Dashboard sections" });
  return Array.from(nav.querySelectorAll("button")).find(
    (b) => b.textContent === label,
  );
};

describe("DashboardPageV2 mobile scorecard tabs", () => {
  beforeEach(() => {
    global.ResizeObserver = global.ResizeObserver || FakeResizeObserver;
    const store = new Map([
      ["waves_admin_user", JSON.stringify({ name: "Waves Owner" })],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    });
    mockFetch();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("mounts ONLY the active tab's section (Today first)", async () => {
    render(
      <MemoryRouter>
        <DashboardPageV2 />
      </MemoryRouter>,
    );
    await screen.findAllByText(/Good (morning|afternoon|evening), Waves/);

    expect(document.getElementById("today")).toBeInTheDocument();
    for (const id of ["growth", "profit", "retention", "cash"]) {
      expect(document.getElementById(id)).not.toBeInTheDocument();
    }
    expect(navButton("Today").getAttribute("aria-current")).toBe("true");
  });

  it("switches sections on pill tap and marks the pill current", async () => {
    render(
      <MemoryRouter>
        <DashboardPageV2 />
      </MemoryRouter>,
    );
    await screen.findAllByText(/Good (morning|afternoon|evening), Waves/);

    fireEvent.click(navButton("Profit"));
    expect(document.getElementById("profit")).toBeInTheDocument();
    expect(document.getElementById("today")).not.toBeInTheDocument();
    expect(navButton("Profit").getAttribute("aria-current")).toBe("true");
    expect(navButton("Today").getAttribute("aria-current")).toBeNull();

    fireEvent.click(navButton("Cash"));
    expect(document.getElementById("cash")).toBeInTheDocument();
    expect(document.getElementById("profit")).not.toBeInTheDocument();
  });

  it("keeps the period select available in every tab, with readable labels", async () => {
    render(
      <MemoryRouter>
        <DashboardPageV2 />
      </MemoryRouter>,
    );
    await screen.findAllByText(/Good (morning|afternoon|evening), Waves/);

    fireEvent.click(navButton("Retention"));
    const select = screen.getByLabelText("Period");
    expect(select.tagName).toBe("SELECT");
    const labels = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(labels).toContain("Month to date");
    expect(labels).toContain("Quarter to date");
    expect(labels).toContain("Custom range…");

    fireEvent.change(select, { target: { value: "qtd" } });
    expect(select.value).toBe("qtd");
  });

  it("renders the section explainer dropdown", async () => {
    render(
      <MemoryRouter>
        <DashboardPageV2 />
      </MemoryRouter>,
    );
    await screen.findAllByText(/Good (morning|afternoon|evening), Waves/);
    expect(screen.getByText("What is this?")).toBeInTheDocument();
    expect(screen.getByText(/Action Inbox ranks what to fix first/)).toBeInTheDocument();
  });
});
