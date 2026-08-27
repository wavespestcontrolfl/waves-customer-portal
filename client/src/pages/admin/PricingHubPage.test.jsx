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

import PricingHubPage from "./PricingHubPage";

afterEach(cleanup);
beforeEach(() => {
  mockGetAdminUser.mockReset();
  mockGetAdminUser.mockReturnValue({ role: "admin" });
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
    expect(screen.getByRole("button", { name: "Logic & Margins" }))
      .toHaveAttribute("aria-current", "page");
  });

  it("deep-links directly to Pricing Strategy", () => {
    renderHub("/admin/pricing-logic?source=bookmark&area=strategy");

    expect(screen.getByText("Strategy workspace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Strategy & Offers" }))
      .toHaveAttribute("aria-current", "page");
  });

  it("hides the admin-only Strategy area from technicians", () => {
    mockGetAdminUser.mockReturnValue({ role: "tech" });
    renderHub("/admin/pricing-logic?area=strategy");

    expect(screen.queryByRole("button", { name: "Strategy & Offers" })).not.toBeInTheDocument();
    expect(screen.queryByText("Strategy workspace")).not.toBeInTheDocument();
    // A deep link to the hidden area falls back to Logic & Margins.
    expect(screen.getByText("Logic workspace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Logic & Margins" }))
      .toHaveAttribute("aria-current", "page");
  });

  it("switches areas without dropping existing query context", () => {
    renderHub("/admin/pricing-logic?source=alert&section=reality");

    fireEvent.click(screen.getByRole("button", { name: "Price Notices" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Strategy & Offers" }));
    expect(screen.getByText("Strategy workspace")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Pricing section" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Pricing" })).toBeInTheDocument();
  });
});
