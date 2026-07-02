// @vitest-environment jsdom
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
vi.mock("../../../hooks/useIsMobile", () => ({ default: () => false }));
vi.mock("../../../hooks/useFeatureFlag", () => ({
  useFeatureFlag: () => false,
}));
vi.mock("../../../components/dashboard/AiChartsPanel", () => ({
  default: () => null,
}));

// recharts' ResponsiveContainer needs ResizeObserver, which jsdom lacks.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const CORE_KPIS = {
  periodLabel: "Month to Date",
  momentum: {
    mrr: { net: -55, new: 0, churned: 55 },
    customers: { net: -1, new: 0, lost: 1 },
  },
  sales: {
    conversion: 0,
    booked: 0,
    leads: 6,
    avgResponseMin: 35,
    callToBooking: 0,
    inboundCalls: 14,
  },
  service: {
    completionRate: 50,
    completed: 3,
    scheduled: 6,
    callbackRate: 0,
    callbacks: 0,
  },
  billing: {
    collectionRate: 20.3,
    issuedCount: 3,
    collectedCount: 1,
    collected: 129,
    billed: 634,
    autopayPct: 23,
    autopayCount: 40,
    customerBase: 173,
  },
  financial: {
    grossMarginWeighted: 77,
    grossMarginAvg: 68,
    revPerJob: 110,
    jobsDone: 3,
    rpmh: 31,
  },
  retention: { pct: 99.9, lost: 1 },
  ar: { days: 12, open: 2660, overdueCount: 5 },
  quality: { nps: null, csatAvg: null, csatResponses: 0 },
  leaderboard: [],
  membershipsSold: 0,
};

const FIXTURES = {
  "/admin/dashboard": {
    kpis: {
      revenueMTD: 497,
      revenueChangePercent: 230.6,
      activeCustomers: 725,
      newCustomersThisMonth: 0,
    },
    mrr: 9750,
    mrrBreakdown: { committed: 9374, atRisk: 376 },
    revenueChart: { daily: [{ date: "2026-07-01", total: 497 }] },
  },
  "/admin/dashboard/compare": {
    deltas: { revenue: 230.6 },
    period: { series: [] },
    against: { series: [], label: "Last month" },
  },
  "/admin/dashboard/sales-capture": {
    captured: 0,
    missed: 887,
    captureRate: 0,
    wonCount: 0,
    lostCount: 3,
  },
  "/admin/dashboard/today-completion": {
    date: "2026-07-01",
    completed: 3,
    total: 7,
    remaining: 3,
    cancelled: 1,
    noShow: 0,
  },
  "/admin/billing-health": {
    summary: {
      total_billable: 173,
      autopay_active: 38,
      autopay_paused: 2,
      autopay_disabled: 133,
      no_payment_method: 36,
      failed_last_30_days: 0,
      in_retry_queue: 0,
      escalated_last_30_days: 0,
      expiring_cards_60_days: 0,
      charged_this_month: 4,
    },
  },
  "/admin/dashboard/alerts": {
    alerts: [
      {
        id: "ar_overdue",
        severity: "critical",
        label: "$2.4k overdue AR",
        href: "/admin/invoices",
        amount: 2410,
      },
    ],
  },
  "/admin/dashboard/core-kpis": CORE_KPIS,
  "/admin/dashboard/funnel": {
    funnel: { sent: 4, viewed: 4, accepted: 0, declined: 0 },
    rates: {},
    period: { from: "2026-07-01", to: "2026-07-01" },
  },
  "/admin/dashboard/aging": {
    aging: {},
    invoice_count: 12,
    total_outstanding: 2660,
    total_overdue: 2410,
  },
  "/admin/dashboard/mrr-trend": { trend: [], avg_growth_pct: 7 },
  "/admin/dashboard/service-mix": { mix: [], total_services: 3 },
  "/admin/dashboard/revenue-by-city": { cities: [], total: 331 },
  "/admin/dashboard/review-trend": { trend: [], total: 180, avgRating: 5 },
  "/admin/dashboard/retention-cohort": { cohorts: [], maxOffset: 0 },
  "/admin/ads/capital-allocation": null,
  "/admin/dashboard/calls-by-source": { sources: [], period: { label: "Month to Date" } },
  "/admin/dashboard/leads-by-source": { sources: [], period: {} },
  "/admin/dashboard/channel-mix": { channels: [] },
};

function mockFetchWithFixtures() {
  adminFetch.mockImplementation((url) => {
    const key = String(url).split("?")[0];
    if (key in FIXTURES) return Promise.resolve(FIXTURES[key]);
    return Promise.resolve({});
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <DashboardPageV2 />
    </MemoryRouter>,
  );
}

describe("DashboardPageV2 sections", () => {
  beforeEach(() => {
    global.ResizeObserver = global.ResizeObserver || FakeResizeObserver;
    // This jsdom setup exposes a non-functional localStorage — stub a real one
    // so adminFirstName() can read the greeting name.
    const store = new Map([
      ["waves_admin_user", JSON.stringify({ name: "Waves Owner" })],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    });
    mockFetchWithFixtures();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the five command-center sections with jump-nav pills", async () => {
    renderPage();

    // Wait for the initial load to settle (header greeting appears post-load).
    await screen.findAllByText(/Good (morning|afternoon|evening), Waves/);

    // One anchor <section> per command-center section.
    for (const id of ["today", "growth", "profit", "retention", "cash"]) {
      expect(document.getElementById(id)).toBeInTheDocument();
      expect(document.getElementById(id).tagName).toBe("SECTION");
    }

    // Jump-nav renders a pill per section (plus the section's own heading).
    const nav = screen.getByRole("navigation", { name: "Dashboard sections" });
    for (const label of ["Today", "Growth", "Profit", "Retention", "Cash"]) {
      expect(
        Array.from(nav.querySelectorAll("button")).some(
          (b) => b.textContent === label,
        ),
      ).toBe(true);
    }
  });

  it("keeps the existing cards, re-homed into their sections", async () => {
    renderPage();
    await screen.findAllByText(/Good (morning|afternoon|evening), Waves/);

    // TODAY
    expect(document.getElementById("today")).toContainElement(
      screen.getByText("Today's Completion"),
    );
    expect(document.getElementById("today")).toContainElement(
      screen.getByText("Action Inbox"),
    );
    // GROWTH
    expect(document.getElementById("growth")).toContainElement(
      screen.getByText("Sales Capture"),
    );
    expect(document.getElementById("growth")).toContainElement(
      screen.getByText("Marketing Attribution"),
    );
    // PROFIT
    expect(document.getElementById("profit")).toContainElement(
      screen.getByText("Service Mix"),
    );
    // RETENTION
    expect(document.getElementById("retention")).toContainElement(
      screen.getByText("MRR Trend"),
    );
    expect(document.getElementById("retention")).toContainElement(
      screen.getByText("Retention by Cohort"),
    );
    // CASH
    expect(document.getElementById("cash")).toContainElement(
      screen.getByText("Accounts Receivable Aging"),
    );
    expect(document.getElementById("cash")).toContainElement(
      screen.getByText("Billing Health"),
    );
  });

  it("moves the period selector into the sticky bar and switches periods", async () => {
    renderPage();
    await screen.findAllByText(/Good (morning|afternoon|evening), Waves/);

    const mtd = screen.getByRole("button", { name: "MTD" });
    expect(mtd).toBeInTheDocument();

    adminFetch.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "7D" }));
    // The period effects re-fetch core-kpis + the three attribution endpoints.
    await vi.waitFor(() => {
      const urls = adminFetch.mock.calls.map((c) => String(c[0]));
      expect(
        urls.some((u) => u.startsWith("/admin/dashboard/core-kpis?period=last_7")),
      ).toBe(true);
      expect(
        urls.some((u) => u.startsWith("/admin/dashboard/leads-by-source?period=last_7")),
      ).toBe(true);
    });
  });
});
