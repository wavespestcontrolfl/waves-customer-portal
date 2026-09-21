// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminInvoicesPage from "./AdminInvoicesPage";

const customer = { id: "customer-example", first_name: "Avery", last_name: "Example", email: "avery@example.invalid", phone: "9415550100", property_type: "residential" };
const invoice = { ...customer, customer_id: customer.id, id: "invoice-example", invoice_number: "WPC-QA-001", status: "sent", total: 120, due_date: "2099-12-31", service_date: "2026-09-08", line_items: [{ description: "Quarterly pest control", quantity: 1, unit_price: 120, amount: 120 }], notes: "Existing notes" };
const recipients = { customerName: "Avery Example", emailRecipient: { name: "Example Accounts", email: "billing@example.invalid", role: "billing" }, smsRecipient: { phone: customer.phone } };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let overrides, requests, unmatched, rows;

beforeEach(() => {
  overrides = new Map(); requests = []; unmatched = []; rows = [{ ...invoice }];
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
});
