// @vitest-environment jsdom
// Area add-ons follow the property they were chosen for (Codex r6 P1). Every
// path that replaces the property (typed address, customer or lead pick, Clear
// All) clears the selected add-ons and the group visit; a lookup that reruns
// re-seeds an entry the rep never touched and leaves a chosen tier alone.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EstimateToolViewV2 from "./EstimateToolViewV2";

vi.mock("../../components/admin/EstimateSendDialog", () => ({ useEstimateSend: () => vi.fn() }));

const ADDRESS = "500 Example Court, Venice, FL 34285";
const OTHER_ADDRESS = "9 Sample Row, Parrish, FL 34219";
const ITEMS = [
  { key: "bed_pre_emergent", name: "Bed Pre-Emergent Weed Control", category: "lawn_care", areaLabel: "bed", tiers: [1000, 2000, 3500], limitText: "2 in 12 months", requiresGrassTrack: null },
  { key: "web_sweep", name: "Web Sweep", category: "pest_control", areaLabel: null, tiers: null, limitText: null, requiresGrassTrack: null },
];
const json = (body) => ({ ok: true, status: 200, json: async () => body, clone() { return this; }, text: async () => JSON.stringify(body) });

let lookupEnriched;
let customers;
let leads;
beforeEach(() => {
  localStorage.setItem("waves_admin_token", "qa-token");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  lookupEnriched = { homeSqFt: 2000, lotSqFt: 9000, stories: 1, estimatedBedAreaSf: 1450 };
  customers = [{ id: "synthetic-customer", firstName: "Jamie", lastName: "Fixture", address: OTHER_ADDRESS }];
  leads = [{ id: "synthetic-lead", first_name: "Dana", last_name: "Sample", email: "dana.sample@example.com", phone: null, address: OTHER_ADDRESS, service_interest: "Pest Control", customer_id: null }];
  vi.stubGlobal("fetch", vi.fn((url) => {
    const path = String(url);
    if (path.includes("/admin/pricing-config/lawn_pricing_v2")) return Promise.resolve(json({ areaAddOns: { enabled: true, visitContexts: ["standalone", "sameTripAddOn"], items: ITEMS } }));
    if (path.endsWith("/estimator/property-lookup")) return Promise.resolve(json({ enriched: structuredClone(lookupEnriched), errors: [] }));
    if (path.startsWith("/api/admin/customers?")) return Promise.resolve(json({ customers }));
    if (path.startsWith("/api/admin/leads?")) return Promise.resolve(json({ leads }));
    if (path.includes("/discounts")) return Promise.resolve(json([]));
    return Promise.resolve(json({}));
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

const box = (name) => screen.getByRole("checkbox", { name });
const renderNew = () => render(<MemoryRouter><EstimateToolViewV2 initialAddress={ADDRESS} /></MemoryRouter>);
async function openGroup() {
  const group = await screen.findByTestId("area-addons-group");
  if (within(group).queryAllByRole("checkbox").length === 0) fireEvent.click(within(group).getByRole("button", { name: "Show" }));
  return group;
}
async function lookUp() {
  fireEvent.click(screen.getByRole("button", { name: "Property Lookup", exact: true }));
  await screen.findByRole("region", { name: "Property lookup results" });
}
// A property looked up, a bed add-on and the same-visit choice picked.
async function selectedState() {
  renderNew();
  await openGroup();
  await lookUp();
  fireEvent.click(box("Bed Pre-Emergent Weed Control"));
  fireEvent.click(box("Web Sweep"));
  fireEvent.change(screen.getByLabelText("Visit"), { target: { value: "sameTripAddOn" } });
  expect(screen.getByText("2 selected")).toBeInTheDocument();
  expect(screen.getByLabelText("Visit")).toHaveValue("sameTripAddOn");
}
function expectCleared() {
  expect(screen.queryByText(/\d+ selected/)).not.toBeInTheDocument();
  expect(box("Bed Pre-Emergent Weed Control")).not.toBeChecked();
  expect(box("Web Sweep")).not.toBeChecked();
  // The visit choice went back to its default (it shows again once an add-on is picked).
  fireEvent.click(box("Web Sweep"));
  expect(screen.getByLabelText("Visit")).toHaveValue("standalone");
}
const searchBox = () => screen.getByRole("textbox", { name: "Search customers by first name, last name, or full name" });

describe("area add-ons are dropped when the property changes", () => {
  it("typing a new address", async () => {
    await selectedState();
    fireEvent.change(screen.getByRole("textbox", { name: "Service address" }), { target: { value: OTHER_ADDRESS } });
    expectCleared();
  });

  it("picking a customer whose address differs", async () => {
    await selectedState();
    fireEvent.change(searchBox(), { target: { value: "Jamie" } });
    fireEvent.click(await screen.findByRole("button", { name: /Jamie Fixture/ }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Service address" })).toHaveValue(OTHER_ADDRESS));
    expectCleared();
  });

  it("picking a lead whose address differs", async () => {
    await selectedState();
    fireEvent.change(searchBox(), { target: { value: "Dana" } });
    fireEvent.click(await screen.findByRole("button", { name: /Dana Sample.*Lead/ }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Service address" })).toHaveValue(OTHER_ADDRESS));
    expectCleared();
  });

  it("picking a customer at the same address keeps them: it is the same property", async () => {
    customers = [{ id: "synthetic-customer", firstName: "Jamie", lastName: "Fixture", address: ADDRESS }];
    await selectedState();
    fireEvent.change(searchBox(), { target: { value: "Jamie" } });
    fireEvent.click(await screen.findByRole("button", { name: /Jamie Fixture/ }));
    await waitFor(() => expect(document.getElementById("estimate-customerName")).toHaveValue("Jamie Fixture"));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });

  it("Clear All", async () => {
    await selectedState();
    fireEvent.click(screen.getByRole("button", { name: "Clear All" }));
    await openGroup();
    expectCleared();
  });
});

describe("a lookup that reruns", () => {
  it("re-seeds an add-on whose tier the rep never touched, and leaves a chosen tier alone", async () => {
    renderNew();
    await openGroup();
    await lookUp();
    fireEvent.click(box("Bed Pre-Emergent Weed Control"));
    expect(screen.getByLabelText("Bed area")).toHaveValue("2000");
    // The bed area the lookup knows changes (a refreshed lookup).
    lookupEnriched = { ...lookupEnriched, estimatedBedAreaSf: 3000 };
    fireEvent.click(screen.getByRole("button", { name: "Property Lookup", exact: true }));
    await waitFor(() => expect(screen.getByLabelText("Bed area")).toHaveValue("3500"));
    // The rep chooses a tier; a later lookup no longer moves it.
    fireEvent.change(screen.getByLabelText("Bed area"), { target: { value: "1000" } });
    lookupEnriched = { ...lookupEnriched, estimatedBedAreaSf: 450 };
    fireEvent.click(screen.getByRole("button", { name: "Property Lookup", exact: true }));
    await waitFor(() => expect(screen.getByText(/about 450 sq ft of beds/)).toBeInTheDocument());
    expect(screen.getByLabelText("Bed area")).toHaveValue("1000");
  });
});
