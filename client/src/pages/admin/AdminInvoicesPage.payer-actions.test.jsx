// @vitest-environment jsdom
// Invoice row actions mirror the server's payer rules: a payer invoice refuses
// card, credit, plan and Tap to Pay; a statement invoice also refuses manual
// payment (record it on the payer statement); a withdrawn invoice refuses all.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminInvoicesPage from "./AdminInvoicesPage";
import { __resetDiscountStackingCache } from "../../hooks/useDiscountStacking";

const customer = { id: "customer-example", first_name: "Avery", last_name: "Example", email: "avery@example.invalid", phone: "9415550100", property_type: "residential" };
const baseInvoice = {
  ...customer,
  customer_id: customer.id,
  id: "invoice-example",
  invoice_number: "WPC-QA-001",
  status: "sent",
  total: 120,
  due_date: "2099-12-31",
  service_date: "2026-09-08",
  line_items: [{ description: "Quarterly pest control", quantity: 1, unit_price: 120, amount: 120 }],
  card_on_file: { last_four: "4242", brand: "visa" },
};
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let rows;

beforeEach(() => {
  rows = [];
  __resetDiscountStackingCache();
  localStorage.clear();
  localStorage.setItem("waves_admin_token", "synthetic-token");
  localStorage.setItem("waves_admin_user", JSON.stringify({ id: "fixture-user", role: "admin" }));
  vi.stubGlobal("fetch", vi.fn(async (input, options = {}) => {
    const url = new URL(String(input), "http://localhost");
    const key = `${options.method || "GET"} ${url.pathname}`;
    if (key === "GET /api/admin/feature-flags") return response({ flags: {} });
    if (key === "GET /api/admin/invoices") return response({ invoices: rows, total: rows.length, page: 1 });
    if (key === "GET /api/admin/invoices/stats") return response({ paid: 0, outstanding: rows.length, overdue: 0 });
    if (key === "GET /api/admin/invoices/payment-notices") return response({ notices: [] });
    if (key === "GET /api/admin/discounts") return response({ discounts: [] });
    if (key === "GET /api/admin/discounts/stacking") return response({ enabled: false });
    if (key === `GET /api/admin/invoices/${baseInvoice.id}`) return response(rows[0]);
    if (key === `GET /api/admin/invoices/${baseInvoice.id}/recipients`) return response({ customerName: "Avery Example", emailRecipient: null, smsRecipient: null });
    if (key === `GET /api/admin/invoices/${baseInvoice.id}/attachments`) return response({ attachments: [] });
    if (key === `GET /api/admin/invoices/${baseInvoice.id}/followup`) return response({ sequence: null, steps: [] });
    return response({});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function expandInvoice(extra) {
  rows = [{ ...baseInvoice, ...extra }];
  render(<MemoryRouter initialEntries={["/admin/invoices"]}><AdminInvoicesPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: /Avery Example.*WPC-QA-001/ }));
  await screen.findByRole("button", { name: "Copy link", exact: true });
}
const has = (name) => screen.queryByRole("button", { name, exact: true }) !== null;
const FIVE = ["Charge in person", "Add payment", "Apply credit", "Payment plan", "Charge card on file"];
const STATEMENT_LINK = "Record payment on the payer statement";

describe("invoice row actions for payer invoices", () => {
  it("a self-pay open invoice keeps every collection action", async () => {
    await expandInvoice({});
    for (const name of FIVE) expect(has(name), name).toBe(true);
    expect(screen.queryByRole("link", { name: STATEMENT_LINK })).not.toBeInTheDocument();
  });

  it("a payer invoice with no statement still takes a manual payment but nothing else", async () => {
    await expandInvoice({ payer_id: "payer-example" });
    expect(has("Add payment")).toBe(true);
    for (const name of ["Charge in person", "Apply credit", "Payment plan", "Charge card on file"]) {
      expect(has(name), name).toBe(false);
    }
    expect(screen.queryByRole("link", { name: STATEMENT_LINK })).not.toBeInTheDocument();
  });

  it("a statement invoice hides all five and links to the payer statement", async () => {
    await expandInvoice({ payer_id: "payer example/1", payer_statement_id: "statement-example" });
    for (const name of FIVE) expect(has(name), name).toBe(false);
    const link = screen.getByRole("link", { name: STATEMENT_LINK });
    expect(link).toHaveAttribute("href", "/admin/payers?payer=payer%20example%2F1");
    expect(link).toHaveAttribute("title", expect.stringMatching(/monthly statement/i));
  });

  it("a plain statement link keeps the payer id as the param", async () => {
    await expandInvoice({ payer_id: "payer-example", payer_statement_id: "statement-example" });
    expect(screen.getByRole("link", { name: STATEMENT_LINK })).toHaveAttribute("href", "/admin/payers?payer=payer-example");
  });

  it("a withdrawn-to-payer invoice hides all five", async () => {
    await expandInvoice({ scheduled_send_error: "payer_billed: moved to the payer statement" });
    for (const name of FIVE) expect(has(name), name).toBe(false);
    expect(screen.queryByRole("link", { name: STATEMENT_LINK })).not.toBeInTheDocument();
  });
});
