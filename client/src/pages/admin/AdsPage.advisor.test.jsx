// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdvisorTab } from "./AdsPage";

const CAMPAIGN = {
  id: 1, platform: "google_ads", campaign_type: "SEARCH", campaign_name: "Synthetic campaign 1",
  status: "active", daily_budget_current: 5,
  last7d: { spend: 0, conversionValue: 0, conversions: 0, clicks: 0, impressions: 0 },
  last30d: { spend: 46, conversionValue: 0, conversions: 2 },
};
const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";

const REPORT_DATA = {
  grade: "B",
  overall_assessment: "Thin data: $46 and 2 conversions in 30 days.",
  model: "claude-fable-5-1",
  provider: "anthropic",
  recommendations: [
    {
      priority: "high", campaign: "Synthetic Search", campaign_id: CAMPAIGN_ID,
      action: "Raise the daily budget", reasoning: "Lost 40% impression share to budget at $5/day.",
      estimated_impact: "+2 clicks/day", apply_action: "increase_budget", apply_value: 8,
    },
    {
      priority: "medium", campaign: "Synthetic Search", action: "Add a negative keyword",
      reasoning: "3 clicks, $4.10, 0 conversions.", apply_action: "add_negative",
    },
  ],
  waste_alerts: [{ search_term: "synthetic waste term", spend: 4.1, conversions: 0, action: "add_negative" }],
  scaling_opportunities: [], capacity_warnings: [], insights: [],
};

function stubFetch({ report, onApply, onGenerate } = {}) {
  const fetchMock = vi.fn(async (url, options = {}) => {
    const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
    if (url === "/api/admin/ads/campaigns") return json({ campaigns: [CAMPAIGN] });
    if (url === "/api/admin/ads/funnel?period=30d" || url === "/api/admin/ads/revenue-attribution?period=month") return json(null);
    if (url === "/api/admin/ads/sync-status") return json({ syncs: [] });
    if (url === "/api/admin/ads/advisor") return json({ report: report === undefined ? { date: "2026-10-01", grade: "B", report_data: REPORT_DATA } : report });
    if (url === "/api/admin/ads/advisor/history") return json({ reports: [] });
    if (url === "/api/admin/ads/advisor/apply") return onApply ? onApply(options) : json({ applied: true, result: {} });
    if (url === "/api/admin/ads/advisor/generate") return onGenerate ? onGenerate(options) : json({ report: REPORT_DATA });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function openAdvisor() {
  render(<AdvisorTab />);
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("localStorage", { getItem: () => "synthetic-token" });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Ads page Advisor tab", () => {
  it("shows the report: grade, assessment, model, recommendations and waste alerts", async () => {
    stubFetch();
    await openAdvisor();
    expect(await screen.findByText(REPORT_DATA.overall_assessment)).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
    expect(screen.getByText(/Written by claude-fable-5-1 \(anthropic\)/)).toBeInTheDocument();
    expect(screen.getByText("Raise the daily budget")).toBeInTheDocument();
    expect(screen.getByText("Lost 40% impression share to budget at $5/day.")).toBeInTheDocument();
    expect(screen.getByText("Est. impact: +2 clicks/day")).toBeInTheDocument();
    expect(screen.getByText("synthetic waste term")).toBeInTheDocument();
    expect(screen.queryByText(/No recommendations today/)).not.toBeInTheDocument();
    // Empty secondary lists render no card.
    expect(screen.queryByText("Capacity Warnings")).not.toBeInTheDocument();
    expect(screen.queryByText("Insights")).not.toBeInTheDocument();
  });

  it("shows a clear empty state when the advisor recommends nothing", async () => {
    stubFetch({ report: { date: "2026-10-01", grade: "B", report_data: { ...REPORT_DATA, recommendations: [], waste_alerts: [] } } });
    await openAdvisor();
    expect(await screen.findByText("No recommendations today — nothing worth changing.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Apply/ })).not.toBeInTheDocument();
  });

  it("Apply confirms campaign + value, then POSTs the body the route expects and shows success", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = stubFetch();
    await openAdvisor();
    fireEvent.click(await screen.findByRole("button", { name: /^Apply: increase budget to \$8\/day/ }));
    expect(confirm).toHaveBeenCalledWith('Set "Synthetic Search" daily budget to $8/day?');
    await screen.findByRole("button", { name: /^Applied at/ });
    const call = fetchMock.mock.calls.find(([url]) => url === "/api/admin/ads/advisor/apply");
    expect(call[1].method).toBe("POST");
    expect(JSON.parse(call[1].body)).toEqual({
      action: "increase_budget", campaignId: CAMPAIGN_ID, campaignName: "Synthetic Search",
      value: 8, reason: "Raise the daily budget",
    });
  });

  it("a declined confirm sends nothing; a route refusal shows inline and never reads as applied", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const fetchMock = stubFetch({
      onApply: () => ({ ok: false, status: 422, json: async () => ({ applied: false, error: "Refusing a 3x move." }) }),
    });
    await openAdvisor();
    const button = await screen.findByRole("button", { name: /^Apply: increase budget/ });
    fireEvent.click(button);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/admin/ads/advisor/apply")).toBe(false);

    confirm.mockReturnValue(true);
    fireEvent.click(button);
    expect(await screen.findByText("Refusing a 3x move.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Applied at/ })).not.toBeInTheDocument();
  });

  it("manual recommendations say 'Manual action' and carry no Apply button", async () => {
    stubFetch();
    await openAdvisor();
    await screen.findByText("Add a negative keyword");
    expect(screen.getByText(/Manual action:\s*add negative/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Apply/ })).toHaveLength(1);
  });

  it("Regenerate is disabled while running, shows a running note, and swaps in the new report", async () => {
    let release;
    stubFetch({
      onGenerate: () => new Promise((resolve) => {
        release = () => resolve({ ok: true, status: 200, json: async () => ({ report: { ...REPORT_DATA, overall_assessment: "Fresh report text." } }) });
      }),
    });
    await openAdvisor();
    const button = await screen.findByRole("button", { name: "Regenerate" });
    fireEvent.click(button);
    const running = await screen.findByRole("button", { name: "Regenerating..." });
    expect(running).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/few minutes/);
    release();
    expect(await screen.findByText("Fresh report text.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Regenerate" })).not.toBeDisabled());
  });

  it("a failed Regenerate shows an inline alert and re-enables the button", async () => {
    stubFetch({ onGenerate: () => ({ ok: false, status: 500, json: async () => ({ error: "advice dispatch failed" }) }) });
    await openAdvisor();
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn't regenerate the report: advice dispatch failed/);
    expect(screen.getByRole("button", { name: "Regenerate" })).not.toBeDisabled();
  });
});
