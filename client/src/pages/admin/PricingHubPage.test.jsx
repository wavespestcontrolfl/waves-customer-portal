// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./PricingLogicPage", () => ({
  default: () => <div>Logic workspace</div>,
}));
vi.mock("./PricingStrategyPage", () => ({
  default: () => <div>Strategy workspace</div>,
}));
vi.mock("./AdminPriceChangePage", () => ({
  default: () => <div>Price notices workspace</div>,
}));

import PricingHubPage from "./PricingHubPage";

afterEach(cleanup);

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

  it("switches areas without dropping existing query context", () => {
    renderHub("/admin/pricing-logic?source=alert&section=reality");

    fireEvent.click(screen.getByRole("button", { name: "Price Notices" }));

    expect(screen.getByText("Price notices workspace")).toBeInTheDocument();
    expect(screen.getByTestId("location-search")).toHaveTextContent(
      "?source=alert&section=reality&area=notices",
    );
  });
});
