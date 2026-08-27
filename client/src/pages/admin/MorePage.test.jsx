// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useIsMobile", () => ({ default: () => true }));
vi.mock("../../hooks/useFeatureFlag", () => ({
  useFeatureFlag: () => false,
  refetchFlags: vi.fn(),
}));

import MorePage from "./MorePage";

function renderMore(role = "admin") {
  return render(
    <MemoryRouter initialEntries={["/admin/more"]}>
      <Routes>
        <Route element={<Outlet context={{ user: { role } }} />}>
          <Route path="/admin/more" element={<MorePage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("MorePage — the mobile Settings tab", () => {
  it("is titled Settings and lists the Settings leaves inline instead of a Settings nav row", () => {
    renderMore();
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    // Inline leaves deep-link into SettingsPage tabs…
    expect(screen.getByRole("link", { name: /Team/ })).toHaveAttribute("href", "/admin/settings?tab=team");
    expect(screen.getByRole("link", { name: /Blackout Days/ })).toHaveAttribute("href", "/admin/settings?tab=blackout-days");
    // …and there is no single "Settings" row pointing at a second index page.
    expect(screen.queryByRole("link", { name: /^Settings$/ })).not.toBeInTheDocument();
    // Ordinary destinations are still there.
    expect(screen.getByRole("link", { name: /Invoices/ })).toHaveAttribute("href", "/admin/invoices");
  });

  it("hides owner-only Settings leaves from a technician", () => {
    renderMore("tech");
    expect(screen.getByRole("link", { name: /Team/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Blackout Days/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /KPI Targets/ })).not.toBeInTheDocument();
  });
});
