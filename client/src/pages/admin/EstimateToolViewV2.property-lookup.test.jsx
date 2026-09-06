// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EstimateToolViewV2 from "./EstimateToolViewV2";

const ADDRESS = "100 Example Way, Bradenton, FL 34203";
const SECOND = "200 Example Way, Bradenton, FL 34203";
const json = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });
const empty = {
  enriched: {
    homeSqFt: 0, lotSqFt: 0, stories: 1, storiesSource: "default", fieldEvidence: {},
    propertyDataQuality: { score: 0, missingCriticalFields: ["squareFootage", "lotSize", "stories", "propertyType"] },
  }, errors: [],
};
const complete = {
  enriched: {
    homeSqFt: 2400, lotSqFt: 10000, stories: 2, storiesSource: "county", propertyType: "Single Family",
    fieldEvidence: {
      squareFootage: { value: 2400, sourceLabel: "county record", winningSource: "https://www.manateepao.gov/parcel/?parid=123456" },
      lotSize: { value: 10000, sourceLabel: "county record" },
      stories: { value: 2, sourceLabel: "county record" },
      propertyType: { value: "Single Family", sourceLabel: "county record" },
    },
    propertyDataQuality: { score: 100, missingCriticalFields: [] },
  }, errors: [], meta: { cache: "hit", cachedAt: "2026-01-01T17:00:00Z" },
};
let lookupResponse;
let customerResponse;
let fetchMock;

beforeEach(() => {
  lookupResponse = complete;
  customerResponse = () => json({ customers: [] });
  localStorage.setItem("waves_admin_token", "test-token");
  fetchMock = vi.fn((url) => {
    if (url === "/api/admin/estimator/property-lookup") return json(lookupResponse);
    if (url === "/api/admin/customers/at-address") return customerResponse();
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

function mount() {
  render(<MemoryRouter><EstimateToolViewV2 /></MemoryRouter>);
}
function editAddress(address) {
  fireEvent.change(screen.getByPlaceholderText("Start typing an address..."), { target: { value: address } });
}
async function lookUp() {
  fireEvent.click(screen.getByRole("button", { name: "Property Lookup" }));
  await screen.findByRole("region", { name: "Property lookup results" });
}
const home = () => screen.getByPlaceholderText("2000");
const lot = () => screen.getByPlaceholderText("8000");

describe("estimate property lookup accuracy", () => {
  it("finishes property status while optional customer suggestions are still pending", async () => {
    customerResponse = () => new Promise(() => {});
    mount(); editAddress(ADDRESS); await lookUp();
    expect(screen.getByText("Property lookup complete. Review the measurements and sources below.")).toBeInTheDocument();
    expect(screen.queryByText(/Checking property records/)).not.toBeInTheDocument();
    expect(home()).toHaveValue(2400);
  });

  it("clears the previous property's measurements and evidence when the address changes", async () => {
    mount(); editAddress(ADDRESS); await lookUp();
    expect(home()).toHaveValue(2400);
    editAddress(SECOND);
    expect(home()).toHaveValue(null);
    expect(lot()).toHaveValue(null);
    expect(screen.queryByRole("region", { name: "Property lookup results" })).not.toBeInTheDocument();
    lookupResponse = empty;
    await lookUp();
    expect(home()).toHaveValue(null);
    expect(lot()).toHaveValue(null);
    expect(screen.queryByRole("button", { name: /^Verify home/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Home and lot measurements were not found/)).toBeInTheDocument();
  });

  it("forces fresh records and preserves only the same property's manual correction", async () => {
    mount(); editAddress(ADDRESS); await lookUp();
    fireEvent.change(home(), { target: { value: "2600" } });
    lookupResponse = empty;
    fireEvent.click(screen.getByRole("button", { name: "Refresh property records" }));
    await waitFor(() => expect(screen.getByText(/Home and lot measurements were not found/)).toBeInTheDocument());
    expect(home()).toHaveValue(2600);
    expect(lot()).toHaveValue(null);
    const calls = fetchMock.mock.calls.filter(([url]) => url === "/api/admin/estimator/property-lookup");
    expect(JSON.parse(calls.at(-1)[1].body)).toEqual({ address: ADDRESS, refresh: true });
    fireEvent.click(screen.getByRole("button", { name: /^Verify home living area: 2,600/ }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/property-lookup/verify"))).toBe(true));
    const verify = fetchMock.mock.calls.find(([url]) => url.endsWith("/property-lookup/verify"));
    expect(JSON.parse(verify[1].body)).toEqual({ address: ADDRESS, fields: { squareFootage: 2600 } });
    editAddress(SECOND);
    expect(home()).toHaveValue(null);
  });

  it("discards a response that was requested for a previous address", async () => {
    let resolveLookup;
    fetchMock.mockImplementation((url) => url === "/api/admin/estimator/property-lookup"
      ? new Promise((resolve) => { resolveLookup = resolve; }) : json({}));
    mount(); editAddress(ADDRESS);
    fireEvent.click(screen.getByRole("button", { name: "Property Lookup" }));
    editAddress(SECOND);
    resolveLookup({ ok: true, json: async () => complete });
    await waitFor(() => expect(screen.queryByText(/Checking property records/)).not.toBeInTheDocument());
    expect(home()).toHaveValue(null);
    expect(screen.queryByRole("region", { name: "Property lookup results" })).not.toBeInTheDocument();
  });

  it("shows the source and retrieval date, and keeps an address mismatch out of verification", async () => {
    mount(); editAddress(ADDRESS); await lookUp();
    expect(screen.getByRole("link", { name: "View source" })).toHaveAttribute("href", "https://www.manateepao.gov/parcel/?parid=123456");
    expect(screen.getByText(/Records retrieved/)).toHaveTextContent(/Saved lookup/);
    lookupResponse = { ...empty, enriched: { ...empty.enriched, fieldVerifyFlags: [{ field: "address", reason: "Confirm the entered address." }] } };
    fireEvent.click(screen.getByRole("button", { name: "Refresh property records" }));
    await screen.findByRole("button", { name: "Check address" });
    expect(screen.queryByRole("button", { name: /^Verify home/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check address" }));
    expect(screen.getByPlaceholderText("Start typing an address...")).toHaveFocus();
  });
});
