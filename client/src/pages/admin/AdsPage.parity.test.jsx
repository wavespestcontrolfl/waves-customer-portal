// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AdsPage from "./AdsPage";

vi.mock("../../lib/adminUsage", () => ({ trackAdminPageView: vi.fn() }));
vi.mock("./PPCDashboardPage", () => ({ default: () => <div>Existing PPC dashboard</div> }));

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => "fixture-token" });
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const data = url.endsWith("/campaigns") ? { campaigns: [] }
      : url.includes("/call-bridge?") ? { summary: {}, matches: [] }
        : url.includes("/service-lines?") ? { totalLeads: 0 }
          : url.endsWith("/advisor/history") ? { reports: [] }
            : url.endsWith("/advisor") ? { report: null }
              : url.endsWith("/capacity-heatmap") ? { heatmap: {} } : null;
    if (!data) throw new Error(`Unexpected fixture request: ${url}`);
    return { ok: true, json: async () => data };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("retains all six PPC workflows and their data reads without starting an action", async () => {
  render(<MemoryRouter><AdsPage /></MemoryRouter>);
  expect(await screen.findByText("Existing PPC dashboard")).toBeInTheDocument();
  for (const [label, endpoint] of [
    ["Overview", "/admin/ads/campaigns"],
    ["Call Bridge", "/admin/ads/call-bridge?period=30d"],
    ["Service Lines", "/admin/ads/service-lines?period=30d"],
    ["AI Advisor", "/admin/ads/advisor"],
    ["Capacity", "/admin/ads/capacity-heatmap"],
  ]) {
    fireEvent.click(screen.getByRole("button", { name: label, exact: true }));
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith(endpoint))).toBe(true));
    await waitFor(() => expect(screen.queryByText(/^Loading /)).not.toBeInTheDocument());
  }
  expect(fetch.mock.calls.some(([url]) => url.endsWith("/admin/ads/advisor/history"))).toBe(true);
  expect(fetch.mock.calls).toHaveLength(6);
  expect(fetch.mock.calls.every(([url, options]) => !url.includes("/seo") && (!options.method || options.method === "GET"))).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "PPC Dashboard", exact: true }));
  expect(await screen.findByText("Existing PPC dashboard")).toBeInTheDocument();
});
