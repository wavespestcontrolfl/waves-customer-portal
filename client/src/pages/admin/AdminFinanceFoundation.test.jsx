// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BankingPage from "./BankingPage";
import TaxPage from "./TaxPage";
const response = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
let requests, overrides;
const defaults = {
  "/api/admin/feature-flags": { flags: {} },
  "/api/admin/banking/balance": {
    total_available: 1500,
    total_pending: 100,
    total_instant_available: 500,
  },
  "/api/admin/banking/stats": { mtd_deposited: 100, payout_count: 1 },
  "/api/admin/banking/payouts": { payouts: [], pages: 1 },
  "/api/admin/banking/reconciliation": {
    payouts: [
      {
        id: "payout-example",
        amount: 120,
        expected_amount: 120,
        reconciled: false,
      },
    ],
  },
  "/api/admin/tax/dashboard": {
    ytdTaxCollected: 0,
    expenses: { total: 0, count: 0 },
    equipment: { bookValue: 0, count: 0 },
    nextDeadlines: [],
  },
  "/api/admin/tax/bank-import/status": { enabled: false },
  "/api/admin/tax/pnl": {},
  "/api/admin/tax/accounts-receivable": {
    summary: { total: 0, count: 0 },
    invoices: [],
  },
  "/api/admin/tax/rates": { rates: [] },
  "/api/admin/tax/service-taxability": {
    services: [
      {
        id: "service-example",
        serviceLabel: "Example pest control",
        serviceKey: "pest",
        isTaxable: true,
      },
    ],
  },
  "/api/admin/tax/expenses": { expenses: [], summary: [] },
  "/api/admin/tax/expense-categories": {
    categories: [{ id: "category-example", name: "Supplies", irsLine: "22" }],
  },
  "/api/admin/tax/equipment": { equipment: [] },
  "/api/admin/tax/filings": {
    filings: [
      {
        id: "filing-example",
        title: "Synthetic filing",
        dueDate: "2099-01-15",
        status: "upcoming",
        amountDue: 500,
      },
    ],
  },
  "/api/client-errors": {},
};
beforeEach(() => {
  requests = [];
  overrides = new Map();
  localStorage.clear();
  localStorage.setItem("waves_admin_token", "synthetic-token");
  localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  vi.stubGlobal(
    "prompt",
    vi.fn(() => "500"),
  );
  vi.stubGlobal("alert", vi.fn());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, options = {}) => {
      const url = new URL(String(input), "http://localhost"),
        key = `${options.method || "GET"} ${url.pathname}`;
      let body = null;
      if (options.body) body = JSON.parse(options.body);
      requests.push({ key, query: url.search, body });
      if (overrides.has(key)) return overrides.get(key)(body);
      if (Object.hasOwn(defaults, url.pathname))
        return response(defaults[url.pathname]);
      throw Error(`Unexpected fixture ${key}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function open(Component) {
  render(
    <MemoryRouter>
      <Component />
    </MemoryRouter>,
  );
}
function hold(key) {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  overrides.set(key, () => promise);
  return release;
}
const edit = (label, value) =>
  fireEvent.change(screen.getByLabelText(label, { exact: true }), {
    target: { value },
  });
async function bankDialog() {
  open(BankingPage);
  const buttons = await screen.findAllByRole("button", {
    name: "Standard Payout",
    exact: true,
  });
  await waitFor(() => expect(buttons.at(-1)).toBeEnabled());
  fireEvent.click(buttons.at(-1));
  return within(
    await screen.findByRole("dialog", { name: "Transfer Stripe Balance" }),
  );
}
async function taxSection(group, leaf) {
  fireEvent.click(
    screen
      .getByRole("navigation", { name: "Taxes section" })
      .querySelector(`[aria-current]`) ||
      screen.getByRole("heading", { name: "Taxes" }),
  );
  const nav = within(screen.getByRole("navigation", { name: "Taxes section" }));
  fireEvent.click(nav.getByRole("button", { name: group, exact: true }));
  if (leaf)
    fireEvent.click(
      await screen.findByRole("button", { name: leaf, exact: true }),
    );
}
describe("Finance workflow preservation", () => {
  it("keeps the payout amount and idempotency key on failed retry, with one in-flight write", async () => {
    const dialog = await bankDialog();
    fireEvent.change(dialog.getByLabelText("Payout Amount"), {
      target: { value: "125" },
    });
    const key = "POST /api/admin/banking/payouts/standard",
      release = hold(key);
    const submit = dialog.getByRole("button", { name: "Confirm Standard" });
    act(() => {
      fireEvent.click(submit);
      fireEvent.click(submit);
    });
    expect(requests.filter((r) => r.key === key)).toHaveLength(1);
    expect(dialog.getByLabelText("Payout Amount")).toBeDisabled();
    expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await act(async () =>
      release(response({ error: "Payout unavailable" }, 503)),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Payout unavailable",
    );
    expect(dialog.getByLabelText("Payout Amount")).toHaveValue(125);
    const first = requests.find((r) => r.key === key).body;
    expect(first).toEqual({
      amount: 125,
      idempotency_key: expect.stringMatching(/^spo_/),
    });
    overrides.set(key, () => response({ error: "Still unavailable" }, 503));
    fireEvent.click(submit);
    await screen.findByText(/Still unavailable/);
    expect(requests.filter((r) => r.key === key)[1].body).toEqual(first);
  });
  it("changes the payout retry key when the operator changes the amount or method", async () => {
    const dialog = await bankDialog();
    const key = "POST /api/admin/banking/payouts/standard";
    overrides.set(key, () => response({ error: "Declined" }, 503));
    fireEvent.click(dialog.getByRole("button", { name: "Confirm Standard" }));
    await screen.findByRole("alert");
    const first = requests.find((r) => r.key === key).body;
    fireEvent.change(dialog.getByLabelText("Payout Amount"), {
      target: { value: "100" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Confirm Standard" }));
    await waitFor(() =>
      expect(requests.filter((r) => r.key === key)).toHaveLength(2),
    );
    expect(
      requests.filter((r) => r.key === key)[1].body.idempotency_key,
    ).not.toBe(first.idempotency_key);
    await waitFor(() =>
      expect(dialog.getByLabelText("Payout Amount")).toBeEnabled(),
    );
    fireEvent.click(dialog.getByRole("button", { name: /Instant.*fee/ }));
    const instant = "POST /api/admin/banking/payouts/instant";
    overrides.set(instant, () => response({ error: "Declined" }, 503));
    fireEvent.click(dialog.getByRole("button", { name: "Confirm Instant" }));
    await waitFor(() =>
      expect(requests.some((r) => r.key === instant)).toBe(true),
    );
    expect(requests.find((r) => r.key === instant).body).toEqual({
      amount: 100,
      idempotency_key: expect.stringMatching(/^ipo_/),
    });
  });
  it("does not expose a zero balance or payout action after a failed balance read", async () => {
    overrides.set("GET /api/admin/banking/balance", () =>
      response({ error: "Balance unavailable" }, 503),
    );
    open(BankingPage);
    await screen.findByText(/Couldn't load balance/);
    screen
      .getAllByRole("button", { name: "Standard Payout", exact: true })
      .forEach((button) => expect(button).toBeDisabled());
    expect(
      screen.getByRole("button", { name: "Instant Payout", exact: true }),
    ).toBeDisabled();
    overrides.delete("GET /api/admin/banking/balance");
    fireEvent.click(screen.getByRole("button", { name: "Retry", exact: true }));
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("button", { name: "Standard Payout", exact: true })
          .at(-1),
      ).toBeEnabled(),
    );
  });
  it("retains reconciliation values and its original payload after failure", async () => {
    open(BankingPage);
    fireEvent.click(
      within(
        screen.getByRole("navigation", { name: "Banking section" }),
      ).getByRole("button", { name: "Reconciliation" }),
    );
    await screen.findByLabelText("Actual Amount");
    edit("Actual Amount", "119.50");
    edit("Notes", "Keep this note");
    const key = "POST /api/admin/banking/reconciliation/payout-example";
    overrides.set(key, () => response({ error: "Write unavailable" }, 503));
    fireEvent.click(
      screen.getByRole("button", { name: "Reconcile", exact: true }),
    );
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Notes")).toHaveValue("Keep this note");
    expect(requests.find((r) => r.key === key).body).toEqual({
      actual_amount: 119.5,
      notes: "Keep this note",
    });
  });
  it("keeps taxability confirmation and restores the enabled control after failure", async () => {
    open(TaxPage);
    await taxSection("Tax Setup", "Taxability");
    const control = await screen.findByRole("button", {
      name: /Example pest control/,
    });
    confirm.mockReturnValueOnce(false);
    fireEvent.click(control);
    expect(requests.filter((r) => r.key.startsWith("PUT"))).toHaveLength(0);
    await waitFor(() => expect(control).toBeEnabled());
    const key = "PUT /api/admin/tax/service-taxability/service-example";
    overrides.set(key, () => response({ error: "Update unavailable" }, 503));
    fireEvent.click(control);
    await screen.findByRole("alert");
    expect(control).toHaveTextContent("Taxable");
    expect(requests.find((r) => r.key === key).body).toEqual({
      isTaxable: false,
    });
  });
  it("retains a failed expense draft and blocks duplicate submission", async () => {
    open(TaxPage);
    await taxSection("Expenses");
    fireEvent.click(
      await screen.findByRole("button", { name: "+ Add Expense", exact: true }),
    );
    edit("Description *", "Synthetic expense");
    edit("Amount *", "85.50");
    edit("Date *", "2099-01-01");
    const key = "POST /api/admin/tax/expenses",
      release = hold(key);
    const button = screen.getByRole("button", { name: "Save", exact: true });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(requests.filter((r) => r.key === key)).toHaveLength(1);
    expect(screen.getByLabelText("Description *")).toBeDisabled();
    await act(async () =>
      release(response({ error: "Expense unavailable" }, 503)),
    );
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Description *")).toHaveValue(
      "Synthetic expense",
    );
    expect(requests.find((r) => r.key === key).body).toEqual({
      categoryId: "",
      description: "Synthetic expense",
      amount: 85.5,
      expenseDate: "2099-01-01",
      vendorName: "",
      paymentMethod: "card",
    });
  });
  it("renders failed expense reads with a safe retry instead of empty totals", async () => {
    overrides.set("GET /api/admin/tax/expenses", () =>
      response({ error: "Read unavailable" }, 503),
    );
    open(TaxPage);
    await taxSection("Expenses");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load expenses",
    );
    expect(
      screen.queryByText("Total Expenses", { exact: true }),
    ).not.toBeInTheDocument();
    overrides.delete("GET /api/admin/tax/expenses");
    fireEvent.click(
      screen.getByRole("button", { name: "Try again", exact: true }),
    );
    await screen.findByText("Total Expenses", { exact: true });
  });
  it("does not append an old page while a new bank-import filter is loading", async () => {
    const key = "GET /api/admin/tax/bank-import/transactions";
    const oldRow = { id: "old-row", description: "Previous filter row", status: "ignored", amount: 10 };
    const newRow = { ...oldRow, id: "new-row", description: "Filtered first page", status: "unmatched" };
    overrides.set("GET /api/admin/tax/bank-import/status", () => response({ enabled: true, counts: {} }));
    overrides.set("GET /api/admin/tax/bank-import/coverage", () => response({ months: [] }));
    overrides.set(key, () => response({ transactions: [oldRow], hasMore: true }));
    open(TaxPage);
    await taxSection("Expenses", "Bank Import");
    await screen.findByText(oldRow.description);
    const releaseFilter = hold(key);
    edit("Status", "unmatched");
    await screen.findByText("Loading bank transactions…");
    expect(screen.queryByRole("button", { name: "Load 200 more" })).not.toBeInTheDocument();
    expect(screen.queryByText(oldRow.description)).not.toBeInTheDocument();
    expect(requests.filter((r) => r.key === key).map((r) => r.query)).toEqual([
      "?limit=200&offset=0", "?limit=200&offset=0&status=unmatched",
    ]);
    await act(async () => releaseFilter(response({ transactions: [newRow], hasMore: true })));
    await screen.findByText(newRow.description);
    const releaseMore = hold(key);
    const more = screen.getByRole("button", { name: "Load 200 more" });
    act(() => { fireEvent.click(more); fireEvent.click(more); });
    expect(more).toBeDisabled();
    expect(requests.filter((r) => r.key === key)).toHaveLength(3);
    expect(requests.filter((r) => r.key === key).at(-1).query).toBe("?limit=200&offset=1&status=unmatched");
    await act(async () => releaseMore(response({ transactions: [{ ...newRow, id: "next-row", description: "Filtered next page" }], hasMore: false })));
    await screen.findByText("Filtered next page");
    expect(screen.getByText(newRow.description)).toBeInTheDocument();
    expect(screen.queryByText(oldRow.description)).not.toBeInTheDocument();
  });
  it("keeps the bank-import gate closed on a failed status read", async () => {
    overrides.set("GET /api/admin/tax/bank-import/status", () =>
      response({ error: "Read unavailable" }, 503),
    );
    open(TaxPage);
    await taxSection("Expenses");
    await screen.findByRole("button", { name: "+ Add Expense" });
    expect(
      screen.queryByRole("button", { name: "Bank Import", exact: true }),
    ).not.toBeInTheDocument();
  });
});
