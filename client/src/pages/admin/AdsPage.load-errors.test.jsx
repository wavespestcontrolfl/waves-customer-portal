// @vitest-environment jsdom
// 10-29 Ads screen audit #3 and #4: a failed read or a refused action shows as
// a failure (never as empty data or "0 bridge updates applied"), and an empty
// Services period keeps the period buttons.
import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AdsPage from "./AdsPage";

vi.mock("../../lib/adminUsage", () => ({ trackAdminPageView: vi.fn() }));
vi.mock("./PPCDashboardPage", () => ({ default: () => <div>Existing PPC dashboard</div> }));

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const PREVIEW = {
  configured: true,
  summary: { googleCalls: 3, ready: 2, alreadyBridged: 1, crmMainLineCalls: 4 },
  matches: [],
};

let routes;
beforeEach(() => {
  routes = {};
  vi.stubGlobal("localStorage", { getItem: () => "fixture-token" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, opts = {}) => {
      const key = `${opts.method || "GET"} ${url.replace(/^\/api/, "")}`;
      const route = routes[key];
      if (!route) throw new Error(`Unexpected fixture request: ${key}`);
      return route();
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = (tab) =>
  render(
    <MemoryRouter initialEntries={[`/admin/ppc?tab=${tab}`]}>
      <AdsPage />
    </MemoryRouter>,
  );

it("Overview: a failed campaigns read says so and retries, instead of 'No Campaigns Yet'", async () => {
  let fail = true;
  routes["GET /admin/ads/campaigns"] = () =>
    fail
      ? json({ error: "Service unavailable" }, 503)
      : json({ campaigns: [{ id: "c1", campaign_name: "Search", last7d: { spend: 7 } }] });
  open("overview");

  expect(await screen.findByRole("alert")).toHaveTextContent("Campaigns did not load: Service unavailable");
  expect(screen.queryByText("No Campaigns Yet")).not.toBeInTheDocument();

  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Campaign Performance")).toBeInTheDocument();
});

it("Call bridge: a refused apply shows the server's reason and keeps the preview", async () => {
  routes["GET /admin/ads/call-bridge?period=30d"] = () => json(PREVIEW);
  routes["POST /admin/ads/call-bridge/apply"] = () =>
    json({ error: "Call bridge is currently running. Try again shortly." }, 409);
  open("call-bridge");

  fireEvent.click(await screen.findByRole("button", { name: "Apply ready matches" }));

  expect(
    await screen.findByText("Bridge apply did not run: Call bridge is currently running. Try again shortly."),
  ).toBeInTheDocument();
  expect(screen.queryByText(/bridge updates? applied/)).not.toBeInTheDocument();
  // The loaded preview is still on screen: 2 ready matches, 3 Google calls.
  expect(screen.getByText("Ready Matches").parentElement).toHaveTextContent("2");
  expect(screen.getByText("Google Calls").parentElement).toHaveTextContent("3");
});

it("Call bridge: a failed preview leaves nothing to apply", async () => {
  routes["GET /admin/ads/call-bridge?period=30d"] = () => json({ error: "Bridge scan failed" }, 500);
  open("call-bridge");

  expect(await screen.findByText("Bridge preview did not load: Bridge scan failed")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Record clean rescan" })).toBeDisabled();
});

it("Services: an empty period keeps the period buttons, so another period can be picked", async () => {
  routes["GET /admin/ads/service-lines?period=30d"] = () => json({ totalLeads: 0, byBucket: [] });
  routes["GET /admin/ads/service-lines?period=90d"] = () =>
    json({
      totalLeads: 1,
      byBucket: [],
      bySpecificService: [],
    });
  open("service-lines");

  expect(await screen.findByText(/No leads in this period/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "90 Days" }));

  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith("/api/admin/ads/service-lines?period=90d", expect.anything()),
  );
  await waitFor(() =>
    expect(screen.queryByText("Loading service-line data...")).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("button", { name: "90 Days" })).toBeInTheDocument();
  expect(screen.queryByText(/No leads in this period/)).not.toBeInTheDocument();
});

it("Services: a failed read says so, keeps the period buttons, and retries", async () => {
  let fail = true;
  routes["GET /admin/ads/service-lines?period=30d"] = () =>
    fail ? json({ error: "Service unavailable" }, 503) : json({ totalLeads: 0, byBucket: [] });
  open("service-lines");

  expect(await screen.findByRole("alert")).toHaveTextContent("Service-line data did not load: Service unavailable");
  expect(screen.getByRole("button", { name: "7 Days" })).toBeInTheDocument();
  expect(screen.queryByText(/No leads in this period/)).not.toBeInTheDocument();

  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText(/No leads in this period/)).toBeInTheDocument();
});
