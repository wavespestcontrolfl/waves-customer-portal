// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetAdminUser = vi.fn(() => ({ role: "admin" }));
vi.mock("../../lib/adminAuth", () => ({
  getAdminUser: (...args) => mockGetAdminUser(...args),
}));

// The Logic area registers its section tabs with the hub header (second
// tab row) the way the real page does, so the wiring is exercised here.
const mockLogicSectionChange = vi.fn();
vi.mock("./PricingLogicPage", () => ({
  default: ({ embedded, onSecondaryNav }) => {
    React.useEffect(() => {
      if (!embedded || !onSecondaryNav) return undefined;
      onSecondaryNav({
        sections: [
          { key: "margins", label: "Margins" },
          { key: "brackets", label: "Brackets" },
        ],
        activeKey: "margins",
        onChange: mockLogicSectionChange,
        ariaLabel: "Pricing section",
      });
      return () => onSecondaryNav(null);
    }, [embedded, onSecondaryNav]);
    return <div>Logic workspace</div>;
  },
}));
vi.mock("./PricingStrategyPage", () => ({
  default: () => <div>Strategy workspace</div>,
}));
vi.mock("./AdminPriceChangePage", () => ({
  default: () => <div>Price notices workspace</div>,
}));
// The Rate review area is dark behind GATE_RATE_REVIEW: the hub asks the
// probe hook and shows the area only on 'on'.
const mockRateReviewGate = vi.fn(() => "off");
vi.mock("./RateReviewPage", () => ({
  default: () => <div>Rate review workspace</div>,
  useRateReviewAvailable: (enabled) => mockRateReviewGate(enabled),
}));

import PricingHubPage from "./PricingHubPage";

afterEach(cleanup);
beforeEach(() => {
  mockGetAdminUser.mockReset();
  mockGetAdminUser.mockReturnValue({ role: "admin" });
  mockRateReviewGate.mockReset();
  mockRateReviewGate.mockReturnValue("off");
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
}

function renderHub(entry = "/admin/pricing-logic") {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/admin/pricing-logic"
          element={(
            <>
              <PricingHubPage />
              <LocationProbe />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("PricingHubPage", () => {
  it("defaults to the existing Logic and Margins workspace", () => {
    renderHub();

    expect(screen.getByText("Logic workspace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Logic" }))
      .toHaveAttribute("aria-current", "page");
  });

  it("deep-links directly to Pricing Strategy", () => {
    renderHub("/admin/pricing-logic?source=bookmark&area=strategy");

    expect(screen.getByText("Strategy workspace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Strategy" }))
      .toHaveAttribute("aria-current", "page");
  });

  it("hides the admin-only Strategy area from technicians", () => {
    mockGetAdminUser.mockReturnValue({ role: "tech" });
    renderHub("/admin/pricing-logic?area=strategy");

    expect(screen.queryByRole("button", { name: "Strategy" })).not.toBeInTheDocument();
    expect(screen.queryByText("Strategy workspace")).not.toBeInTheDocument();
    // A deep link to the hidden area falls back to Logic & Margins.
    expect(screen.getByText("Logic workspace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Logic" }))
      .toHaveAttribute("aria-current", "page");
  });

  it("switches areas without dropping existing query context", () => {
    renderHub("/admin/pricing-logic?source=alert&section=reality");

    fireEvent.click(screen.getByRole("button", { name: "Notices" }));

    expect(screen.getByText("Price notices workspace")).toBeInTheDocument();
    expect(screen.getByTestId("location-search")).toHaveTextContent(
      "?source=alert&section=reality&area=notices",
    );
  });

  it("shows the embedded area's sub-tabs on the hub header and drops them when the area changes", () => {
    renderHub();

    // One header card: hub area tabs + the Logic area's section tabs.
    expect(screen.getByRole("heading", { level: 1, name: "Pricing" })).toBeInTheDocument();
    const sectionNav = screen.getByRole("navigation", { name: "Pricing section" });
    expect(sectionNav).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Margins" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "Brackets" }));
    expect(mockLogicSectionChange).toHaveBeenCalledWith("brackets");

    // Strategy has no sub-tabs — the second row must unmount with Logic.
    fireEvent.click(screen.getByRole("button", { name: "Strategy" }));
    expect(screen.getByText("Strategy workspace")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Pricing section" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Pricing" })).toBeInTheDocument();
  });
});

describe("PricingHubPage — Rate review area (GATE_RATE_REVIEW)", () => {
  it("does not exist while the gate is off: no tab, and the ops-email deep link falls back to Logic", () => {
    renderHub("/admin/pricing-logic?area=rate-review&batch=2027-01");

    expect(mockRateReviewGate).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("button", { name: "Rate review" })).not.toBeInTheDocument();
    expect(screen.queryByText("Rate review workspace")).not.toBeInTheDocument();
    expect(screen.getByText("Logic workspace")).toBeInTheDocument();
  });

  it("appears once the probe says on, and the deep link keeps ?batch=", () => {
    mockRateReviewGate.mockReturnValue("on");
    renderHub("/admin/pricing-logic?area=rate-review&batch=2027-01");

    expect(screen.getByRole("button", { name: "Rate review" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Rate review workspace")).toBeInTheDocument();
    expect(screen.queryByText("Logic workspace")).not.toBeInTheDocument();
    expect(screen.getByTestId("location-search")).toHaveTextContent("?area=rate-review&batch=2027-01");
  });

  it("holds the deep link while the probe is pending instead of flashing Logic", () => {
    mockRateReviewGate.mockReturnValue("pending");
    renderHub("/admin/pricing-logic?area=rate-review");

    expect(screen.getByText("Loading pricing…")).toHaveAttribute("role", "status");
    expect(screen.queryByText("Logic workspace")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rate review" })).not.toBeInTheDocument();
  });

  it("never probes for a technician and never shows the area to one", () => {
    mockGetAdminUser.mockReturnValue({ role: "tech" });
    mockRateReviewGate.mockReturnValue("on");
    renderHub("/admin/pricing-logic?area=rate-review");

    expect(mockRateReviewGate).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("button", { name: "Rate review" })).not.toBeInTheDocument();
    expect(screen.getByText("Logic workspace")).toBeInTheDocument();
  });
});
