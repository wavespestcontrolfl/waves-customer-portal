// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PropertyLookupResult from "./PropertyLookupResult";

afterEach(cleanup);

// Unassessed vacant parcel (new construction the county roll hasn't posted):
// no record for THIS home, but the server supplies the plat's assessed-
// neighbor median beside an EMPTY homeSqFt. Real case: a Lakewood Ranch new-build lot,
// Lakewood Ranch (2026-09-21) — 174 assessed neighbors, median 3,071 sq ft.
const VACANT_PROFILE = {
  homeSqFt: 0,
  lotSqFt: 9541,
  stories: 1,
  storiesSource: "default",
  propertyType: "Single Family",
  unassessedVacantParcel: true,
  subdivisionMedian: { medianSqft: 3071, sampleCount: 174, minSqft: 2101, maxSqft: 3242 },
  fieldEvidence: {
    lotSize: { value: 9541, sourceType: "county", sourceLabel: "county record", winningSource: "https://www.manateepao.gov/parcel/?parid=999990002" },
    propertyType: { value: "Single Family", sourceType: "listing", sourceLabel: "listing" },
  },
  propertyDataQuality: { missingCriticalFields: ["squareFootage"] },
  fieldVerifyFlags: [{ field: "vacantParcel", priority: "HIGH", reason: "County roll shows Vacant Residential Platted" }],
};

function renderPanel({ profile = VACANT_PROFILE, form = {}, verification = {} } = {}) {
  const onVerify = vi.fn();
  render(
    <PropertyLookupResult
      profile={profile}
      form={{ address: "1010 Example Loop, Lakewood Ranch, FL 34211", isCommercial: "NO", homeSqFt: "3071", lotSqFt: "9541", stories: "1", ...form }}
      meta={{ matchedAddress: "1010 EXAMPLE LOOP, LAKEWOOD RANCH, FL" }}
      refreshing={false}
      onRefresh={vi.fn()}
      onEditAddress={vi.fn()}
      onVerify={onVerify}
      verification={verification}
    />,
  );
  return { onVerify };
}

describe("PropertyLookupResult — plat-median estimate for an unassessed parcel", () => {
  it("shows the neighbor median as an estimate, not a sourced record", () => {
    renderPanel();
    expect(screen.getByText("3,071 sq ft")).toBeInTheDocument();
    expect(screen.getByText("Estimated from neighbors")).toBeInTheDocument();
    expect(screen.getByText(/Median of 174 assessed homes in this plat \(2,101–3,242 sq ft\)/)).toBeInTheDocument();
    expect(screen.getByText(/not a record for this address/)).toBeInTheDocument();
    expect(screen.queryByText("Not found")).not.toBeInTheDocument();
    // The lot row is untouched.
    expect(screen.getByText("9,541 sq ft")).toBeInTheDocument();
    expect(screen.getByText("county record")).toBeInTheDocument();
  });

  it("offers no one-click verify for the untouched median, but does once the operator types a size", () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: /Verify home living area/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Verify lot area: 9,541 sq ft/ })).toBeInTheDocument();
    cleanup();
    renderPanel({ form: { homeSqFt: "3000", _homeSqFtEdited: true } });
    expect(screen.getByRole("button", { name: /Verify home living area: 3,000 sq ft/ })).toBeInTheDocument();
  });

  it("names a lot-series sample when the server banded the neighbors by lot size", () => {
    renderPanel({ profile: { ...VACANT_PROFILE, subdivisionMedian: { medianSqft: 3070, sampleCount: 118, minSqft: 2373, maxSqft: 3125, lotBanded: true } }, form: { homeSqFt: "3070" } });
    expect(screen.getByText(/Median of 118 assessed homes on similar-size lots in this plat \(2,373–3,125 sq ft\)/)).toBeInTheDocument();
  });

  it("falls back to Not found when the server sends no median", () => {
    renderPanel({ profile: { ...VACANT_PROFILE, subdivisionMedian: null }, form: { homeSqFt: "" } });
    expect(screen.getByText("Not found")).toBeInTheDocument();
    expect(screen.getAllByText("No matching source returned").length).toBeGreaterThan(0);
  });

  it("a real record value hides the estimate entirely", () => {
    renderPanel({
      profile: {
        ...VACANT_PROFILE,
        homeSqFt: 2980,
        unassessedVacantParcel: undefined,
        subdivisionMedian: null,
        propertyDataQuality: { missingCriticalFields: [] },
        fieldEvidence: { ...VACANT_PROFILE.fieldEvidence, squareFootage: { value: 2980, sourceType: "county", sourceLabel: "county record" } },
      },
      form: { homeSqFt: "2980" },
    });
    expect(screen.getByText("2,980 sq ft")).toBeInTheDocument();
    expect(screen.queryByText("Estimated from neighbors")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Verify home living area: 2,980 sq ft/ })).toBeInTheDocument();
  });
});

// The home's own Manatee building permit: a stronger estimate than the plat
// median, exposed by the server beside an EMPTY homeSqFt.
const PERMIT_FACTS = {
  conditionedSqft: 2314, underRoofSqft: 3102, stories: 2, bedrooms: 4, bathrooms: 2.5,
  permitNo: "BLD2503-01234", issuedAt: "2025-03-14T00:00:00.000Z", coIssuedAt: null,
  sourceLabel: "Manatee building permit BLD2503-01234, issued Mar 2025",
};
const PERMIT_PROFILE = { ...VACANT_PROFILE, stories: 2, storiesSource: "permit", permitBuildingFacts: PERMIT_FACTS };

describe("PropertyLookupResult — building-permit estimate for an unassessed parcel", () => {
  it("shows the permit's conditioned area with its source line, and wins over the median", () => {
    renderPanel({ profile: PERMIT_PROFILE, form: { homeSqFt: "2314", stories: "2" } });
    expect(screen.getByText("2,314 sq ft")).toBeInTheDocument();
    expect(screen.getAllByText("From building permit").length).toBe(2);
    expect(screen.getByText(
      "Manatee building permit BLD2503-01234, issued Mar 2025: 2,314 sq ft conditioned, 3,102 under roof, 2 stories — not on the county roll yet; confirm with the customer",
    )).toBeInTheDocument();
    expect(screen.queryByText("Estimated from neighbors")).not.toBeInTheDocument();
    expect(screen.queryByText(/Median of 174/)).not.toBeInTheDocument();
    expect(screen.queryByText("3,071 sq ft")).not.toBeInTheDocument();
    expect(screen.queryByText("Not found")).not.toBeInTheDocument();
  });

  it("shows the permit story count with its own source line, even while the record lists stories as missing", () => {
    // The record itself has no story count (the server's quality list still
    // names it); the profile's count is the permit's explicit fallback.
    const profile = { ...PERMIT_PROFILE, propertyDataQuality: { missingCriticalFields: ["squareFootage", "stories"] } };
    renderPanel({ profile, form: { homeSqFt: "2314", stories: "2" } });
    expect(screen.getAllByText("From building permit").length).toBe(2);
    expect(screen.queryByText("Not found")).not.toBeInTheDocument();
    expect(screen.getByText("Manatee building permit BLD2503-01234, issued Mar 2025 — confirm with the customer")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("omits the under-roof and stories parts when the permit lacks them", () => {
    renderPanel({
      profile: { ...VACANT_PROFILE, permitBuildingFacts: { ...PERMIT_FACTS, underRoofSqft: null, stories: null } },
      form: { homeSqFt: "2314" },
    });
    expect(screen.getByText(
      "Manatee building permit BLD2503-01234, issued Mar 2025: 2,314 sq ft conditioned — not on the county roll yet; confirm with the customer",
    )).toBeInTheDocument();
    // Stories row is still the defaulted one: no permit label there.
    expect(screen.getAllByText("From building permit").length).toBe(1);
  });

  it("offers no one-click verify for the untouched permit prefill, but does once the operator types a size", () => {
    renderPanel({ profile: PERMIT_PROFILE, form: { homeSqFt: "2314", stories: "2" } });
    expect(screen.queryByRole("button", { name: /Verify home living area/ })).not.toBeInTheDocument();
    cleanup();
    renderPanel({ profile: PERMIT_PROFILE, form: { homeSqFt: "2400", stories: "2", _homeSqFtEdited: true } });
    expect(screen.getByRole("button", { name: /Verify home living area: 2,400 sq ft/ })).toBeInTheDocument();
  });

  it("falls back to the median rendering when permit facts are null or absent", () => {
    for (const permitBuildingFacts of [null, undefined]) {
      renderPanel({ profile: { ...VACANT_PROFILE, permitBuildingFacts } });
      expect(screen.getByText("3,071 sq ft")).toBeInTheDocument();
      expect(screen.getByText("Estimated from neighbors")).toBeInTheDocument();
      expect(screen.getByText(/Median of 174 assessed homes in this plat \(2,101–3,242 sq ft\)/)).toBeInTheDocument();
      expect(screen.queryByText("From building permit")).not.toBeInTheDocument();
      cleanup();
    }
  });

  it("an unconfirmed address hides the permit estimate", () => {
    renderPanel({
      profile: { ...PERMIT_PROFILE, fieldVerifyFlags: [{ field: "address", priority: "HIGH", reason: "house number mismatch" }] },
      form: { homeSqFt: "" },
    });
    expect(screen.queryByText("2,314 sq ft")).not.toBeInTheDocument();
    expect(screen.getByText("Not found")).toBeInTheDocument();
  });
});
