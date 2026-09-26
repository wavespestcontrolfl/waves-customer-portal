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

vi.mock("../../components/dispatch/DayScorecardPanel", () => ({
  default: () => <div>Scorecard workspace</div>,
}));

const mockAdminFetch = vi.fn();
vi.mock("../../lib/adminFetch", () => ({
  adminFetch: (...args) => mockAdminFetch(...args),
}));

import AdminDispatchPage from "./AdminDispatchPage";

beforeEach(() => {
  // The Automation tab is admin-only (requireAdmin API); default the suite
  // to an admin session so the full tab strip renders.
  localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
  // GATE_ROUTE_SCORECARD off by default — matches this page's behavior
  // before the scorecard existed for every test that doesn't say otherwise.
  mockAdminFetch.mockReset();
  mockAdminFetch.mockResolvedValue({ ok: true, json: async () => ({ enabled: false }) });
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

  it("keeps autonomous dispatch out of Schedule controls", () => {
    renderSchedule("/admin/dispatch?tab=board");
    expect(screen.queryByRole("button", { name: "Auto-Dispatch" })).not.toBeInTheDocument();
    expect(screen.getByText("Dispatch board workspace")).toBeInTheDocument();
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

  it("exposes every Schedule section in the mobile tab strip", () => {
    renderSchedule("/admin/dispatch?tab=schedule");

    for (const label of ["Board", "Schedule", "Protocols"]) {
      expect(screen.getByRole("button", { name: label })).not.toHaveClass("hidden");
    }
    for (const label of ["Matching", "Booking", "Scores", "Insights"]) {
      const button = screen.getByRole("button", { name: label });
      expect(button).not.toHaveClass("hidden");
      fireEvent.click(button);
      expect(button).toHaveAttribute("aria-current", "page");
    }
  });

  it("keeps the Scorecard tab off the strip while GATE_ROUTE_SCORECARD is off", async () => {
    renderSchedule("/admin/dispatch?tab=board");
    await waitFor(() => expect(mockAdminFetch).toHaveBeenCalledWith("/admin/route-scorecard/status"));
    expect(screen.queryByRole("button", { name: "Scorecard" })).not.toBeInTheDocument();
  });

  it("adds the Scorecard tab once the gate's own status endpoint reports it enabled", async () => {
    mockAdminFetch.mockResolvedValue({ ok: true, json: async () => ({ enabled: true }) });
    renderSchedule("/admin/dispatch?tab=board");
    const button = await screen.findByRole("button", { name: "Scorecard" });
    fireEvent.click(button);
    expect(await screen.findByText("Scorecard workspace")).toBeInTheDocument();
  });

  it("never requests the gate status for a technician account", async () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "tech" }));
    renderSchedule("/admin/dispatch?tab=board");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockAdminFetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Scorecard" })).not.toBeInTheDocument();
  });
});
