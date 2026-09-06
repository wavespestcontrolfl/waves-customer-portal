// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../components/admin/AdminCommandHeader", () => ({
  default: ({ sections, activeKey, onSectionChange, ariaLabel, actions = [] }) => (
    <nav aria-label={ariaLabel}>
      {actions.map(({ label, onClick }) => <button key={label} onClick={onClick}>{label}</button>)}
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

beforeEach(() => {
  // The Automation tab is admin-only (requireAdmin API); default the suite
  // to an admin session so the full tab strip renders.
  localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-search">{location.pathname}{location.search}{location.hash}</output>;
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
        <Route path="/admin/agents" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("AdminDispatchPage", () => {
  it("redirects legacy Automation links to Agent Ops with run, query, and hash intact", async () => {
    renderSchedule("/admin/dispatch?source=bookmark&tab=automation&run=run-123#audit");
    await waitFor(() => expect(screen.getByTestId("location-search")).toHaveTextContent(
      "/admin/agents?source=bookmark&tab=dispatch&run=run-123#audit",
    ));
  });

  it("links to Agent Ops from Schedule without embedding a duplicate workspace", async () => {
    renderSchedule("/admin/dispatch?tab=board");
    fireEvent.click(screen.getByRole("button", { name: "Auto-Dispatch" }));
    await waitFor(() => expect(screen.getByTestId("location-search")).toHaveTextContent(
      "/admin/agents?tab=dispatch",
    ));
    expect(screen.queryByText("Embedded automation workspace")).not.toBeInTheDocument();
  });

  it("hides the admin-only Automation tab from technician accounts", () => {
    // Every /api/admin/auto-dispatch endpoint is requireAdmin — techs must
    // not be offered a workspace whose every request 403s.
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "tech" }));
    renderSchedule("/admin/dispatch?tab=automation");

    expect(
      screen.queryByRole("button", { name: "Auto-Dispatch" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Embedded automation workspace"),
    ).not.toBeInTheDocument();
    // The unrecognized deep-link falls back to the Board tab.
    expect(screen.getByText("Dispatch board workspace")).toBeInTheDocument();
  });

  it("keeps the phone workspace focused on mobile-capable sections", () => {
    renderSchedule("/admin/dispatch?tab=schedule");

    for (const label of ["Board", "Schedule", "Protocols"]) {
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
