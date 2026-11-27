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
          transactions: [
            { id: "l1", entry_id: "e1", entry_number: 7, entry_date: "2026-11-08", memo: "Stripe payout settled", debit_cents: 151397, credit_cents: 0, running_balance_cents: 2651397, reconciled: true },
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
  });
});
