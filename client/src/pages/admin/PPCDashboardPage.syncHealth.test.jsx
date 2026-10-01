// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PPCDashboardPage from "./PPCDashboardPage";

const CAMPAIGN = {
  id: 1, platform: "google_ads", campaign_type: "SEARCH", campaign_name: "Synthetic campaign 1",
  status: "active", daily_budget_current: 10,
  last7d: { spend: 0, conversionValue: 0, conversions: 0, clicks: 0, impressions: 0 },
  last30d: { spend: 10, conversionValue: 20, conversions: 1 },
};
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const sync = (platform, job, over = {}) => ({
  platform, job, configured: true, last_success_at: hoursAgo(2), last_status: "success",
  last_error: null, consecutive_failures: 0, ...over,
});

// routes: url -> { ok, body } overrides; anything unlisted is an empty 200.
function stubFetch(routes) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const r = routes[url] || { ok: true, body: null };
    return { ok: r.ok, status: r.status || (r.ok ? 200 : 500), json: async () => r.body };
  }));
}
const ok = (body) => ({ ok: true, body });

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("localStorage", { getItem: () => "synthetic-token" });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("PPC dashboard load errors", () => {
  it("shows an inline error instead of the empty state when the campaigns load fails", async () => {
    stubFetch({ "/api/admin/ads/campaigns": { ok: false, status: 403, body: { error: "Forbidden" } } });
    render(<PPCDashboardPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't load campaigns/);
    expect(screen.queryByText("No Campaigns Yet")).not.toBeInTheDocument();
  });

  it("flags a failed secondary load but still renders the campaigns that loaded", async () => {
    stubFetch({
      "/api/admin/ads/campaigns": ok({ campaigns: [CAMPAIGN] }),
      "/api/admin/ads/funnel?period=30d": { ok: false, status: 500, body: { error: "boom" } },
    });
    render(<PPCDashboardPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't load funnel/);
    expect(screen.getByText("Google Search Ads")).toBeInTheDocument();
  });

  it("shows no alert when every load succeeds", async () => {
    stubFetch({ "/api/admin/ads/campaigns": ok({ campaigns: [CAMPAIGN] }) });
    render(<PPCDashboardPage />);
    await screen.findByText("Google Search Ads");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("PPC dashboard last-synced line", () => {
  const mountWith = async (syncs) => {
    stubFetch({
      "/api/admin/ads/campaigns": ok({ campaigns: [CAMPAIGN] }),
      "/api/admin/ads/sync-status": ok({ syncs }),
    });
    const view = render(<PPCDashboardPage />);
    await screen.findByText("Google Search Ads");
    return (platform) => view.container.querySelector(`[data-qa="sync-${platform}"]`);
  };

  it("shows a normal line for a fresh, successful sync", async () => {
    const line = await mountWith([sync("google_ads", "google-ads-sync")]);
    expect(line("google_ads")).toHaveTextContent(/^Google Ads last synced: /);
    expect(line("google_ads")).not.toHaveClass("text-amber-700");
    expect(line("google_ads")).not.toHaveTextContent(/failed|36 hours/);
  });

  it("only lists configured platforms", async () => {
    const line = await mountWith([
      sync("google_ads", "google-ads-sync"),
      sync("facebook", "meta-ads-campaigns", { configured: false }),
      sync("facebook", "meta-ads-performance", { configured: false }),
    ]);
    expect(line("google_ads")).toBeInTheDocument();
    expect(line("facebook")).toBeNull();
  });

  it("warns when the latest sync failed", async () => {
    const line = await mountWith([
      sync("google_ads", "google-ads-sync", { last_status: "failed", last_error: "invalid_grant", consecutive_failures: 2 }),
    ]);
    expect(line("google_ads")).toHaveClass("text-amber-700");
    expect(line("google_ads")).toHaveTextContent(/latest sync failed \(invalid_grant\)/);
  });

  it("warns when the last success is older than 36 hours", async () => {
    const line = await mountWith([sync("google_ads", "google-ads-sync", { last_success_at: hoursAgo(40) })]);
    expect(line("google_ads")).toHaveClass("text-amber-700");
    expect(line("google_ads")).toHaveTextContent(/over 36 hours ago/);
  });

  it("reads 'never' with a warning when a configured platform has no success", async () => {
    const line = await mountWith([sync("google_ads", "google-ads-sync", { last_success_at: null, last_status: null })]);
    expect(line("google_ads")).toHaveTextContent(/last synced: never/);
    expect(line("google_ads")).toHaveClass("text-amber-700");
  });

  it("Meta shows its oldest job's success and any job's failure", async () => {
    const line = await mountWith([
      sync("facebook", "meta-ads-campaigns", { last_success_at: hoursAgo(1) }),
      sync("facebook", "meta-ads-performance", { last_success_at: hoursAgo(50), last_status: "failed", last_error: "Invalid token" }),
    ]);
    expect(line("facebook")).toHaveClass("text-amber-700");
    expect(line("facebook")).toHaveTextContent(/Meta Ads last synced: .*latest sync failed \(Invalid token\)/);
  });
});
