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
        // the route returns stripe_payouts.*: a midnight-UTC arrival marker
        arrival_date: "2026-07-21T00:00:00.000Z",
        created_at_stripe: "2026-07-19T14:05:00.000Z",
      },
    ],
  },
  "/api/admin/banking/cash-flow": {
    period: { start: "2026-07-01", end: "2026-07-31" },
    summary: {
      total_revenue: 0,
      total_expenses: 0,
      stripe_fees: 0,
      total_payouts: 0,
      operating_cash_flow: 0,
      bank_balance_delta: 0,
      net_cash_flow: 0,
      payment_count: 0,
      payout_count: 0,
      total_in: 0,
      total_out: 0,
      net: 0,
    },
    daily: [],
    periods: [],
  },
  "/api/admin/tax/dashboard": {
    ytdTaxCollected: 0,
    expenses: { total: 0, count: 0 },
    equipment: { bookValue: 0, count: 0 },
    nextDeadlines: [],
  },
  "/api/admin/tax/bank-import/status": { enabled: false },
  "/api/admin/tax/bank-import/ledger/status": { enabled: false },
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
  it("returns focus to the header payout opener when clicking does not focus it", async () => {
    open(BankingPage);
    const openers = await screen.findAllByRole("button", {
      name: "Standard Payout",
      exact: true,
    });
    await waitFor(() => expect(openers[0]).toBeEnabled());
    openers[1].focus();
    fireEvent.click(openers[0]);
    const dialog = within(
      await screen.findByRole("dialog", {
        name: "Transfer Stripe Balance",
      }),
    );
    fireEvent.click(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    );
    await waitFor(() => expect(openers[0]).toHaveFocus());
  });
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
  it("shows each reconciliation payout's arrival day", async () => {
    open(BankingPage);
    fireEvent.click(
      within(
        screen.getByRole("navigation", { name: "Banking section" }),
      ).getByRole("button", { name: "Reconciliation" }),
    );
    await screen.findByLabelText("Actual Amount");
    expect(screen.getByText("7/21/2026")).toBeInTheDocument();
  });
  it("shows a failed cash-flow read as unavailable, and a real empty period as $0.00", async () => {
    const key = "GET /api/admin/banking/cash-flow";
    overrides.set(key, () =>
      response({ error: "the cash-flow read failed" }, 500),
    );
    open(BankingPage);
    fireEvent.click(
      within(
        screen.getByRole("navigation", { name: "Banking section" }),
      ).getByRole("button", { name: "Cashflow" }),
    );
    await screen.findByText(/Couldn't load cash flow \(the cash-flow read failed\)/);
    expect(screen.queryByText("Revenue In")).toBeNull();
    overrides.delete(key);
    fireEvent.click(screen.getByRole("button", { name: "Retry", exact: true }));
    const label = await screen.findByText("Revenue In");
    expect(label.parentElement).toHaveTextContent("$0.00");
  });
  it("keeps taxability confirmation and restores the enabled control after failure", async () => {
    open(TaxPage);
    await taxSection("Setup", "Taxability");
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
  it.each([
    [{}, "0"],
    [{ matched_expense: 2, matched_payout: 3 }, "5"],
  ])(
    "keeps unavailable matched counts distinct from a loaded total (%j)",
    async (counts, expected) => {
      const key = "GET /api/admin/tax/bank-import/status";
      overrides.set(key, () => response({ enabled: true, counts: {} }));
      overrides.set("GET /api/admin/tax/bank-import/coverage", () =>
        response({ months: [] }),
      );
      overrides.set("GET /api/admin/tax/bank-import/transactions", () =>
        response({ transactions: [], hasMore: false }),
      );
      open(TaxPage);
      await taxSection("Expenses");
      await screen.findByRole("button", { name: "Import", exact: true });
      const release = hold(key);
      await taxSection("Expenses", "Import");
      const matched = within(
        (await screen.findByText("Matched", { exact: true })).parentElement,
      );
      expect(matched.getByText("—", { exact: true })).toBeInTheDocument();
      await act(async () =>
        release(response({ error: "Counts unavailable" }, 503)),
      );
      const error = await screen.findByRole("alert");
      expect(error).toHaveTextContent("Counts unavailable");
      expect(matched.getByText("—", { exact: true })).toBeInTheDocument();
      overrides.set(key, () => response({ enabled: true, counts }));
      fireEvent.click(
        within(error).getByRole("button", { name: "Try again", exact: true }),
      );
      await waitFor(() =>
        expect(
          matched.getByText(expected, { exact: true }),
        ).toBeInTheDocument(),
      );
    },
  );
  it("does not append an old page while a new bank-import filter is loading", async () => {
    const key = "GET /api/admin/tax/bank-import/transactions";
    const oldRow = { id: "old-row", description: "Previous filter row", status: "ignored", amount: 10 };
    const newRow = { ...oldRow, id: "new-row", description: "Filtered first page", status: "unmatched" };
    overrides.set("GET /api/admin/tax/bank-import/status", () => response({ enabled: true, counts: {} }));
    overrides.set("GET /api/admin/tax/bank-import/coverage", () => response({ months: [] }));
    overrides.set(key, () => response({ transactions: [oldRow], hasMore: true }));
    open(TaxPage);
    await taxSection("Expenses", "Import");
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
  it("sets up a Plaid connection: an existing CSV label continues its series the day after its last row", async () => {
    overrides.set("GET /api/admin/tax/bank-import/status", () =>
      response({ enabled: true, plaidEnabled: true, counts: {} }));
    overrides.set("GET /api/admin/tax/bank-import/coverage", () => response({ months: [] }));
    overrides.set("GET /api/admin/tax/bank-import/transactions", () => response({ transactions: [], hasMore: false }));
    overrides.set("GET /api/admin/tax/bank-import/plaid/status", () => response({
      configured: true, tokenKey: true, env: "sandbox",
      existingLabels: [{ label: "capone-checking", accountType: "bank", lastDate: "2026-09-10", rows: 42 }],
      items: [{
        id: "item-1", institutionName: "Synthetic Bank", status: "setup", lastSyncedAt: null, lastError: null,
        accounts: [{
          id: "acct-1", name: "Checking", mask: "0001", plaidType: "depository", plaidSubtype: "checking",
          accountLabel: "synthetic-bank-checking-0001", accountType: "bank", syncFrom: "2026-01-01", enabled: true,
        }],
      }],
    }));
    overrides.set("POST /api/admin/tax/bank-import/plaid/items/item-1/setup", () =>
      response({ success: true, sync: { inserted: 3, updated: 0, deleted: 0, flagged: 0, skips: { pending: 2 }, complete: true, matching: null, matchingError: null } }));
    open(TaxPage);
    await taxSection("Expenses", "Import");
    const label = await screen.findByDisplayValue("synthetic-bank-checking-0001");
    fireEvent.change(label, { target: { value: "capone-checking" } });
    expect(await screen.findByText("42 rows already imported, last 2026-09-10")).toBeInTheDocument();
    expect(screen.getByDisplayValue("2026-09-11")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save and sync" }));
    await screen.findByText("Synced: 3 new");
    expect(requests.find((r) => r.key === "POST /api/admin/tax/bank-import/plaid/items/item-1/setup").body).toEqual({
      accounts: [{ id: "acct-1", accountLabel: "capone-checking", accountType: "bank", syncFrom: "2026-09-11", enabled: true }],
    });
  });
  it("shows a bank correction on a reviewed row and applies it only once the row is unlinked", async () => {
    overrides.set("GET /api/admin/tax/bank-import/status", () =>
      response({ enabled: true, plaidEnabled: true, bankChanges: 2, counts: {} }));
    overrides.set("GET /api/admin/tax/bank-import/coverage", () => response({ months: [] }));
    overrides.set("GET /api/admin/tax/bank-import/plaid/status", () =>
      response({ configured: true, tokenKey: true, env: "sandbox", existingLabels: [], items: [] }));
    const base = { txn_date: "2026-09-05", account_label: "card", account_type: "card", direction: "debit", amount: 10 };
    overrides.set("GET /api/admin/tax/bank-import/transactions", () => response({
      hasMore: false,
      transactions: [
        { ...base, id: "row-linked", description: "Linked purchase", status: "matched_expense",
          suggestion: { plaidModified: { amount: 12.34, direction: "debit", txn_date: "2026-09-06", description: "FIXED" } } },
        { ...base, id: "row-created", description: "Created purchase", status: "created_expense",
          suggestion: { plaidModified: { amount: 8, direction: "debit", txn_date: "2026-09-04", description: "FIXED 3" } } },
        { ...base, id: "row-open", description: "Open purchase", status: "unmatched",
          suggestion: { plaidModified: { amount: 9, direction: "debit", txn_date: "2026-09-07", description: "FIXED 2" } } },
        { ...base, id: "row-plain", description: "Plain purchase", status: "unmatched", suggestion: null },
      ],
    }));
    overrides.set("POST /api/admin/tax/bank-import/plaid/rows/row-open/bank-change", () => response({ success: true }));
    open(TaxPage);
    await taxSection("Expenses", "Import");
    expect(await screen.findByText(/The bank changed this to \$12\.34 debit on 2026-09-06 — unlink to apply it\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Changed by bank 2" })).toBeInTheDocument();
    expect(screen.getByText(/\$8\.00 debit on 2026-09-04 — edit the expense created from this row to match, then dismiss\./)).toBeInTheDocument();
    const apply = screen.getAllByRole("button", { name: "Apply bank's change" });
    expect(apply).toHaveLength(1); // only the unlinked row
    // the unlinked row still holds the pre-correction values: the server
    // refuses claims on it, so only the plain row offers Create expense
    expect(screen.getAllByRole("button", { name: "Create expense" })).toHaveLength(1);
    expect(
      within(screen.getByText("Open purchase").closest("tr")).queryByRole("button", { name: "Create expense" }),
    ).not.toBeInTheDocument();
    fireEvent.click(apply[0]);
    await waitFor(() =>
      expect(requests.find((r) => r.key === "POST /api/admin/tax/bank-import/plaid/rows/row-open/bank-change")?.body)
        .toEqual({ action: "apply", expected: { plaidModified: { amount: 9, direction: "debit", txn_date: "2026-09-07", description: "FIXED 2" }, plaidRemoved: null } }));
  });
  it("shows the ledger's note under a parked row and on its Create expense button", async () => {
    overrides.set("GET /api/admin/tax/bank-import/status", () =>
      response({ enabled: true, plaidEnabled: false, bankChanges: 0, counts: {} }));
    overrides.set("GET /api/admin/tax/bank-import/coverage", () => response({ months: [] }));
    const base = { txn_date: "2025-03-14", account_label: "ledger-3098", account_type: "bank", direction: "debit", amount: 61.5, status: "unmatched" };
    const note = 'no category in the portal for line 16b; the ledger says interest: "Card interest". Pick the category knowingly, or leave it for the return';
    overrides.set("GET /api/admin/tax/bank-import/transactions", () => response({
      hasMore: false,
      transactions: [
        { ...base, id: "row-parked", description: "INTEREST CHARGE ON PURCHASES", suggestion: { review: true, note } },
        { ...base, id: "row-near", description: "ACME SUPPLY 4471", suggestion: { review: true, manualLink: true, note: "an expense of the same amount already in the portal: \"Acme Supply\" dated the same day: link this row to that expense in Bank Import, or create the expense there if it is a different purchase", categoryId: "cat-1", categoryName: "Supplies", categorySource: "ledger" } },
        { ...base, id: "row-plain", description: "Plain purchase", suggestion: null },
      ],
    }));
    open(TaxPage);
    await taxSection("Expenses", "Import");
    const parked = (await screen.findByText("INTEREST CHARGE ON PURCHASES")).closest("tr");
    expect(within(parked).getByText(/no category in the portal for line 16b/)).toBeInTheDocument();
    // the note reads at the 14px floor, and a category the ledger carried is named as the ledger's, not the AI's
    expect(within(parked).getByText(/no category in the portal for line 16b/).className).toMatch(/\btext-sm\b/);
    const near = screen.getByText("ACME SUPPLY 4471").closest("tr");
    expect(within(near).getByText("Ledger: Supplies")).toBeInTheDocument();
    expect(within(parked).getByRole("button", { name: "Create expense" }).getAttribute("title")).toMatch(/no category in the portal for line 16b/);
    const plain = screen.getByText("Plain purchase").closest("tr");
    expect(within(plain).queryByText(/no category in the portal/)).not.toBeInTheDocument();
    expect(within(plain).getByRole("button", { name: "Create expense" }).getAttribute("title")).toBeNull();
  });
  it("keeps bank-change Dismiss and Disconnect reachable after the Plaid feed is switched off", async () => {
    overrides.set("GET /api/admin/tax/bank-import/status", () =>
      response({ enabled: true, plaidEnabled: false, bankChanges: 1, counts: {} }));
    overrides.set("GET /api/admin/tax/bank-import/coverage", () => response({ months: [] }));
    overrides.set("GET /api/admin/tax/bank-import/transactions", () => response({
      hasMore: false,
      transactions: [{ id: "row-gone", txn_date: "2026-09-05", account_label: "card", account_type: "card", direction: "debit",
        amount: 10, description: "Withdrawn purchase", status: "matched_expense", suggestion: { plaidRemoved: true } }],
    }));
    overrides.set("POST /api/admin/tax/bank-import/plaid/rows/row-gone/bank-change", () => response({ success: true }));
    // a connection still in place: listed with Disconnect only
    overrides.set("GET /api/admin/tax/bank-import/plaid/status", () => response({
      configured: true, tokenKey: true, env: "sandbox", existingLabels: [],
      items: [{ id: "item-1", institutionName: "Synthetic Bank", status: "active", tokenReadable: true, lastSyncedAt: null, lastError: null,
        accounts: [{ id: "acct-1", name: "Card", mask: "1234", accountLabel: "card", accountType: "card", syncFrom: "2026-09-01", enabled: true }] }],
    }));
    open(TaxPage);
    await taxSection("Expenses", "Import");
    expect(await screen.findByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(screen.getByText(/Live bank feeds are switched off/)).toBeInTheDocument();
    for (const name of ["Connect a bank", "Sync now", "Edit accounts"])
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(requests.find((r) => r.key === "POST /api/admin/tax/bank-import/plaid/rows/row-gone/bank-change")?.body)
        .toEqual({ action: "dismiss", expected: { plaidModified: null, plaidRemoved: true } }));
  });
  it("resumes Plaid Link on the Bank Import tab after a bank's OAuth redirect", async () => {
    overrides.set("GET /api/admin/tax/bank-import/status", () =>
      response({ enabled: true, plaidEnabled: true, counts: {} }));
    overrides.set("GET /api/admin/tax/bank-import/coverage", () => response({ months: [] }));
    overrides.set("GET /api/admin/tax/bank-import/transactions", () => response({ transactions: [], hasMore: false }));
    overrides.set("GET /api/admin/tax/bank-import/plaid/status", () =>
      response({ configured: true, tokenKey: true, env: "sandbox", existingLabels: [], items: [] }));
    overrides.set("POST /api/admin/tax/bank-import/plaid/connect", () => response({ success: true, itemId: "item-9" }));
    const create = vi.fn((config) => ({
      open: () => config.onSuccess("public-sandbox-1", { institution: { name: "Synthetic Bank" } }),
      destroy: () => {},
    }));
    vi.stubGlobal("Plaid", { create });
    localStorage.setItem("waves_plaid_link_resume", JSON.stringify({ linkToken: "link-sandbox-1", itemId: null }));
    window.history.pushState(null, "", "/admin/tax?oauth_state_id=state-1");
    try {
      open(TaxPage);
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(create.mock.calls[0][0]).toMatchObject({
        token: "link-sandbox-1",
        receivedRedirectUri: `${window.location.origin}/admin/tax?oauth_state_id=state-1`,
      });
      expect(window.location.search).toBe("");
      await waitFor(() =>
        expect(requests.find((r) => r.key === "POST /api/admin/tax/bank-import/plaid/connect")?.body)
          .toEqual({ publicToken: "public-sandbox-1", institutionName: "Synthetic Bank" }));
      expect(requests.some((r) => r.key === "POST /api/admin/tax/bank-import/plaid/link-token")).toBe(false);
      await waitFor(() => expect(localStorage.getItem("waves_plaid_link_resume")).toBeNull());
    } finally {
      localStorage.removeItem("waves_plaid_link_resume");
      window.history.replaceState(null, "", "/");
    }
  });
  const activePlaidItem = () => {
    overrides.set("GET /api/admin/tax/bank-import/status", () =>
      response({ enabled: true, plaidEnabled: true, counts: {} }));
    overrides.set("GET /api/admin/tax/bank-import/coverage", () => response({ months: [] }));
    overrides.set("GET /api/admin/tax/bank-import/transactions", () => response({ transactions: [], hasMore: false }));
    overrides.set("GET /api/admin/tax/bank-import/plaid/status", () => response({
      configured: true, tokenKey: true, env: "sandbox", existingLabels: [],
      items: [{
        id: "item-1", institutionName: "Synthetic Bank", status: "active", lastSyncedAt: null, lastError: null,
        accounts: [{
          id: "acct-1", name: "Checking", mask: "0001", plaidType: "depository", plaidSubtype: "checking",
          accountLabel: "synthetic-bank-checking-0001", accountType: "bank", syncFrom: "2026-01-01", enabled: true,
        }],
      }],
    }));
  };
  it("adds accounts to a connection: Link opens with account selection, then a new account waits for confirmation", async () => {
    activePlaidItem();
    overrides.set("POST /api/admin/tax/bank-import/plaid/link-token", () => response({ linkToken: "link-sandbox-2" }));
    overrides.set("POST /api/admin/tax/bank-import/plaid/items/item-1/accounts-changed", () =>
      response({ success: true, added: 1, setup: true, unshared: [], sync: null }));
    let resumeDuringLink = null;
    const create = vi.fn((config) => ({
      open: () => {
        resumeDuringLink = JSON.parse(localStorage.getItem("waves_plaid_link_resume"));
        config.onSuccess("public-sandbox-2", {});
      },
      destroy: () => {},
    }));
    vi.stubGlobal("Plaid", { create });
    open(TaxPage);
    await taxSection("Expenses", "Import");
    fireEvent.click(await screen.findByRole("button", { name: "Add accounts" }));
    await screen.findByText(/^Confirm the accounts below: tick Import for each account to sync/);
    expect(requests.find((r) => r.key === "POST /api/admin/tax/bank-import/plaid/link-token").body)
      .toEqual({ itemId: "item-1", addAccounts: true });
    // a bank's OAuth redirect resumes this session as Add accounts, not as a re-login
    expect(resumeDuringLink).toEqual({ linkToken: "link-sandbox-2", itemId: "item-1", addAccounts: true });
    expect(requests.some((r) => r.key.endsWith("/reconnected"))).toBe(false);
  });
  it("resumes an Add accounts session after the bank's OAuth redirect and flags an account left unticked", async () => {
    activePlaidItem();
    overrides.set("POST /api/admin/tax/bank-import/plaid/items/item-1/accounts-changed", () =>
      response({
        success: true, added: 0, setup: false,
        unshared: [{ id: "acct-1", name: "Checking", mask: "0001" }],
        sync: { inserted: 0, updated: 0, deleted: 0, flagged: 0 },
      }));
    const create = vi.fn((config) => ({ open: () => config.onSuccess("public-sandbox-3", {}), destroy: () => {} }));
    vi.stubGlobal("Plaid", { create });
    localStorage.setItem("waves_plaid_link_resume",
      JSON.stringify({ linkToken: "link-sandbox-3", itemId: "item-1", addAccounts: true }));
    window.history.pushState(null, "", "/admin/tax?oauth_state_id=state-2");
    try {
      open(TaxPage);
      expect(await screen.findByText(/The bank no longer shares Checking ••0001/)).toHaveTextContent(
        "No new account was shared. Synced: 0 new. The bank no longer shares Checking ••0001, so no new transactions arrive for it — click Add accounts again and tick it.",
      );
      expect(create.mock.calls[0][0].token).toBe("link-sandbox-3");
      expect(requests.some((r) => r.key.endsWith("/reconnected"))).toBe(false);
      expect(requests.some((r) => r.key === "POST /api/admin/tax/bank-import/plaid/link-token")).toBe(false);
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });
  it("keeps the bank-import gate closed on a failed status read", async () => {
    overrides.set("GET /api/admin/tax/bank-import/status", () =>
      response({ error: "Read unavailable" }, 503),
    );
    open(TaxPage);
    await taxSection("Expenses");
    await screen.findByRole("button", { name: "+ Add Expense" });
    expect(
      screen.queryByRole("button", { name: "Import", exact: true }),
    ).not.toBeInTheDocument();
    // the ledger leaf is nested under bank import: nothing asks for it
    expect(screen.queryByRole("button", { name: "Inbox", exact: true })).not.toBeInTheDocument();
    expect(requests.some((r) => r.key === "GET /api/admin/tax/bank-import/ledger/status")).toBe(false);
  });
  // GATE_TAX_LEDGER fails closed: with bank import on, the Inbox leaf exists
  // only when the ledger status says enabled; an off status or a failed read
  // leaves the Tax navigation exactly as it is today.
  it.each([
    ["hides", { enabled: false }, 200],
    ["hides", { error: "Read unavailable" }, 503],
    ["shows", { enabled: true, rules: 0, inbox: 0, income: 0, bankImport: 0, unexamined: 0 }, 200],
  ])("%s the Inbox leaf when the ledger status reads %j", async (verb, ledgerStatus, code) => {
    const key = "GET /api/admin/tax/bank-import/ledger/status";
    overrides.set("GET /api/admin/tax/bank-import/status", () => response({ enabled: true, counts: {} }));
    overrides.set(key, () => response(ledgerStatus, code));
    overrides.set("GET /api/admin/tax/bank-import/ledger/inbox", () => response({ rows: [], total: 0 }));
    overrides.set("GET /api/admin/tax/bank-import/ledger/rules", () => response({ rules: [] }));
    open(TaxPage);
    await taxSection("Expenses");
    await screen.findByRole("button", { name: "Import", exact: true });
    await waitFor(() => expect(requests.filter((r) => r.key === key)).toHaveLength(1));
    if (verb === "hides") {
      expect(screen.queryByRole("button", { name: "Inbox", exact: true })).not.toBeInTheDocument();
      return;
    }
    fireEvent.click(await screen.findByRole("button", { name: "Inbox", exact: true }));
    expect(await screen.findByRole("button", { name: "Apply rules now", exact: true })).toBeInTheDocument();
    expect(requests.some((r) => r.key === "GET /api/admin/tax/bank-import/ledger/inbox")).toBe(true);
  });
});
