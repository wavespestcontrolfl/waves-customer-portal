// @vitest-environment jsdom
// Certified-operator countersignature on the termite annual protection
// agreement (owner ruling 2026-09-25, A-14): a RECORD step after the
// customer signs, offered only on signed annual agreements not yet
// countersigned, and the operator types their own name.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
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
    if (path === "/admin/contracts/done/pdf") {
      return Promise.resolve({ ok: true, status: 200, blob: async () => new Blob(["%PDF"], { type: "application/pdf" }) });
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

it("follows ?status= when the bell link navigates to the already-mounted page (codex #4842 r1 P2)", async () => {
  function GoToSigned() {
    const navigate = useNavigate();
    return <button type="button" onClick={() => navigate("/admin/contracts?tab=requests&status=signed")}>open bell link</button>;
  }
  render(
    <MemoryRouter initialEntries={["/admin/contracts?tab=requests&status=open"]}>
      <GoToSigned />
      <DocumentRequestsPage />
    </MemoryRouter>,
  );
  await screen.findByText("Annual agreement");
  expect(listPaths.at(-1)).toContain("status=open");
  fireEvent.click(screen.getByRole("button", { name: "open bell link" }));
  await waitFor(() => expect(listPaths.at(-1)).toContain("status=signed"));
});

it("a tab click clears the stale ?status= so the SAME bell link works again (codex #4842 r2 P2)", async () => {
  function GoToSigned() {
    const navigate = useNavigate();
    return <button type="button" onClick={() => navigate("/admin/contracts?tab=requests&status=signed")}>open bell link</button>;
  }
  render(
    <MemoryRouter initialEntries={["/admin/contracts?tab=requests&status=signed"]}>
      <GoToSigned />
      <DocumentRequestsPage />
    </MemoryRouter>,
  );
  await screen.findByText("Annual agreement");
  expect(listPaths.at(-1)).toContain("status=signed");
  fireEvent.click(screen.getByRole("button", { name: /^Open/ }));
  await waitFor(() => expect(listPaths.at(-1)).toContain("status=open"));
  fireEvent.click(screen.getByRole("button", { name: "open bell link" }));
  await waitFor(() => expect(listPaths.at(-1)).toContain("status=signed"));
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

it("a countersigned row offers the executed PDF, fetched with admin auth (codex #4842 r1 P2)", async () => {
  const tab = { location: { href: "" }, close: vi.fn() };
  const openSpy = vi.spyOn(window, "open").mockReturnValue(tab);
  URL.createObjectURL = vi.fn(() => "blob:signed-pdf");
  URL.revokeObjectURL = vi.fn();
  try {
    render(<MemoryRouter><DocumentRequestsPage /></MemoryRouter>);
    await screen.findByText("Annual agreement");
    expect(within(rowFor("Annual agreement")).queryByRole("button", { name: /signed pdf/i })).toBeNull();
    fireEvent.click(within(rowFor("Countersigned annual")).getByRole("button", { name: /signed pdf/i }));
    await waitFor(() => expect(tab.location.href).toBe("blob:signed-pdf"));
    expect(adminFetch).toHaveBeenCalledWith("/admin/contracts/done/pdf");
  } finally {
    openSpy.mockRestore();
  }
});
