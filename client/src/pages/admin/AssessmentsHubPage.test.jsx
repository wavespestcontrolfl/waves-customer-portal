// @vitest-environment jsdom
// Usage-beacon contract for the Assessments hub (Codex #2961 r14): an
// invalid ?tab= deep link renders the Lead Magnets fallback WITHOUT
// rewriting the URL, so the page must authoritatively report the tab it
// actually rendered — never the raw query value.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Lead Magnets tab hands its "Add Assessment" button up to the hub
// header (same spot as Schedule's Add Appointment), so exercise that wiring.
const mockAddAssessment = vi.fn();
vi.mock("./PhotoAssessmentsPage", () => ({
  default: ({ embedded, onSecondaryNav }) => {
    React.useEffect(() => {
      if (!embedded || !onSecondaryNav) return undefined;
      onSecondaryNav({
        actions: [{ key: "new-assessment", label: "Add Assessment", onClick: mockAddAssessment }],
      });
      return () => onSecondaryNav(null);
    }, [embedded, onSecondaryNav]);
    return <div>Lead magnets workspace</div>;
  },
}));
vi.mock("./LawnAssessmentPanel", () => ({
  default: () => <div>Field workspace</div>,
}));
vi.mock("../../lib/adminUsage", () => ({
  trackAdminPageView: vi.fn(),
}));

import AssessmentsHubPage from "./AssessmentsHubPage";
import { trackAdminPageView } from "../../lib/adminUsage";

afterEach(cleanup);
beforeEach(() => {
  trackAdminPageView.mockClear();
});

function renderHub(entry = "/admin/lawn-assessments") {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/admin/lawn-assessments" element={<AssessmentsHubPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("AssessmentsHubPage usage reporting", () => {
  it("reports the rendered fallback for an invalid ?tab=, never the raw value", () => {
    renderHub("/admin/lawn-assessments?tab=typo");

    expect(screen.getByText("Lead magnets workspace")).toBeInTheDocument();
    expect(trackAdminPageView).toHaveBeenCalledWith({
      pathname: "/admin/lawn-assessments",
      search: "?tab=funnel",
      authoritative: true,
    });
    expect(trackAdminPageView).not.toHaveBeenCalledWith(
      expect.objectContaining({ search: "?tab=typo" }),
    );
  });

  it("reports a valid deep-linked tab as rendered", async () => {
    renderHub("/admin/lawn-assessments?tab=field");

    expect(await screen.findByText("Field workspace")).toBeInTheDocument();
    expect(trackAdminPageView).toHaveBeenCalledWith({
      pathname: "/admin/lawn-assessments",
      search: "?tab=field",
      authoritative: true,
    });
  });

  it("records a header switch once and ignores active re-clicks", async () => {
    renderHub();
    expect(trackAdminPageView).toHaveBeenCalledWith(
      expect.objectContaining({ search: "?tab=funnel" }),
    );
    trackAdminPageView.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Field Assessment" }));
    expect(await screen.findByText("Field workspace")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Field Assessment" }));

    expect(trackAdminPageView).toHaveBeenCalledTimes(1);
    expect(trackAdminPageView).toHaveBeenCalledWith({
      pathname: "/admin/lawn-assessments",
      search: "?tab=field",
      authoritative: true,
    });
  });

  it("puts Add Assessment on the hub header for Lead Magnets and drops it on Field", async () => {
    renderHub();

    const add = screen.getByRole("button", { name: "Add Assessment" });
    // Lives in the header card next to the title, not in the tab content.
    expect(add.closest(".rounded-md.border-hairline")).toContainElement(
      screen.getByRole("heading", { level: 1, name: "Assessments" }),
    );
    fireEvent.click(add);
    expect(mockAddAssessment).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Field/ }));
    expect(await screen.findByText("Field workspace")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Assessment" })).not.toBeInTheDocument();
  });
});
