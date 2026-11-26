// @vitest-environment jsdom
// WDO report hold (GATE_WDO_REPORT_HOLD, owner 2026-11-24): "Invoice now, report after payment"
// sits beside "Send report + invoice" only while the server offers it, sends the hold flag on
// the preview and the send, and a held project shows its banner (with the failure reason when
// the paid release did not send).
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

const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data, blob: async () => new Blob(["pdf"]) });
const typesRegistry = { wdo_inspection: { label: "WDO inspection", findingsFields: [] } };
const baseProject = {
  id: "project-1",
  project_type: "wdo_inspection",
  customer_id: "customer-1",
  customer_name: "Synthetic customer",
  title: "Synthetic WDO",
  status: "draft",
  findings: { property_address: "1 Synthetic Way", wdo_finding: "No visible evidence", inspection_scope: "Interior and exterior" },
  recommendations: "",
  project_date: "2026-11-05",
  wdo_signature: { signed: true, content_stale: false },
};

function stubProject(project) {
  vi.stubGlobal("fetch", vi.fn(async (url, opts = {}) => {
    const path = String(url).replace(/^\/api/, "");
    if (path === "/admin/projects/project-1") return response({ project, photos: [], closeoutPreview: { canClose: true, billing: { required: false }, followup: { required: false } } });
    if (path.endsWith("/activity")) return response({ activity: [] });
    if (path.endsWith("/send-with-invoice")) {
      const body = JSON.parse(opts.body);
      return body.dry_run
        ? response({ dry_run: true, invoice: { id: "inv-1", invoice_number: "WPC-1", total: 175, created: false, billing_fingerprint: "0123456789abcdef" }, email_routing: { recipient: "synthetic@example.invalid" }, report_hold_release: { recipient: "synthetic@example.invalid", copies: ["closing@example.invalid"] } })
        : response({ sent: true, report_held: !!body.hold_report_until_paid, invoice: { invoice_number: "WPC-1" }, channels: { email: { ok: true } } });
    }
    throw new Error("Unexpected synthetic project request: " + path);
  }));
  render(
    <MemoryRouter>
      <ProjectDetail projectId="project-1" typesRegistry={typesRegistry} onClose={() => {}} canAdminActions />
    </MemoryRouter>,
  );
}
const invoiceCalls = () => fetch.mock.calls
  .filter(([url, opts]) => String(url).endsWith("/send-with-invoice") && opts?.method === "POST")
  .map(([, opts]) => JSON.parse(opts.body));

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

describe("WDO report hold on the project page", () => {
  it("a held report on a closed project still offers Send report now, and no other send button", async () => {
    stubProject({ ...baseProject, status: "closed", report_hold_status: "held" });
    expect(await screen.findByRole("button", { name: "Send report now" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send report + invoice" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send report" })).not.toBeInTheDocument();
  });

  it("a closed project that is not held offers no send button", async () => {
    stubProject({ ...baseProject, status: "closed", report_hold_status: null });
    await screen.findByRole("button", { name: "Save changes" });
    expect(screen.queryByRole("button", { name: "Send report now" })).not.toBeInTheDocument();
  });

  it("offers no hold button unless the server offers the hold", async () => {
    stubProject(baseProject);
    await screen.findByRole("button", { name: "Send report + invoice" });
    expect(screen.queryByRole("button", { name: "Invoice now, report after payment" })).not.toBeInTheDocument();
  });

  it("sends the hold flag on the preview and the send, and says the report is held", async () => {
    stubProject({ ...baseProject, report_payment_hold_available: true });
    fireEvent.click(await screen.findByRole("button", { name: "Invoice now, report after payment" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirmation" });
    expect(dialog).toHaveTextContent("hold the WDO report until it is paid");
    expect(dialog).toHaveTextContent("report waits until it does");
    // the addresses payment will email, from the dry run (the release's own recipient rule)
    expect(dialog).toHaveTextContent("After payment the report goes to: synthetic@example.invalid, closing@example.invalid");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(invoiceCalls()).toHaveLength(2));
    const [preview, send] = invoiceCalls();
    expect(preview).toEqual(expect.objectContaining({ dry_run: true, hold_report_until_paid: true }));
    // the send hands back the fingerprint of the amount the operator confirmed
    expect(send).toEqual(expect.objectContaining({ invoice_id: "inv-1", hold_report_until_paid: true, expected_billing_fingerprint: "0123456789abcdef" }));
    expect(await screen.findByText(/The report is held and goes out by itself once the invoice is paid/)).toBeInTheDocument();
  });

  it("the normal Send report + invoice sends no hold flag", async () => {
    stubProject({ ...baseProject, report_payment_hold_available: true });
    fireEvent.click(await screen.findByRole("button", { name: "Send report + invoice" }));
    await screen.findByRole("dialog", { name: "Confirmation" });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(invoiceCalls()).toHaveLength(2));
    expect(invoiceCalls().every((body) => !("hold_report_until_paid" in body))).toBe(true);
  });

  it("a held project shows the banner", async () => {
    stubProject({ ...baseProject, report_hold_status: "held" });
    expect(await screen.findByText(/Report held until the invoice is paid/)).toBeInTheDocument();
  });

  it("a held project whose paid release failed shows the reason", async () => {
    stubProject({ ...baseProject, report_hold_status: "held", report_hold_invoice_status: "paid", report_hold_last_error: "Licensee signature required, re-sign to release the paid report" });
    expect(await screen.findByText(/The invoice is paid, but the report did not send: Licensee signature required/)).toBeInTheDocument();
  });

  it.each(["processing", "partial", "sent", null])("says the invoice is paid only for a paid invoice (status %s is not)", async (invoiceStatus) => {
    stubProject({ ...baseProject, report_hold_status: "held", report_hold_invoice_status: invoiceStatus, report_hold_last_error: "No email on file" });
    expect(await screen.findByText(/The report did not send: No email on file/)).toBeInTheDocument();
    expect(screen.queryByText(/The invoice is paid/)).not.toBeInTheDocument();
  });

  it("a released or never-held project shows no banner", async () => {
    stubProject({ ...baseProject, report_hold_status: "released" });
    await screen.findByRole("button", { name: "Send report + invoice" });
    expect(screen.queryByText(/Report held until the invoice is paid/)).not.toBeInTheDocument();
  });
});
