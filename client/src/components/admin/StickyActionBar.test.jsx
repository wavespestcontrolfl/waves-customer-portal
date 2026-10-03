// @vitest-environment jsdom
// The call bridge is owner-only (technician allow-list, 2026-10-02): the
// customer action bar drops its Call action for a technician login.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { CustomerActionBar } from "./StickyActionBar";

afterEach(cleanup);

const customer = { id: "fixture-1", firstName: "Avery", lastName: "Sample", phone: "+15555550102" };

function renderBar(role) {
  render(
    <MemoryRouter initialEntries={["/admin"]}>
      <Routes>
        <Route path="/admin" element={<Outlet context={{ user: { role } }} />}>
          <Route index element={<CustomerActionBar customer={customer} />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("CustomerActionBar call action", () => {
  it("is offered to an admin", () => {
    renderBar("admin");
    expect(screen.getByRole("button", { name: /Call/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Text/ })).toBeInTheDocument();
  });

  it("is not offered to a technician, who keeps Text and Book", () => {
    renderBar("technician");
    expect(screen.queryByRole("button", { name: /Call/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Text/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Book/ })).toBeInTheDocument();
  });
});
