// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../components/admin/AdminCommandHeader", () => ({
  default: ({ sections, activeKey, onSectionChange, ariaLabel }) => (
    <nav aria-label={ariaLabel}>
      {sections.map(({ key, label, className }) => (
        <button
          key={key}
          type="button"
          className={className}
          aria-current={activeKey === key ? "page" : undefined}
          onClick={() => onSectionChange(key)}
        >
          {label}
        </button>
      ))}
    </nav>
  ),
}));

vi.mock("./DispatchBoardPage", () => ({
  default: () => <div>Dispatch board workspace</div>,
}));

vi.mock("./DispatchPageV2", () => ({
  default: ({ activeTab }) => <div>Dispatch workspace: {activeTab}</div>,
}));

vi.mock("./AutoDispatchPage", () => ({
  default: ({ embedded }) => (
    <div>{embedded ? "Embedded automation workspace" : "Automation page"}</div>
  ),
}));

import AdminDispatchPage from "./AdminDispatchPage";

afterEach(cleanup);

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
}

function renderSchedule(entry = "/admin/dispatch") {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/admin/dispatch"
          element={(
            <>
              <AdminDispatchPage />
              <LocationProbe />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("AdminDispatchPage", () => {
  it("deep-links to the embedded Auto-Dispatch workspace", () => {
    renderSchedule("/admin/dispatch?source=bookmark&tab=automation");

    expect(screen.getByText("Embedded automation workspace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Automation" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("switches to Automation without dropping query context", async () => {
    renderSchedule("/admin/dispatch?source=alert&tab=board");

    fireEvent.click(screen.getByRole("button", { name: "Automation" }));

    expect(screen.getByText("Embedded automation workspace")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("location-search")).toHaveTextContent(
        "?source=alert&tab=automation",
      );
    });
  });

  it("keeps the phone workspace focused on mobile-capable sections", () => {
    renderSchedule("/admin/dispatch?tab=schedule");

    for (const label of ["Board", "Schedule", "Protocols", "Automation"]) {
      expect(screen.getByRole("button", { name: label })).not.toHaveClass("hidden");
    }
    for (const label of ["Tech Match", "CSR Booking", "Job Scores", "Insights"]) {
      expect(screen.getByRole("button", { name: label })).toHaveClass(
        "hidden",
        "md:inline-flex",
      );
    }
  });
});
