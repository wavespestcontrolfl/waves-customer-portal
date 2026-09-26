// @vitest-environment jsdom
/**
 * Commercial suite type-default refresh (codex P2, PR #4840, thread at
 * EstimateToolViewV2.jsx:502): the type-default resolver runs once, at
 * lookup time, off whatever commercialRiskType the form had THEN (usually
 * none — the county subtype guess, e.g. office_retail's 1,500 sq ft office
 * default, wins). The server recomputes an untouched default off the
 * CURRENT commercialRiskType/commercialSubtype at generate time
 * (translateV2CallToV1Input — see the server-side commercial-suite-size
 * tests for that recompute itself). This file pins the CLIENT half: once
 * the server's response carries a different priced size, the Home Sq Ft
 * box and the suite-size evidence note must refresh to match it — the
 * priced value must never disagree with what the operator sees — while a
 * manually edited/confirmed box, or a real (license-sourced) measurement,
 * is never touched.
 */
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EstimateToolViewV2 from "./EstimateToolViewV2";

vi.mock("../../components/admin/EstimateSendDialog", () => ({ useEstimateSend: () => vi.fn() }));

const ADDRESS = "4400 Test Commons Pkwy E #102, Bradenton, FL 34203";

function suiteEnriched(overrides = {}) {
  return {
    homeSqFt: 1500,
    lotSqFt: 0,
    stories: 1,
    storiesSource: "county",
    propertyType: "Commercial",
    category: "Commercial",
    commercialSubtype: "office_retail",
    suiteSize: { value: 1500, source: "suite_type_default", confidence: "low", businessName: null },
    suiteBuildingTotalSqFt: 46031,
    fieldEvidence: {},
    propertyDataQuality: { score: 100, missingCriticalFields: [] },
    ...overrides,
  };
}

// A minimal calculate-estimate reply shaped like mapV1ToLegacyShape's
// output — `property.homeSqFt` is what the server (translateV2CallToV1Input)
// actually priced off, the one field this lane keeps the box in sync with.
function suiteCalcResult(homeSqFt) {
  return {
    recurring: {
      tier: null,
      grandTotal: 95,
      annualAfterDiscount: 1140,
      services: [{
        service: "commercial_pest",
        name: "Commercial Pest Control",
        mo: 95,
        annual: 1140,
        footprintUsed: homeSqFt,
        commercialPricingMode: "auto_estimate",
        pricingConfidence: "LOW",
      }],
    },
    oneTime: { total: 0, items: [] },
    results: {},
    totals: { year2mo: 95, year1: 1140 },
    property: { homeSqFt, lotSqFt: 0, stories: 1, footprint: homeSqFt, propertyType: "commercial" },
  };
}

function jsonResponse(body) {
  return {
    ok: true, status: 200, json: async () => body,
    clone() { return this; }, text: async () => JSON.stringify(body),
  };
}

let fetchMock;
let lookupEnriched;
let calcHomeSqFt;
beforeEach(() => {
  localStorage.setItem("waves_admin_token", "qa-token");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(window, "alert").mockImplementation(() => {});
  lookupEnriched = suiteEnriched();
  calcHomeSqFt = 1800; // the "server recomputed a Restaurant default" case
  fetchMock = vi.fn((url) => {
    const path = String(url);
    if (path.endsWith("/estimator/property-lookup")) {
      return Promise.resolve(jsonResponse({ enriched: structuredClone(lookupEnriched), errors: [] }));
    }
    if (path.endsWith("/calculate-estimate")) {
      return Promise.resolve(jsonResponse(suiteCalcResult(calcHomeSqFt)));
    }
    if (path.includes("/discounts")) return Promise.resolve(jsonResponse([]));
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function lookUpSuite() {
  render(<MemoryRouter><EstimateToolViewV2 initialAddress={ADDRESS} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Property Lookup", exact: true }));
  await screen.findByRole("region", { name: "Property lookup results" });
}

function pickRiskType(value) {
  fireEvent.change(screen.getByLabelText("Business type (cadence)"), { target: { value } });
}

async function generate() {
  fireEvent.click(screen.getByRole("checkbox", { name: "Pest Control", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Generate Estimate", exact: true }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/calculate-estimate"))).toBe(true));
}

describe("suite type-default box/note refresh at generate time", () => {
  it("operator picks Restaurant after an office-default suite lookup: the Home Sq Ft box refreshes to the server's recomputed 1,800", async () => {
    await lookUpSuite();
    expect(screen.getByLabelText("Home Sq Ft")).toHaveValue(1500);
    expect(screen.getByText(/Suite size 1,500 sq ft/)).toBeInTheDocument();

    pickRiskType("restaurant_food");
    calcHomeSqFt = 1800; // what the server actually priced for this pick
    await generate();

    await waitFor(() => expect(screen.getByLabelText("Home Sq Ft")).toHaveValue(1800));
    expect(screen.getByText(/Suite size 1,800 sq ft/)).toBeInTheDocument();
  });

  it("a manually edited Home Sq Ft box is never overwritten by the server's recompute", async () => {
    await lookUpSuite();
    fireEvent.change(screen.getByLabelText("Home Sq Ft"), { target: { value: "2200" } });
    pickRiskType("restaurant_food");
    calcHomeSqFt = 1800; // the server still prices off the type default the box no longer holds is irrelevant here — this operator typed a value
    await generate();

    // The box stays exactly what the operator typed.
    expect(screen.getByLabelText("Home Sq Ft")).toHaveValue(2200);
  });

  it("a license-sourced (real measurement) suite size is never touched by this sync", async () => {
    lookupEnriched = suiteEnriched({
      homeSqFt: 1400,
      suiteSize: { value: 1400, source: "license_seats", confidence: "medium", businessName: "Test Taco Shop", seats: 25 },
    });
    await lookUpSuite();
    expect(screen.getByLabelText("Home Sq Ft")).toHaveValue(1400);

    pickRiskType("healthcare_childcare");
    // Even if a bug elsewhere made the server return a different number, a
    // license_seats source must never resync the box off it.
    calcHomeSqFt = 2500;
    await generate();

    expect(screen.getByLabelText("Home Sq Ft")).toHaveValue(1400);
  });
});
