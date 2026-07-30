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
vi.mock("../../lib/adminUsage", () => ({
  trackAdminPageView: vi.fn(),
}));

import AgentsHubPage from "./AgentsHubPage";
import { trackAdminPageView } from "../../lib/adminUsage";

afterEach(cleanup);
beforeEach(() => {
  trackAdminPageView.mockClear();
});

function renderHub(entry = "/admin/agents") {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/admin/agents" element={<AgentsHubPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

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
