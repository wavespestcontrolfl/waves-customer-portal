// @vitest-environment jsdom
//
// Mobile scorecard mode: below md the five sections render ONE at a time
// behind the jump-nav pills (real tabs). Separate file from the desktop tests
// because vi.mock is hoisted per-module — useIsMobile is true for every test
// here and false over there.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  "/admin/kpi-targets": { targets: [] },
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

  it.each([
    ["Growth", "/admin/dashboard/funnel", "estimate funnel", "No estimates sent this period", { funnel: {}, rates: {} }, "No estimates sent this period"],
    ["Growth", "/admin/ads/capital-allocation", "ad spend", "No ad spend tracked yet", { channels: [] }, "No ad spend tracked yet"],
    ["Profit", "/admin/dashboard/service-mix", "service mix", "0 completed services this month", { mix: [], total_services: 8 }, "8 completed services this month"],
    ["Retention", "/admin/dashboard/review-trend", "reviews", "0 reviews · —★ avg", { trend: [], total: 12, avgRating: 5 }, "12 reviews · 5★ avg"],
    ["Cash", "/admin/dashboard/aging", "accounts receivable", "No outstanding invoices", { aging: {}, invoice_count: 4 }, "4 open invoices"],
    ["Cash", "/admin/billing-health", "billing health", "0 billable", { summary: { total_billable: 7 } }, "7 billable"],
  ])("shows loading and recovery for deferred %s feed %s", async (tab, path, label, falseEmpty, value, loadedText) => {
    const fetchFixture = adminFetch.getMockImplementation();
    let fail;
    const held = new Promise((_, reject) => { fail = reject; });
    adminFetch.mockImplementation((url) => String(url).split("?")[0] === path ? held : fetchFixture(url));
    render(<MemoryRouter><DashboardPageV2 /></MemoryRouter>);
    await screen.findAllByText(/Good (morning|afternoon|evening), Waves/);
    fireEvent.click(navButton(tab));
    if (label === "ad spend") fireEvent.click(screen.getByText("Where to Put Ad Dollars"));
    await screen.findByText(`Loading ${label}…`);
    expect(screen.queryByText(falseEmpty)).not.toBeInTheDocument();
    // Shared, already-loaded KPI tiles remain available beside the held feed.
    expect(screen.queryByText("Loading metrics…")).not.toBeInTheDocument();
    await act(async () => fail(new Error("Offline")));
    await screen.findByText(`${label} is unavailable.`);
    expect(screen.queryByText(falseEmpty)).not.toBeInTheDocument();
    adminFetch.mockImplementation((url) => String(url).split("?")[0] === path
      ? Promise.resolve(value) : fetchFixture(url));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled());
    fireEvent.click(screen.getAllByRole("button", { name: "Try again" })[0]);
    await screen.findByText(loadedText);
    expect(screen.queryByText(`${label} is unavailable.`)).not.toBeInTheDocument();
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
    expect(navButton("Today").getAttribute("aria-current")).toBe("page");
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
    expect(navButton("Profit").getAttribute("aria-current")).toBe("page");
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
    expect(select).toHaveClass("ui-select", "ui-control-comfortable");
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
