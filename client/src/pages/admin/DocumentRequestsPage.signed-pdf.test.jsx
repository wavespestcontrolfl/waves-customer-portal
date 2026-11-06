// @vitest-environment jsdom
// "Signed PDF" is the staff download of any executed document-template
// agreement (GET /admin/contracts/:id/pdf), countersigned or not.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DocumentRequestsPage from "./DocumentRequestsPage";

const { adminFetch } = vi.hoisted(() => ({ adminFetch: vi.fn() }));
vi.mock("../../lib/adminFetch", () => ({ adminFetch }));

const response = (data, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => data });
const request = (id, title, overrides = {}) => ({
  id,
  title,
  status: "signed",
  requestStatus: "signed",
  contractType: "document_template",
  documentTemplateKey: "service_agreement.general",
  signedAt: "2026-09-24T14:00:00.000Z",
  countersignedAt: null,
  customerId: `customer-${id}`,
  customer: { name: `Customer ${id}` },
  deliverySummary: {},
  ...overrides,
});

beforeEach(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  adminFetch.mockReset();
  const rows = [
    request("plain", "Plain signed agreement"),
    request("counter", "Countersigned agreement", { countersignedAt: "2026-09-25T14:00:00.000Z" }),
    request("cancelledAfter", "Cancelled after signing", { status: "cancelled", requestStatus: "cancelled" }),
    request("draft", "Draft agreement", { status: "draft", requestStatus: "draft", signedAt: null }),
    request("sent", "Sent agreement", { status: "sent", requestStatus: "sent", signedAt: null }),
    request("viewed", "Viewed agreement", { status: "viewed", requestStatus: "viewed", signedAt: null }),
    request("other", "Signed other type", { contractType: "service_agreement" }),
  ];
  adminFetch.mockImplementation((path) => {
    if (path === "/admin/contracts/requests/stats") return Promise.resolve(response({ stats: {} }));
    if (path.startsWith("/admin/contracts/requests?")) return Promise.resolve(response({ requests: rows }));
    if (path === "/admin/contracts/plain/pdf") {
      return Promise.resolve({ ok: true, status: 200, blob: async () => new Blob(["%PDF"], { type: "application/pdf" }) });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
});

afterEach(cleanup);

const rowFor = (title) => screen.getByText(title).closest("tr");
const pdfButton = (title) => within(rowFor(title)).queryByRole("button", { name: /signed pdf/i });

it("shows Signed PDF on every executed document-template agreement, and only there", async () => {
  render(<MemoryRouter><DocumentRequestsPage /></MemoryRouter>);
  await screen.findByText("Plain signed agreement");
  expect(pdfButton("Plain signed agreement")).toBeInTheDocument();
  expect(pdfButton("Countersigned agreement")).toBeInTheDocument();
  expect(pdfButton("Cancelled after signing")).toBeInTheDocument();
  expect(pdfButton("Draft agreement")).toBeNull();
  expect(pdfButton("Sent agreement")).toBeNull();
  expect(pdfButton("Viewed agreement")).toBeNull();
  expect(pdfButton("Signed other type")).toBeNull();
});

it("clicking Signed PDF requests /admin/contracts/<id>/pdf", async () => {
  const tab = { location: { href: "" }, close: vi.fn() };
  const openSpy = vi.spyOn(window, "open").mockReturnValue(tab);
  URL.createObjectURL = vi.fn(() => "blob:plain-pdf");
  URL.revokeObjectURL = vi.fn();
  try {
    render(<MemoryRouter><DocumentRequestsPage /></MemoryRouter>);
    await screen.findByText("Plain signed agreement");
    fireEvent.click(pdfButton("Plain signed agreement"));
    await waitFor(() => expect(tab.location.href).toBe("blob:plain-pdf"));
    expect(adminFetch).toHaveBeenCalledWith("/admin/contracts/plain/pdf");
  } finally {
    openSpy.mockRestore();
  }
});
