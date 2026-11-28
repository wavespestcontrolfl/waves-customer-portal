// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import AccountingPage from "./AccountingPage";

function jsonResponse(body, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

describe("AccountingPage (QuickBooks-style General Ledger UI)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    localStorage.setItem("waves_admin_token", "test-token");
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders dark-gate notice cleanly when GATE_ACCOUNTING_GL is off", async () => {
    global.fetch = vi.fn((url) => {
      if (String(url).endsWith("/admin/accounting/status")) return jsonResponse({ enabled: false });
      return jsonResponse({ enabled: false }, 404);
    });

    render(<AccountingPage />);
    expect((await screen.findAllByText(/GATE_ACCOUNTING_GL=true/)).length).toBeGreaterThan(0);
  });

  it("renders balanced KPI overview, P&L statement, and Chart of Accounts register when enabled", async () => {
    global.fetch = vi.fn((url) => {
      const u = String(url);
      if (u.endsWith("/admin/accounting/status")) return jsonResponse({ enabled: true });
      if (u.endsWith("/admin/accounting/overview")) {
        return jsonResponse({
          as_of: "2026-11-27",
          posted_entries: 14,
          trial_balance_ok: true,
          balance_sheet_ok: true,
          cash_total_cents: 2936397,
          accounts_receivable_cents: 120000,
          sales_tax_payable_cents: 6300,
          unearned_revenue_cents: 45000,
          ytd: { net_income_cents: 4820000 },
          locked_through: "2026-10",
        });
      }
      if (u.includes("/admin/accounting/reports/pnl")) {
        return jsonResponse({
          from: "2026-01-01",
          to: "2026-11-27",
          basis: "accrual",
          sections: {
            revenue: [{ id: "a1", code: "4000", name: "Residential Pest & Mosquito Revenue", amount_cents: 9500000, deductible_pct: 100 }],
            cogs: [{ id: "a2", code: "5100", name: "Field Technician Wages", amount_cents: 3200000, deductible_pct: 100 }],
            expenses: [{ id: "a3", code: "6610", name: "Interest Expense (Non-Mortgage, Line 16b)", schedule_c_line: "16b", amount_cents: 75000, deductible_pct: 100 }],
          },
          totals: {
            revenue_cents: 9500000,
            cogs_cents: 3200000,
            gross_profit_cents: 6300000,
            gross_margin_pct: 66.32,
            operating_expenses_cents: 75000,
            ebitda_cents: 6300000,
            net_income_cents: 6225000,
            net_margin_pct: 65.53,
          },
        });
      }
      if (u.includes("/admin/accounting/accounts?includeInactive=true")) {
        return jsonResponse({
          accounts: [
            { id: "acc-1010", code: "1010", name: "Capital One Operating Checking", account_type: "asset", sub_type: "checking", balance_cents: 2500000, deductible_pct: 100 },
          ],
        });
      }
      if (u.includes("/admin/accounting/accounts/acc-1010/register")) {
        return jsonResponse({
          account: { id: "acc-1010", code: "1010", name: "Capital One Operating Checking" },
          opening_balance_cents: 2500000,
          closing_balance_cents: 2651397,
          total: 150,
          limit: 100,
          offset: 0,
          transactions: [
            { id: "l1", entry_id: "e1", entry_number: 7, entry_date: "2026-11-08", memo: "Stripe payout settled", debit_cents: 151397, credit_cents: 0, running_balance_cents: 2651397, reconciled: true },
          ],
        });
      }
      if (u.includes("/admin/accounting/journal-entries")) {
        const isPageTwo = u.includes("offset=50");
        return jsonResponse({
          total: 120,
          limit: 50,
          offset: isPageTwo ? 50 : 0,
          entries: [
            {
              id: isPageTwo ? "je-older" : "je-newest",
              entry_number: isPageTwo ? 70 : 120,
              entry_date: isPageTwo ? "2026-06-15" : "2026-11-27",
              entry_type: "operational",
              memo: isPageTwo ? "Older June Entry" : "Latest Nov Entry",
              total_cents: 10000,
              lines: [],
            },
          ],
        });
      }
      if (u.endsWith("/admin/accounting/accounts")) {
        return jsonResponse({
          accounts: [
            { id: "acc-1010", code: "1010", name: "Capital One Operating Checking", account_type: "asset", sub_type: "checking" },
          ],
        });
      }
      return jsonResponse({});
    });

    render(<AccountingPage />);

    expect(await screen.findByText("Books Balanced")).toBeTruthy();
    expect(screen.getByText("Locked through 2026-10")).toBeTruthy();
    expect(await screen.findByText(/Residential Pest & Mosquito Revenue/)).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Chart of Accounts" }));
    expect(await screen.findByText("Capital One Operating Checking")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "View Register" }));
    await waitFor(() => expect(screen.getByText("Stripe payout settled")).toBeTruthy());
    expect(screen.getByText(/Showing 1–1 of 150/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next" }).disabled).toBe(false);

    // New Account dialog switches Account Subtype options to match selected Account Type using canonical statement subtypes
    fireEvent.click(screen.getByRole("button", { name: "New Account" }));
    const typeSelect = screen.getByLabelText("Account Type");
    const subSelect = screen.getByLabelText("Account Subtype");
    fireEvent.change(typeSelect, { target: { value: "asset" } });
    expect(subSelect.value).toBe("checking");
    const assetValues = Array.from(subSelect.options).map((o) => o.value);
    expect(assetValues).toContain("ar");
    expect(assetValues).toContain("accum_depreciation");
    expect(assetValues).not.toContain("accounts_receivable");
    expect(assetValues).not.toContain("accumulated_depreciation");

    fireEvent.change(typeSelect, { target: { value: "liability" } });
    expect(subSelect.value).toBe("credit_card");
    const liabilityValues = Array.from(subSelect.options).map((o) => o.value);
    expect(liabilityValues).toContain("ap");
    expect(liabilityValues).toContain("net_pay_clearing");
    expect(liabilityValues).not.toContain("accounts_payable");

    fireEvent.change(typeSelect, { target: { value: "expense" } });
    const expenseValues = Array.from(subSelect.options).map((o) => o.value);
    expect(expenseValues).toContain("depreciation_expense");
    expect(expenseValues).not.toContain("depreciation");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // Journal Entries tab paginates past the initial 50 entries so older entries can be inspected & reversed
    fireEvent.click(screen.getByRole("tab", { name: "Journal Entries" }));
    expect(await screen.findByText("Latest Nov Entry")).toBeTruthy();
    expect(screen.getByText(/Showing 1–1 of 120/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Older June Entry")).toBeTruthy();
    expect(screen.getByText(/Showing 51–51 of 120/)).toBeTruthy();
  });

  it("switches from Profit & Loss to Balance Sheet without crashing and ignores stale responses", async () => {
    let resolveBalanceSheet;
    const balanceSheetPromise = new Promise((resolve) => {
      resolveBalanceSheet = resolve;
    });

    global.fetch = vi.fn((url) => {
      const u = String(url);
      if (u.endsWith("/admin/accounting/status")) return jsonResponse({ enabled: true });
      if (u.endsWith("/admin/accounting/overview")) {
        return jsonResponse({
          as_of: "2026-11-27",
          posted_entries: 4,
          trial_balance_ok: true,
          balance_sheet_ok: true,
          cash_total_cents: 100000,
          accounts_receivable_cents: 0,
          sales_tax_payable_cents: 0,
          unearned_revenue_cents: 0,
          ytd: { net_income_cents: 100000 },
          locked_through: null,
        });
      }
      if (u.includes("/admin/accounting/reports/pnl")) {
        return jsonResponse({
          from: "2026-01-01",
          to: "2026-11-27",
          basis: "accrual",
          sections: {
            revenue: [{ id: "a1", code: "4000", name: "Residential Pest & Mosquito Revenue", amount_cents: 100000, deductible_pct: 100 }],
            cogs: [],
            expenses: [],
          },
          totals: {
            revenue_cents: 100000,
            cogs_cents: 0,
            gross_profit_cents: 100000,
            gross_margin_pct: 100,
            operating_expenses_cents: 0,
            ebitda_cents: 100000,
            net_income_cents: 100000,
            net_margin_pct: 100,
          },
        });
      }
      if (u.includes("/admin/accounting/reports/balance-sheet")) {
        return balanceSheetPromise;
      }
      return jsonResponse({});
    });

    render(<AccountingPage />);
    expect(await screen.findByText(/Residential Pest & Mosquito Revenue/)).toBeTruthy();

    // Switching immediately while Balance Sheet request is still pending must NOT pass P&L shape to BalanceSheetView.
    fireEvent.change(screen.getByLabelText("Report"), { target: { value: "balance-sheet" } });
    expect(await screen.findByText(/Loading financial statement/i)).toBeTruthy();

    resolveBalanceSheet({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        as_of: "2026-11-27",
        sections: {
          current_assets: [{ id: "c1", code: "1010", name: "Capital One Operating Checking", amount_cents: 100000 }],
          fixed_assets: [],
          other_assets: [{ id: "o1", code: "1700", name: "Security Deposit (Warehouse)", amount_cents: 25000 }],
          current_liabilities: [],
          long_term_liabilities: [],
          equity: [],
        },
        totals: {
          current_assets_cents: 100000,
          fixed_assets_net_cents: 0,
          other_assets_cents: 25000,
          total_assets_cents: 125000,
          current_liabilities_cents: 0,
          long_term_liabilities_cents: 0,
          total_liabilities_cents: 0,
          recorded_equity_cents: 0,
          net_income_cents: 125000,
          total_equity_cents: 125000,
          liabilities_and_equity_cents: 125000,
          discrepancy_cents: 0,
          balanced: true,
        },
      }),
    });

    expect(await screen.findByText(/Balanced \(Assets = Liabilities \+ Equity\)/)).toBeTruthy();
    expect(screen.getByText(/Capital One Operating Checking/)).toBeTruthy();
    expect(screen.getByText(/Security Deposit \(Warehouse\)/)).toBeTruthy();
    expect(screen.getByText(/Total Other Assets/)).toBeTruthy();
  });
});
