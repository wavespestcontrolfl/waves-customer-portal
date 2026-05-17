// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PricingRealityCheckPage, {
  buildPricingRealityQuery,
  sortSegmentsWorstMarginFirst,
} from "./PricingRealityCheckPage";
import { adminFetch } from "../../lib/adminFetch";

vi.mock("../../lib/adminFetch", () => ({
  adminFetch: vi.fn(),
}));

function apiResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(payload),
  };
}

function payload(overrides = {}) {
  return {
    lookbackDays: 90,
    laborRateDollarsPerHour: 35,
    generatedAt: "2026-05-16T12:00:00.000Z",
    coverage: {
      completedServiceCount: 12,
      includedServiceCount: 10,
      excludedMissingQuoteCount: 1,
      excludedMissingActualCount: 1,
      excludedInvalidDurationCount: 0,
    },
    summary: {
      serviceCount: 10,
      avgQuotedMinutes: 42.1,
      avgActualMinutes: 46.8,
      avgVarianceMinutes: 4.7,
      weightedPercentVariance: 11.2,
      totalDollarMarginImpact: -301.54,
      avgDollarMarginImpact: -30.15,
      outlierCount: 1,
    },
    segments: [
      {
        key: "helped",
        label: "Helped margin",
        serviceCount: 4,
        avgQuotedMinutes: 30,
        avgActualMinutes: 20,
        avgVarianceMinutes: -10,
        weightedPercentVariance: -33.3,
        totalDollarMarginImpact: 23.33,
        avgDollarMarginImpact: 5.83,
        outlierCount: 0,
      },
      {
        key: "hurt",
        label: "Hurt margin",
        serviceCount: 6,
        avgQuotedMinutes: 40,
        avgActualMinutes: 60,
        avgVarianceMinutes: 20,
        weightedPercentVariance: 50,
        totalDollarMarginImpact: -70,
        avgDollarMarginImpact: -11.67,
        outlierCount: 1,
      },
    ],
    outliers: [
      {
        serviceId: "svc-outlier",
        completedAt: "2026-05-15T16:00:00.000Z",
        serviceType: "Mowing",
        lawnCareTrack: "Standard",
        sqftBand: "8,000-8,499",
        zone: "Zone A",
        technician: "Jane Doe",
        quotedMinutes: 42,
        actualMinutes: 91,
        varianceMinutes: 49,
        percentVariance: 116.7,
        dollarMarginImpact: -28.58,
        zScore: 2.7,
        customerId: "cust-1",
        customerName: "Ada Lovelace",
        billingCohort: "Annual Prepay",
      },
    ],
    availableFilters: {
      serviceTypes: ["Mowing"],
      lawnCareTracks: ["Standard"],
      sqftBands: ["Unknown", "8,000-8,499"],
      zones: [{ id: "Zone A", label: "Zone A" }],
      technicians: [{ id: "tech-1", label: "Jane Doe" }],
      months: ["2026-05"],
      billingCohorts: ["Annual Prepay"],
    },
    ...overrides,
  };
}

function renderPage(data = payload()) {
  adminFetch.mockResolvedValue(apiResponse(data));
  return render(<PricingRealityCheckPage />);
}

beforeEach(() => {
  adminFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("pricing reality check helpers", () => {
  it("builds API query params", () => {
    expect(buildPricingRealityQuery({
      lookbackDays: 30,
      groupBy: "sqft_band",
      filters: { serviceType: "Mowing", zoneId: "", technicianId: "tech-1" },
    })).toBe("lookbackDays=30&groupBy=sqft_band&serviceType=Mowing&technicianId=tech-1");
  });

  it("sorts segment rows by worst margin impact first", () => {
    const rows = sortSegmentsWorstMarginFirst([
      { label: "Positive", totalDollarMarginImpact: 10 },
      { label: "Negative", totalDollarMarginImpact: -50 },
    ]);

    expect(rows.map((row) => row.label)).toEqual(["Negative", "Positive"]);
  });
});

describe("PricingRealityCheckPage", () => {
  it("renders the admin page and read-only badge", async () => {
    renderPage();

    expect(screen.getByText("Audit")).toBeInTheDocument();
    expect(screen.getByText("Read-only. No pricing engine writes.")).toBeInTheDocument();
    expect(await screen.findByText("Included services")).toBeInTheDocument();
  });

  it("changes the API query when lookback changes", async () => {
    renderPage();
    await screen.findByText("Included services");

    fireEvent.change(screen.getByLabelText("Lookback"), { target: { value: "30" } });

    await waitFor(() => {
      const lastCall = adminFetch.mock.calls.at(-1)[0];
      expect(lastCall).toContain("lookbackDays=30");
    });
  });

  it("changes groupBy when segment selector changes", async () => {
    renderPage();
    await screen.findByText("Included services");

    fireEvent.click(screen.getByRole("button", { name: "Sqft band" }));

    await waitFor(() => {
      const lastCall = adminFetch.mock.calls.at(-1)[0];
      expect(lastCall).toContain("groupBy=sqft_band");
    });
  });

  it("displays KPI values from the API response", async () => {
    renderPage();

    expect(await screen.findByText("42.1 min")).toBeInTheDocument();
    expect(screen.getByText("46.8 min")).toBeInTheDocument();
    expect(screen.getByText("11.2%")).toBeInTheDocument();
    expect(screen.getByText("-$301.54")).toBeInTheDocument();
  });

  it("renders outlier service rows", async () => {
    renderPage();

    expect(await screen.findByText("svc-outlier")).toBeInTheDocument();
    expect(screen.getAllByText("Jane Doe").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Annual Prepay").length).toBeGreaterThan(0);
  });

  it("renders outlier service dates in Eastern time", async () => {
    renderPage(payload({
      outliers: [{
        ...payload().outliers[0],
        completedAt: "2026-06-01T03:30:00.000Z",
      }],
    }));

    expect(await screen.findByText("2026-05-31")).toBeInTheDocument();
    expect(screen.queryByText("2026-06-01")).not.toBeInTheDocument();
  });

  it("renders the empty state", async () => {
    renderPage(payload({
      coverage: {
        completedServiceCount: 0,
        includedServiceCount: 0,
        excludedMissingQuoteCount: 0,
        excludedMissingActualCount: 0,
        excludedInvalidDurationCount: 0,
      },
      summary: {
        serviceCount: 0,
        avgQuotedMinutes: 0,
        avgActualMinutes: 0,
        avgVarianceMinutes: 0,
        weightedPercentVariance: 0,
        totalDollarMarginImpact: 0,
        avgDollarMarginImpact: 0,
        outlierCount: 0,
      },
      segments: [],
      outliers: [],
    }));

    expect(await screen.findByText(
      "No completed services with both quoted and actual minutes were found for this window.",
    )).toBeInTheDocument();
  });
});
