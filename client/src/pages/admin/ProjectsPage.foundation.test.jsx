// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useIsMobile", () => ({ default: () => false }));
vi.mock("../../components/tech/CreateProjectModal", () => ({ default: ({ onClose }) => <div role="dialog" aria-label="Create report"><button onClick={onClose}>Cancel creation</button></div> }));
vi.mock("../../components/tech/WdoIntelligenceBar", () => ({ default: () => <div>WDO intelligence fixture</div> }));
vi.mock("../../components/tech/WdoSignaturePad", () => ({ default: () => <div>WDO signature fixture</div> }));
vi.mock("../../components/tech/ProjectFindingFieldInput", () => ({
  default: ({ field, id, value, onChange }) => <input id={id} aria-label={field.label} value={value} onChange={(event) => onChange(event.target.value)} />,
  hasCatalogBackedProjectFields: () => false,
  normalizeApplicationRows: (value) => Array.isArray(value) ? value : [],
}));
vi.mock("../ProjectReportViewPage", () => ({ parseSections: () => null, TERMITE_COMPLIANCE_SECTIONS: {} }));

import ProjectsPage from "./ProjectsPage";

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 15000 });

const project = {
  id: "project-1",
  project_type: "pest_inspection",
  customer_id: "customer-1",
  customer_name: "Synthetic customer",
  title: "Synthetic inspection",
  project_date: "2026-09-10",
  created_at: "2026-09-10T12:00:00.000Z",
  tech_name: "Fixture technician",
  status: "draft",
  photo_count: 0,
  findings: { scope: "Kitchen inspection complete" },
  recommendations: "Monitor the kitchen and schedule follow-up treatment.",
  delivery_channels: null,
};

const types = {
  pest_inspection: { label: "Pest inspection", findingsFields: [{ key: "scope", label: "Inspection scope", type: "text", required: true }] },
  wdo_inspection: { label: "WDO inspection", appointmentManaged: true, linkedCreationOnly: true, findingsFields: [] },
};

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function fixtureFor(url, options = {}) {
  const path = String(url).replace(/^\/api/, "");
  const body = options.body ? JSON.parse(options.body) : null;
  if (path.startsWith("/admin/projects?") && path.includes("project_type=wdo_inspection")) return { projects: [] };
  if (path.startsWith("/admin/projects?")) return { projects: [project] };
  if (path === "/admin/projects/types") return { types };
  if (path === "/admin/projects/project-1/activity") return { activity: [{ id: "event-1", action: "project_created", description: "Synthetic report created.", actor_name: "Fixture technician", created_at: "2026-09-10T12:00:00.000Z" }] };
  if (path === "/admin/projects/project-1" && (!options.method || options.method === "GET")) return { project, photos: [], upcomingAppointment: null, closeoutPreview: { canClose: true, billing: { required: false }, followup: { required: false }, portal: { attached: false }, serviceCompletion: { linked: false } } };
  if (path === "/admin/projects/project-1" && options.method === "PUT") return { success: true, received: body };
  if (path === "/admin/projects/project-1/send" && body?.dry_run) return { email_routing: { recipient: "customer@example.invalid", report_copies: [] } };
  if (path === "/admin/projects/project-1/send") return { sent: true, report_url: "/report/project/synthetic", channels: { email: { ok: true }, sms: { ok: true } } };
  if (path === "/admin/projects/project-1/send-prep-guide") return { template_key: "pest-inspection-prep" };
  if (path === "/admin/projects/project-1/send-portal-invite") return { success: true };
  if (path === "/admin/projects/project-1/close") return { serviceCompleted: false, portalAttached: false };
  throw new Error(`Unexpected synthetic request: ${options.method || "GET"} ${path}`);
}

function mount(entry = "/admin/projects?projectId=project-1", role = "admin") {
  localStorage.getItem.mockImplementation((key) => key === "waves_admin_token" ? "synthetic-token" : key === "waves_admin_user" ? JSON.stringify({ role }) : null);
  return render(<MemoryRouter initialEntries={[entry]}><ProjectsPage /></MemoryRouter>);
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("localStorage", { getItem: vi.fn() });
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => response(fixtureFor(url, options))));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Reports Tier 2 token pass", () => {
  it("renders the preserved deep-linked workspace with readable directory tokens and a status dot", async () => {
    mount();
    expect(await screen.findByRole("heading", { name: "Reports", level: 1 })).toBeInTheDocument();
    expect(await screen.findByText("Customer report preview")).toBeInTheDocument();
    expect(screen.getByText("Synthetic report created.")).toBeInTheDocument();
    expect(screen.getByText("Pre-send review")).toBeInTheDocument();
    const projectRow = screen.getByRole("button", { name: /Synthetic customer/ });
    const status = within(projectRow).getByText("Draft");
    expect(status).toHaveClass("text-14", "uppercase", "tracking-label");
    expect(status.querySelector(".project-status-dot")).toBeInTheDocument();
    expect(within(projectRow).getByText("Synthetic inspection")).toHaveClass("text-14");
  });

  it("preserves filter queries and the create-report action", async () => {
    mount("/admin/projects");
    await screen.findByText("Synthetic customer");
    fireEvent.change(screen.getAllByRole("combobox")[1], { target: { value: "pest_inspection" } });
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === "/api/admin/projects?limit=500&project_type=pest_inspection")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: /New reports/i }));
    expect(screen.getByRole("dialog", { name: "Create report" })).toBeInTheDocument();
  });

  it("preserves project edit and two-step report-send payloads", async () => {
    mount();
    const title = await screen.findByLabelText("Report title");
    fireEvent.change(title, { target: { value: "Updated synthetic inspection" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      const call = fetch.mock.calls.find(([url, options]) => url === "/api/admin/projects/project-1" && options?.method === "PUT");
      expect(JSON.parse(call[1].body)).toEqual({ title: "Updated synthetic inspection", project_date: "2026-09-10", findings: { scope: "Kitchen inspection complete" }, recommendations: "Monitor the kitchen and schedule follow-up treatment." });
    });

    const sendReport = screen.getByRole("button", { name: "Send report" });
    await waitFor(() => expect(sendReport).not.toBeDisabled());
    fireEvent.click(sendReport);
    expect(await screen.findByRole("dialog", { name: "Confirmation" })).toHaveTextContent("Email to: customer@example.invalid");
    fireEvent.click(screen.getByRole("button", { name: "Send", exact: true }));
    await screen.findByText(/Report delivered/);
    const sendCalls = fetch.mock.calls.filter(([url, options]) => url === "/api/admin/projects/project-1/send" && options?.method === "POST");
    expect(sendCalls.map(([, options]) => JSON.parse(options.body))).toEqual([{ dry_run: true }, {}]);
  });

  it("keeps admin-only delivery and close actions hidden from technicians", async () => {
    mount("/admin/projects?projectId=project-1", "technician");
    await screen.findByText("Customer report preview");
    expect(screen.queryByRole("button", { name: "Send report" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close project" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Portal invite" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });
});
