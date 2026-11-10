// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter, MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useIsMobile", () => ({ default: () => false }));
vi.mock("../../components/tech/CreateProjectModal", () => ({ default: () => null }));
vi.mock("../../components/tech/WdoIntelligenceBar", () => ({ default: () => null }));
vi.mock("../../components/tech/WdoSignaturePad", () => ({ default: () => null }));
vi.mock("../../components/tech/ProjectFindingFieldInput", () => ({
  default: ({ field, id, value, onChange }) => <input id={id} aria-label={field.label} value={value} onChange={(event) => onChange(event.target.value)} />,
  hasCatalogBackedProjectFields: () => false,
  normalizeApplicationRows: (value) => Array.isArray(value) ? value : [],
}));
vi.mock("../ProjectReportViewPage", () => ({ parseSections: () => null, TERMITE_COMPLIANCE_SECTIONS: {} }));

import ProjectsPage from "./ProjectsPage";
import { confirmLeaveIfGuarded } from "../../lib/navigation-guard";

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 15000 });

const PROMPT = "Discard unsaved report edits?";

function report(n) {
  return {
    id: `project-${n}`,
    project_type: "pest_inspection",
    customer_id: `customer-${n}`,
    customer_name: `Synthetic customer ${n}`,
    title: `Synthetic inspection ${n}`,
    project_date: "2026-09-10",
    created_at: "2026-09-10T12:00:00.000Z",
    tech_name: "Fixture technician",
    status: "draft",
    photo_count: 0,
    findings: { scope: "Kitchen inspection complete" },
    recommendations: "Monitor the kitchen.",
    delivery_channels: null,
  };
}
const reports = { "project-1": report(1), "project-2": report(2) };
const types = { pest_inspection: { label: "Pest inspection", findingsFields: [{ key: "scope", label: "Inspection scope", type: "text", required: true }] } };

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function fixtureFor(url, options = {}) {
  const path = String(url).replace(/^\/api/, "");
  if (path.startsWith("/admin/projects?") && path.includes("project_type=wdo_inspection")) return { projects: [] };
  if (path.startsWith("/admin/projects?")) return { projects: Object.values(reports) };
  if (path === "/admin/projects/types") return { types };
  const [, id, rest] = path.match(/^\/admin\/projects\/(project-\d)(\/.*)?$/) || [];
  if (id && rest === "/activity") return { activity: [] };
  if (id && !rest && options.method === "PUT") return { success: true };
  if (id && !rest) return { project: reports[id], photos: [], upcomingAppointment: null, closeoutPreview: { canClose: true, billing: { required: false }, followup: { required: false }, portal: { attached: false }, serviceCompletion: { linked: false } } };
  throw new Error(`Unexpected synthetic request: ${options.method || "GET"} ${path}`);
}

function renderPage(entry = "/admin/projects?projectId=project-1", extra = null) {
  return render(<MemoryRouter initialEntries={[entry]}>{extra}<ProjectsPage /></MemoryRouter>);
}

async function editTitle(value = "Unsaved synthetic title") {
  const title = await screen.findByLabelText("Report title");
  await waitFor(() => expect(title).toHaveValue("Synthetic inspection 1"));
  fireEvent.change(title, { target: { value } });
  return title;
}

const openRow = (n) => fireEvent.click(screen.getByText(`Synthetic customer ${n}`).closest("button"));
const closeButton = () => screen.getByRole("button", { name: "Close" });

function fireBeforeUnload() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("localStorage", { getItem: vi.fn((key) => key === "waves_admin_token" ? "synthetic-token" : key === "waves_admin_user" ? JSON.stringify({ role: "admin" }) : null) });
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => response(fixtureFor(url, options))));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // The Back test moves the real URL.
  window.history.replaceState(null, "", "/");
});

describe("Reports page unsaved edits guard", () => {
  it("asks before the × closes a report with unsaved edits, and keeps them on Cancel", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();
    await editTitle();
    fireEvent.click(closeButton());
    expect(confirm).toHaveBeenCalledWith(PROMPT);
    expect(screen.getByLabelText("Report title")).toHaveValue("Unsaved synthetic title");

    confirm.mockReturnValue(true);
    fireEvent.click(closeButton());
    await waitFor(() => expect(screen.queryByLabelText("Report title")).toBeNull());
  });

  it("asks before another report replaces one with unsaved edits", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();
    await editTitle();
    openRow(2);
    expect(confirm).toHaveBeenCalledWith(PROMPT);
    expect(screen.getByLabelText("Report title")).toHaveValue("Unsaved synthetic title");

    confirm.mockReturnValue(true);
    openRow(2);
    await waitFor(() => expect(screen.getByLabelText("Report title")).toHaveValue("Synthetic inspection 2"));
  });

  it("never asks with nothing unsaved: before any edit, after a save, after a discard", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    await screen.findByLabelText("Report title");
    openRow(2);
    await waitFor(() => expect(screen.getByLabelText("Report title")).toHaveValue("Synthetic inspection 2"));
    openRow(1);
    await editTitle("Saved synthetic title");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(fetch.mock.calls.some(([url, options]) => url === "/api/admin/projects/project-1" && options?.method === "PUT")).toBe(true));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled());
    openRow(2);
    await waitFor(() => expect(screen.getByLabelText("Report title")).toHaveValue("Synthetic inspection 2"));
    expect(confirm).not.toHaveBeenCalled();

    // A discarded report leaves no stale flag behind.
    fireEvent.change(screen.getByLabelText("Report title"), { target: { value: "Edit to discard" } });
    fireEvent.click(closeButton());
    expect(confirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByLabelText("Report title")).toBeNull());
    openRow(1);
    await screen.findByLabelText("Report title");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
  });

  it("asks before a same-tab link leaves the page, and lets it go on Discard", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const linkClicks = vi.fn();
    // Stands in for a sidebar <Link>: its own handler runs only when the
    // capture-phase guard lets the click through.
    renderPage(undefined, <a href="/admin/dashboard" onClick={(e) => { e.preventDefault(); linkClicks(); }}>Leave to Dashboard</a>);
    const leave = () => fireEvent.click(screen.getByRole("link", { name: "Leave to Dashboard" }));
    await screen.findByLabelText("Report title");
    leave();
    expect(confirm).not.toHaveBeenCalled();
    expect(linkClicks).toHaveBeenCalledTimes(1);

    await editTitle();
    leave();
    expect(confirm).toHaveBeenCalledWith(PROMPT);
    expect(linkClicks).toHaveBeenCalledTimes(1);

    confirm.mockReturnValue(true);
    leave();
    expect(linkClicks).toHaveBeenCalledTimes(2);
  });

  // A real BrowserRouter: MemoryRouter never touches window.history or fires
  // 'popstate' (same precedent as AdminInvoicesPage.unsaved-guard.test.jsx).
  it("asks before browser Back closes the report, and keeps it open on Cancel", async () => {
    window.history.replaceState({ idx: 0 }, "", "/admin/projects");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><ProjectsPage /></BrowserRouter>);
    await screen.findByText("Synthetic customer 1");
    openRow(1);
    await waitFor(() => expect(window.location.search).toBe("?projectId=project-1"));
    await editTitle();

    // jsdom dispatches 'popstate' after history.back() in a later task.
    act(() => { window.history.back(); });
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(window.location.search).toBe("?projectId=project-1"));
    expect(screen.getByLabelText("Report title")).toHaveValue("Unsaved synthetic title");

    confirm.mockReturnValue(true);
    act(() => { window.history.back(); });
    await waitFor(() => expect(screen.queryByLabelText("Report title")).toBeNull());
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("makes sign-out and a reload ask only while edits are unsaved", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();
    await screen.findByLabelText("Report title");
    expect(confirmLeaveIfGuarded()).toBe(true);
    expect(fireBeforeUnload().defaultPrevented).toBe(false);

    await editTitle();
    expect(confirmLeaveIfGuarded()).toBe(false);
    expect(confirm).toHaveBeenCalledWith(PROMPT);
    expect(fireBeforeUnload().defaultPrevented).toBe(true);

    fireEvent.change(screen.getByLabelText("Report title"), { target: { value: "Synthetic inspection 1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(confirmLeaveIfGuarded()).toBe(true));
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
  });
});
