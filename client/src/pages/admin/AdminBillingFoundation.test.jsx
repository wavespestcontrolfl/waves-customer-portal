// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UiSurface } from "../../components/ui";
import BillingRecoveryPage from "./BillingRecoveryPage";
import PayersPage from "./PayersPage";
import PayerDetailSheet from "./PayerDetailSheet";
import PayerArAgingDialog from "./PayerArAgingDialog";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const payer = { id: 42, display_name: "Example payer", payment_terms: "net30", active: true };
const statement = { id: 71, status: "sent", total: 240, invoice_count: 1 };
const ar = { summary: { statement_count: 0 } };

describe("Admin billing failure and draft boundaries", () => {
  it("does not turn a failed recovery read into zero balances or empty queues; safe retry restores data", async () => {
    let fail = true;
    const fetch = vi.fn(async (url) => {
      if (url.includes("/leaks?")) return fail ? response({ error: "Recovery unavailable" }, 503)
        : response({ summary: { leak_dollars: 0, review_dollars: 0, leak_visits: 0, leak_customers: 0, review_visits: 0 }, leaks: [], needs_review: [] });
      if (url.endsWith("/aging")) return response({ total_outstanding: 0, total_overdue: 0, invoice_count: 0, aging: {}, top_balances: [] });
      return response({ accounts: [], count: 0, atRisk: 0 });
    });
    vi.stubGlobal("fetch", fetch);
    render(<BillingRecoveryPage />);
    await screen.findByText("Recovery unavailable");
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.queryByText("No outstanding balances.")).not.toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("No outstanding balances.");
    expect(screen.getAllByText("$0.00").length).toBeGreaterThan(0);
    expect(fetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it("keeps a payer save draft and its payload after failure, and suppresses repeated submission while pending", async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const fetch = vi.fn(async (_url, options) => options?.method === "POST" ? pending : response({ payers: [] }));
    vi.stubGlobal("fetch", fetch);
    render(<PayersPage />);
    fireEvent.click(screen.getByRole("button", { name: "New payer" }));
    const dialog = within(screen.getByRole("dialog", { name: "New payer" }));
    fireEvent.change(dialog.getByLabelText(/Payer name/), { target: { value: "Example payer" } });
    fireEvent.change(dialog.getByLabelText("Payment terms"), { target: { value: "net30" } });
    fireEvent.change(dialog.getByLabelText("Notes"), { target: { value: "Keep this draft" } });
    const save = dialog.getByRole("button", { name: "Save payer" });
    act(() => { fireEvent.click(save); fireEvent.click(save); });
    expect(save).toBeDisabled();
    expect(dialog.getByLabelText("Notes")).toBeDisabled();
    expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    await act(async () => release(response({ error: "Payer save failed" }, 503)));
    await dialog.findByText("Payer save failed");
    expect(dialog.getByLabelText("Notes")).toHaveValue("Keep this draft");
    expect(dialog.getByLabelText("Payment terms")).toHaveValue("net30");
    expect(save).toBeEnabled();
    const write = fetch.mock.calls.find(([, options]) => options?.method === "POST");
    expect(write[0]).toBe("/api/admin/payers");
    expect(JSON.parse(write[1].body)).toEqual({ display_name: "Example payer", company_name: "", ap_email: "", ap_phone: "", billing_address_line1: "", billing_city: "", billing_state: "", billing_zip: "", payment_terms: "net30", requires_po: false, tax_exempt: false, tax_exempt_cert: "", notes: "Keep this draft", active: true });
  });

  it.each(["change window", "mark free"])("clears a previous Bill failure when the operator chooses to %s", async (nextAction) => {
    const fetch = vi.fn(async (url, options) => {
      if (options?.method === "POST") return url.endsWith("/bill") ? response({ error: "Invoice failed" }, 503) : response({ ok: true });
      if (url.includes("/leaks?")) return response({ summary: {}, leaks: [{ scheduled_service_id: "visit-a", customer: "Avery Example", price: 120, billable: true }] });
      if (url.endsWith("/aging")) return response({ aging: {}, top_balances: [] });
      return response({ accounts: [], count: 0, atRisk: 0 });
    });
    vi.stubGlobal("fetch", fetch);
    render(<BillingRecoveryPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Bill", exact: true }));
    await screen.findByText("Invoice failed");
    if (nextAction === "change window") {
      fireEvent.change(screen.getByLabelText("Visit window"), { target: { value: "60" } });
      await screen.findByRole("button", { name: "Bill", exact: true });
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Mark free", exact: true }));
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Mark free", exact: true }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    }
    expect(screen.queryByText("Invoice failed")).not.toBeInTheDocument();
  });

  it("starts a new free-visit draft when opening another visit after cancelling", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (url.includes("/leaks?")) return response({ summary: {}, leaks: [
        { scheduled_service_id: "visit-a", customer: "Avery Example", price: 120, billable: true },
        { scheduled_service_id: "visit-b", customer: "Jordan Example", price: 120, billable: true },
      ] });
      if (url.endsWith("/aging")) return response({ aging: {}, top_balances: [] });
      return response({ accounts: [], count: 0, atRisk: 0 });
    }));
    render(<BillingRecoveryPage />);
    const actions = await screen.findAllByRole("button", { name: "Mark free", exact: true });
    fireEvent.click(actions[0]);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Other (see note)" } });
    fireEvent.change(screen.getByLabelText("Optional note"), { target: { value: "Visit A only" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(actions[1]);
    expect(screen.getByLabelText("Optional note")).toHaveValue("");
    expect(screen.getByLabelText("Reason")).toHaveValue("Warranty callback / re-treat");
    expect(screen.getByRole("dialog")).toHaveTextContent("Jordan Example");
  });

  it("distinguishes payer read failures from an empty directory and retries only the read", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ error: "Directory unavailable" }, 503)).mockResolvedValue(response({ payers: [payer] }));
    vi.stubGlobal("fetch", fetch);
    render(<PayersPage />);
    await screen.findByText("Directory unavailable");
    expect(screen.queryByText(/No payers yet/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("button", { name: payer.display_name });
    expect(fetch.mock.calls.every(([url, options]) => url === "/api/admin/payers?" && !options?.method)).toBe(true);
  });

  it("retains failed offline-payment fields through tab navigation and clears them for a different payer", async () => {
    const fetch = vi.fn(async (url, options) => {
      if (options?.method === "POST") return response({ error: "Reconciliation unavailable" }, 503);
      if (url.endsWith("/statements")) return response({ statements: [statement] });
      if (url.endsWith("/ar")) return response(ar);
      if (url.endsWith("/followups")) return response({ sequence: null });
      return response({ lines: [] });
    });
    vi.stubGlobal("fetch", fetch);
    const changed = vi.fn();
    const { rerender } = render(<UiSurface><PayerDetailSheet key={payer.id} payer={payer} onClose={vi.fn()} onChanged={changed} /></UiSurface>);
    fireEvent.click(await screen.findByRole("button", { name: /S-71/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Record offline payment" }));
    fireEvent.change(screen.getByLabelText("Method"), { target: { value: "wire" } });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "239.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Record", exact: true }));
    await screen.findByText("Reconciliation unavailable");
    expect(screen.getByLabelText("Amount")).toHaveValue("239.50");
    expect(changed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "AR / aging" }));
    expect(screen.queryByRole("textbox", { name: "Amount" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Statements" }));
    expect(screen.getByLabelText("Amount")).toHaveValue("239.50");
    expect(screen.getByLabelText("Method")).toHaveValue("wire");
    const write = fetch.mock.calls.find(([, options]) => options?.method === "POST");
    expect(write[0]).toBe("/api/admin/payers/42/statements/71/reconcile");
    expect(JSON.parse(write[1].body)).toEqual({ method: "wire", amount: 239.5 });
    rerender(<UiSurface><PayerDetailSheet key={43} payer={{ ...payer, id: 43 }} onClose={vi.fn()} onChanged={changed} /></UiSurface>);
    await screen.findByRole("button", { name: /S-71/ });
    expect(screen.queryByLabelText("Amount")).not.toBeInTheDocument();
  });

  it("keeps statement-authorized reminder controls available when the status read fails", async () => {
    const fetch = vi.fn(async (url, options) => {
      if (options?.method === "POST") return response({ error: "Reminder temporarily unavailable" }, 503);
      if (url.endsWith("/statements")) return response({ statements: [statement] });
      if (url.endsWith("/ar")) return response(ar);
      if (url.endsWith("/followups")) return response({ error: "Reminder status unavailable" }, 503);
      return response({ lines: [] });
    });
    vi.stubGlobal("fetch", fetch);
    render(<UiSurface><PayerDetailSheet payer={payer} onClose={vi.fn()} onChanged={vi.fn()} /></UiSurface>);
    fireEvent.click(await screen.findByRole("button", { name: /S-71/ }));
    await screen.findByText("Reminder status unavailable");
    expect(screen.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Send reminder now" }));
    await screen.findByText("Reminder temporarily unavailable");
    expect(fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toEqual([
      ["/api/admin/payers/42/statements/71/followups/send-now", expect.objectContaining({ method: "POST", body: "{}" })],
    ]);
  });

  it("reports failed payer AR as unavailable, while a successful zero-count response is empty", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ error: "AR unavailable" }, 503)).mockResolvedValue(response({ statement_count: 0, payers: [] }));
    vi.stubGlobal("fetch", fetch);
    render(<UiSurface><PayerArAgingDialog onClose={vi.fn()} /></UiSurface>);
    await screen.findByText("AR unavailable");
    expect(screen.queryByText(/No outstanding payer statements/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText(/No outstanding payer statements/);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });
});
