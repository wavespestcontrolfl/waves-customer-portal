// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useIsMobile", () => ({ default: () => true }));
vi.mock("../../hooks/useFeatureFlag", () => ({
  useFeatureFlag: () => false,
  refetchFlags: vi.fn(),
}));

import MorePage from "./MorePage";
import { clearEmailDrafts, loadEmailDrafts, setEmailSending, updateEmailDrafts } from "../../lib/emailDrafts";

function renderMore(role = "admin") {
  return render(
    <MemoryRouter initialEntries={["/admin/more"]}>
      <Routes>
        <Route element={<Outlet context={{ user: { role } }} />}>
          <Route path="/admin/more" element={<MorePage />} />
        </Route>
        <Route path="/admin/login" element={<div>Signed out</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => { cleanup(); clearEmailDrafts(); localStorage.clear(); });

describe("MorePage — the mobile Settings tab", () => {
  it("is titled Settings and lists the Settings leaves inline instead of a Settings nav row", () => {
    renderMore();
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    // Inline leaves deep-link into SettingsPage tabs…
    expect(screen.getByRole("link", { name: /^Account$/ })).toHaveAttribute("href", "/admin/settings?tab=general");
    expect(screen.getByRole("link", { name: /Blackout Days/ })).toHaveAttribute("href", "/admin/settings?tab=blackout-days");
    expect(screen.getAllByRole("link", { name: /^Integrations$/ })).toHaveLength(1);
    expect(screen.queryByRole("link", { name: /^Tap to Pay$/ })).not.toBeInTheDocument();
    // …and there is no single "Settings" row pointing at a second index page.
    expect(screen.queryByRole("link", { name: /^Settings$/ })).not.toBeInTheDocument();
    // Standalone leaves that only the old mobile Settings index linked survive…
    expect(screen.getByRole("link", { name: /Early feature access/ })).toHaveAttribute("href", "/admin/_design-system/flags");
    // …while destinations already in the nav sections are not repeated.
    expect(screen.getAllByRole("link", { name: /^Invoices$/ })).toHaveLength(1);
    expect(screen.getByRole("link", { name: /^Invoices$/ })).toHaveAttribute("href", "/admin/invoices");
    expect(screen.queryByRole("link", { name: /^Payments$/ })).not.toBeInTheDocument();
  });

  it("hides owner-only Settings leaves from a technician", () => {
    renderMore("tech");
    expect(screen.getByRole("link", { name: /^Account$/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Blackout Days/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /KPI Targets/ })).not.toBeInTheDocument();
  });

  it("clears Email recovery and pending callbacks when signing out on mobile", () => {
    localStorage.setItem("waves_admin_token", "fixture-token");
    const session = loadEmailDrafts("fixture-owner");
    updateEmailDrafts(session, (drafts) => ({ ...drafts, replies: { fixture: "Unsent mobile reply" } }));
    setEmailSending(session, "reply", true);
    renderMore();
    fireEvent.click(screen.getByRole("button", { name: "Sign Out" }));
    expect(screen.getByText("Signed out")).toBeInTheDocument();
    expect(localStorage.getItem("waves_admin_token")).toBeNull();
    expect(loadEmailDrafts("fixture-owner").drafts.replies).toEqual({});
    expect(updateEmailDrafts(session, (drafts) => drafts)).toBeNull();
    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(false);
  });
});
