// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "./SettingsPage";
import { KPI_METRIC_LABELS } from "./dashboard/kpi-targets";

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
  if (path === "/admin/revenue/settings") return { settings: { ovh_office_payroll: "1200", overhead_entered_at: "2026-09-01T15:00:00.000Z" } };
  if (path === "/admin/kpi-targets") return { targets: [] };
  if (path === "/admin/cost-cards") return { enabled: false };
  if (path === "/admin/communications/link-library") {
    return options.method === "POST"
      ? { ok: true }
      : { links: [{ id: "manual-1", key: "manual-1", name: "Synthetic link", url: "https://example.invalid/help", source: "manual", category: "website" }], lastSyncedAt: null };
  }
  if (path === "/admin/communications/link-library/sync") return { fetched: 1, added: 0, updated: 1, removed: 0 };
  if (path.startsWith("/admin/communications/link-library/")) return { ok: true };
  if (path === "/admin/schedule/blackout-dates") {
    return {
      blackouts: [{ id: "day-1", date: "2026-12-25", reason: "Holiday" }],
      weeklyDaysOff: [0],
      holidays: [
        { key: "thanksgiving", name: "Thanksgiving", date: "2026-11-26", observed: false, observedDate: null, closed: false },
        { key: "independence_day", name: "4th of July", date: "2027-07-04", observed: false, observedDate: "2027-07-05", closed: false },
        { key: "christmas", name: "Christmas", date: "2027-12-24", observed: true, observedDate: null, closed: false },
      ],
    };
  }
  if (path === "/admin/schedule/blackout-dates/weekly") return { weeklyDaysOff: [0, 6] };
  if (path === "/admin/schedule/blackout-dates/holidays") return { success: true, closedHolidays: JSON.parse(options.body).closed };
  if (path.startsWith("/admin/schedule/blackout-dates/")) return { ok: true };
  if (path === "/admin/schedule/departure-time") {
    return options.method === "PUT"
      ? { success: true, departureTime: JSON.parse(options.body).departureTime, inUse: false }
      : { departureTime: "07:30", saved: false, inUse: false, earliest: "06:00", latest: "08:00", stepMinutes: 15 };
  }
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

  it("keeps Operating Costs owner-only: a technician gets no Costs tab and no company-financials read", async () => {
    // GET/PUT /admin/revenue/settings are closed to a technician by the staff
    // allow-list; the admin still reads them (see the next test).
    const adminFixture = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, options = {}) => (
      String(url).replace(/^\/api/, "") === "/admin/auth/me"
        ? response({ id: "synthetic-tech", name: "Synthetic technician", email: "tech@example.invalid", role: "technician" })
        : adminFixture(url, options)
    ));
    mount("operating-costs");
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/admin/auth/me"))).toBe(true));
    await screen.findByRole("button", { name: /General/ });
    expect(screen.queryByRole("button", { name: /Financials|Costs/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Operating costs", { exact: true })).not.toBeInTheDocument();
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/admin/revenue/settings"))).toBe(false);
    // The deep link resolves to General, not an empty content area (codex #5683 r1).
    expect(await screen.findByText("Company info")).toBeInTheDocument();
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

  it("saves the van departure time from the Day start tab", async () => {
    mount("day-start");
    const select = await screen.findByLabelText("Van leaves at");
    await waitFor(() => expect(select).toHaveValue("07:30"));
    expect(select.querySelectorAll("option")).toHaveLength(9);
    expect(screen.getByText(/Not in use yet/)).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.change(select, { target: { value: "07:00" } });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await screen.findByText("Saved.");
    const call = fetch.mock.calls.find(([url, options]) =>
      url === "/api/admin/schedule/departure-time" && options?.method === "PUT");
    expect(JSON.parse(call[1].body)).toEqual({ departureTime: "07:00" });
  });

  it("shows the server's refusal when the departure time does not save", async () => {
    const base = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, options = {}) => (
      String(url) === "/api/admin/schedule/departure-time" && options.method === "PUT"
        ? response({ error: "departureTime must be a time from 06:00 to 08:00 in 15-minute steps" }, 400)
        : base(url, options)
    ));
    mount("day-start");
    const select = await screen.findByLabelText("Van leaves at");
    await waitFor(() => expect(select).toHaveValue("07:30"));
    fireEvent.change(select, { target: { value: "06:45" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("15-minute steps");
    expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
  });

  it("lists the holidays open by default and saves a holiday closure", async () => {
    mount("blackout-days");
    await screen.findByText("Thanksgiving");
    expect(screen.getByText(/observed Mon, Jul 5, 2027/)).toBeInTheDocument();
    expect(screen.getByText(/Fri, Dec 24, 2027 \(observed\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "4th of July open" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Thanksgiving open" }));
    await waitFor(() => expect(fetch.mock.calls.some(([url, options]) =>
      url === "/api/admin/schedule/blackout-dates/holidays"
      && options?.method === "PUT"
      && options.body === JSON.stringify({ closed: ["thanksgiving"] }))).toBe(true));
    expect(await screen.findByRole("button", { name: "Thanksgiving closed" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "4th of July open" })).toBeInTheDocument();
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

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// Route chosen paths to a handler; a handler that returns undefined falls
// back to the shared fixture.
function override(handlers) {
  const base = fetch.getMockImplementation();
  fetch.mockImplementation(async (url, options = {}) => {
    const path = String(url).replace(/^\/api/, "");
    const handled = handlers[path] ? await handlers[path](options) : undefined;
    return handled === undefined ? base(url, options) : handled;
  });
}

const technician = () => response({ id: "synthetic-tech", name: "Synthetic technician", email: "tech@example.invalid", role: "technician" });
const requestedPaths = () => fetch.mock.calls.map(([url]) => String(url).replace(/^\/api/, ""));
// Let pending fetch replies and the renders they cause settle.
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("Settings audit fixes", () => {
  it.each([
    "integrations",
    "gates",
    "link-library",
    "service-reports",
    "blackout-days",
    "day-start",
    "kpi-targets",
    "operating-costs",
    "system",
  ])("a technician deep link to %s shows General and requests no owner endpoint", async (tab) => {
    override({ "/admin/auth/me": technician });
    mount(tab);
    expect(await screen.findByText("Company info")).toBeInTheDocument();
    await settle();
    expect(requestedPaths().filter((p) => p !== "/health" && p !== "/admin/auth/me")).toEqual([]);
  });

  it("a failed profile read hides owner settings, says so, and retries", async () => {
    let fail = true;
    override({ "/admin/auth/me": () => (fail ? response({ error: "Profile unavailable" }, 500) : undefined) });
    mount("kpi-targets");
    expect(await screen.findByText("Could not load your account, so owner settings are hidden.")).toBeInTheDocument();
    expect(screen.getByText("Company info")).toBeInTheDocument();
    await settle();
    expect(requestedPaths().some((p) => p.startsWith("/admin/kpi-targets"))).toBe(false);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    // The owner's deep link opens once the profile loads.
    expect(await screen.findByText("KPI targets", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText(/Could not load your account/)).not.toBeInTheDocument();
  });

  describe("in a browser outside Eastern time", () => {
    // A bare toLocale*String() renders in UTC here; ET-pinned calls keep
    // America/New_York. 02:30Z on Oct 1 is still Sep 30 in Eastern.
    let spies = [];
    beforeEach(() => {
      spies = ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"].map((method) => {
        const original = Date.prototype[method];
        return vi.spyOn(Date.prototype, method).mockImplementation(function utcBrowser(locales, options) {
          return original.call(this, locales, { timeZone: "UTC", ...(options || {}) });
        });
      });
    });
    afterEach(() => spies.forEach((spy) => spy.mockRestore()));

    it("System shows the server time in Eastern", async () => {
      override({ "/health": () => response({ status: "ok", environment: "synthetic", timestamp: "2026-10-01T02:30:00.000Z" }) });
      mount("system");
      expect(await screen.findByText(/^9\/30\/2026, 10:30:00\sPM$/)).toBeInTheDocument();
    });

    it("Link Library shows the last sync in Eastern", async () => {
      override({
        "/admin/communications/link-library": () => response({ links: [], lastSyncedAt: "2026-10-01T02:30:00.000Z" }),
      });
      mount("link-library");
      expect(await screen.findByText(/website pages last synced 9\/30\/2026, 10:30:00\sPM/)).toBeInTheDocument();
    });

    it("LinkedIn shows the token expiry day in Eastern", async () => {
      override({
        "/admin/settings/linkedin/status": () => response({
          configured: true, connected: true, orgVerified: true, hasRefreshToken: true, tokenExpiresAt: "2026-12-01T03:00:00.000Z",
        }),
      });
      mount("integrations");
      expect(await screen.findByText(/token expires 11\/30\/2026/)).toBeInTheDocument();
    });

    it("Operating Costs shows the Eastern day the figures were entered", async () => {
      override({
        "/admin/revenue/settings": () => response({ settings: { ovh_office_payroll: "1200", overhead_entered_at: "2026-10-01T02:30:00.000Z" } }),
      });
      mount("operating-costs");
      expect(await screen.findByText("Last entered 9/30/2026.")).toBeInTheDocument();
    });
  });

  it("a failed Google or LinkedIn read says so with a retry, never 'Not configured'", async () => {
    let fail = true;
    override({
      "/admin/gbp/locations": () => (fail ? response({ error: "GBP read failed" }, 500) : undefined),
      "/admin/settings/linkedin/status": () => (fail ? response({ error: "LinkedIn read failed" }, 500) : undefined),
    });
    mount("integrations");
    expect(await screen.findByText("Could not load the Google Business Profile locations. GBP read failed")).toBeInTheDocument();
    expect(screen.getByText("Could not load the LinkedIn connection status. LinkedIn read failed")).toBeInTheDocument();
    expect(screen.queryByText(/Not configured/)).not.toBeInTheDocument();
    fail = false;
    screen.getAllByRole("button", { name: "Try again" }).forEach((button) => fireEvent.click(button));
    expect(await screen.findByText("Bradenton")).toBeInTheDocument();
    expect(await screen.findByText("Waves Pest Control")).toBeInTheDocument();
  });

  it("a refused service-report save shows as an error, whatever its wording", async () => {
    override({
      "/admin/settings/service-coverage": (options) => (options.method === "PUT" ? response({ error: "Admin access required" }, 403) : undefined),
      "/admin/settings/visit-timeline": (options) => (options.method === "PUT" ? response({}, 422) : undefined),
    });
    mount("service-reports");
    await screen.findByText("Service coverage", { exact: true });
    const [timelineSave, coverageSave] = screen.getAllByRole("button", { name: "Save settings" });
    fireEvent.click(coverageSave);
    expect((await screen.findByText("Admin access required")).closest('[role="alert"]')).not.toBeNull();
    fireEvent.click(timelineSave);
    expect((await screen.findByText("Request failed (422)")).closest('[role="alert"]')).not.toBeNull();
    expect(screen.queryByText(/settings saved\./)).not.toBeInTheDocument();
  });

  it("a failed service-report load shows the error with a retry, and Visit Timeline stays usable", async () => {
    let fail = true;
    override({ "/admin/settings/service-coverage": () => (fail ? response({ error: "Coverage read failed" }, 500) : undefined) });
    mount("service-reports");
    const message = await screen.findByText("Could not load Service Coverage settings. Coverage read failed");
    expect(message.closest('[role="alert"]')).not.toBeNull();
    expect(screen.queryByText("Loading Service Coverage settings...")).not.toBeInTheDocument();
    // Visit Timeline has its own read: the Service Coverage failure does not hide it.
    fireEvent.change(await screen.findByDisplayValue("Synthetic timeline source note."), { target: { value: "Typed before the retry." } });
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Service coverage", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText(/Could not load Service Coverage settings/)).not.toBeInTheDocument();
    // The Visit Timeline card stayed mounted: one read, and the typed note is still there.
    expect(screen.getByDisplayValue("Typed before the retry.")).toBeInTheDocument();
    expect(requestedPaths().filter((p) => p === "/admin/settings/visit-timeline")).toHaveLength(1);
  });

  it("a failed Visit Timeline read, or a reply with no settings, says so and Try again loads it", async () => {
    const replies = [response({ error: "Timeline read failed" }, 503), response({})];
    override({
      "/admin/settings/visit-timeline": (options) => (options.method ? undefined : replies.shift()),
      "/admin/settings/visit-timeline/reset": () => response({}),
    });
    mount("service-reports");
    const failed = await screen.findByText("Could not load Visit Timeline settings. Timeline read failed");
    expect(failed.closest('[role="alert"]')).not.toBeNull();
    expect(screen.queryByText("Loading Visit Timeline settings...")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Could not load Visit Timeline settings. The reply had no settings.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByDisplayValue("Synthetic timeline source note.")).toBeInTheDocument();
    expect(screen.queryByText(/Could not load Visit Timeline settings/)).not.toBeInTheDocument();
    // A restore whose reply has no settings is an error, and the form stays.
    fireEvent.click(screen.getAllByRole("button", { name: "Restore defaults" })[0]);
    expect((await screen.findByText("The reply had no settings.")).closest('[role="alert"]')).not.toBeNull();
    expect(screen.getByDisplayValue("Synthetic timeline source note.")).toBeInTheDocument();
  });

  it("locks the service-coverage controls while its save runs", async () => {
    const put = deferred();
    override({
      "/admin/settings/service-coverage": (options) => (options.method === "PUT"
        ? put.promise.then(() => response({ config: serviceCoverage }))
        : undefined),
    });
    mount("service-reports");
    await screen.findByText("Service coverage", { exact: true });
    fireEvent.click(screen.getAllByRole("button", { name: "Save settings" })[1]);
    expect(screen.getByRole("switch", { name: "Show map" })).toBeDisabled();
    put.resolve();
    await screen.findByText("Service Coverage settings saved.");
    expect(screen.getByRole("switch", { name: "Show map" })).not.toBeDisabled();
  });

  it("keeps an operating-cost figure typed while a save runs", async () => {
    const put = deferred();
    override({
      "/admin/revenue/settings": (options) => (options.method === "PUT"
        ? put.promise.then(() => response({ settings: { ovh_office_payroll: "1750", overhead_entered_at: "2026-10-30T15:00:00.000Z" } }))
        : undefined),
    });
    mount("operating-costs");
    fireEvent.change(await screen.findByLabelText("Office payroll"), { target: { value: "1750" } });
    fireEvent.click(screen.getByRole("button", { name: "Save costs" }));
    fireEvent.change(screen.getByLabelText("Rent / storage"), { target: { value: "900" } });
    put.resolve();
    await screen.findByText(/Saved\. The dashboard's EBITDA bridge/);
    expect(screen.getByLabelText("Rent / storage")).toHaveValue(900);
    expect(screen.getAllByText("Unsaved")).toHaveLength(1);
    const call = fetch.mock.calls.find(([url, options]) => url === "/api/admin/revenue/settings" && options?.method === "PUT");
    expect(JSON.parse(call[1].body)).toEqual({ ovhOfficePayroll: 1750 });
  });

  it("keeps a KPI target typed while a save runs", async () => {
    const put = deferred();
    override({
      "/admin/kpi-targets": (options) => (options.method === "PUT" ? put.promise.then(() => response({ updated: 1 })) : undefined),
    });
    const [first, second] = Object.values(KPI_METRIC_LABELS);
    mount("kpi-targets");
    fireEvent.change(await screen.findByLabelText(`${first} target`), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save targets" }));
    fireEvent.change(screen.getByLabelText(`${second} target`), { target: { value: "7" } });
    put.resolve();
    await screen.findByText(/Saved 1 target\./);
    expect(screen.getByLabelText(`${second} target`)).toHaveValue(7);
    expect(screen.getAllByText("Unsaved")).toHaveLength(1);
  });

  it("offers no blackout controls until the days off have loaded", async () => {
    let fail = true;
    override({
      "/admin/schedule/blackout-dates": (options) => (fail && !options.method ? response({ error: "Schedule read failed" }, 500) : undefined),
    });
    mount("blackout-days");
    expect(await screen.findByText("Could not load blackout days. Schedule read failed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /weekly$/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/No blackout days set/)).not.toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Sat open weekly" })).toBeEnabled();
    expect(requestedPaths().includes("/admin/schedule/blackout-dates/weekly")).toBe(false);
  });

  it("a blocked day stays listed when the reload after it fails", async () => {
    let reads = 0;
    override({
      "/admin/schedule/blackout-dates": (options) => {
        if (options.method === "POST") {
          return response({ success: true, blackout: { id: "day-2", date: "2026-12-31", reason: "Office closed" } });
        }
        reads += 1;
        return reads === 1 ? undefined : response({ error: "Schedule read failed" }, 500);
      },
    });
    mount("blackout-days");
    await screen.findByText("Holiday");
    fireEvent.change(screen.getByLabelText("Blackout date"), { target: { value: "2026-12-31" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Office closed" } });
    fireEvent.click(screen.getByRole("button", { name: "Block day" }));
    expect(await screen.findByText("Could not refresh blackout days. Schedule read failed")).toBeInTheDocument();
    expect(screen.getByText("Office closed")).toBeInTheDocument();
    expect(screen.getByText("Holiday")).toBeInTheDocument();
  });

  it("a failed Link Library read shows its error, not \"0 links\"", async () => {
    override({
      "/admin/communications/link-library": (options) => (options.method ? undefined : response({ error: "Links read failed" }, 500)),
    });
    mount("link-library");
    expect(await screen.findByText("Links read failed")).toBeInTheDocument();
    expect(screen.queryByText(/0 links/)).not.toBeInTheDocument();
  });

  it("an Unblock that lands while the list reloads stays unblocked", async () => {
    let stored = [{ id: "day-1", date: "2026-12-25", reason: "Holiday" }];
    let held = null;
    let reads = 0;
    override({
      "/admin/schedule/blackout-dates": (options) => {
        if (options.method === "POST") {
          stored = [...stored, { id: "day-2", date: "2026-12-31", reason: "Office closed" }];
          return response({ success: true, blackout: stored[stored.length - 1] });
        }
        reads += 1;
        const body = { blackouts: stored, weeklyDaysOff: [0], holidays: [] };
        if (reads !== 2) return response(body);
        held = deferred(); // the reload after Block day, read before the Unblock
        return held.promise.then(() => response(body));
      },
      "/admin/schedule/blackout-dates/day-1": () => {
        stored = stored.filter((b) => b.id !== "day-1");
        return response({ success: true });
      },
    });
    mount("blackout-days");
    await screen.findByText("Holiday");
    fireEvent.change(screen.getByLabelText("Blackout date"), { target: { value: "2026-12-31" } });
    fireEvent.click(screen.getByRole("button", { name: "Block day" }));
    await waitFor(() => expect(held).not.toBeNull());
    // Rows are in date order: the first Unblock is Dec 25 ("Holiday"); the
    // new Dec 31 row is already listed from the POST reply.
    fireEvent.click(screen.getAllByRole("button", { name: "Unblock" })[0]);
    expect(await screen.findByText("Office closed")).toBeInTheDocument();
    held.resolve();
    await settle();
    expect(screen.queryByText("Holiday")).not.toBeInTheDocument();
    expect(screen.getByText("Office closed")).toBeInTheDocument();
  });

  it("a weekly day saved while the list reloads is not undone by the older read", async () => {
    let weekly = [0];
    let held = null;
    let reads = 0;
    override({
      "/admin/schedule/blackout-dates": (options) => {
        if (options.method === "POST") return response({ success: true, blackout: { id: "day-2", date: "2026-12-31", reason: null } });
        reads += 1;
        const body = { blackouts: [{ id: "day-1", date: "2026-12-25", reason: "Holiday" }], weeklyDaysOff: weekly, holidays: [] };
        if (reads !== 2) return response(body);
        held = deferred();
        return held.promise.then(() => response(body));
      },
      "/admin/schedule/blackout-dates/weekly": (options) => {
        weekly = JSON.parse(options.body).daysOff;
        return response({ weeklyDaysOff: weekly });
      },
    });
    mount("blackout-days");
    await screen.findByText("Holiday");
    fireEvent.change(screen.getByLabelText("Blackout date"), { target: { value: "2026-12-31" } });
    fireEvent.click(screen.getByRole("button", { name: "Block day" }));
    await waitFor(() => expect(held).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Sat open weekly" }));
    expect(await screen.findByRole("button", { name: "Sat closed weekly" })).toBeInTheDocument();
    held.resolve();
    await settle();
    expect(screen.getByRole("button", { name: "Sat closed weekly" })).toBeInTheDocument();
  });

  it("a link removed while an older reload is out stays removed", async () => {
    const manual = (id, name) => ({ id, key: id, name, url: `https://example.invalid/${id}`, source: "manual", category: "website" });
    let links = [manual("manual-1", "First link"), manual("manual-2", "Second link")];
    let held = null;
    let reads = 0;
    override({
      "/admin/communications/link-library": (options) => {
        if (options.method) return undefined;
        reads += 1;
        const body = { links, lastSyncedAt: null };
        if (reads !== 2) return response(body);
        held = deferred(); // the reload after the first remove
        return held.promise.then(() => response(body));
      },
      "/admin/communications/link-library/manual-1": () => {
        links = links.filter((l) => l.id !== "manual-1");
        return response({ ok: true });
      },
      "/admin/communications/link-library/manual-2": () => {
        links = links.filter((l) => l.id !== "manual-2");
        return response({ ok: true });
      },
    });
    mount("link-library");
    await screen.findByText("Second link");
    fireEvent.click(screen.getByRole("button", { name: "Remove First link" }));
    await waitFor(() => expect(held).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Remove Second link" }));
    await waitFor(() => expect(screen.queryByText("Second link")).not.toBeInTheDocument());
    held.resolve();
    await settle();
    expect(screen.queryByText("Second link")).not.toBeInTheDocument();
  });
});
