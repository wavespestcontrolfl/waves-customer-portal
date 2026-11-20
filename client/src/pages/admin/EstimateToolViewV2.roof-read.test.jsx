// @vitest-environment jsdom
// GATE_ROOF_ENTRY_READ: the Roof read panel in the rodent exclusion area shows only while the server says the gate is
// on (roofEntryRead: true on the rodent_waveguard row), never posts on its own, and starts blank after Next estimate
// and after a property or customer change.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EstimateToolViewV2 from "./EstimateToolViewV2";

configure({ asyncUtilTimeout: 15000 });
vi.setConfig({ testTimeout: 30000 });
vi.mock("../../components/admin/EstimateSendDialog", () => ({ useEstimateSend: () => vi.fn() }));

const ADDRESS = "400 Example Court, Venice, FL 34285";
const CUST_A = "44444444-4444-4444-8444-444444444444";
const CUST_B = "55555555-5555-4555-8555-555555555555";
const READ = {
  id: "66666666-6666-4666-8666-666666666666", county: "sarasota", image_year: 2025, tier: "med",
  tech_final_count: null, tech_final_flags: null,
  flags: { plumbing_vent_stacks: { likely: "yes", pins: [{ x: 0.5, y: 0.5 }] } },
};

const reply = (body, status = 200) => ({
  ok: status < 400, status, json: async () => body,
  clone() { return this; }, text: async () => JSON.stringify(body),
});

let fetchMock;
let waveguardRow;
let snapped;
let verifyFlag;
beforeEach(() => {
  localStorage.setItem("waves_admin_token", "qa-token");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(window, "alert").mockImplementation(() => {});
  waveguardRow = { data: {}, roofEntryRead: true };
  snapped = false;
  verifyFlag = false;
  fetchMock = vi.fn((url, init) => {
    const path = String(url);
    if (path.includes("/admin/pricing-config/rodent_waveguard")) return Promise.resolve(reply(waveguardRow));
    if (path.endsWith("/estimator/property-lookup")) {
      return Promise.resolve(reply({
        enriched: { homeSqFt: 2000, lotSqFt: 9000, stories: 1, ...(verifyFlag ? { fieldVerifyFlags: [{ field: "address", reason: "Verify the address", priority: "HIGH" }] } : {}) },
        propertyRecord: { latitude: 27.3, longitude: -82.4, _parcel: { county: "Sarasota" } },
        ...(snapped ? { addressAudit: { snappedRecord: { typed: "400", record: "402 Example Court" } } } : {}),
        errors: [],
      }));
    }
    if (path.endsWith("/admin/roof-entry-read") && init?.method === "POST") {
      return Promise.resolve(reply({ status: "ok", cached: false, read: READ, image_url: "https://example.test/crop.jpg" }));
    }
    if (path.endsWith("/calculate-estimate")) {
      return Promise.resolve(reply({
        recurring: { tier: "Bronze", grandTotal: 0, annualAfterDiscount: 0, services: [] },
        oneTime: { total: 99, items: [] }, results: {}, totals: { year2mo: 0, year1: 99 },
      }));
    }
    if (path === "/api/admin/estimates" && init?.method === "POST") {
      return Promise.resolve(reply({ id: JSON.parse(init.body).clientDraftId, status: "draft", editVersion: "v1", token: "t", monthlyTotal: 0, annualTotal: 0, onetimeTotal: 99 }));
    }
    if (path.endsWith("/edit-source")) {
      return Promise.resolve(reply({
        id: "qa-roof-estimate", status: "draft", editable: true, editVersion: "v1", customerName: "QA Contact", address: ADDRESS,
        inputs: { svcExclusion: true }, engineProfile: { homeSqFt: 2000, lotSqFt: 9000, stories: 1 },
        result: { recurring: { services: [] }, oneTime: { total: 0, items: [] }, results: {}, totals: {} },
      }));
    }
    if (path.includes("/discounts")) return Promise.resolve(reply([]));
    return Promise.resolve(reply({}));
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const roofPosts = () => fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith("/admin/roof-entry-read") && init?.method === "POST");
const panel = () => screen.queryByTestId("roof-read-panel");
const tickExclusion = () => fireEvent.click(screen.getByRole("checkbox", { name: "Rodent Exclusion Service" }));
async function lookUp() {
  fireEvent.click(screen.getByRole("button", { name: "Property Lookup", exact: true }));
  await screen.findByRole("region", { name: "Property lookup results" });
}
const renderNew = (props = {}) => render(<MemoryRouter><EstimateToolViewV2 initialAddress={ADDRESS} {...props} /></MemoryRouter>);

describe("availability", () => {
  it("shows the panel only while the server says the gate is on", async () => {
    renderNew();
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("rodent_waveguard"))).toBe(true));
    tickExclusion();
    await waitFor(() => expect(panel()).toBeInTheDocument());
    for (const row of [{ data: {} }, { data: {}, roofEntryRead: false }]) {
      cleanup();
      waveguardRow = row;
      renderNew();
      await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("rodent_waveguard")).length).toBeGreaterThan(1));
      tickExclusion();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(panel()).toBeNull();
    }
    expect(roofPosts()).toHaveLength(0);
  });

  it("never posts until the button is tapped, and asks for a lookup first", async () => {
    renderNew();
    tickExclusion();
    await screen.findByTestId("roof-read-no-spot");
    await lookUp();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(roofPosts()).toHaveLength(0);
    fireEvent.click(await screen.findByTestId("roof-read-button"));
    await screen.findByTestId("roof-read-result");
    expect(roofPosts()).toHaveLength(1);
    expect(JSON.parse(roofPosts()[0][1].body)).toEqual({ lat: 27.3, lng: -82.4, county: "Sarasota" });
  });
});

describe("resets", () => {
  it("starts blank when the draft gets its estimate id, then again after Next estimate", async () => {
    renderNew();
    tickExclusion();
    await lookUp();
    fireEvent.click(await screen.findByTestId("roof-read-button"));
    await screen.findByTestId("roof-read-result");
    expect(JSON.parse(roofPosts()[0][1].body).estimate_id).toBeUndefined();
    // The read may run pre-draft, but the tech's count needs a saved estimate.
    expect(screen.getByTestId("roof-read-save")).toBeDisabled();
    expect(screen.getByTestId("roof-read-save-first")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Generate Estimate", exact: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Save draft", exact: true }));
    const next = await screen.findByRole("button", { name: /Next estimate \(keep services\)/ });
    // The pre-draft read is gone, so a tech count cannot land on a row another draft can reuse.
    await waitFor(() => expect(screen.queryByTestId("roof-read-result")).toBeNull());
    expect(roofPosts()).toHaveLength(1);
    fireEvent.click(await screen.findByTestId("roof-read-button"));
    await screen.findByTestId("roof-read-result");
    expect(JSON.parse(roofPosts()[1][1].body).estimate_id).toEqual(expect.any(String));
    expect(screen.getByTestId("roof-read-save")).not.toBeDisabled();
    fireEvent.click(next);
    await waitFor(() => expect(screen.queryByTestId("roof-read-result")).toBeNull());
    expect(roofPosts()).toHaveLength(2);
  });

  it("offers no read when the lookup raises an address verify flag", async () => {
    verifyFlag = true;
    renderNew();
    tickExclusion();
    await lookUp();
    expect(await screen.findByTestId("roof-read-snapped")).toBeInTheDocument();
    expect(screen.queryByTestId("roof-read-button")).toBeNull();
    expect(roofPosts()).toHaveLength(0);
  });

  it("offers no read for a snapped neighbour's address", async () => {
    snapped = true;
    renderNew();
    tickExclusion();
    await lookUp();
    expect(await screen.findByTestId("roof-read-snapped")).toBeInTheDocument();
    expect(screen.queryByTestId("roof-read-button")).toBeNull();
    expect(roofPosts()).toHaveLength(0);
  });

  it("links a reopened estimate only while the address is the one it was saved with", async () => {
    render(<MemoryRouter><EstimateToolViewV2 editEstimateId="qa-roof-estimate" /></MemoryRouter>);
    await screen.findByDisplayValue("QA Contact");
    await lookUp();
    fireEvent.click(await screen.findByTestId("roof-read-button"));
    await screen.findByTestId("roof-read-result");
    expect(JSON.parse(roofPosts()[0][1].body).estimate_id).toBe("qa-roof-estimate");
    expect(screen.getByTestId("roof-read-save")).not.toBeDisabled();
    // A different address: the estimate's id no longer fits the roof, so the read runs without it and Save stays locked.
    fireEvent.change(screen.getByLabelText("Service address"), { target: { value: "12 Example Lane, Bradenton FL" } });
    await waitFor(() => expect(screen.queryByTestId("roof-read-result")).toBeNull());
    await lookUp();
    fireEvent.click(await screen.findByTestId("roof-read-button"));
    await screen.findByTestId("roof-read-result");
    expect(roofPosts()).toHaveLength(2);
    expect(JSON.parse(roofPosts()[1][1].body)).not.toHaveProperty("estimate_id");
    expect(screen.getByTestId("roof-read-save")).toBeDisabled();
    expect(screen.getByTestId("roof-read-save-first")).toBeInTheDocument();
  });

  it("starts blank when the customer changes", async () => {
    const view = renderNew({ initialCustomerId: CUST_A });
    tickExclusion();
    await lookUp();
    fireEvent.click(await screen.findByTestId("roof-read-button"));
    await screen.findByTestId("roof-read-result");
    expect(JSON.parse(roofPosts()[0][1].body).customer_id).toBe(CUST_A);
    view.rerender(<MemoryRouter><EstimateToolViewV2 initialAddress={ADDRESS} initialCustomerId={CUST_B} /></MemoryRouter>);
    await waitFor(() => expect(screen.queryByTestId("roof-read-result")).toBeNull());
    expect(roofPosts()).toHaveLength(1);
  });

  it("starts blank when the service address changes", async () => {
    renderNew();
    tickExclusion();
    await lookUp();
    fireEvent.click(await screen.findByTestId("roof-read-button"));
    await screen.findByTestId("roof-read-result");
    fireEvent.change(screen.getByLabelText("Service address"), { target: { value: "12 Example Lane, Bradenton FL" } });
    await waitFor(() => expect(screen.queryByTestId("roof-read-result")).toBeNull());
    expect(screen.getByTestId("roof-read-no-spot")).toBeInTheDocument();
  });
});
