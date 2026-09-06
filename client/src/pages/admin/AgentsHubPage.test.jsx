// @vitest-environment jsdom
// Usage-beacon contract for the Agents hub (Codex #2961 r15): an invalid
// ?tab= deep link renders the Overview fallback WITHOUT rewriting the URL,
// so the page must authoritatively report the tab it actually rendered —
// never the raw query value.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./AutoDispatchPage", () => ({ default: () => <div>Auto-Dispatch workspace</div> }));

vi.mock("./AgentOpsPage", () => ({
  default: () => <div>Overview workspace</div>,
}));
vi.mock("./AgentDecisionsPage", () => ({
  default: () => <div>Decisions workspace</div>,
}));
vi.mock("./AgentShadowDraftsPage", () => ({
  default: () => <div>Shadow workspace</div>,
}));
vi.mock("./DataHygienePage", () => ({
  default: () => <div>Hygiene workspace</div>,
}));
vi.mock("./agents/AgentControlCenterTab", () => ({
  default: () => <div>Control center workspace</div>,
}));
vi.mock("./AgentModelsTab", () => ({
  default: () => <div>Models workspace</div>,
}));
vi.mock("../../lib/adminUsage", () => ({
  trackAdminPageView: vi.fn(),
}));
vi.mock("../../utils/admin-fetch", () => ({ adminFetch: vi.fn() }));

import AgentsHubPage from "./AgentsHubPage";
import { trackAdminPageView } from "../../lib/adminUsage";
import { adminFetch } from "../../utils/admin-fetch";
import { useLocation } from "react-router-dom";

const HUB = { features: { queue: false }, areas: [{ key: "sms", label: "SMS & messaging" }, { key: "calls", label: "Calls" }] };

afterEach(() => { cleanup(); localStorage.clear(); });
beforeEach(() => {
  localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
  trackAdminPageView.mockClear();
  adminFetch.mockReset();
  adminFetch.mockImplementation(async (path) => {
    if (path === "/admin/agents/control/hub") return HUB;
    throw new Error(`unexpected fetch ${path}`);
  });
});

function LocationSpy() {
  return <output data-testid="search">{useLocation().search}</output>;
}

function renderHub(entry = "/admin/agents") {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/admin/agents" element={<><AgentsHubPage /><LocationSpy /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("AgentsHubPage area strip", () => {
  it("shows the product-area strip on the Models tab only and writes ?area= without touching ?tab=", async () => {
    renderHub("/admin/agents?tab=models");
    expect(screen.getByText("Models workspace")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "SMS & messaging" }));
    expect(screen.getByTestId("search")).toHaveTextContent("?tab=models&area=sms");
    fireEvent.click(screen.getByRole("button", { name: "All areas" }));
    expect(screen.getByTestId("search")).toHaveTextContent("?tab=models");
    // The beacon reports the tab alone, never the area (the lib dedupes re-asserts).
    expect(trackAdminPageView).toHaveBeenCalledWith(expect.objectContaining({ search: "?tab=models" }));
    expect(trackAdminPageView).not.toHaveBeenCalledWith(expect.objectContaining({ search: expect.stringContaining("area") }));
  });

  it("keeps the strip off the Overview and labels the activity tab Runs", async () => {
    renderHub("/admin/agents?tab=overview");
    expect(await screen.findByRole("button", { name: "Runs" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "SMS & messaging" })).toBeNull();
    expect(screen.getByText("Overview workspace")).toBeInTheDocument();
    expect(screen.queryByText("Control center workspace")).toBeNull();
  });

  it("renders the Control center as Overview, with the area strip, only when the probe reports the ledger phase", async () => {
    adminFetch.mockImplementation(async (path) => {
      if (path === "/admin/agents/control/hub") return { ...HUB, features: { queue: false, ledger: true } };
      throw new Error(`unexpected fetch ${path}`);
    });
    renderHub("/admin/agents?tab=overview");
    expect(await screen.findByText("Control center workspace")).toBeInTheDocument();
    expect(screen.queryByText("Overview workspace")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Calls" }));
    expect(screen.getByTestId("search")).toHaveTextContent("?tab=overview&area=calls");
  });
});

describe("AgentsHubPage usage reporting", () => {
  it("reports the rendered fallback for an invalid ?tab=, never the raw value", () => {
    renderHub("/admin/agents?tab=typo");

    expect(screen.getByText("Overview workspace")).toBeInTheDocument();
    expect(trackAdminPageView).toHaveBeenCalledWith({
      pathname: "/admin/agents",
      search: "?tab=overview",
      authoritative: true,
    });
    expect(trackAdminPageView).not.toHaveBeenCalledWith(
      expect.objectContaining({ search: "?tab=typo" }),
    );
  });

  it("reports a valid deep-linked tab (legacy data-hygiene redirect target)", () => {
    renderHub("/admin/agents?tab=hygiene");

    expect(screen.getByText("Hygiene workspace")).toBeInTheDocument();
    expect(trackAdminPageView).toHaveBeenCalledWith({
      pathname: "/admin/agents",
      search: "?tab=hygiene",
      authoritative: true,
    });
  });

  it("records a header switch once and ignores active re-clicks", () => {
    renderHub();
    expect(trackAdminPageView).toHaveBeenCalledWith(
      expect.objectContaining({ search: "?tab=overview" }),
    );
    trackAdminPageView.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Shadow Drafts" }));
    expect(screen.getByText("Shadow workspace")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Shadow Drafts" }));

    expect(trackAdminPageView).toHaveBeenCalledTimes(1);
    expect(trackAdminPageView).toHaveBeenCalledWith({
      pathname: "/admin/agents",
      search: "?tab=shadow",
      authoritative: true,
    });
  });
});


describe("Dispatch oversight", () => {
  it("opens the canonical Dispatch tab and retains the requested run", () => {
    renderHub("/admin/agents?tab=dispatch&run=run-123");
    expect(screen.getByText("Auto-Dispatch workspace")).toBeInTheDocument();
    expect(screen.getByTestId("search")).toHaveTextContent("run=run-123");
  });
  it("hides Dispatch oversight from technician accounts", () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "tech" }));
    renderHub("/admin/agents?tab=dispatch");
    expect(screen.queryByRole("button", { name: "Dispatch" })).not.toBeInTheDocument();
    expect(screen.queryByText("Auto-Dispatch workspace")).not.toBeInTheDocument();
  });
});
