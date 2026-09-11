// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "./SettingsPage";

vi.mock("../../hooks/useIsMobile", () => ({ default: () => false }));
vi.mock("../../lib/adminUsage", () => ({ trackAdminPageView: vi.fn() }));

const visitTimeline = {
  enabled: true,
  showOnCustomerReports: true,
  showTechnicianEnRoute: true,
  showTechnicianOnSite: true,
  showCustomerContact: true,
  showReportGenerated: false,
  showDuration: true,
  minimumDurationMinutes: 5,
  showTimingNoteWhenDurationUnavailable: true,
  showDataSourceNote: true,
  dataSourceNote: "Synthetic timeline source note.",
};

const serviceCoverage = {
  enabled: true,
  showOnCustomerReports: true,
  showSummaryCounts: true,
  showMap: true,
  showList: true,
  showAddress: true,
  showServiceDate: true,
  defaultTitle: "Service Coverage",
  titleByServiceLine: { pest: "Pest service coverage" },
  introByServiceLine: { default: "Synthetic coverage intro.", pest: "Synthetic pest coverage intro." },
  disclaimerText: "Synthetic coverage disclaimer.",
  defaultLayout: "split",
  mapPrecisionMode: "exact",
  showInaccessibleReasonsToCustomer: true,
  showTechnicianNotesToCustomer: false,
  statusLabels: { completed: "Completed", inspected: "Inspected", checked: "Checked" },
};

const integrationCatalog = {
  integrations: [{
    id: "synthetic-provider",
    name: "Synthetic provider",
    category: "Messaging & Reviews",
    description: "Synthetic integration fixture.",
    health: { status: "connected", label: "Connected", reason: "Synthetic credentials are ready.", lastCheckedAt: new Date().toISOString() },
    gates: [{ key: "syntheticGate", label: "Synthetic gate", enabled: true }],
    env: [{ key: "SYNTHETIC_TOKEN", present: true, required: true }],
  }],
};

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function fixtureFor(url, options = {}) {
  const path = String(url).replace(/^\/api/, "");
  if (path === "/health") return { status: "ok", environment: "synthetic", timestamp: "2026-09-11T12:00:00.000Z", gates: { cronJobs: true, syntheticGate: true } };
  if (path === "/admin/auth/me") return { id: "synthetic-admin", name: "Synthetic operator", email: "operator@example.invalid", role: "admin" };
  if (path === "/admin/settings/visit-timeline") return { config: visitTimeline, defaults: visitTimeline };
  if (path === "/admin/settings/visit-timeline/reset") return { config: visitTimeline };
  if (path === "/admin/settings/service-coverage") return { config: serviceCoverage, defaults: serviceCoverage };
  if (path === "/admin/settings/service-coverage/reset") return { config: serviceCoverage };
  if (path === "/admin/revenue/settings") return { settings: { ovh_office_payroll: "1200", overhead_entered_at: "2026-09-01" } };
  if (path === "/admin/kpi-targets") return { targets: [] };
  if (path === "/admin/communications/link-library") {
    return options.method === "POST"
      ? { ok: true }
      : { links: [{ id: "manual-1", key: "manual-1", name: "Synthetic link", url: "https://example.invalid/help", source: "manual", category: "website" }], lastSyncedAt: null };
  }
  if (path === "/admin/communications/link-library/sync") return { fetched: 1, added: 0, updated: 1, removed: 0 };
  if (path.startsWith("/admin/communications/link-library/")) return { ok: true };
  if (path === "/admin/schedule/blackout-dates") return { blackouts: [{ id: "day-1", date: "2026-12-25", reason: "Holiday" }], weeklyDaysOff: [0] };
  if (path === "/admin/schedule/blackout-dates/weekly") return { weeklyDaysOff: [0, 6] };
  if (path.startsWith("/admin/schedule/blackout-dates/")) return { ok: true };
  if (path === "/admin/gbp/locations") return { locations: [{ id: "bradenton", name: "Bradenton", hasCredentials: true }] };
  if (path === "/admin/settings/linkedin/status") return { configured: true, connected: true, orgVerified: true, hasRefreshToken: true };
  if (path === "/admin/integrations/health") return integrationCatalog;
  if (path === "/admin/token-health/check") return { ok: true };
  if (path.startsWith("/admin/usage/summary?")) return {
    windowDays: 30,
    totals: { views: 12, activeDays: 4 },
    users: [{ name: "Synthetic operator", views: 12 }],
    pages: [{ pageKey: "dispatch", views: 12, activeDays: 4, lastUsed: new Date().toISOString(), sources: { sidebar: 12 }, tabs: [] }],
  };
  throw new Error(`Unexpected synthetic request: ${options.method || "GET"} ${path}`);
}

function mount(tab) {
  return render(
    <MemoryRouter initialEntries={[`/admin/settings?tab=${tab}`]}>
      <SettingsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => "synthetic-token" });
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => response(fixtureFor(url, options))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Settings new UI foundation", () => {
  it.each([
    ["general", "Company info"],
    ["integrations", "Synthetic provider"],
    ["gates", "Feature gates"],
    ["link-library", "Link library"],
    ["service-reports", "Service coverage"],
    ["blackout-days", "Blackout days"],
    ["kpi-targets", "KPI targets"],
    ["operating-costs", "Operating costs"],
    ["system", "System info"],
    ["usage", "Portal usage"],
  ])("renders the complete %s leaf on the comfortable shared surface", async (tab, expectedText) => {
    const view = mount(tab);
    expect(await screen.findByText(expectedText, { exact: true })).toBeInTheDocument();
    expect(view.container.querySelector('[data-ui-density="comfortable"]')).toBeInTheDocument();
  });

  it("preserves the operating-cost save endpoint and numeric payload", async () => {
    mount("operating-costs");
    const payroll = await screen.findByLabelText("Office payroll");
    fireEvent.change(payroll, { target: { value: "1750.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save costs" }));
    await screen.findByText(/Saved\. The dashboard's EBITDA bridge/);
    const call = fetch.mock.calls.find(([url, options]) => url === "/api/admin/revenue/settings" && options?.method === "PUT");
    expect(call).toBeTruthy();
    expect(JSON.parse(call[1].body)).toEqual({ ovhOfficePayroll: 1750.5 });
  });

  it("preserves schedule mutation payloads and refreshes blackout data", async () => {
    mount("blackout-days");
    await screen.findByText("Holiday");
    fireEvent.click(screen.getByRole("button", { name: "Sat open weekly" }));
    await waitFor(() => expect(fetch.mock.calls.some(([url, options]) =>
      url === "/api/admin/schedule/blackout-dates/weekly"
      && options?.method === "PUT"
      && options.body === JSON.stringify({ daysOff: [0, 6] }))).toBe(true));

    fireEvent.change(screen.getByLabelText("Blackout date"), { target: { value: "2026-12-31" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Office closed" } });
    fireEvent.click(screen.getByRole("button", { name: "Block day" }));
    await waitFor(() => expect(fetch.mock.calls.some(([url, options]) =>
      url === "/api/admin/schedule/blackout-dates"
      && options?.method === "POST"
      && options.body === JSON.stringify({ date: "2026-12-31", reason: "Office closed" }))).toBe(true));
  });

  it("keeps service-report toggles and the visit-timeline save contracts", async () => {
    mount("service-reports");
    await screen.findByText("Service coverage", { exact: true });
    fireEvent.click(screen.getByRole("switch", { name: "Show map" }));
    const saveButtons = screen.getAllByRole("button", { name: "Save settings" });
    fireEvent.click(saveButtons[1]);
    await screen.findByText("Service Coverage settings saved.");
    const coverageCall = fetch.mock.calls.find(([url, options]) =>
      url === "/api/admin/settings/service-coverage" && options?.method === "PUT");
    expect(JSON.parse(coverageCall[1].body).config.showMap).toBe(false);

    fireEvent.click(screen.getByRole("switch", { name: "Show duration when reliable" }));
    fireEvent.click(saveButtons[0]);
    await screen.findByText("Visit Timeline settings saved.");
    const timelineCall = fetch.mock.calls.find(([url, options]) =>
      url === "/api/admin/settings/visit-timeline" && options?.method === "PUT");
    expect(JSON.parse(timelineCall[1].body).config.showDuration).toBe(false);
  });

  it("keeps portal-usage window and owner scope query changes", async () => {
    mount("usage");
    expect((await screen.findAllByText("Dispatch", { exact: true })).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    fireEvent.click(screen.getByRole("button", { name: "Everyone" }));
    await waitFor(() => expect(fetch.mock.calls.some(([url]) =>
      url === "/api/admin/usage/summary?days=7&scope=all")).toBe(true));
  });
});
