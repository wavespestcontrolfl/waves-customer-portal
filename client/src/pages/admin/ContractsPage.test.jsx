// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useRenderedTabBeacon", () => ({ default: () => {} }));

// Tab pages register their filter tabs + actions with the hub header the
// way the real pages do, so the one-card wiring is exercised end to end.
const mockRefresh = vi.fn();
vi.mock("./DocumentTemplatesPage", () => ({
  default: ({ embedded, onSecondaryNav }) => {
    React.useEffect(() => {
      if (!embedded || !onSecondaryNav) return undefined;
      onSecondaryNav({
        sections: [{ key: "all", label: "All" }, { key: "wdo", label: "WDO" }],
        activeKey: "all",
        onChange: () => {},
        ariaLabel: "Template category",
        actions: [{ label: "Refresh", onClick: mockRefresh }],
      });
      return () => onSecondaryNav(null);
    }, [embedded, onSecondaryNav]);
    return <div>Templates workspace</div>;
  },
}));
vi.mock("./DocumentRequestsPage", () => ({
  default: () => <div>Requests workspace</div>,
}));

import ContractsPage from "./ContractsPage";

afterEach(cleanup);

async function renderHub(entry = "/admin/contracts") {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/admin/contracts" element={<ContractsPage />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText(/workspace/);
}

describe("ContractsPage", () => {
  it("renders one header card with the hub tabs, the active tab's filters, and its actions", async () => {
    await renderHub();

    expect(screen.getByRole("heading", { level: 1, name: "Contracts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Templates" })).toHaveAttribute("aria-current", "page");
    // The lazy tab page registers its filters in an effect after it mounts.
    await screen.findByRole("navigation", { name: "Template category" });
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(mockRefresh).toHaveBeenCalled();
    expect(screen.getByText("Templates workspace")).toBeInTheDocument();
  });

  it("switches tabs and drops the previous tab's filter row", async () => {
    await renderHub();

    fireEvent.click(screen.getByRole("button", { name: "Requests" }));
    await screen.findByText("Requests workspace");
    expect(screen.getByRole("button", { name: "Requests" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("navigation", { name: "Template category" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Contracts" })).toBeInTheDocument();
  });
});
