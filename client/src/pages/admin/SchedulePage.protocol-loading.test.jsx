// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { ProtocolPanel } from "./SchedulePage";

const service = {
  id: "visit-fixture-a", customerId: "customer-fixture-a",
  serviceType: "Lawn Care", customerName: "Fixture account",
  lawnType: "St. Augustine", lawnSqft: 10000,
};
const reply = (body, status = 200) => Promise.resolve({
  ok: status < 400, status, json: async () => body,
});
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(url, label = "Current") {
  const path = new URL(url, "http://localhost").pathname;
  if (path.endsWith("/turf-profile")) return { profile: { track_key: "A_St_Aug_Sun", lawn_sqft: 10000 } };
  if (path.endsWith("/photos/relevant")) return { photos: [{ name: `${label} photo guide`, description: "Fixture reference" }] };
  if (path.endsWith("/seasonal-index")) return { pests: [] };
  if (path.endsWith("/scripts")) return { scripts: [] };
  if (path.endsWith("/equipment")) return { checklists: [{ service_type: "Lawn", checklist_items: [{ category: "Equipment", items: [{ item: `${label} sprayer`, required: true }] }] }] };
  if (path.endsWith("/programs")) return { track: { name: `${label} lawn program`, notes: [], visits: [] } };
  if (path.endsWith("/lawn-mix")) return {
    month: "Jul", visit: { visit: 7 }, areaSqft: 10000,
    equipment: { systemName: "Fixture calibrated rig", carrierGalPer1000: 2 },
    items: [{ raw: "Fixture selected product", product: { name: `${label} mix product` }, jobMix: { amount: 2.9, amountUnit: "oz" }, fullTankMix: { amount: 5.8, amountUnit: "oz" } }],
  };
  throw new Error(`Unexpected request: ${path}`);
}

beforeEach(() => {
  // Exercise the real panel and its HTTP error handling; no request leaves the test.
  vi.stubGlobal("fetch", vi.fn((url) => reply(fixture(url))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("ProtocolPanel mix previews", () => {
  it("shows labeled optional quantities and prefers actual quantities for selected products", async () => {
    fetch.mockImplementation((url) => {
      const body = fixture(url);
      if (url.includes("/lawn-mix")) {
        body.items = [
          { raw: "Base instruction", selected: true, product: { name: "Selected product" }, jobMix: { amount: 30, amountUnit: "fl_oz" }, fullTankMix: { amount: 60, amountUnit: "fl_oz" }, plannedMix: { amount: 999, amountUnit: "fl_oz" }, plannedFullTankMix: { amount: 1998, amountUnit: "fl_oz" } },
          { raw: "If rescue is needed", selected: false, product: { name: "Rescue product" }, jobMix: null, fullTankMix: null, plannedMix: { amount: 2.9, amountUnit: "oz" }, plannedFullTankMix: { amount: 5.8, amountUnit: "oz" } },
          { raw: "Premium option", selected: false, product: { name: "Premium product" }, jobMix: null, fullTankMix: null, plannedMix: { amount: 90, amountUnit: "fl_oz" }, plannedFullTankMix: { amount: 180, amountUnit: "fl_oz" } },
        ];
      }
      return reply(body);
    });
    render(<ProtocolPanel service={service} onClose={() => {}} />);
    const selected = within(await screen.findByRole("group", { name: "Selected product" }));
    expect(selected.getByText("30 fl_oz")).toBeVisible();
    expect(selected.getByText("60 fl_oz/tank")).toBeVisible();
    expect(selected.queryByText("Optional preview")).not.toBeInTheDocument();
    expect(selected.queryByText(/999|1998/)).not.toBeInTheDocument();
    const rescue = within(screen.getByRole("group", { name: "Rescue product" }));
    expect(rescue.getByText("Optional preview")).toBeVisible();
    expect(rescue.getByText("If rescue is needed")).toBeVisible();
    expect(rescue.getByText("2.9 oz")).toBeVisible();
    expect(rescue.getByText("5.8 oz/tank")).toBeVisible();
    const premium = within(screen.getByRole("group", { name: "Premium product" }));
    expect(premium.getByText("Optional preview")).toBeVisible();
    expect(premium.getByText("90 fl_oz")).toBeVisible();
    expect(premium.getByText("180 fl_oz/tank")).toBeVisible();
    // Previewing does not select products or submit applications.
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(fetch.mock.calls.every(([, options]) => !options.method || options.method === "GET")).toBe(true);
  });

  it.each([
    ["SKIP instruction", null],
    ["Missing calibration", { code: "missing_calibration", message: "No active calibration. Quantities withheld." }],
    ["Expired calibration", { code: "expired_calibration", message: "Calibration expired. Quantities withheld." }],
  ])("keeps %s quantities unavailable without inventing a preview", async (label, warning) => {
    fetch.mockImplementation((url) => {
      const body = fixture(url);
      if (url.includes("/lawn-mix")) {
        body.items = [{ raw: label, selected: false, product: { name: "Unavailable product" }, jobMix: null, fullTankMix: null, plannedMix: null, plannedFullTankMix: null }];
        body.warnings = warning ? [warning] : [];
      }
      return reply(body);
    });
    render(<ProtocolPanel service={service} onClose={() => {}} />);
    const row = within(await screen.findByRole("group", { name: "Unavailable product" }));
    expect(row.getByText(label)).toBeVisible();
    expect(row.getByText("—")).toBeVisible();
    expect(row.getByText("— /tank")).toBeVisible();
    expect(row.queryByText("Optional preview")).not.toBeInTheDocument();
    expect(screen.queryByText("2.9 oz")).not.toBeInTheDocument();
    if (warning) expect(screen.getByText(warning.message, { exact: false })).toBeVisible();
  });
});

describe("ProtocolPanel independent request failures", () => {
  it("keeps mix and equipment after photo failure and recovers through the visible retry", async () => {
    let failPhotos = true;
    fetch.mockImplementation((url) => url.includes("/photos/relevant") && failPhotos
      ? reply({ error: "Fixture failure" }, 503) : reply(fixture(url)));
    render(<ProtocolPanel service={service} onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load: ID guide.");
    expect(screen.getByText("Current mix product")).toBeVisible();
    expect(screen.getByText("2.9 oz")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /^Equipment/ }));
    expect(screen.getByText("Current sprayer")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /^ID Guide/ }));
    expect(screen.getByText("ID guide unavailable")).toBeVisible();
    expect(screen.queryByText("No photo references for this service")).not.toBeInTheDocument();

    failPhotos = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
    expect(await screen.findByText("Current photo guide")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("withholds failed mix quantities while retaining the program and equipment", async () => {
    fetch.mockImplementation((url) => url.includes("/lawn-mix")
      ? Promise.reject(new Error("Fixture network failure")) : reply(fixture(url)));
    render(<ProtocolPanel service={service} onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load: Mix quantities.");
    expect(screen.getAllByText("Current lawn program")[0]).toBeVisible();
    expect(screen.queryByText("2.9 oz")).not.toBeInTheDocument();
    expect(screen.queryByText("Fixture calibrated rig", { exact: false })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Equipment/ }));
    expect(screen.getByText("Current sprayer")).toBeVisible();
  });

  it("reports a failed turf profile while preserving the existing appointment-data fallback", async () => {
    fetch.mockImplementation((url) => url.includes("/turf-profile")
      ? reply({}, 503) : reply(fixture(url)));
    render(<ProtocolPanel service={service} onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load: Turf profile.");
    expect(screen.getByText("Current mix product")).toBeVisible();
    expect(fetch.mock.calls.some(([url]) => url.includes("/lawn-mix?") && url.includes("lawnSqft=10000"))).toBe(true);
  });

  it("clears a previous service's guidance when the next service cannot load it", async () => {
    const view = render(<ProtocolPanel service={service} onClose={() => {}} />);
    expect(await screen.findByText("Current mix product")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /^Equipment/ }));
    expect(screen.getByText("Current sprayer")).toBeVisible();
    fetch.mockImplementation((url) => /\/(equipment|lawn-mix|photos\/relevant)/.test(url)
      ? reply({}, 503) : reply(fixture(url, "Next")));
    view.rerender(<ProtocolPanel service={{ ...service, id: "visit-fixture-b", customerId: "customer-fixture-b" }} onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("ID guide, Equipment, Mix quantities");
    expect(screen.queryByText("Current mix product")).not.toBeInTheDocument();
    expect(screen.queryByText("2.9 oz")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Equipment/ }));
    expect(screen.getByText("Equipment checklist unavailable")).toBeVisible();
    expect(screen.queryByText("Current sprayer")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^ID Guide/ }));
    expect(screen.queryByText("Current photo guide")).not.toBeInTheDocument();
  });

  it.each(["turf-profile", "equipment"])("ignores late %s responses from a previous service", async (pendingPath) => {
    const oldResponse = deferred();
    fetch.mockImplementation((url) => url.includes(`/${pendingPath}`)
      ? oldResponse.promise : reply(fixture(url, "Old")));
    const view = render(<ProtocolPanel service={service} onClose={() => {}} />);
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.includes(`/${pendingPath}`))).toBe(true));
    fetch.mockImplementation((url) => reply(fixture(url, "Next")));
    view.rerender(<ProtocolPanel service={{ ...service, id: "visit-fixture-b", customerId: "customer-fixture-b" }} onClose={() => {}} />);
    expect(await screen.findByText("Next mix product")).toBeVisible();
    const callsBeforeOldResponse = fetch.mock.calls.length;
    await act(async () => { oldResponse.resolve(await reply(fixture(`/api/admin/${pendingPath}`, "Old"))); });
    expect(fetch).toHaveBeenCalledTimes(callsBeforeOldResponse);
    expect(screen.getByText("Next mix product")).toBeVisible();
    expect(screen.queryByText("Old mix product")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Equipment/ }));
    expect(screen.getByText("Next sprayer")).toBeVisible();
    expect(screen.queryByText("Old sprayer")).not.toBeInTheDocument();
  });
});
