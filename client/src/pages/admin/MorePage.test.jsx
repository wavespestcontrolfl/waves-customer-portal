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
import { AdminNavigationProvider } from '../../hooks/useAdminNavigation';
import { clearEmailDrafts, loadEmailDrafts, setEmailSending, updateEmailDrafts } from "../../lib/emailDrafts";

// The grouped menu is the only menu; `navigation: false` models the unverified
// session, where the shell gives no navigation context.
function renderMore(role = "admin", navigation = true, name) {
  return render(
    <MemoryRouter initialEntries={["/admin/more"]}>
      <Routes>
        <Route element={<AdminNavigationProvider user={{ id: 'fixture', role }} enabled={navigation}><Outlet context={{ user: { role, name } }} /></AdminNavigationProvider>}>
          <Route path="/admin/more" element={<MorePage />} />
        </Route>
        <Route path="/admin/login" element={<div>Signed out</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => { cleanup(); clearEmailDrafts(); localStorage.clear(); });

describe("MorePage — the mobile Settings tab", () => {
  it('is the one phone menu: every page that is not a bottom tab, with no row named after a tab (owner 2026-10-29)', () => {
    renderMore('admin');
    // An owner has no Today tab, so Today is listed; Schedule and Customers are
    // tabs, so their other pages are plain rows, never a folder named after the tab.
    expect(screen.getByRole('link', { name: 'Today', exact: true })).toHaveAttribute('href', '/admin/today');
    expect(screen.getByRole('link', { name: 'Contracts', exact: true })).toHaveAttribute('href', '/admin/contracts');
    expect(screen.getByRole('link', { name: 'Gate codes', exact: true })).toHaveAttribute('href', '/admin/customers/gate-codes');
    for (const tab of ['Dashboard', 'Schedule', 'Customers', 'Communications']) {
      expect(screen.queryByRole('link', { name: tab, exact: true }), tab).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: tab, exact: true }), tab).not.toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Expand Sales', exact: true }));
    expect(screen.getByRole('link', { name: 'Estimates', exact: true })).toHaveAttribute('href', '/admin/pipeline?tab=estimates');
    fireEvent.click(screen.getByRole('button', { name: 'Operations', exact: true }));
    expect(screen.getByRole('link', { name: 'Assessments', exact: true })).toHaveAttribute('href', '/admin/lawn-assessments?tab=field');
    expect(screen.getByRole('link', { name: 'Health', exact: true })).toHaveAttribute('href', '/admin/tool-health');
    expect(screen.getByRole('link', { name: 'Features', exact: true })).toHaveAttribute('href', '/admin/_design-system/flags');
    expect(screen.getByRole('link', { name: 'Account', exact: true })).toHaveAttribute('href', '/admin/settings?tab=general');
    expect(screen.getByRole('link', { name: 'Agents', exact: true })).toHaveAttribute('href', '/admin/agents');
  });

  it('keeps Contracts and Health owner-only in the grouped technician directory', () => {
    renderMore('technician');
    expect(screen.queryByRole('link', { name: 'Today', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Contracts', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Customers', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Settings', exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Usage', exact: true })).toBeVisible();
  });
  it("shows the signed-in account, since a phone has no side menu", () => {
    renderMore("technician", true, "Fixture Technician");
    expect(screen.getByText("Fixture Technician")).toBeInTheDocument();
    expect(screen.getByText("Technician")).toBeInTheDocument();
  });

  it("is titled Settings and lists the Settings leaves inline instead of a Settings nav row", () => {
    renderMore();
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    // Inline leaves deep-link into SettingsPage tabs…
    expect(screen.getByRole("link", { name: /^Account$/ })).toHaveAttribute("href", "/admin/settings?tab=general");
    expect(screen.getByRole("link", { name: /Blackouts/ })).toHaveAttribute("href", "/admin/settings?tab=blackout-days");
    expect(screen.getAllByRole("link", { name: /^Integrations$/ })).toHaveLength(1);
    expect(screen.queryByRole("link", { name: /^Tap to Pay$/ })).not.toBeInTheDocument();
    // …and there is no single "Settings" row pointing at a second index page.
    expect(screen.queryByRole("link", { name: /^Settings$/ })).not.toBeInTheDocument();
    // Standalone leaves that only the old mobile Settings index linked survive…
    expect(screen.getByRole("link", { name: /Features/ })).toHaveAttribute("href", "/admin/_design-system/flags");
    // …while destinations already in the Workspaces list are not repeated: the
    // Billing row opens Invoices, and its group lists only the other pages.
    fireEvent.click(screen.getByRole("button", { name: "Expand Billing", exact: true }));
    expect(screen.getByRole("link", { name: /^Billing$/ })).toHaveAttribute("href", "/admin/invoices");
    expect(screen.queryByRole("link", { name: /^Invoices$/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link").filter((link) => link.getAttribute("href") === "/admin/invoices")).toHaveLength(1);
    expect(screen.queryByRole("link", { name: /^Payments$/ })).not.toBeInTheDocument();
    // The flat per-section list is gone: only the grouped Workspaces list renders.
    expect(screen.getByRole("heading", { level: 2, name: "Workspaces" })).toBeInTheDocument();
    expect(screen.queryByText("Finance")).not.toBeInTheDocument();
  });

  it("renders the Settings leaves, Customer Portal and Sign Out when there is no navigation context", () => {
    renderMore("admin", false);
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "Workspaces" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Pinned pages" })).not.toBeInTheDocument();
    expect(screen.getByText("Preferences")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Account$/ })).toHaveAttribute("href", "/admin/settings?tab=general");
    expect(screen.getByRole("link", { name: "Customer Portal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign Out" })).toBeInTheDocument();
  });

  it("hides owner-only Settings leaves from a technician", () => {
    renderMore("technician");
    expect(screen.getByRole("link", { name: /^Account$/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Blackouts/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Targets/ })).not.toBeInTheDocument();
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
