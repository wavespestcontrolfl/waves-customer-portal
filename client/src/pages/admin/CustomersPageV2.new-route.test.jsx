// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useIsMobile", () => ({ default: () => true }));
vi.mock("../../components/AddressAutocomplete", () => ({
  default: (props) => <input {...props} />,
}));
vi.mock("../../components/admin/Customer360ProfileV2", () => ({
  default: ({ onClose }) => (
    <div role="dialog" aria-label="Customer profile">
      <button type="button" onClick={onClose}>Close profile</button>
    </div>
  ),
}));

import CustomersPageV2 from "./CustomersPageV2";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

describe("CustomersPageV2 new-customer route", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ customers: [], total: 0, totalPages: 1 }),
    })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens the mobile form with call details and closes back to Customers", async () => {
    render(
      <MemoryRouter initialEntries={[
        "/admin/customers/new?phone=%2B19415550123&city=Lakewood+Ranch&state=FL",
      ]}>
        <Routes>
          <Route path="/admin/customers/new" element={<CustomersPageV2 />} />
          <Route path="/admin/customers" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "New customer" })).toBeVisible();
    expect(screen.getByPlaceholderText("Phone number")).toHaveValue("9415550123");
    expect(screen.getByPlaceholderText("City")).toHaveValue("Lakewood Ranch");
    expect(screen.getByPlaceholderText("State")).toHaveValue("FL");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/admin/customers");
  });

  it("keeps customer profile selection and close state in the URL", async () => {
    fetch.mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        customers: [{
          id: "cust-1",
          firstName: "Ada",
          lastName: "Lovelace",
          address: {},
        }],
        total: 1,
        totalPages: 1,
      }),
    }));

    render(
      <MemoryRouter initialEntries={["/admin/customers"]}>
        <Routes>
          <Route
            path="/admin/customers"
            element={(
              <>
                <CustomersPageV2 />
                <LocationProbe />
              </>
            )}
          />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", {
      name: "Open Ada Lovelace customer profile",
    }));
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/admin/customers?customerId=cust-1",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Close profile" }));
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/admin/customers");
    });
  });
});
