// @vitest-environment jsdom
// Certified-operator countersignature on the termite annual protection
// agreement (owner ruling 2026-09-25, A-14): a RECORD step after the
// customer signs, offered only on signed annual agreements not yet
// countersigned, and the operator types their own name.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DocumentRequestsPage from "./DocumentRequestsPage";

const { adminFetch } = vi.hoisted(() => ({ adminFetch: vi.fn() }));
vi.mock("../../lib/adminFetch", () => ({ adminFetch }));

const ANNUAL_KEY = "service_agreement.termite_annual_protection";
const response = (data, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => data });
const request = (id, title, overrides = {}) => ({
  id,
  title,
  status: "signed",
  requestStatus: "signed",
  contractType: "document_template",
  documentTemplateKey: ANNUAL_KEY,
  countersignedAt: null,
  customerId: `customer-${id}`,
  customer: { name: `Customer ${id}` },
  deliverySummary: {},
  ...overrides,
});

let listPaths;
let rows;
beforeEach(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  adminFetch.mockReset();
  listPaths = [];
  rows = [
    request("annual", "Annual agreement"),
    request("done", "Countersigned annual", { countersignedAt: "2026-09-25T14:00:00.000Z" }),
    request("quarterly", "Quarterly agreement", { documentTemplateKey: "service_agreement.termite_bait_program_purchase" }),
    request("unsigned", "Unsigned annual", { status: "viewed", requestStatus: "viewed" }),
  ];
  adminFetch.mockImplementation((path, options = {}) => {
    if (path === "/admin/contracts/requests/stats") return Promise.resolve(response({ stats: {} }));
    if (path.startsWith("/admin/contracts/requests?")) {
      listPaths.push(path);
      return Promise.resolve(response({ requests: rows }));
    }
    if (path === "/admin/contracts/annual/countersign" && options.method === "POST") {
      rows = rows.map((row) => (row.id === "annual" ? { ...row, countersignedAt: "2026-09-25T15:00:00.000Z" } : row));
      return Promise.resolve(response({ updated: true }));
    }
    throw new Error(`Unexpected request: ${path}`);
  });
});

afterEach(cleanup);

function rowFor(title) {
  return screen.getByText(title).closest("tr");
}

it("preselects the Signed tab from ?status=signed (the countersign bell's link)", async () => {
  render(<MemoryRouter initialEntries={["/admin/contracts?tab=requests&status=signed"]}><DocumentRequestsPage /></MemoryRouter>);
  await screen.findByText("Annual agreement");
  expect(listPaths[0]).toContain("status=signed");
});

it("offers Countersign only on a signed, not-yet-countersigned annual agreement", async () => {
  render(<MemoryRouter><DocumentRequestsPage /></MemoryRouter>);
  await screen.findByText("Annual agreement");
  expect(within(rowFor("Annual agreement")).getByRole("button", { name: /countersign/i })).toBeInTheDocument();
  expect(within(rowFor("Countersigned annual")).queryByRole("button", { name: /countersign/i })).toBeNull();
  expect(within(rowFor("Countersigned annual")).getByText("Countersigned")).toBeInTheDocument();
  expect(within(rowFor("Quarterly agreement")).queryByRole("button", { name: /countersign/i })).toBeNull();
  expect(within(rowFor("Unsigned annual")).queryByRole("button", { name: /countersign/i })).toBeNull();
});

it("requires a typed name, posts it, and refreshes the row as countersigned", async () => {
  render(<MemoryRouter><DocumentRequestsPage /></MemoryRouter>);
  await screen.findByText("Annual agreement");
  fireEvent.click(within(rowFor("Annual agreement")).getByRole("button", { name: /countersign/i }));

  const dialog = await screen.findByRole("dialog");
  const confirm = within(dialog).getByRole("button", { name: /^countersign$/i });
  expect(confirm).toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText(/type your full name/i), { target: { value: "  Adam Owner " } });
  expect(confirm).toBeEnabled();
  fireEvent.click(confirm);

  await waitFor(() => expect(adminFetch).toHaveBeenCalledWith(
    "/admin/contracts/annual/countersign",
    expect.objectContaining({ method: "POST", body: { name: "Adam Owner" } }),
  ));
  await waitFor(() => expect(within(rowFor("Annual agreement")).queryByRole("button", { name: /countersign/i })).toBeNull());
  expect(within(rowFor("Annual agreement")).getByText("Countersigned")).toBeInTheDocument();
});
