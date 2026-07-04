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
    funnel: { sent: 4, viewed: 4, accepted: 1, declined: 1, pending: 2 },
    rates: { view_rate: 100, close_rate: 25, decline_rate: 25 },
    by_service: [
      { service: "Pest Control", sent: 2, won: 1, lost: 0, open: 1, wonValue: 248 },
      { service: "Termite", sent: 2, won: 0, lost: 1, open: 1, wonValue: 0 },
    ],
    period: { from: "2026-07-01", to: "2026-07-01" },
  },
  "/admin/dashboard/aging": {
    aging: {},
    invoice_count: 12,
    total_outstanding: 2660,
    total_overdue: 2410,
  },
  "/admin/dashboard/mrr-trend": { trend: [], avg_growth_pct: 7 },
  "/admin/dashboard/mrr-bridge": {
    months: [
      {
        month: "2026-06-01", label: "Jun \u201926", degraded: true, inProgress: false,
        startMrr: null, endMrr: null, net: 75,
        new: { mrr: 120, count: 2 }, reactivated: { mrr: 0, count: 0 },
        expansion: { mrr: 0, count: 0 }, contraction: { mrr: 0, count: 0 },
        churned: { mrr: 45, count: 1 },
      },
      {
        month: "2026-07-01", label: "Jul \u201926", degraded: false, inProgress: true,
        startMrr: 9804.69, endMrr: 9749.69, net: -55,
        new: { mrr: 0, count: 0 }, reactivated: { mrr: 0, count: 0 },
        expansion: { mrr: 0, count: 0 }, contraction: { mrr: 0, count: 0 },
        churned: { mrr: 55, count: 1 },
      },
    ],
    snapshotStart: "2026-06-01",
    today: "2026-07-04",
  },
  "/admin/dashboard/ebitda-bridge": {
    rows: [
      { key: "revenue", label: "Revenue", amount: 497, kind: "start" },
      { key: "cogs", label: "COGS (labor · materials · drive)", amount: -114, kind: "minus" },
      { key: "gross_profit", label: "Gross profit", amount: 383, kind: "subtotal", marginPct: 77 },
      { key: "marketing", label: "Marketing (ads · retainers · referral rewards)", amount: -50, kind: "minus" },
      { key: "contribution", label: "Contribution", amount: 333, kind: "subtotal", marginPct: 67 },
      { key: "overhead", label: "Overhead (vehicle · insurance · software · admin)", amount: -160, kind: "minus" },
      { key: "ebitda", label: "Adjusted EBITDA", amount: 173, kind: "result", marginPct: 34.8 },
    ],
    revenue: 497,
    cogs: 114,
    grossProfit: 383,
    grossMarginPct: 77,
    marketing: { adSpend: 50, fixedCosts: 0, referralRewards: 0, total: 50 },
    contribution: 333,
    contributionMarginPct: 67,
    overhead: { vehicle: 28, insurance: 13, software: 12, admin: 107, total: 160 },
    overheadEntered: true,
    ebitda: 173,
    ebitdaMarginPct: 34.8,
    monthFraction: 0.033,
    period: { from: "2026-07-01", to: "2026-07-01", label: "Month to date", elapsedDays: 1, daysInMonth: 31 },
    uncostedRevenue: 0,
  },
  "/admin/dashboard/service-mix": { mix: [], total_services: 3 },
  "/admin/dashboard/revenue-by-city": { cities: [], total: 331 },
  "/admin/dashboard/review-trend": { trend: [], total: 180, avgRating: 5 },
  "/admin/dashboard/retention-cohort": { cohorts: [], maxOffset: 0 },
  "/admin/ads/capital-allocation": null,
  "/admin/dashboard/calls-by-source": { sources: [], period: { label: "Month to Date" } },
  "/admin/dashboard/leads-by-source": { sources: [], period: {} },
  "/admin/dashboard/channel-mix": { channels: [] },
  "/admin/dashboard/lead-funnel": {
    period: { label: "Month to Date" },
    sources: [
      { sourceKey: "google_ads", source: "Google Ads", isPaid: true, leads: 8, contacted: 7, estimate: 5, booked: 4, completed: 3, lost: 1, rates: { contactRate: 88, estimateRate: 63, bookRate: 50, completeRate: 38 } },
      { sourceKey: "organic", source: "Organic", isPaid: false, leads: 3, contacted: 2, estimate: 1, booked: 1, completed: 1, lost: 0, rates: { contactRate: 67, estimateRate: 33, bookRate: 33, completeRate: 33 } },
    ],
    totals: { leads: 11, contacted: 9, estimate: 6, booked: 5, completed: 4, lost: 1, bookRate: 45 },
    paid: { leads: 8, contacted: 7, estimate: 5, booked: 4, completed: 3, lost: 1, bookRate: 50 },
    organic: { leads: 3, contacted: 2, estimate: 1, booked: 1, completed: 1, lost: 0, bookRate: 33 },
  },
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
    // Estimate funnel: pending row + per-requested-service outcomes
    expect(document.getElementById("growth")).toContainElement(
      screen.getByText("Pending"),
    );
    // Lead funnel by source: card + a source row with visible low-sample pill
    expect(document.getElementById("growth")).toContainElement(
      screen.getByText("Lead Funnel by Source"),
    );
    expect(document.getElementById("growth")).toContainElement(
      screen.getByText("Low sample · n=3"),
    );
    expect(document.getElementById("growth")).toContainElement(
      screen.getByText("What leads asked for"),
    );
    expect(document.getElementById("growth")).toContainElement(
      screen.getByText("Termite"),
    );
    // PROFIT — the adjusted-EBITDA bridge is its own card NEXT TO the margin
    // tiles (company-level vs job-level; never combined).
    expect(document.getElementById("profit")).toContainElement(
      screen.getByText("Service Mix"),
    );
    expect(document.getElementById("profit")).toContainElement(
      screen.getByText("Adjusted EBITDA Bridge"),
    );
    expect(document.getElementById("profit")).toContainElement(
      screen.getByText("Adjusted EBITDA"),
    );
    // RETENTION
    expect(document.getElementById("retention")).toContainElement(
      screen.getByText("MRR Trend"),
    );
    // Net-MRR bridge: month strip + waterfall rows + in-progress flag
    expect(document.getElementById("retention")).toContainElement(
      screen.getByText("MRR Bridge"),
    );
    expect(document.getElementById("retention")).toContainElement(
      screen.getByText("Churned"),
    );
    expect(document.getElementById("retention")).toContainElement(
      screen.getByText("in progress"),
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
