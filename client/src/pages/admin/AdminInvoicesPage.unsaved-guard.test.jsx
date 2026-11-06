// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdminInvoicesPage from "./AdminInvoicesPage";

const DRAFT = {
  id: "inv-draft-1",
  invoice_number: "WPC-TEST-0001",
  status: "draft",
  customer_id: "cust-1",
  first_name: "Pat",
  last_name: "Sample",
  phone: "+15555550101",
  email: "pat.sample@example.test",
  property_type: "residential",
  tax_rate: 0,
  total: 120,
  subtotal: 120,
  service_date: "2026-11-01",
  due_date: "2026-11-15",
  notes: "Loaded notes",
  line_items: [
    { client_id: "li_1", description: "Test service", quantity: 1, unit_price: 120 },
  ],
};

// `discountsGate`, when given, holds the discount catalog response until it
// resolves, so a test can type into the form while that load is still out.
function stubFetch({ discountsGate } = {}) {
  const requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, opts = {}) => {
      const url = new URL(String(input), "http://localhost");
      const method = opts.method || "GET";
      requests.push({ path: url.pathname, method });
      let body = {};
      if (url.pathname === "/api/admin/invoices")
        body = { invoices: [DRAFT], total: 1 };
      if (url.pathname === "/api/admin/invoices/payment-notices")
        body = { notices: [] };
      if (url.pathname === "/api/admin/feature-flags") body = { flags: {} };
      if (url.pathname === "/api/admin/discounts") {
        if (discountsGate) await discountsGate;
        body = { discounts: [] };
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return requests;
}

const button = (name) => screen.getByRole("button", { name, exact: true });

async function openCreateForm() {
  render(
    <MemoryRouter>
      <AdminInvoicesPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Create invoice", exact: true }));
  // The notes field exists once the form renders; the discount catalog load
  // settles right after, which is the moment the form's baseline is taken.
  const notes = await screen.findByLabelText("Notes (optional)");
  await vi.waitFor(() => expect(notes).not.toBeDisabled());
  await new Promise((resolve) => setTimeout(resolve, 20));
  return notes;
}

// Expands the draft's list row, then opens it in the edit form.
async function openEditForm() {
  await screen.findByText("#WPC-TEST-0001");
  const row = document.querySelector('button[aria-controls="invoice-detail-inv-draft-1"]');
  if (row.getAttribute("aria-expanded") !== "true") fireEvent.click(row);
  fireEvent.click(await screen.findByRole("button", { name: "Edit", exact: true }));
  const notes = await screen.findByLabelText("Notes (optional)");
  await vi.waitFor(() => expect(notes).toHaveValue("Loaded notes"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  return notes;
}

function fireBeforeUnload() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AdminInvoicesPage unsaved invoice guard", () => {
  it("keeps the form and its notes when the operator cancels the discard prompt", async () => {
    stubFetch();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const notes = await openCreateForm();
    fireEvent.change(notes, { target: { value: "Synthetic notes to keep" } });
    fireEvent.click(button("Invoice list"));
    expect(confirm).toHaveBeenCalledWith("Discard your unsaved invoice changes?");
    expect(screen.getByLabelText("Notes (optional)")).toHaveValue("Synthetic notes to keep");
    expect(screen.queryByRole("button", { name: "Create invoice", exact: true })).toBeNull();
  });

  it("protects notes typed while the discount catalog is still loading", async () => {
    let releaseDiscounts;
    stubFetch({ discountsGate: new Promise((resolve) => { releaseDiscounts = resolve; }) });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <MemoryRouter>
        <AdminInvoicesPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Create invoice", exact: true }));
    const notes = await screen.findByLabelText("Notes (optional)");
    fireEvent.change(notes, { target: { value: "Synthetic notes typed early" } });
    fireEvent.click(button("Invoice list"));
    expect(confirm).toHaveBeenCalledWith("Discard your unsaved invoice changes?");
    // The late catalog must not absorb the typed notes into a clean baseline.
    await act(async () => { releaseDiscounts(); });
    expect(fireBeforeUnload().defaultPrevented).toBe(true);
    expect(screen.getByLabelText("Notes (optional)")).toHaveValue("Synthetic notes typed early");
  });

  it("shows the list when the operator accepts the discard prompt", async () => {
    stubFetch();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const notes = await openCreateForm();
    fireEvent.change(notes, { target: { value: "Synthetic notes to drop" } });
    fireEvent.click(button("Invoice list"));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Create invoice", exact: true })).toBeInTheDocument();
    expect(screen.queryByLabelText("Notes (optional)")).toBeNull();
  });

  it("leaves a fresh empty create form without a prompt", async () => {
    stubFetch();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await openCreateForm();
    fireEvent.click(button("Invoice list"));
    expect(confirm).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Create invoice", exact: true })).toBeInTheDocument();
  });

  it("stops warning once the typed work is cleared again", async () => {
    stubFetch();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const notes = await openCreateForm();
    fireEvent.change(notes, { target: { value: "x" } });
    fireEvent.change(notes, { target: { value: "" } });
    fireEvent.click(button("Invoice list"));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("prevents a tab close or reload only while the form holds unsaved work", async () => {
    stubFetch();
    const notes = await openCreateForm();
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
    fireEvent.change(notes, { target: { value: "Synthetic unsaved notes" } });
    expect(fireBeforeUnload().defaultPrevented).toBe(true);
    fireEvent.change(notes, { target: { value: "" } });
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
  });

  it("removes the leave warning when the form unmounts", async () => {
    stubFetch();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const notes = await openCreateForm();
    fireEvent.change(notes, { target: { value: "Synthetic unsaved notes" } });
    expect(fireBeforeUnload().defaultPrevented).toBe(true);
    fireEvent.click(button("Invoice list"));
    await screen.findByRole("button", { name: "Create invoice", exact: true });
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
  });

  it("does not warn on an edit form with nothing changed, and warns after an edit", async () => {
    const requests = stubFetch();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <MemoryRouter>
        <AdminInvoicesPage />
      </MemoryRouter>,
    );
    await openEditForm();
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
    fireEvent.click(button("Invoice list"));
    expect(confirm).not.toHaveBeenCalled();

    const editNotes = await openEditForm();
    fireEvent.change(editNotes, { target: { value: "Loaded notes, changed" } });
    expect(fireBeforeUnload().defaultPrevented).toBe(true);
    fireEvent.click(button("Invoice list"));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Notes (optional)")).toHaveValue("Loaded notes, changed");
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });
});
