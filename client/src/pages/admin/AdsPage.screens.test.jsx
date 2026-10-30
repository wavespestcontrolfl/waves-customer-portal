// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AdsPage from "./AdsPage";

vi.mock("../../lib/adminUsage", () => ({ trackAdminPageView: vi.fn() }));
vi.mock("./PPCDashboardPage", () => ({ default: () => <div>Existing PPC dashboard</div> }));

const CAMPAIGN = {
  id: "c1", campaign_name: "Waves Pest Control - GBP Search", campaign_type: "2", target_area: null,
  budget_mode: "stop", daily_budget_current: "0.05", daily_budget_base: "5.00",
  last7d: { spend: 0.3, conversionValue: 12, conversions: 1, clicks: 4, roas: 40, cpa: 0.3 },
};
const days = Array.from({ length: 14 }, (_, i) => ({
  date: `2026-10-${String(29 + i).padStart(2, "0")}`,
  dayName: ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"][i % 7],
  dayLabel: `Day ${i}`,
  booked: i, slots: 8, utilizationPct: Math.round((i / 8) * 100), colorZone: i > 7 ? "red" : "green",
  isSunday: i % 7 === 3,
}));
const HEATMAP = {
  heatmap: { all: { days, weeklyBooked: 91, weeklySlots: 112, weeklyUtilization: 81, techs: 1 } },
  thresholds: { green: 70, yellow: 85, orange: 95 },
  campaigns: [CAMPAIGN],
  recentChanges: [{
    created_at: "2026-10-27T18:00:00.000Z", campaign_name: "Waves Pest Control - GBP Search",
    previous_mode: "spent", new_mode: "stop", previous_budget: "5.00", new_budget: "0.05",
    reason: "Capacity 100% for general on 2026-10-28", trigger: "auto", google_ads_updated: true,
  }],
};

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => "fixture-token" });
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const data = url.endsWith("/campaigns")
      ? { campaigns: [CAMPAIGN, { ...CAMPAIGN, id: "c2", campaign_name: "Display test", campaign_type: "OUTCOME_LEADS", target_area: "Venice" }] }
      : url.endsWith("/capacity-heatmap") ? HEATMAP : null;
    if (!data) throw new Error(`Unexpected fixture request: ${url}`);
    return { ok: true, json: async () => data };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const open = async (tab) => {
  render(<MemoryRouter initialEntries={[`/admin/ppc?tab=${tab}`]}><AdsPage /></MemoryRouter>);
};

it("Overview labels ad-platform value as reported, not revenue, drops Trend, and hides the numeric campaign type", async () => {
  await open("overview");
  expect(await screen.findByText("Reported value (7d)")).toBeInTheDocument();
  expect(screen.getByText("Google/Meta conversion value, not booked revenue")).toBeInTheDocument();
  expect(screen.getByText("Reported ROAS (7d)")).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "7d reported value" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Reported ROAS" })).toBeInTheDocument();
  expect(screen.queryByRole("columnheader", { name: "Trend" })).not.toBeInTheDocument();
  expect(screen.queryByText("7-Day Revenue")).not.toBeInTheDocument();
  expect(screen.queryByText("Blended ROAS")).not.toBeInTheDocument();
  // enum digit "2" is mapped to its name; a null area prints nothing; a text type stays
  expect(screen.getByText("Search")).toBeInTheDocument();
  expect(screen.getByText("Venice • OUTCOME_LEADS")).toBeInTheDocument();
  expect(screen.queryByText(/•\s*2$/)).not.toBeInTheDocument();
});

it("Capacity shows 14 day cards, the campaign's real budget and latest change, and the changes table", async () => {
  await open("capacity");
  expect(await screen.findByText("Capacity and ad budget — next 14 days")).toBeInTheDocument();
  expect(screen.getAllByTestId("capacity-day")).toHaveLength(14);
  expect(screen.getByText("Today's budget $0.05/day (base $5.00/day)")).toBeInTheDocument();
  expect(screen.getByText(/Latest change: Oct 27, 2:00 PM — Spent → Stop — Capacity 100% for general on 2026-10-28/)).toBeInTheDocument();
  // no per-day mode label on the cards
  for (const card of screen.getAllByTestId("capacity-day")) {
    expect(card).not.toHaveTextContent(/base|spent|stop/i);
  }
  const table = screen.getByRole("table");
  for (const h of ["When (ET)", "Change", "Why", "Who", "Sent to Google"]) {
    expect(within(table).getByRole("columnheader", { name: h })).toBeInTheDocument();
  }
  const row = within(table).getAllByRole("row")[1];
  expect(row).toHaveTextContent("Oct 27, 2:00 PM");
  expect(row).toHaveTextContent("Spent → Stop ($5.00/day → $0.05/day)");
  expect(row).toHaveTextContent("Auto");
  expect(row).toHaveTextContent("Yes");
  expect(screen.getByText(/70% or less: full budget/)).toBeInTheDocument();
  expect(screen.getByText(/71–95%: keeps the current budget/)).toBeInTheDocument();
  expect(screen.getByText(/over 95%: 1% of budget/)).toBeInTheDocument();
  expect(screen.getByText(/On Sundays the rule checks Monday/)).toBeInTheDocument();
});
