// @vitest-environment jsdom
/**
 * The tool keeps only named fields of the lookup's meta for the panel. The
 * campus parcel (server meta.campusParcel) must be one of them, or the panel
 * never shows the parcel or its buildings. Synthetic fixtures only.
 */
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EstimateToolViewV2 from "./EstimateToolViewV2";

const ADDRESS = "950 Example Park Blvd, Suite 101, Bradenton, FL 34201";

function jsonResponse(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    clone() { return this; },
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

beforeEach(() => {
  localStorage.setItem("waves_admin_token", "test-token");
  vi.stubGlobal("fetch", vi.fn((url) => {
    if (String(url).includes("/estimator/property-lookup")) {
      return jsonResponse({
        enriched: {},
        errors: [],
        meta: {
          campusParcel: {
            parcelId: "1000000000",
            county: "Manatee",
            situsAddress: "900 EXAMPLE PARK BLVD",
            landUseDescription: "Office Buildings-Multi Story (1555)",
            buildings: { total: 3, groups: [{ classification: "OFFICE BUILDING", stories: 1, sqft: 9504, count: 3 }], moreGroups: 0 },
          },
        },
      });
    }
    return jsonResponse({});
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("campus parcel reaches the lookup panel", () => {
  it("shows the parcel's buildings from the server's meta", async () => {
    render(<MemoryRouter><EstimateToolViewV2 /></MemoryRouter>);
    fireEvent.change(screen.getByPlaceholderText("Start typing an address..."), { target: { value: ADDRESS } });
    fireEvent.click(screen.getByRole("button", { name: "Property Lookup" }));
    await waitFor(() => expect(screen.getByText(/Buildings on the county parcel at 900 EXAMPLE PARK BLVD/)).toBeInTheDocument());
    expect(screen.getByText(/3 × Office Building · 9,504 sq ft · 1 story/)).toBeInTheDocument();
  });
});
