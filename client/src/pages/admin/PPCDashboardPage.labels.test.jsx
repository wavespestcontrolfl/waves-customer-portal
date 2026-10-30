// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PPCDashboardPage from "./PPCDashboardPage";

const campaign = (over) => ({
  id: 1, platform: "google_ads", campaign_type: "2", campaign_name: "Waves Pest Control - GBP Search",
  status: "active", budget_mode: "stop", daily_budget_current: 0.05, daily_budget_base: 5,
  last7d: { spend: 0.3, conversionValue: 12, conversions: 1, clicks: 4, impressions: 100 },
  last30d: { spend: 10, conversionValue: 20, conversions: 1 },
  ...over,
});

function mount(campaigns) {
  vi.stubGlobal("fetch", vi.fn(async (url) => ({
    ok: true, status: 200,
    json: async () => (url === "/api/admin/ads/campaigns" ? { campaigns } : null),
  })));
  return render(<PPCDashboardPage />);
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("localStorage", { getItem: () => "synthetic-token" });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("calls Google's numbers Google-reported and measures the budget against base, not the $0.05 Stop budget", async () => {
  mount([campaign()]);
  expect(await screen.findByText("Google-reported value (7d)")).toBeInTheDocument();
  expect(screen.getByText("conversion value, not booked revenue")).toBeInTheDocument();
  expect(screen.getByText("Google ROAS")).toBeInTheDocument();
  expect(screen.getByText("Cost per Google conversion")).toBeInTheDocument();
  expect(screen.queryByText("7-Day Revenue")).not.toBeInTheDocument();
  expect(screen.queryByText("Cost Per Lead")).not.toBeInTheDocument();
  expect(screen.getByText("Google Ads and Meta Ads — synced daily")).toBeInTheDocument();
  // $5/day base x 7 = $35.00, not 0.05 x 7 = $0.35
  expect(screen.getByText("of $35.00 base budget")).toBeInTheDocument();
  expect(screen.getByText(/\$0\.30 of \$35\.00 base\s+budget/)).toBeInTheDocument();
  expect(screen.getByText("1%")).toBeInTheDocument();
  expect(screen.getByText("1 active campaign")).toBeInTheDocument();
});

it("falls back to the current budget when base is unset, and says 'campaigns' for more than one", async () => {
  mount([campaign({ daily_budget_base: null, daily_budget_current: 2 }), campaign({ id: 2, campaign_name: "Second" })]);
  expect(await screen.findByText("2 active campaigns")).toBeInTheDocument();
  expect(screen.getByText("of $49.00 base budget")).toBeInTheDocument();
});

it("shows the Local Service Ads card only when an LSA campaign exists", async () => {
  const first = mount([campaign()]);
  await screen.findByText("Google Search Ads");
  expect(screen.queryByText("Local Service Ads")).not.toBeInTheDocument();
  first.unmount();
  mount([campaign(), campaign({ id: 3, platform: "google_lsa", campaign_type: "google_lsa", campaign_name: "LSA" })]);
  expect(await screen.findByText("Local Service Ads")).toBeInTheDocument();
});
