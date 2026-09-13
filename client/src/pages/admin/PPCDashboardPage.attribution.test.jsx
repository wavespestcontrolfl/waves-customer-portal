// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PPCDashboardPage from "./PPCDashboardPage";

function campaign(id, platform, campaignType, spend, revenue, conversions, status = "active") {
  return {
    id, platform, campaign_type: campaignType, campaign_name: `Synthetic campaign ${id}`,
    status, daily_budget_current: 10,
    last7d: { spend: 0, conversionValue: 0, conversions: 0, clicks: 0, impressions: 0 },
    last30d: { spend, conversionValue: revenue, conversions },
  };
}

async function mount(campaigns) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (url === "/api/admin/ads/campaigns") return { json: async () => ({ campaigns }) };
    if (url === "/api/admin/ads/funnel?period=30d" || url === "/api/admin/ads/revenue-attribution?period=month") {
      return { json: async () => null };
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
  const view = render(<PPCDashboardPage />);
  await screen.findByText("Google Search Ads");
  return (type) => within(view.container.querySelector(`[data-qa="platform-${type}"]`));
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("localStorage", { getItem: () => "synthetic-token" });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("PPC platform attribution", () => {
  it("includes synced Search and existing legacy Search rows exactly once", async () => {
    const card = await mount([
      campaign(1, "google_ads", "SEARCH", 200, 900, 3),
      campaign(2, "google_ads", "google_search", 100, 500, 2),
      campaign(3, "google_ads", "2", 50, 100, 1),
      campaign(4, "google_lsa", "google_lsa", 70, 210, 1),
    ]);
    for (const value of ["$350.00", "$1,500.00", "6", "4.3x"]) {
      expect(card("google_search").getByText(value, { exact: true })).toBeInTheDocument();
    }
    for (const value of ["$70.00", "$210.00", "1", "3.0x"]) {
      expect(card("google_lsa").getByText(value, { exact: true })).toBeInTheDocument();
    }
  });

  it("does not attribute non-Search channels, other providers, or paused campaigns to Search", async () => {
    const card = await mount([
      campaign(1, "google_ads", "SEARCH", 20, 90, 3),
      campaign(2, "google_ads", "DISPLAY", 1000, 2000, 100),
      campaign(3, "google_ads", "PERFORMANCE_MAX", 1000, 2000, 100),
      campaign(4, "facebook", "SEARCH", 1000, 2000, 100),
      campaign(5, "google_ads", "SEARCH", 1000, 2000, 100, "paused"),
      campaign(6, "google_ads", "google_search", 1000, 2000, 100, "paused"),
      campaign(7, "google_ads", null, 1000, 2000, 100),
      campaign(8, "google_ads", "3", 1000, 2000, 100),
      campaign(9, "google_ads", "10", 1000, 2000, 100),
      campaign(10, "google_ads", "11", 1000, 2000, 100),
      campaign(11, "facebook", "2", 1000, 2000, 100),
      campaign(12, "google_ads", "2", 1000, 2000, 100, "paused"),
    ]);
    for (const value of ["$20.00", "$90.00", "3", "4.5x"]) {
      expect(card("google_search").getByText(value, { exact: true })).toBeInTheDocument();
    }
  });
});
