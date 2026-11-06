// @vitest-environment jsdom
// An open photo-caption draft is not saved yet, and the emailed report and its
// FDACS PDF render from SAVED captions. Send and PDF actions wait for the save.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectDetail } from "./ProjectsPage";

vi.mock("../../hooks/useRenderedTabBeacon", () => ({ default: () => {} }));
vi.mock("../../hooks/useIsMobile", () => ({ default: () => false }));
vi.mock("../../components/tech/WdoIntelligenceBar", () => ({ default: () => null }));
vi.mock("../../components/tech/WdoSignaturePad", () => ({ default: () => null }));
vi.mock("../../components/tech/ProjectFindingFieldInput", () => ({
  default: () => null,
  hasCatalogBackedProjectFields: () => false,
  normalizeApplicationRows: (v) => (Array.isArray(v) ? v : []),
}));
vi.mock("../ProjectReportViewPage", () => ({ parseSections: () => null, TERMITE_COMPLIANCE_SECTIONS: {} }));
vi.mock("../../components/admin/customer360/CustomerSmsPanel", () => ({
  useCustomerSms: () => () => {},
  CustomerSmsProvider: ({ children }) => children,
  openEstimateMessages: () => {},
}));

const MESSAGE = /Save or cancel the photo caption you are editing first/;
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data, blob: async () => new Blob(["pdf"]) });
const typesRegistry = {
  pest_inspection: { label: "Pest inspection", findingsFields: [{ key: "scope", label: "Inspection scope", required: true }] },
  wdo_inspection: { label: "WDO inspection", findingsFields: [] },
};
const baseProject = {
  id: "project-1",
  project_type: "pest_inspection",
  customer_id: "customer-1",
  customer_name: "Synthetic customer",
  title: "Synthetic report",
  status: "draft",
  findings: { scope: "Kitchen inspection complete" },
  recommendations: "Monitor the kitchen and schedule follow-up treatment.",
  project_date: "2026-11-05",
};

function stubProject(project) {
  const photos = [{ id: "photo-1", caption: "Old caption", category: "exterior" }];
  vi.stubGlobal("fetch", vi.fn(async (url, opts = {}) => {
    const path = String(url).replace(/^\/api/, "");
    if (path === "/admin/projects/project-1") return response({ project, photos, closeoutPreview: { canClose: true, billing: { required: false }, followup: { required: false } } });
    if (path.endsWith("/activity")) return response({ activity: [] });
    if (path.endsWith("/photos/photo-1/url")) return response({ url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" });
    if (path.endsWith("/photos/photo-1") && opts.method === "PUT") return response({ success: true });
    if (path.endsWith("/fdacs-pdf")) return response({});
    if (path.endsWith("/send")) {
      const body = JSON.parse(opts.body);
      return response(body.dry_run ? { email_routing: { recipient: "synthetic@example.invalid", report_copies: [] } } : { sent: true, channels: { email: { ok: true } } });
    }
    throw new Error("Unexpected synthetic project request: " + path);
  }));
  render(
    <MemoryRouter>
      <ProjectDetail projectId="project-1" typesRegistry={typesRegistry} onClose={() => {}} canAdminActions />
    </MemoryRouter>,
  );
}
const sendCalls = () => fetch.mock.calls.filter(([url, opts]) => String(url).endsWith("/send") && opts?.method === "POST");
const pdfCalls = () => fetch.mock.calls.filter(([url]) => String(url).endsWith("/fdacs-pdf"));

async function editCaptionDraft() {
  fireEvent.click(await screen.findByRole("button", { name: "Edit caption" }));
  fireEvent.change(screen.getByPlaceholderText("Photo caption"), { target: { value: "New unsaved caption" } });
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  localStorage.setItem("waves_admin_token", "synthetic-token");
  localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("unsaved photo caption blocks report actions", () => {
  it("blocks Send report until the caption is saved, then sends", async () => {
    stubProject(baseProject);
    await editCaptionDraft();
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    expect(await screen.findByText(MESSAGE)).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Confirmation" })).not.toBeInTheDocument();
    expect(sendCalls()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Save caption" }));
    await waitFor(() => expect(fetch.mock.calls.some(([url, opts]) => String(url).endsWith("/photos/photo-1") && opts?.method === "PUT")).toBe(true));
    await waitFor(() => expect(screen.queryByPlaceholderText("Photo caption")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    await waitFor(() => expect(sendCalls().some(([, opts]) => JSON.parse(opts.body).dry_run)).toBe(true));
    expect(screen.queryByText(MESSAGE)).not.toBeInTheDocument();
  });

  it("blocks Send report + invoice while a caption draft is open", async () => {
    stubProject({ ...baseProject, service_record_id: "service-1" });
    await editCaptionDraft();
    fireEvent.click(screen.getByRole("button", { name: "Send report + invoice" }));
    expect(await screen.findByText(MESSAGE)).toBeInTheDocument();
    expect(sendCalls()).toHaveLength(0);
    expect(screen.queryByRole("dialog", { name: "Confirmation" })).not.toBeInTheDocument();
  });

  it("blocks View filled form (PDF) before any tab opens or PDF is fetched", async () => {
    stubProject({ ...baseProject, project_type: "wdo_inspection" });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await editCaptionDraft();
    fireEvent.click(screen.getByRole("button", { name: "View filled form" }));
    expect(await screen.findByText(MESSAGE)).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    expect(pdfCalls()).toHaveLength(0);
  });
});
