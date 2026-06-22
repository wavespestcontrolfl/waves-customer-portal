import { describe, expect, it } from "vitest";
import {
  calculateEstimate,
  isCommercialEstimateInput,
  normalizePropertyType,
  resolveLookupPropertyTypeAutofill,
} from "./estimateEngine";

function baseInput(overrides = {}) {
  return {
    homeSqFt: 2000,
    stories: "1",
    lotSqFt: 10000,
    propertyType: "Single Family",
    hasPool: false,
    hasPoolCage: false,
    hasLargeDriveway: false,
    shrubDensity: "MODERATE",
    treeDensity: "MODERATE",
    landscapeComplexity: "MODERATE",
    nearWater: false,
    isAfterHours: false,
    isRecurringCustomer: false,
    svcLawn: true,
    svcPest: true,
    pestFreq: "4",
    lawnFreq: "9",
    grassType: "st_augustine",
    roachModifier: "NONE",
    ...overrides,
  };
}

describe("client estimate engine commercial safety fallback", () => {
  it("normalizes commercial property types", () => {
    expect(normalizePropertyType("Commercial Property")).toBe("commercial");
    expect(normalizePropertyType("Commercial Office")).toBe("commercial");
    expect(normalizePropertyType("Commercial Retail")).toBe("commercial");
    expect(normalizePropertyType("Office/Retail")).toBe("commercial");
    expect(normalizePropertyType("Warehouse/Office")).toBe("commercial");
    expect(normalizePropertyType("Warehouse")).toBe("commercial");
    expect(normalizePropertyType("Office")).toBe("commercial");
    expect(normalizePropertyType("Restaurant")).toBe("commercial");
    expect(normalizePropertyType("Food Service")).toBe("commercial");
    expect(normalizePropertyType("School")).toBe("commercial");
    expect(normalizePropertyType("Daycare")).toBe("commercial");
    expect(normalizePropertyType("Government Municipal")).toBe("commercial");
    expect(normalizePropertyType("Medical Office")).toBe("commercial");
    expect(normalizePropertyType("Clinic")).toBe("commercial");
    expect(normalizePropertyType("HOA Common Area")).toBe("commercial");
    expect(normalizePropertyType("Residential HOA Common Area")).toBe("commercial");
    expect(normalizePropertyType("Commercial HOA / Business Park Common Area")).toBe("commercial");
    expect(normalizePropertyType("Apartment")).toBe("commercial");
    expect(normalizePropertyType("Multi Family")).toBe("commercial");
    expect(normalizePropertyType("Multi-family")).toBe("commercial");
    expect(normalizePropertyType("Multifamily")).toBe("commercial");
    expect(normalizePropertyType("Multi Story Home")).toBe("single_family");
    expect(normalizePropertyType("single family multi story")).toBe("single_family");
    expect(normalizePropertyType("Multi Story")).not.toBe("commercial");
    expect(normalizePropertyType("Townhome Interior")).toBe("townhome_interior");
    expect(normalizePropertyType("Townhome Interior Unit")).toBe("townhome_interior");
    expect(normalizePropertyType("Duplex Residential")).toBe("duplex");
    expect(normalizePropertyType("Residential Condo")).toBe("condo_ground");
  });

  it("detects commercial form values", () => {
    expect(isCommercialEstimateInput({ propertyType: "Commercial" })).toBe(true);
    expect(isCommercialEstimateInput({ isCommercial: "YES" })).toBe(true);
    expect(isCommercialEstimateInput({ commercialSubtype: "office_retail" })).toBe(true);
    expect(isCommercialEstimateInput({ propertyType: "Apartment" })).toBe(true);
    expect(isCommercialEstimateInput({ propertyType: "Restaurant" })).toBe(true);
    expect(isCommercialEstimateInput({ propertyType: "School" })).toBe(true);
    expect(isCommercialEstimateInput({ propertyType: "HOA Common Area" })).toBe(true);
    expect(isCommercialEstimateInput({ propertyType: "Government Municipal" })).toBe(true);
    expect(isCommercialEstimateInput({ propertyType: "Single Family" })).toBe(false);
    expect(isCommercialEstimateInput({
      propertyType: "Single Family",
      category: "COMMERCIAL",
      isCommercial: "NO",
    })).toBe(false);
    expect(isCommercialEstimateInput({
      propertyType: "Single Family",
      category: "COMMERCIAL",
    })).toBe(false);
    expect(isCommercialEstimateInput({
      propertyType: "Single Family",
      category: "COMMERCIAL",
      commercialSubtype: "office_retail",
    })).toBe(false);
    expect(isCommercialEstimateInput({
      propertyType: "Single Family",
      isCommercial: "NO",
      commercialSubtype: "office_retail",
    })).toBe(false);
    expect(isCommercialEstimateInput({
      isCommercial: "NO",
      commercialSubtype: "office_retail",
    })).toBe(false);
  });

  it("does not let stale commercial lookup categories override concrete residential property types", () => {
    expect(resolveLookupPropertyTypeAutofill("Single Family", "COMMERCIAL")).toEqual({
      propertyType: "Single Family",
      isCommercial: "NO",
      commercialSubtype: "",
    });
    expect(resolveLookupPropertyTypeAutofill("Residential Condo", "COMMERCIAL")).toEqual({
      propertyType: "Condo",
      isCommercial: "NO",
      commercialSubtype: "",
    });
    expect(resolveLookupPropertyTypeAutofill("", "COMMERCIAL")).toEqual({
      propertyType: "Commercial",
      isCommercial: "YES",
    });
    expect(resolveLookupPropertyTypeAutofill("Office", "RESIDENTIAL")).toEqual({
      propertyType: "Commercial",
      isCommercial: "YES",
    });
  });

  it("suppresses residential recurring pest and lawn pricing for commercial fallback estimates", () => {
    const result = calculateEstimate(baseInput({ propertyType: "Commercial" }));

    expect(result.results.pest).toBeUndefined();
    expect(result.results.lawn).toBeUndefined();
    expect(result.recurring.services).toEqual([]);
    expect(result.specItems).toContainEqual(expect.objectContaining({
      service: "commercial_pest",
      quoteRequired: true,
      requiresManualReview: true,
      taxCategory: "nonresidential_pest_control",
    }));
    expect(result.specItems).toContainEqual(expect.objectContaining({
      service: "commercial_lawn",
      quoteRequired: true,
      requiresManualReview: true,
      taxCategory: "lawn_spraying_or_treatment",
    }));
  });

  it("suppresses residential one-time pest and lawn pricing for commercial fallback estimates", () => {
    const result = calculateEstimate(baseInput({
      propertyType: "Commercial",
      svcLawn: false,
      svcPest: false,
      svcOnetimePest: true,
      svcOnetimeLawn: true,
    }));

    expect(result.oneTime.items).toEqual([]);
    expect(result.specItems).toContainEqual(expect.objectContaining({
      service: "commercial_pest",
      quoteRequired: true,
    }));
    expect(result.specItems).toContainEqual(expect.objectContaining({
      service: "commercial_lawn",
      quoteRequired: true,
    }));
  });

  it("suppresses residential specialty pricing for commercial fallback estimates", () => {
    const result = calculateEstimate(baseInput({
      propertyType: "Commercial",
      svcLawn: false,
      svcPest: false,
      svcMosquito: true,
      svcTermiteBait: true,
      svcFlea: true,
      svcTopdress: true,
      svcDethatch: true,
      svcPlugging: true,
      plugArea: 1000,
      svcTs: true,
      svcInjection: true,
      bedArea: 600,
      palmCount: 3,
    }));

    expect(result.recurring.services).toEqual([]);
    expect(result.oneTime.items).toEqual([]);
    expect(result.results.mq).toBeUndefined();
    expect(result.results.tmBait).toBeUndefined();
    expect(result.results.td).toBeUndefined();
    expect(result.results.dth).toBeUndefined();
    expect(result.results.ts).toBeUndefined();
    expect(result.results.injection).toBeUndefined();
    expect(result.specItems).toContainEqual(expect.objectContaining({
      service: "commercial_pest",
      price: null,
      quoteRequired: true,
    }));
    expect(result.specItems).toContainEqual(expect.objectContaining({
      service: "commercial_lawn",
      price: null,
      quoteRequired: true,
    }));
  });
});

describe("client estimate engine pre-slab small-slab minimums", () => {
  function preSlabEstimate(overrides = {}) {
    return calculateEstimate(baseInput({
      svcLawn: false,
      svcPest: false,
      svcPreslab: true,
      preslabSqft: 100,
      preslabProductKey: "bifen_it",
      preslabLabelConfirmed: true,
      preslabWarranty: "BASIC",
      preslabVolume: "NONE",
      ...overrides,
    }));
  }

  it("does not apply the normal full-slab floor to 100 sqft Bifen I/T", () => {
    const standalone = preSlabEstimate({ preslabJobContext: "standalone" }).oneTime.items
      .find((item) => item.name === "Pre-Slab");
    expect(standalone.productOz).toBe(10);
    expect(standalone.productCost).toBe(3.24);
    expect(standalone.contextualFloor).toBe(191);
    expect(standalone.price).toBe(191);
    expect(standalone.price).not.toBe(510);

    const builderBatch = preSlabEstimate({ preslabJobContext: "builderBatch" }).oneTime.items
      .find((item) => item.name === "Pre-Slab");
    expect(builderBatch.contextualFloor).toBe(128);
    expect(builderBatch.price).toBe(148);
    expect(builderBatch.price).not.toBe(510);

    const sameTripAddOn = preSlabEstimate({ preslabJobContext: "sameTripAddOn" }).oneTime.items
      .find((item) => item.name === "Pre-Slab");
    expect(sameTripAddOn.contextualFloor).toBe(106);
    expect(sameTripAddOn.price).toBe(148);
    expect(sameTripAddOn.price).not.toBe(510);
  });
});
