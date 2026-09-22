// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminInvoicesPage from "./AdminInvoicesPage";
import { __resetDiscountStackingCache } from "../../hooks/useDiscountStacking";

const customer = { id: "customer-example", first_name: "Avery", last_name: "Example", email: "avery@example.invalid", phone: "9415550100", property_type: "residential" };
const invoice = { ...customer, customer_id: customer.id, id: "invoice-example", invoice_number: "WPC-QA-001", status: "sent", total: 120, due_date: "2099-12-31", service_date: "2026-09-08", line_items: [{ description: "Quarterly pest control", quantity: 1, unit_price: 120, amount: 120 }], notes: "Existing notes" };
const recipients = { customerName: "Avery Example", emailRecipient: { name: "Example Accounts", email: "billing@example.invalid", role: "billing" }, smsRecipient: { phone: customer.phone } };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let overrides, requests, unmatched, rows;

beforeEach(() => {
  overrides = new Map(); requests = []; unmatched = []; rows = [{ ...invoice }];
  __resetDiscountStackingCache();
  localStorage.clear(); localStorage.setItem("waves_admin_token", "synthetic-token");
  localStorage.setItem("waves_admin_user", JSON.stringify({ id: "fixture-user", role: "admin" }));
  vi.stubGlobal("confirm", vi.fn(() => true));
  vi.stubGlobal("fetch", vi.fn(async (input, options = {}) => {
    const url = new URL(String(input), "http://localhost"), method = options.method || "GET", key = `${method} ${url.pathname}`;
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ key, url, body });
    if (overrides.has(key)) return overrides.get(key)(url, body);
    if (key === "GET /api/admin/feature-flags") return response({ flags: {} });
    if (key === "GET /api/admin/invoices") return response({ invoices: rows, total: rows.length, page: 1 });
    if (key === "GET /api/admin/invoices/stats") return response({ paid: 0, outstanding: rows.length, overdue: 0 });
    if (key === "GET /api/admin/invoices/payment-notices") return response({ notices: [] });
    if (key === "GET /api/admin/invoices/customers/search") return response({ customers: [customer] });
    if (key === `GET /api/admin/invoices/service-records/${customer.id}`) return response({ records: [] });
    if (key === "GET /api/admin/discounts") return response({ discounts: [] });
    // GATE_DISCOUNT_STACKING probe (useDiscountStacking.js) — every money
    // surface with a discount preview issues this once per mount; off by
    // default here, matching the gate's dark-ships-off contract.
    if (key === "GET /api/admin/discounts/stacking") return response({ enabled: false });
    if (key === "GET /api/admin/services") return response({ services: [] });
    if (key === `GET /api/admin/invoices/${invoice.id}`) return response(rows[0]);
    if (key === `GET /api/admin/invoices/${invoice.id}/recipients`) return response(recipients);
    if (key === `GET /api/admin/invoices/${invoice.id}/attachments`) return response({ attachments: [] });
    if (key === `GET /api/admin/invoices/${invoice.id}/followup`) return response({ sequence: null, steps: [] });
    if (key === `GET /api/admin/invoices/${invoice.id}/credit-context`) return response({ balance: 1000, amount_due: 120 });
    unmatched.push(key); return response({ error: "Unmatched test request" }, 500);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); expect(unmatched).toEqual([]); });

async function openPage(path = "/admin/invoices") {
  render(<MemoryRouter initialEntries={[path]}><AdminInvoicesPage /></MemoryRouter>);
  await screen.findByRole("button", { name: /Avery Example.*WPC-QA-001/ });
}
async function expand() {
  fireEvent.click(await screen.findByRole("button", { name: /Avery Example.*WPC-QA-001/ }));
  await screen.findByRole("button", { name: "Add payment", exact: true });
}
async function dialogFrom(button, title) {
  fireEvent.click(screen.getByRole("button", { name: button, exact: true }));
  return within(await screen.findByRole("dialog", { name: title, exact: true }));
}
function pending(key) {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  overrides.set(key, () => promise);
  return release;
}

describe("Invoice foundation workflow preservation", () => {
  it("keeps selection separate from expansion and preserves the customer query on reads", async () => {
    await openPage("/admin/invoices?customerId=customer-example&source=qa");
    const row = screen.getByRole("button", { name: /Avery Example.*WPC-QA-001/ });
    const checkbox = screen.getByRole("checkbox", { name: "Select invoice WPC-QA-001" });
    expect(row).not.toContainElement(checkbox);
    fireEvent.click(checkbox);
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Add payment", exact: true })).not.toBeInTheDocument();
    expect(requests.find(request => request.key === "GET /api/admin/invoices").url.searchParams.get("customerId")).toBe(customer.id);
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(row.getAttribute("aria-controls"))).toBeInTheDocument();
  });

  it("shows unavailable totals and an invoice read error, then safely retries the list", async () => {
    overrides.set("GET /api/admin/invoices", () => response({ error: "List unavailable" }, 503));
    overrides.set("GET /api/admin/invoices/stats", () => response({ error: "Stats unavailable" }, 503));
    render(<MemoryRouter><AdminInvoicesPage /></MemoryRouter>);
    await screen.findByText("Could not load invoices");
    expect(await screen.findByText("Invoice totals could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText("No invoices match")).not.toBeInTheDocument();
    expect(screen.queryByText(/0 paid/)).not.toBeInTheDocument();
    overrides.delete("GET /api/admin/invoices");
    fireEvent.click(screen.getByRole("button", { name: "Retry", exact: true }));
    await screen.findByRole("button", { name: /Avery Example.*WPC-QA-001/ });
    expect(requests.every(request => request.key.startsWith("GET "))).toBe(true);
  });

  it("retains invoice recipient overrides after failure and sends the same payload on explicit retry", async () => {
    await openPage(); await expand();
    const dialog = await dialogFrom("Resend", "Resend invoice");
    await dialog.findByText("billing@example.invalid");
    fireEvent.click(dialog.getByRole("checkbox", { name: "Send invoice email to someone else" }));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Example Accounts" } });
    fireEvent.change(dialog.getByLabelText("Email"), { target: { value: "alternate@example.invalid" } });
    const key = `POST /api/admin/invoices/${invoice.id}/send`, release = pending(key);
    const submit = dialog.getByRole("button", { name: /Send|Resend/, exact: false });
    act(() => { fireEvent.click(submit); fireEvent.click(submit); });
    expect(requests.filter(request => request.key === key)).toHaveLength(1);
    expect(dialog.getByLabelText("Email")).toBeDisabled();
    expect(submit).toHaveAttribute("aria-busy", "true");
    await act(async () => release(response({ error: "Delivery unavailable" }, 503)));
    await dialog.findByText("Invoice send failed: Delivery unavailable");
    expect(dialog.getByLabelText("Email")).toHaveValue("alternate@example.invalid");
    overrides.set(key, () => response({ ok: true, sms: { ok: true }, email: { ok: true } }));
    fireEvent.click(submit);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(requests.filter(request => request.key === key).map(request => request.body)).toEqual([
      { resend: true, invoiceRecipientEmail: "alternate@example.invalid", invoiceRecipientName: "Example Accounts", saveBillingRecipient: false },
      { resend: true, invoiceRecipientEmail: "alternate@example.invalid", invoiceRecipientName: "Example Accounts", saveBillingRecipient: false },
    ]);
  });

  // Round-6 P1 (#4131): a draft/scheduled invoice has never been delivered
  // — this dialog's own "Send invoice" title (vs. "Resend invoice" above)
  // IS the first-delivery / explicit-resend distinction, and the request
  // body must say so: firstDelivery: true, never operator resend intent.
  it("a first (never-delivered) send states firstDelivery: true on the request", async () => {
    rows = [{ ...invoice, status: "draft" }];
    await openPage(); await expand();
    const dialog = await dialogFrom("Send", "Send invoice");
    await dialog.findByText("billing@example.invalid");
    const key = `POST /api/admin/invoices/${invoice.id}/send`;
    overrides.set(key, () => response({ ok: true, sms: { ok: true }, email: { ok: true } }));
    fireEvent.click(dialog.getByRole("button", { name: /Send/, exact: false }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(requests.find(request => request.key === key).body).toEqual({ firstDelivery: true });
  });

  // Third audit P1 (#4131): a parked row (processScheduledSends left it
  // under a stale-claim review hold — status still 'scheduled' but the due
  // time cleared and an error note left in its place) must show as a
  // Resend, not a first delivery, and post the explicit override intent —
  // never firstDelivery: true, which can never clear the hold.
  it("a parked row (stale-claim review hold) shows as Resend — delivery unverified and posts resend: true", async () => {
    rows = [{
      ...invoice,
      status: "scheduled",
      scheduled_send_at: null,
      scheduled_send_error: "Recovered from stale sending claim — delivery unverified; check whether the customer received it, then resend or re-schedule manually",
      // The server's own predicate (isStaleClaimReviewHold), computed by
      // the list/detail serializers — the client reads this field
      // directly and must NEVER re-derive it from scheduled_send_error's
      // text (fourth audit gap #4131).
      review_hold: true,
    }];
    await openPage(); await expand();
    const dialog = await dialogFrom("Send", "Resend invoice — delivery unverified");
    await dialog.findByText("billing@example.invalid");
    const key = `POST /api/admin/invoices/${invoice.id}/send`;
    overrides.set(key, () => response({ ok: true, sms: { ok: true }, email: { ok: true } }));
    fireEvent.click(dialog.getByRole("button", { name: /Send/, exact: false }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(requests.find(request => request.key === key).body).toEqual({ resend: true });
  });

  // Fourth audit gap #4131: /batch/send can report invoices "held" (parked
  // under a stale-claim review hold) separately from sent/failed — without
  // surfacing it, sent_count + failed_count looks like an unexplained
  // shortfall against total.
  it("a batch send with held invoices reports them in the toast, not just sent/failed", async () => {
    await openPage();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select invoice WPC-QA-001" }));
    overrides.set("POST /api/admin/invoices/batch/send", () => response({
      total: 3, sent_count: 1, failed_count: 1, held_count: 1,
      sent: [{ invoiceId: "a" }], failed: [{ invoiceId: "b", error: "no phone" }],
      held: [{ invoiceId: "c", code: "stale_claim_review_hold" }],
    }));
    fireEvent.click(screen.getByRole("button", { name: "Send 1", exact: true }));
    await screen.findByText(/1 held for review/);
    expect(screen.getByText(/Sent 1 of 3 invoices/)).toBeInTheDocument();
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
  });

  // Fourth audit gap #4131: a scheduled row can carry a scheduled_send_error
  // for a reason that has NOTHING to do with the stale-claim review hold
  // (e.g. a provider rejected the number) — review_hold: false there, and
  // the modal must show the ORDINARY Resend title, never "delivery
  // unverified", since the server (not a client guess at the error text)
  // is the one that decides.
  it("a scheduled row with an unrelated send error (review_hold: false) shows the ordinary Resend, not delivery-unverified", async () => {
    rows = [{
      ...invoice,
      status: "scheduled",
      // A prior attempt actually reached the customer (this is a RETRY
      // scenario, not a first delivery) — the unrelated error is what a
      // provider rejection on the retry attempt looks like.
      sent_at: "2026-09-01T12:00:00Z",
      scheduled_send_at: null,
      scheduled_send_error: "Twilio rejected: invalid phone number",
      review_hold: false,
    }];
    await openPage(); await expand();
    const dialog = await dialogFrom("Send", "Resend invoice");
    expect(screen.queryByRole("dialog", { name: "Resend invoice — delivery unverified" })).not.toBeInTheDocument();
    const key = `POST /api/admin/invoices/${invoice.id}/send`;
    overrides.set(key, () => response({ ok: true, sms: { ok: true }, email: { ok: true } }));
    fireEvent.click(dialog.getByRole("button", { name: /Send/, exact: false }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(requests.find(request => request.key === key).body).toEqual({ resend: true });
  });

  it("retains an offline-payment draft and its receipt choice after a failed request", async () => {
    await openPage(); await expand();
    const dialog = await dialogFrom("Add payment", "Add payment");
    await dialog.findByText(/billing@example.invalid/);
    fireEvent.click(dialog.getByRole("button", { name: "Zelle", exact: true }));
    fireEvent.change(dialog.getByLabelText("Zelle confirmation #"), { target: { value: "SYNTHETIC-123" } });
    fireEvent.change(dialog.getByLabelText("Note (optional)"), { target: { value: "Keep this payment note" } });
    fireEvent.click(dialog.getByRole("checkbox", { name: /Send receipt now/ }));
    const key = `POST /api/admin/invoices/${invoice.id}/record-payment`, release = pending(key);
    const submit = dialog.getByRole("button", { name: "Record payment", exact: true });
    act(() => { fireEvent.click(submit); fireEvent.click(submit); });
    expect(requests.filter(request => request.key === key)).toHaveLength(1);
    expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await act(async () => release(response({ error: "Payment unavailable" }, 503)));
    await dialog.findByText("Record payment failed: Payment unavailable");
    expect(dialog.getByLabelText("Note (optional)")).toHaveValue("Keep this payment note");
    expect(dialog.getByRole("checkbox", { name: /Send receipt now/ })).not.toBeChecked();
    expect(requests.find(request => request.key === key).body).toEqual({ method: "zelle", reference: "SYNTHETIC-123", note: "Keep this payment note", sendReceipt: false });
  });

  it("does not show a failed credit read as zero credit; retry restores the form and preserves a failed-save draft", async () => {
    const read = `GET /api/admin/invoices/${invoice.id}/credit-context`;
    overrides.set(read, () => response({ error: "Credit unavailable" }, 503));
    await openPage(); await expand();
    const dialog = await dialogFrom("Apply credit", "Apply account credit");
    await dialog.findByText("Couldn't load account credit: Credit unavailable");
    expect(dialog.queryByText("$0.00")).not.toBeInTheDocument();
    expect(dialog.queryByText(/This customer has no account credit/)).not.toBeInTheDocument();
    overrides.delete(read); fireEvent.click(dialog.getByRole("button", { name: "Try again" }));
    await dialog.findByLabelText("Note (optional)");
    fireEvent.change(dialog.getByLabelText("Note (optional)"), { target: { value: "Retain waiver note" } });
    fireEvent.click(dialog.getByRole("checkbox", { name: /Waive initial/ }));
    const key = `POST /api/admin/invoices/${invoice.id}/apply-credit`, release = pending(key);
    fireEvent.click(dialog.getByRole("button", { name: "Apply & mark prepaid" }));
    await act(async () => release(response({ error: "Apply unavailable" }, 503)));
    await dialog.findByText("Apply credit failed: Apply unavailable");
    expect(dialog.getByLabelText("Note (optional)")).toHaveValue("Retain waiver note");
    expect(requests.find(request => request.key === key).body).toEqual({ waiveSetupFee: true, note: "Retain waiver note" });
  });

  it("keeps annual-prepay writes disabled until its existing coverage is available", async () => {
    await openPage(); await expand();
    const read = `GET /api/admin/invoices/${invoice.id}`;
    overrides.set(read, () => response({ error: "Coverage unavailable" }, 503));
    const dialog = await dialogFrom("Annual prepay", "Mark as annual prepay");
    await dialog.findByText("Could not load annual prepay: Coverage unavailable");
    expect(dialog.getByLabelText("Coverage start")).toBeDisabled();
    expect(dialog.getByRole("button", { name: /Save|Mark/ })).toBeDisabled();
    overrides.delete(read); fireEvent.click(dialog.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(dialog.getByLabelText("Coverage start")).toBeEnabled());
    expect(requests.every(request => request.key.startsWith("GET "))).toBe(true);
  });

  it("preserves payment-plan dates, frequency and amount through a failed save", async () => {
    await openPage(); await expand();
    const dialog = await dialogFrom("Payment plan", "Create payment plan");
    fireEvent.change(dialog.getByLabelText("Payment amount"), { target: { value: "40" } });
    fireEvent.change(dialog.getByLabelText("Start date"), { target: { value: "2099-01-01" } });
    fireEvent.change(dialog.getByLabelText("Next payment"), { target: { value: "2099-02-01" } });
    fireEvent.change(dialog.getByLabelText("Note (optional)"), { target: { value: "Three payments" } });
    const key = `POST /api/admin/invoices/${invoice.id}/payment-plan`, release = pending(key);
    const submit = dialog.getByRole("button", { name: "Create plan" });
    act(() => { fireEvent.click(submit); fireEvent.click(submit); });
    await act(async () => release(response({ error: "Plan unavailable" }, 503)));
    await dialog.findByText("Payment plan failed: Plan unavailable");
    expect(dialog.getByLabelText("Next payment")).toHaveValue("2099-02-01");
    expect(requests.filter(request => request.key === key).map(request => request.body)).toEqual([{ totalBalance: 120, paymentAmount: 40, paymentFrequency: "monthly", planStartDate: "2099-01-01", nextPaymentDate: "2099-02-01", notes: "Three payments" }]);
  });

  it("keeps an edited invoice draft after failure and omits unchanged line items from the update", async () => {
    rows = [{ ...invoice, status: "draft" }];
    await openPage(); await expand();
    fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
    fireEvent.change(await screen.findByLabelText("Notes (optional)"), { target: { value: "Edited notes" } });
    const key = `PUT /api/admin/invoices/${invoice.id}`, release = pending(key);
    const submit = screen.getByRole("button", { name: "Save changes" });
    act(() => { fireEvent.click(submit); fireEvent.click(submit); });
    expect(screen.getByRole("button", { name: "Invoice list" })).toBeDisabled();
    await act(async () => release(response({ error: "Update unavailable" }, 503)));
    expect(await screen.findAllByText("Error: Update unavailable")).not.toHaveLength(0);
    expect(screen.getByLabelText("Notes (optional)")).toHaveValue("Edited notes");
    expect(requests.filter(request => request.key === key)).toHaveLength(1);
    expect(requests.find(request => request.key === key).body).toEqual({ title: null, notes: "Edited notes", email_message: null, due_date: "2099-12-31" });
  });

  it("keeps creation inputs after failure and never calls send when saving a draft", async () => {
    await openPage(); fireEvent.click(screen.getByRole("button", { name: "Create invoice", exact: true }));
    fireEvent.change(screen.getByLabelText("Find customer"), { target: { value: "Avery" } });
    fireEvent.click(await screen.findByRole("button", { name: /Avery Example/ }));
    fireEvent.change(screen.getByLabelText("Service", { exact: true }), { target: { value: "Quarterly pest control" } });
    fireEvent.change(screen.getByLabelText("Price ($)"), { target: { value: "120" } });
    fireEvent.change(screen.getByLabelText("Send", { exact: true }), { target: { value: "draft" } });
    fireEvent.change(screen.getByLabelText("Notes (optional)"), { target: { value: "Preserve new draft" } });
    const key = "POST /api/admin/invoices", release = pending(key);
    const submit = screen.getByRole("button", { name: "Create draft", exact: true });
    act(() => { fireEvent.click(submit); fireEvent.click(submit); });
    expect(screen.getByLabelText("Price ($)")).toBeDisabled();
    await act(async () => release(response({ error: "Create unavailable" }, 503)));
    expect(await screen.findAllByText("Error: Create unavailable")).not.toHaveLength(0);
    expect(screen.getByLabelText("Notes (optional)")).toHaveValue("Preserve new draft");
    const writes = requests.filter(request => request.key.startsWith("POST "));
    expect(writes).toHaveLength(1); expect(writes[0].key).toBe(key);
    expect(writes[0].body).toMatchObject({ customerId: customer.id, serviceRecordId: null, notes: "Preserve new draft", lineItems: [{ description: "Quarterly pest control", quantity: 1, unit_price: 120, amount: 120 }] });
  });

  // GATE_DISCOUNT_STACKING (coordinator ruling after Codex round 2 on PR
  // #4655): the stacking-freshness probe must never gate a discount-free
  // save — an unreachable /admin/discounts/stacking endpoint (simulated
  // here as a hard failure on every call) must not block an ordinary
  // invoice create that carries no discount line items at all.
  it("a failed stacking probe never blocks a discount-free create", async () => {
    overrides.set("GET /api/admin/discounts/stacking", () => response({ error: "stacking probe down" }, 503));
    await openPage(); fireEvent.click(screen.getByRole("button", { name: "Create invoice", exact: true }));
    fireEvent.change(screen.getByLabelText("Find customer"), { target: { value: "Avery" } });
    fireEvent.click(await screen.findByRole("button", { name: /Avery Example/ }));
    fireEvent.change(screen.getByLabelText("Service", { exact: true }), { target: { value: "Quarterly pest control" } });
    fireEvent.change(screen.getByLabelText("Price ($)"), { target: { value: "120" } });
    fireEvent.change(screen.getByLabelText("Send", { exact: true }), { target: { value: "draft" } });
    const key = "POST /api/admin/invoices";
    overrides.set(key, () => response({ id: "new-invoice-1", invoice_number: "WPC-2026-0100", status: "draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Create draft", exact: true }));
    await waitFor(() => expect(requests.some(request => request.key === key)).toBe(true));
    expect(screen.queryByText(/Discount rules just changed/)).not.toBeInTheDocument();
  });

  // Same probe failure, but the invoice now carries a discount line item —
  // the save must refuse rather than silently post additive totals the
  // server might actually compound (or vice versa).
  it("a failed stacking probe refuses a create that carries a discount line item", async () => {
    overrides.set("GET /api/admin/discounts", () => response({ discounts: [{ id: "ten-pct", name: "Ten Percent", discount_type: "percentage", amount: 10, is_active: true, show_in_invoices: true }] }));
    overrides.set("GET /api/admin/discounts/stacking", () => response({ error: "stacking probe down" }, 503));
    await openPage(); fireEvent.click(screen.getByRole("button", { name: "Create invoice", exact: true }));
    fireEvent.change(screen.getByLabelText("Find customer"), { target: { value: "Avery" } });
    fireEvent.click(await screen.findByRole("button", { name: /Avery Example/ }));
    fireEvent.change(screen.getByLabelText("Service", { exact: true }), { target: { value: "Quarterly pest control" } });
    fireEvent.change(screen.getByLabelText("Price ($)"), { target: { value: "120" } });
    fireEvent.change(screen.getByLabelText("Send", { exact: true }), { target: { value: "draft" } });
    fireEvent.change(await screen.findByLabelText("Add a discount"), { target: { value: "Ten" } });
    fireEvent.click(await screen.findByRole("button", { name: /Ten Percent/ }));
    const key = "POST /api/admin/invoices";
    fireEvent.click(screen.getByRole("button", { name: "Create draft", exact: true }));
    expect(await screen.findAllByText(/Discount rules just changed/)).not.toHaveLength(0);
    expect(requests.some(request => request.key === key)).toBe(false);
  });

  // GitHub Codex round 2 on PR #4655, P2 (:5993 in that head): a CUSTOM
  // pick (operator-typed percentage) must compound with an existing fixed
  // credit already on the line, exactly like a catalog pick already does
  // — the inserted row must show the compounded $7, never the raw $10
  // getCustomDiscountValue alone would give.
  it("a custom percentage pick compounds with an existing fixed credit on the same line", async () => {
    overrides.set("GET /api/admin/discounts", () => response({ discounts: [
      { id: "thirty-fixed", name: "Thirty Dollars", discount_type: "fixed_amount", amount: 30, is_active: true, show_in_invoices: true },
      { id: "custom-pct", name: "Custom Percent", discount_type: "variable_percentage", amount: 0, is_active: true, show_in_invoices: true },
    ] }));
    overrides.set("GET /api/admin/discounts/stacking", () => response({ enabled: true }));
    vi.stubGlobal("prompt", vi.fn(() => "10"));
    await openPage(); fireEvent.click(screen.getByRole("button", { name: "Create invoice", exact: true }));
    fireEvent.change(screen.getByLabelText("Find customer"), { target: { value: "Avery" } });
    fireEvent.click(await screen.findByRole("button", { name: /Avery Example/ }));
    fireEvent.change(screen.getByLabelText("Service", { exact: true }), { target: { value: "Quarterly pest control" } });
    fireEvent.change(screen.getByLabelText("Price ($)"), { target: { value: "100" } });
    fireEvent.change(await screen.findByLabelText("Add a discount"), { target: { value: "Thirty" } });
    fireEvent.click(await screen.findByRole("button", { name: /Thirty Dollars/ }));
    fireEvent.change(await screen.findByLabelText("Add a discount"), { target: { value: "Custom" } });
    fireEvent.click(await screen.findByRole("button", { name: /Custom Percent/ }));
    const creditValues = await waitFor(() => {
      const inputs = screen.getAllByLabelText("Credit ($)");
      expect(inputs).toHaveLength(2);
      return inputs.map((el) => el.value);
    });
    expect(creditValues).toContain("-30");
    expect(creditValues).toContain("-7");
    expect(creditValues).not.toContain("-10");
  });

  // GitHub Codex round 3 on PR #4655, P2 (:6089 in that head): a preset
  // that conflicts with a non-stackable group already on the invoice must
  // be filtered out of the picker BEFORE save, not just refused at Save.
  it("hides a non-stackable-group preset once its group is already chosen on the invoice", async () => {
    overrides.set("GET /api/admin/discounts", () => response({ discounts: [
      { id: "silver-id", name: "WaveGuard Silver", discount_type: "percentage", amount: 10, is_active: true, show_in_invoices: true, stack_group: "tier", is_stackable: false },
      { id: "gold-id", name: "WaveGuard Gold", discount_type: "percentage", amount: 15, is_active: true, show_in_invoices: true, stack_group: "tier", is_stackable: false },
    ] }));
    overrides.set("GET /api/admin/discounts/stacking", () => response({ enabled: true }));
    await openPage(); fireEvent.click(screen.getByRole("button", { name: "Create invoice", exact: true }));
    fireEvent.change(screen.getByLabelText("Find customer"), { target: { value: "Avery" } });
    fireEvent.click(await screen.findByRole("button", { name: /Avery Example/ }));
    fireEvent.change(screen.getByLabelText("Service", { exact: true }), { target: { value: "Quarterly pest control" } });
    fireEvent.change(screen.getByLabelText("Price ($)"), { target: { value: "100" } });
    fireEvent.change(await screen.findByLabelText("Add a discount"), { target: { value: "Wave" } });
    fireEvent.click(await screen.findByRole("button", { name: /WaveGuard Silver/ }));
    fireEvent.change(await screen.findByLabelText("Add a discount"), { target: { value: "Wave" } });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /WaveGuard Gold/ })).not.toBeInTheDocument();
    });
  });

  // Slice 8 of #4405: this form gains its own document-wide (invoice-wide)
  // discount/credit picker — #4655 shipped the math (computeInvoiceLineDiscountTotal
  // etc. already interleave a document-wide credit) but had "no document-level
  // picker of its own" (its own words). Gated behind stackingEnabled so gate-off
  // rendering stays byte-identical to before this slice.
  it("gate off: no invoice-wide discount picker renders at all (byte-identical to before this slice)", async () => {
    overrides.set("GET /api/admin/discounts", () => response({ discounts: [
      { id: "ten-pct", name: "Ten Percent", discount_type: "percentage", amount: 10, is_active: true, show_in_invoices: true },
    ] }));
    await openPage(); fireEvent.click(screen.getByRole("button", { name: "Create invoice", exact: true }));
    fireEvent.change(screen.getByLabelText("Find customer"), { target: { value: "Avery" } });
    fireEvent.click(await screen.findByRole("button", { name: /Avery Example/ }));
    fireEvent.change(screen.getByLabelText("Service", { exact: true }), { target: { value: "Quarterly pest control" } });
    fireEvent.change(screen.getByLabelText("Price ($)"), { target: { value: "100" } });
    expect(screen.queryByLabelText("Add an invoice-wide discount")).not.toBeInTheDocument();
  });

  it("gate on: picking a FIXED discount from the invoice-wide picker adds a document-wide credit sized by the shared stacking engine", async () => {
    overrides.set("GET /api/admin/discounts", () => response({ discounts: [
      { id: "twenty-five-fixed", name: "Twenty Five Dollars", discount_type: "fixed_amount", amount: 25, is_active: true, show_in_invoices: true },
    ] }));
    overrides.set("GET /api/admin/discounts/stacking", () => response({ enabled: true }));
    await openPage(); fireEvent.click(screen.getByRole("button", { name: "Create invoice", exact: true }));
    fireEvent.change(screen.getByLabelText("Find customer"), { target: { value: "Avery" } });
    fireEvent.click(await screen.findByRole("button", { name: /Avery Example/ }));
    fireEvent.change(screen.getByLabelText("Service", { exact: true }), { target: { value: "Quarterly pest control" } });
    fireEvent.change(screen.getByLabelText("Price ($)"), { target: { value: "100" } });
    fireEvent.change(await screen.findByLabelText("Add an invoice-wide discount"), { target: { value: "Twenty" } });
    fireEvent.click(await screen.findByRole("button", { name: /Twenty Five Dollars/ }));
    await waitFor(() => {
      expect(screen.getByLabelText("Credit ($)")).toHaveValue(-25);
    });
    expect(screen.getByText("Applies to: entire invoice")).toBeInTheDocument();
  });

  // Round 2 of this scope extension excluded a PERCENTAGE (or
  // free_service) document-wide pick here — once saved, every frozen
  // discount replays on the next edit as a fixed credit, which used to
  // ALSO decide its canonical-order position, silently changing the
  // invoice's total on a no-op resubmit (reproduced: $50 → $66.67).
  // Round 3 fixes the ROOT cause in discount-stack.js (a persisted sort
  // key rides along with a frozen term's dollars — see that file's own
  // module header), so every type this form's math already models is
  // offered here again. free_service is the one exclusion left — a
  // document-wide free_service term would zero out every eligible
  // line's remaining balance at once, untested and unrequested here.
  it("the invoice-wide picker offers fixed, percentage and stack-grouped rows, but excludes free_service", async () => {
    overrides.set("GET /api/admin/discounts", () => response({ discounts: [
      { id: "free-svc", name: "Free Service", discount_type: "free_service", amount: 0, is_active: true, show_in_invoices: true },
      { id: "ten-pct-doc", name: "Ten Percent Invoice-Wide", discount_type: "percentage", amount: 10, is_active: true, show_in_invoices: true },
      { id: "grouped-fixed", name: "Grouped Fixed", discount_type: "fixed_amount", amount: 20, is_active: true, show_in_invoices: true, stack_group: "promo", is_stackable: false },
      { id: "twenty-five-fixed", name: "Twenty Five Dollars", discount_type: "fixed_amount", amount: 25, is_active: true, show_in_invoices: true },
    ] }));
    overrides.set("GET /api/admin/discounts/stacking", () => response({ enabled: true }));
    await openPage(); fireEvent.click(screen.getByRole("button", { name: "Create invoice", exact: true }));
    fireEvent.change(screen.getByLabelText("Find customer"), { target: { value: "Avery" } });
    fireEvent.click(await screen.findByRole("button", { name: /Avery Example/ }));
    fireEvent.change(screen.getByLabelText("Service", { exact: true }), { target: { value: "Quarterly pest control" } });
    fireEvent.change(screen.getByLabelText("Price ($)"), { target: { value: "100" } });
    fireEvent.focus(await screen.findByLabelText("Add an invoice-wide discount"));
    expect(await screen.findByRole("button", { name: /Twenty Five Dollars/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Grouped Fixed/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ten Percent Invoice-Wide/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Free Service/ })).not.toBeInTheDocument();
  });

  // Coordinator scope extension round 3: picking a PERCENTAGE discount
  // from the invoice-wide picker previews the correct compounded
  // amount — round 2 could not offer this at all.
  it("gate on: picking a PERCENTAGE discount from the invoice-wide picker previews the correct compounded amount", async () => {
    overrides.set("GET /api/admin/discounts", () => response({ discounts: [
      { id: "ten-pct-doc", name: "Ten Percent Invoice-Wide", discount_type: "percentage", amount: 10, is_active: true, show_in_invoices: true },
    ] }));
    overrides.set("GET /api/admin/discounts/stacking", () => response({ enabled: true }));
    await openPage(); fireEvent.click(screen.getByRole("button", { name: "Create invoice", exact: true }));
    fireEvent.change(screen.getByLabelText("Find customer"), { target: { value: "Avery" } });
    fireEvent.click(await screen.findByRole("button", { name: /Avery Example/ }));
    fireEvent.change(screen.getByLabelText("Service", { exact: true }), { target: { value: "Quarterly pest control" } });
    fireEvent.change(screen.getByLabelText("Price ($)"), { target: { value: "100" } });
    fireEvent.change(await screen.findByLabelText("Add an invoice-wide discount"), { target: { value: "Ten" } });
    fireEvent.click(await screen.findByRole("button", { name: /Ten Percent Invoice-Wide/ }));
    await waitFor(() => {
      expect(screen.getByLabelText("Credit ($)")).toHaveValue(-10);
    });
  });

  // One-tier / stack-group enforcement (assertNewStackGroupConflicts
  // server-side, stackablePresets here) reaches across scopes: a tier
  // already picked on a LINE must hide the rest of its stack_group in
  // the invoice-wide picker too, not just within that same line's own
  // picker — using WaveGuard tiers themselves (percentage-typed), now
  // that the invoice-wide picker offers percentage rows again.
  it("one-tier enforcement reaches across scopes: a line-scoped WaveGuard tier hides its group in the invoice-wide picker", async () => {
    overrides.set("GET /api/admin/discounts", () => response({ discounts: [
      { id: "silver-id", name: "WaveGuard Silver", discount_type: "percentage", amount: 10, is_active: true, show_in_invoices: true, stack_group: "tier", is_stackable: false },
      { id: "gold-id", name: "WaveGuard Gold", discount_type: "percentage", amount: 15, is_active: true, show_in_invoices: true, stack_group: "tier", is_stackable: false },
    ] }));
    overrides.set("GET /api/admin/discounts/stacking", () => response({ enabled: true }));
    await openPage(); fireEvent.click(screen.getByRole("button", { name: "Create invoice", exact: true }));
    fireEvent.change(screen.getByLabelText("Find customer"), { target: { value: "Avery" } });
    fireEvent.click(await screen.findByRole("button", { name: /Avery Example/ }));
    fireEvent.change(screen.getByLabelText("Service", { exact: true }), { target: { value: "Quarterly pest control" } });
    fireEvent.change(screen.getByLabelText("Price ($)"), { target: { value: "100" } });
    fireEvent.change(await screen.findByLabelText("Add a discount"), { target: { value: "Wave" } });
    fireEvent.click(await screen.findByRole("button", { name: /WaveGuard Silver/ }));
    fireEvent.focus(await screen.findByLabelText("Add an invoice-wide discount"));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /WaveGuard Gold/ })).not.toBeInTheDocument();
    });
  });

  // Pre-push audit P1 round 1 (this slice's original push): the POST body
  // for a fresh document-wide catalog pick must be accepted by the server
  // at all. Coordinator scope extension (round 3): now that
  // server/services/invoice.js validates and prices a fresh document-wide
  // pick against its own catalog row, the client no longer needs (or
  // does) any submit-time workaround — the pick's discount_id rides
  // straight through, so invoice_discounts.discount_id is recorded and
  // discounts.times_applied / total_discount_given roll up correctly.
  it("a create carrying a fresh invoice-wide pick posts it WITH its discount_id (catalog attribution preserved end to end)", async () => {
    overrides.set("GET /api/admin/discounts", () => response({ discounts: [
      { id: "twenty-five-fixed", name: "Twenty Five Dollars", discount_type: "fixed_amount", amount: 25, is_active: true, show_in_invoices: true },
    ] }));
    overrides.set("GET /api/admin/discounts/stacking", () => response({ enabled: true }));
    await openPage(); fireEvent.click(screen.getByRole("button", { name: "Create invoice", exact: true }));
    fireEvent.change(screen.getByLabelText("Find customer"), { target: { value: "Avery" } });
    fireEvent.click(await screen.findByRole("button", { name: /Avery Example/ }));
    fireEvent.change(screen.getByLabelText("Service", { exact: true }), { target: { value: "Quarterly pest control" } });
    fireEvent.change(screen.getByLabelText("Price ($)"), { target: { value: "100" } });
    fireEvent.change(await screen.findByLabelText("Add an invoice-wide discount"), { target: { value: "Twenty" } });
    fireEvent.click(await screen.findByRole("button", { name: /Twenty Five Dollars/ }));
    await waitFor(() => expect(screen.getByLabelText("Credit ($)")).toHaveValue(-25));
    fireEvent.change(screen.getByLabelText("Send", { exact: true }), { target: { value: "draft" } });
    const key = "POST /api/admin/invoices";
    overrides.set(key, () => response({ id: "new-invoice-2", invoice_number: "WPC-2026-0101", status: "draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Create draft", exact: true }));
    await waitFor(() => expect(requests.some(request => request.key === key)).toBe(true));
    const posted = requests.find(request => request.key === key).body.lineItems.find(i => i.description === "Twenty Five Dollars");
    expect(posted).toBeTruthy();
    expect(posted.discount_id).toBe("twenty-five-fixed");
    expect(posted.unit_price).toBe(-25);
  });

  // GitHub review round 1 P1 (PR #4659): waveguard_member_wdo (100% off,
  // scoped to wdo_inspection) on a mixed invoice (a WDO line and a pest
  // line) must discount ONLY the WDO line — real search-and-pick flow
  // through pickService (which now stamps service_key/service_category
  // onto the picked line), through the invoice-wide picker, into both
  // the live preview AND the submitted payload.
  it("a service-scoped invoice-wide pick (waveguard_member_wdo shape) discounts only the matching line, real pick-a-service flow", async () => {
    overrides.set("GET /api/admin/services", () => response({ services: [
      { id: "svc-wdo", name: "WDO Inspection", service_key: "wdo_inspection", category: "wdo", base_price: 200 },
      { id: "svc-pest", name: "Quarterly Pest Control", service_key: "pest_control", category: "pest", base_price: 100 },
    ] }));
    overrides.set("GET /api/admin/discounts", () => response({ discounts: [
      { id: "wdo-discount", name: "WaveGuard Member WDO", discount_type: "percentage", amount: 100, is_active: true, show_in_invoices: true, service_key_filter: "wdo_inspection" },
    ] }));
    overrides.set("GET /api/admin/discounts/stacking", () => response({ enabled: true }));
    await openPage(); fireEvent.click(screen.getByRole("button", { name: "Create invoice", exact: true }));
    fireEvent.change(screen.getByLabelText("Find customer"), { target: { value: "Avery" } });
    fireEvent.click(await screen.findByRole("button", { name: /Avery Example/ }));

    // Line 1: search for and PICK the WDO service (not just typed text —
    // this is what actually runs pickService).
    const serviceField = screen.getByLabelText("Service", { exact: true });
    fireEvent.focus(serviceField);
    fireEvent.change(serviceField, { target: { value: "WDO" } });
    fireEvent.mouseDown(await screen.findByRole("button", { name: /WDO Inspection/ }));

    // Line 2: add a service line and pick Quarterly Pest Control.
    fireEvent.click(screen.getByRole("button", { name: "+ Add service" }));
    const serviceFields = screen.getAllByLabelText("Service", { exact: true });
    const secondServiceField = serviceFields[serviceFields.length - 1];
    fireEvent.focus(secondServiceField);
    fireEvent.change(secondServiceField, { target: { value: "Pest" } });
    fireEvent.mouseDown(await screen.findByRole("button", { name: /Quarterly Pest Control/ }));

    // Pick the WDO-scoped invoice-wide discount.
    fireEvent.change(await screen.findByLabelText("Add an invoice-wide discount"), { target: { value: "WaveGuard" } });
    fireEvent.click(await screen.findByRole("button", { name: /WaveGuard Member WDO/ }));

    // Preview: the invoice-wide credit resolves to $200 (the WDO line's
    // own gross), never $300 (both lines combined).
    await waitFor(() => {
      const credits = screen.getAllByLabelText("Credit ($)").map((el) => el.value);
      expect(credits).toContain("-200");
      expect(credits).not.toContain("-300");
    });

    fireEvent.change(screen.getByLabelText("Send", { exact: true }), { target: { value: "draft" } });
    const key = "POST /api/admin/invoices";
    overrides.set(key, () => response({ id: "new-invoice-wdo", invoice_number: "WPC-2026-0102", status: "draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Create draft", exact: true }));
    await waitFor(() => expect(requests.some((request) => request.key === key)).toBe(true));
    const body = requests.find((request) => request.key === key).body;
    const wdoLine = body.lineItems.find((i) => i.description === "WDO Inspection");
    const pestLine = body.lineItems.find((i) => i.description === "Quarterly Pest Control");
    const discountLine = body.lineItems.find((i) => i.discount_id === "wdo-discount");
    expect(wdoLine.service_key).toBe("wdo_inspection");
    expect(pestLine.service_key).toBe("pest_control");
    expect(discountLine.unit_price).toBe(-200);
  });

  // GitHub review round 2 P1 (PR #4659): pickService stamps
  // service_key/service_category onto a line, but the SAME "Service"
  // field is an ordinary free-text input bound to updateLineItem the
  // rest of the time — a manual rename after the pick left those
  // catalog-derived fields stale, so a line renamed AWAY from WDO
  // Inspection still read as WDO-eligible (both in this form's own
  // preview, which reads line.service_key directly, and on save, since
  // the server trusts the submitted service_key verbatim and never
  // re-derives it from description). Reproduced and fixed by having
  // updateLineItem clear service_key/service_category on any
  // description edit that follows a pick.
  it("renaming a picked line's description by hand clears its service scope — a WDO-scoped invoice-wide discount no longer applies, in preview or on save", async () => {
    overrides.set("GET /api/admin/services", () => response({ services: [
      { id: "svc-wdo", name: "WDO Inspection", service_key: "wdo_inspection", category: "wdo", base_price: 200 },
      { id: "svc-pest", name: "Quarterly Pest Control", service_key: "pest_control", category: "pest", base_price: 100 },
    ] }));
    overrides.set("GET /api/admin/discounts", () => response({ discounts: [
      { id: "wdo-discount", name: "WaveGuard Member WDO", discount_type: "percentage", amount: 100, is_active: true, show_in_invoices: true, service_key_filter: "wdo_inspection" },
    ] }));
    overrides.set("GET /api/admin/discounts/stacking", () => response({ enabled: true }));
    await openPage(); fireEvent.click(screen.getByRole("button", { name: "Create invoice", exact: true }));
    fireEvent.change(screen.getByLabelText("Find customer"), { target: { value: "Avery" } });
    fireEvent.click(await screen.findByRole("button", { name: /Avery Example/ }));

    // Line 1: PICK the WDO service (runs pickService, stamps service_key).
    const serviceField = screen.getByLabelText("Service", { exact: true });
    fireEvent.focus(serviceField);
    fireEvent.change(serviceField, { target: { value: "WDO" } });
    fireEvent.mouseDown(await screen.findByRole("button", { name: /WDO Inspection/ }));
    await waitFor(() => expect(screen.getByLabelText("Service", { exact: true }).value).toBe("WDO Inspection"));

    // Line 2: a plain unkeyed Pest line, so an orphaned scope's "$0,
    // never a silent full-invoice widen" behavior is also exercised.
    fireEvent.click(screen.getByRole("button", { name: "+ Add service" }));
    const serviceFields = screen.getAllByLabelText("Service", { exact: true });
    const secondServiceField = serviceFields[serviceFields.length - 1];
    fireEvent.focus(secondServiceField);
    fireEvent.change(secondServiceField, { target: { value: "Pest" } });
    fireEvent.mouseDown(await screen.findByRole("button", { name: /Quarterly Pest Control/ }));

    // Pick the WDO-scoped invoice-wide discount WHILE line 1 is still
    // WDO Inspection — confirms it applies first, matching the sibling
    // test's baseline, before the rename below is what actually removes
    // it.
    fireEvent.change(await screen.findByLabelText("Add an invoice-wide discount"), { target: { value: "WaveGuard" } });
    fireEvent.click(await screen.findByRole("button", { name: /WaveGuard Member WDO/ }));
    await waitFor(() => {
      const credits = screen.getAllByLabelText("Credit ($)").map((el) => el.value);
      expect(credits).toContain("-200");
    });

    // Now RENAME line 1 by hand — a plain free-text edit, not a new
    // pick — away from the WDO service entirely.
    fireEvent.change(screen.getAllByLabelText("Service", { exact: true })[0], { target: { value: "Custom WDO Follow-Up Visit" } });

    // Preview: the renamed line no longer carries service_key
    // "wdo_inspection" — the ALREADY-ADDED discount resolves orphaned
    // ($0), never staying at -200 against the renamed line and never
    // widening onto Pest.
    await waitFor(() => {
      const credits = screen.getAllByLabelText("Credit ($)").map((el) => el.value);
      expect(credits).not.toContain("-200");
    });

    fireEvent.change(screen.getByLabelText("Send", { exact: true }), { target: { value: "draft" } });
    const key = "POST /api/admin/invoices";
    overrides.set(key, () => response({ id: "new-invoice-renamed", invoice_number: "WPC-2026-0103", status: "draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Create draft", exact: true }));
    await waitFor(() => expect(requests.some((request) => request.key === key)).toBe(true));
    const body = requests.find((request) => request.key === key).body;
    const renamedLine = body.lineItems.find((i) => i.description === "Custom WDO Follow-Up Visit");
    const pestLine = body.lineItems.find((i) => i.description === "Quarterly Pest Control");
    const discountLine = body.lineItems.find((i) => i.discount_id === "wdo-discount");
    expect(renamedLine.service_key).toBeFalsy();
    expect(renamedLine.unit_price).toBe(200); // the renamed line's own price is untouched — full price, no credit
    expect(pestLine.unit_price).toBe(100); // never widened onto the unrelated line either
    // The orphaned $0 discount is dropped entirely by the submit-time
    // filter (lineItems.filter(i => Number(i.unit_price) !== 0)) — the
    // strongest possible confirmation that it no longer applies at all.
    expect(discountLine).toBeUndefined();
  });

  // Pre-push audit P1 (coordinator scope extension, round 2):
  // repriceLineWithNewDiscountPick only rewrote siblings on the SAME
  // line — a fresh invoice-wide row's own displayed dollars could go
  // stale the same way a same-line sibling's used to (#4655 round 1).
  // Reproduced with two fixed credits (both resolve in the SAME
  // canonical fixed-pass, so the reorder is real): a $100 line gets a
  // $30 invoice-wide credit first (shows -$30, uncontested); adding a
  // NEW $90 line-scoped credit outranks it (larger value sorts first),
  // clamping the invoice-wide credit's own share down to $10 — the row
  // must now display -$10, not the stale -$30.
  it("adding a larger line-scoped fixed pick reprices an existing invoice-wide fixed credit's own displayed row", async () => {
    overrides.set("GET /api/admin/discounts", () => response({ discounts: [
      { id: "thirty-doc", name: "Thirty Invoice-Wide", discount_type: "fixed_amount", amount: 30, is_active: true, show_in_invoices: true },
      { id: "ninety-line", name: "Ninety Dollars", discount_type: "fixed_amount", amount: 90, is_active: true, show_in_invoices: true },
    ] }));
    overrides.set("GET /api/admin/discounts/stacking", () => response({ enabled: true }));
    await openPage(); fireEvent.click(screen.getByRole("button", { name: "Create invoice", exact: true }));
    fireEvent.change(screen.getByLabelText("Find customer"), { target: { value: "Avery" } });
    fireEvent.click(await screen.findByRole("button", { name: /Avery Example/ }));
    fireEvent.change(screen.getByLabelText("Service", { exact: true }), { target: { value: "Quarterly pest control" } });
    fireEvent.change(screen.getByLabelText("Price ($)"), { target: { value: "100" } });
    fireEvent.change(await screen.findByLabelText("Add an invoice-wide discount"), { target: { value: "Thirty" } });
    fireEvent.click(await screen.findByRole("button", { name: /Thirty Invoice-Wide/ }));
    await waitFor(() => expect(screen.getByLabelText("Credit ($)")).toHaveValue(-30));
    fireEvent.change(await screen.findByLabelText("Add a discount"), { target: { value: "Ninety" } });
    fireEvent.click(await screen.findByRole("button", { name: /Ninety Dollars/ }));
    await waitFor(() => {
      const creditValues = screen.getAllByLabelText("Credit ($)").map((el) => el.value);
      expect(creditValues).toContain("-90");
      expect(creditValues).toContain("-10"); // was -30, clamped by the larger new pick
      expect(creditValues).not.toContain("-30");
    });
  });

  // Codex pre-push audit P1 (round 4 on PR #4655, LAST patch round): the
  // write binds the CONFIRMED gate state the preview ran under — the
  // server rejects a mismatch, so the client must actually send it.
  it("a create carrying a discount pick sends expected_discount_stacking bound to the confirmed probe value", async () => {
    overrides.set("GET /api/admin/discounts", () => response({ discounts: [
      { id: "ten-pct", name: "Ten Percent", discount_type: "percentage", amount: 10, is_active: true, show_in_invoices: true },
    ] }));
    overrides.set("GET /api/admin/discounts/stacking", () => response({ enabled: true }));
    await openPage(); fireEvent.click(screen.getByRole("button", { name: "Create invoice", exact: true }));
    fireEvent.change(screen.getByLabelText("Find customer"), { target: { value: "Avery" } });
    fireEvent.click(await screen.findByRole("button", { name: /Avery Example/ }));
    fireEvent.change(screen.getByLabelText("Service", { exact: true }), { target: { value: "Quarterly pest control" } });
    fireEvent.change(screen.getByLabelText("Price ($)"), { target: { value: "120" } });
    fireEvent.change(screen.getByLabelText("Send", { exact: true }), { target: { value: "draft" } });
    fireEvent.change(await screen.findByLabelText("Add a discount"), { target: { value: "Ten" } });
    fireEvent.click(await screen.findByRole("button", { name: /Ten Percent/ }));
    const key = "POST /api/admin/invoices";
    overrides.set(key, () => response({ id: "new-invoice-1", invoice_number: "WPC-2026-0100", status: "draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Create draft", exact: true }));
    await waitFor(() => expect(requests.some(request => request.key === key)).toBe(true));
    expect(requests.find(request => request.key === key).body.expected_discount_stacking).toBe(true);
  });

  // A discount-FREE create never even probes the gate (established round-2
  // ruling) — expected_discount_stacking must therefore be entirely absent
  // from the body, not sent as a stale/undefined value the server would
  // still have to special-case.
  it("a discount-free create omits expected_discount_stacking entirely", async () => {
    await openPage(); fireEvent.click(screen.getByRole("button", { name: "Create invoice", exact: true }));
    fireEvent.change(screen.getByLabelText("Find customer"), { target: { value: "Avery" } });
    fireEvent.click(await screen.findByRole("button", { name: /Avery Example/ }));
    fireEvent.change(screen.getByLabelText("Service", { exact: true }), { target: { value: "Quarterly pest control" } });
    fireEvent.change(screen.getByLabelText("Price ($)"), { target: { value: "120" } });
    fireEvent.change(screen.getByLabelText("Send", { exact: true }), { target: { value: "draft" } });
    const key = "POST /api/admin/invoices";
    overrides.set(key, () => response({ id: "new-invoice-2", invoice_number: "WPC-2026-0101", status: "draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Create draft", exact: true }));
    await waitFor(() => expect(requests.some(request => request.key === key)).toBe(true));
    expect(requests.find(request => request.key === key).body).not.toHaveProperty("expected_discount_stacking");
  });

  // Same binding on the EDIT path — a save whose line_items changed and
  // carries a discount pick must also bind the confirmed gate state.
  it("an edit save that changes discounted line items sends expected_discount_stacking too", async () => {
    rows = [{ ...invoice, status: "draft" }];
    overrides.set("GET /api/admin/discounts", () => response({ discounts: [
      { id: "ten-pct", name: "Ten Percent", discount_type: "percentage", amount: 10, is_active: true, show_in_invoices: true },
    ] }));
    overrides.set("GET /api/admin/discounts/stacking", () => response({ enabled: true }));
    await openPage(); await expand();
    fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
    fireEvent.change(await screen.findByLabelText("Add a discount"), { target: { value: "Ten" } });
    fireEvent.click(await screen.findByRole("button", { name: /Ten Percent/ }));
    const key = `PUT /api/admin/invoices/${invoice.id}`;
    overrides.set(key, () => response({ ...rows[0], status: "draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(requests.some(request => request.key === key)).toBe(true));
    expect(requests.find(request => request.key === key).body.expected_discount_stacking).toBe(true);
  });

  // Codex pre-push audit P1 (round 5 on PR #4655, addendum): the SUBMIT-time
  // freshness probe stackingStillFresh() issues must run ONLY when this
  // save actually changes line_items — a due-date/notes-only edit on an
  // invoice that already carries a discount line must succeed even while
  // /api/admin/discounts/stacking is failing (the component's own mount-time
  // poll for the preview still calls it once, fails closed, and is
  // unrelated to this submit-time gate — this pins that the SAVE itself
  // never depends on that endpoint when line_items isn't being sent).
  it("a notes-only edit on an already-discounted invoice still saves while the probe is down", async () => {
    const discountedInvoice = {
      ...invoice,
      status: "draft",
      line_items: [
        { client_id: "line-1", description: "Quarterly pest control", quantity: 1, unit_price: 120, amount: 120 },
        { client_id: "d1", _kind: "discount", discount_id: "ten-pct", discount_for: "line-1", description: "Ten Percent", quantity: 1, unit_price: -12, amount: -12 },
      ],
    };
    rows = [discountedInvoice];
    overrides.set(`GET /api/admin/invoices/${invoice.id}`, () => response(discountedInvoice));
    overrides.set("GET /api/admin/discounts/stacking", () => response({ error: "stacking probe down" }, 503));
    await openPage(); await expand();
    fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
    fireEvent.change(await screen.findByLabelText("Notes (optional)"), { target: { value: "Notes-only edit" } });
    const key = `PUT /api/admin/invoices/${invoice.id}`;
    overrides.set(key, () => response({ ...discountedInvoice, status: "draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(requests.some(request => request.key === key)).toBe(true));
    expect(screen.queryByText(/Discount rules just changed/)).not.toBeInTheDocument();
    const saved = requests.find(request => request.key === key).body;
    expect(saved).not.toHaveProperty("line_items");
    expect(saved).not.toHaveProperty("expected_discount_stacking");
  });

  // Same discounted invoice, same failing probe — but this save DOES
  // change line_items (adds another discount pick), so the probe is
  // required and its failure must still refuse the save.
  it("an edit that changes discounted line items on the same invoice is still refused while the probe is down", async () => {
    const discountedInvoice = {
      ...invoice,
      status: "draft",
      line_items: [
        { client_id: "line-1", description: "Quarterly pest control", quantity: 1, unit_price: 120, amount: 120 },
        { client_id: "d1", _kind: "discount", discount_id: "ten-pct", discount_for: "line-1", description: "Ten Percent", quantity: 1, unit_price: -12, amount: -12 },
      ],
    };
    rows = [discountedInvoice];
    overrides.set(`GET /api/admin/invoices/${invoice.id}`, () => response(discountedInvoice));
    overrides.set("GET /api/admin/discounts", () => response({ discounts: [
      { id: "twenty-fixed", name: "Twenty Dollars", discount_type: "fixed_amount", amount: 20, is_active: true, show_in_invoices: true },
    ] }));
    overrides.set("GET /api/admin/discounts/stacking", () => response({ error: "stacking probe down" }, 503));
    await openPage(); await expand();
    fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
    fireEvent.change(screen.getAllByLabelText("Price ($)")[0], { target: { value: "150" } });
    const key = `PUT /api/admin/invoices/${invoice.id}`;
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findAllByText(/Discount rules just changed/)).not.toHaveLength(0);
    expect(requests.some(request => request.key === key)).toBe(false);
  });

  // Codex pre-push audit P1 (round 6 on PR #4655): freeze only client_ids
  // that were ACTUALLY persisted — a legacy catalog-backed discount item
  // saved with NO client_id of its own gets one synthesized purely for
  // React/reprice bookkeeping; that synthetic id must never be treated as
  // persisted, or the preview would keep a $10 discount frozen after its
  // $100 parent line is edited to $200, while the server (which never
  // sees the synthetic id) correctly recomputes $20 — client and server
  // must agree.
  it("a legacy discount item with no stored client_id recomputes live on a price edit, matching the server", async () => {
    const legacyInvoice = {
      ...invoice,
      status: "draft",
      line_items: [
        { client_id: "line-1", description: "Quarterly pest control", quantity: 1, unit_price: 100, amount: 100 },
        // No client_id at all — a legacy row from before this field existed.
        { _kind: "discount", discount_id: "ten-pct", discount_for: "line-1", description: "Ten Percent", quantity: 1, unit_price: -10, amount: -10 },
      ],
    };
    rows = [legacyInvoice];
    overrides.set(`GET /api/admin/invoices/${invoice.id}`, () => response(legacyInvoice));
    overrides.set("GET /api/admin/discounts", () => response({ discounts: [
      { id: "ten-pct", name: "Ten Percent", discount_type: "percentage", amount: 10, is_active: true, show_in_invoices: true },
    ] }));
    overrides.set("GET /api/admin/discounts/stacking", () => response({ enabled: true }));
    await openPage(); await expand();
    fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
    const priceInputs = await screen.findAllByLabelText("Price ($)");
    fireEvent.change(priceInputs[0], { target: { value: "200" } });
    // Before this fix the aggregate (and, since round 6, the row's own
    // Credit ($) field too — repriceAllFreshDiscounts now resyncs a fresh
    // sibling on ANY price edit) stayed frozen at $10 (10% of the OLD
    // $100), disagreeing with the server, which never sees the synthetic
    // client_id and always recomputes to $20 (10% of the new $200). Both
    // surfaces now show -$20.00, so at least one match is the proof.
    await waitFor(() => {
      expect(screen.getAllByText("-$20.00").length).toBeGreaterThan(0);
    });
  });

  // Codex pre-push audit P2 (round 6 on PR #4655): the picker's own
  // conflict check must include a PERSISTED discount whose catalog row is
  // now retired/hidden — not only active rows — or an operator could pick
  // a second same-group discount that previews fine and only 400s on Save.
  it("a retired persisted Silver still hides Gold in the picker (not just at Save)", async () => {
    const tieredInvoice = {
      ...invoice,
      status: "draft",
      line_items: [
        { client_id: "line-1", description: "Quarterly pest control", quantity: 1, unit_price: 100, amount: 100 },
        { client_id: "d1", _kind: "discount", discount_id: "silver-id", discount_for: "line-1", description: "WaveGuard Silver", quantity: 1, unit_price: -10, amount: -10 },
      ],
    };
    rows = [tieredInvoice];
    overrides.set(`GET /api/admin/invoices/${invoice.id}`, () => response(tieredInvoice));
    // The server's own GET /api/admin/discounts returns EVERY row,
    // retired included — only the picker's SELECTABLE list narrows it.
    overrides.set("GET /api/admin/discounts", () => response({ discounts: [
      { id: "silver-id", name: "WaveGuard Silver", discount_type: "percentage", amount: 10, is_active: false, show_in_invoices: false, stack_group: "tier", is_stackable: false },
      { id: "gold-id", name: "WaveGuard Gold", discount_type: "percentage", amount: 15, is_active: true, show_in_invoices: true, stack_group: "tier", is_stackable: false },
    ] }));
    overrides.set("GET /api/admin/discounts/stacking", () => response({ enabled: true }));
    await openPage(); await expand();
    fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
    fireEvent.change(await screen.findByLabelText("Add a discount"), { target: { value: "Wave" } });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /WaveGuard Gold/ })).not.toBeInTheDocument();
    });
  });

  // Codex pre-push audit P0 (round 6 on PR #4655, post-push — Codex
  // itself, not the Claude fallback): removing a discount that was
  // clamping a sibling to $0 must reprice that sibling back up before
  // submit — not leave it at its stale $0 (which the submit filter would
  // then silently drop from the POST entirely).
  it("removing a $100 credit reprices a clamped 10% sibling back to $10, and the POST carries it", async () => {
    overrides.set("GET /api/admin/discounts", () => response({ discounts: [
      { id: "ten-pct", name: "Ten Percent", discount_type: "percentage", amount: 10, is_active: true, show_in_invoices: true },
      { id: "hundred-fixed", name: "Hundred Dollars", discount_type: "fixed_amount", amount: 100, is_active: true, show_in_invoices: true },
    ] }));
    overrides.set("GET /api/admin/discounts/stacking", () => response({ enabled: true }));
    await openPage(); fireEvent.click(screen.getByRole("button", { name: "Create invoice", exact: true }));
    fireEvent.change(screen.getByLabelText("Find customer"), { target: { value: "Avery" } });
    fireEvent.click(await screen.findByRole("button", { name: /Avery Example/ }));
    fireEvent.change(screen.getByLabelText("Service", { exact: true }), { target: { value: "Quarterly pest control" } });
    fireEvent.change(screen.getByLabelText("Price ($)"), { target: { value: "100" } });
    fireEvent.change(await screen.findByLabelText("Add a discount"), { target: { value: "Ten" } });
    fireEvent.click(await screen.findByRole("button", { name: /Ten Percent/ }));
    fireEvent.change(await screen.findByLabelText("Add a discount"), { target: { value: "Hundred" } });
    fireEvent.click(await screen.findByRole("button", { name: /Hundred Dollars/ }));
    // The $100 fixed credit (canonical: fixed credits first) fully
    // consumes the line, clamping the 10% row to $0.
    await waitFor(() => {
      const creditValues = screen.getAllByLabelText("Credit ($)").map((el) => el.value);
      expect(creditValues).toContain("-100");
      // The clamped-to-$0 row's own field renders blank (value={item.unit_price
      // || ""} treats -0 as falsy) — a separate, pre-existing display quirk,
      // not this fix's concern. The aggregate total below is the proof this
      // row is genuinely clamped to $0 right now.
      expect(creditValues).toContain("");
    });
    // Remove the $100 fixed credit — the 10% row must reprice back to $10.
    // Slice 8 of #4405: a discount row's own remove button now reads
    // "Remove discount" (was "Remove line item" for every row alike).
    const removeButtons = screen.getAllByRole("button", { name: /^Remove (line item|discount)$/ });
    fireEvent.click(removeButtons[removeButtons.length - 1]);
    await waitFor(() => {
      expect(screen.getByLabelText("Credit ($)").value).toBe("-10");
    });
    fireEvent.change(screen.getByLabelText("Send", { exact: true }), { target: { value: "draft" } });
    const key = "POST /api/admin/invoices";
    overrides.set(key, () => response({ id: "new-invoice-3", invoice_number: "WPC-2026-0102", status: "draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Create draft", exact: true }));
    await waitFor(() => expect(requests.some(request => request.key === key)).toBe(true));
    const posted = requests.find(request => request.key === key).body;
    const discountLine = posted.lineItems.find((i) => i._kind === "discount");
    expect(discountLine).toBeDefined();
    expect(discountLine.amount).toBe(-10);
  });
});
