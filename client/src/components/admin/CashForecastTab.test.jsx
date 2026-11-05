// @vitest-environment jsdom
// Banking → Cash forecast tab (GATE_CASH_FORECAST): what the owner reads and what each editor sends.
// Synthetic numbers only.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CashForecastTab from "./CashForecastTab";

const response = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

// recharts' ResponsiveContainer needs ResizeObserver, which jsdom lacks.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const IN = { stripe: 0, visits: 0, invoices: 0, dues: 0, new_work: 0, prepay_sales: 0 };
const OUT = {
  products_fuel: 0, products_fuel_extra: 0, ai_software: 0, card_payments_off_feed: 0, other_spending: 0,
  card_owed: 0, payroll: 0, taxes: 0, planned: 0, hire: 0,
};
const week = (start, end, over = {}) => ({
  week_start: start,
  week_end: end,
  days: over.days ?? 7,
  money_in: { ...IN, ...(over.in || {}) },
  money_out: { ...OUT, ...(over.out || {}) },
  end_booked: over.booked ?? 9000,
  end_expected: over.expected ?? null,
  end_booked_with_hire: over.bookedHire ?? over.booked ?? 9000,
  end_expected_with_hire: over.expectedHire ?? null,
});
const forecastBody = (over = {}) => ({
  fetched_at: "2026-11-05T14:00:00.000Z",
  today: "2026-11-05",
  window_end: "2027-01-31",
  opening: { bank_usd: 10000, partial: false, card_owed_usd: 300 },
  expected_available: false,
  weeks: [
    week("2026-11-02", "2026-11-08", { days: 4, booked: 9500, in: { visits: 1200 }, out: { payroll: 1700 } }),
    week("2026-11-09", "2026-11-15", { booked: 8000, in: { invoices: 400 }, out: { card_payments_off_feed: 1900 } }),
  ],
  lowest: { booked: { week_start: "2026-11-09", usd: 8000 }, expected: null, booked_with_hire: { week_start: "2026-11-09", usd: 8000 }, expected_with_hire: null },
  method: {},
  missing: [],
  ...over,
});
const inputsBody = (over = {}) => ({
  items: [],
  settings: { floor_cents: null, last_year_receipts: {}, updated_at: null },
  kinds: ["insurance", "health", "tax_account", "ads", "card_payoff", "hire", "other"],
  cadences: ["once", "weekly", "biweekly", "monthly"],
  ...over,
});

let requests, routes;
beforeEach(() => {
  requests = [];
  routes = new Map([
    ["GET /api/admin/banking/cash-forecast", () => response(forecastBody())],
    ["GET /api/admin/banking/cash-forecast/inputs", () => response(inputsBody())],
  ]);
  localStorage.setItem("waves_admin_token", "synthetic-token");
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, options = {}) => {
      const url = new URL(String(input), "http://localhost");
      const key = `${options.method || "GET"} ${url.pathname}`;
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ key, body });
      if (routes.has(key)) return routes.get(key)(body);
      throw Error(`Unexpected fixture ${key}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const reads = (key) => requests.filter((r) => r.key === key).length;
const field = (scope, label) => scope.getByLabelText(label, { exact: true });

describe("Cash forecast tab", () => {
  it("shows today's pool, the lowest week and each week's end; a week opens to its lines", async () => {
    render(<CashForecastTab />);
    expect(await screen.findByText("Cash today (both checking accounts)")).toBeInTheDocument();
    expect(screen.getByText("$10,000")).toBeInTheDocument();
    expect(screen.getByText("$8,000 · week of Nov 9")).toBeInTheDocument();
    // no last-year months yet: the expected line waits for them
    expect(screen.getByText("Needs last year's months")).toBeInTheDocument();
    const table = within(screen.getByRole("table"));
    expect(table.getAllByRole("row")[1]).toHaveTextContent("Nov 2 (4 days)"); // week 0 starts today
    fireEvent.click(table.getByText("Nov 9"));
    expect(table.getByText("Open invoices")).toBeInTheDocument();
    expect(table.getByText("Payments to cards outside the feed")).toBeInTheDocument();
    expect(table.getByText("-$1,900")).toBeInTheDocument();
  });

  it("says what the forecast cannot see in plain sentences", async () => {
    routes.set("GET /api/admin/banking/cash-forecast", () => response(forecastBody({
      missing: [
        { kind: "account_unavailable", institution: "Example Bank", reason: "login_required", mask: "1234" },
        { kind: "card_not_in_feed", account: "example-card-5678", last_day: "2026-10-27", debits_30d_usd: 900 },
        { kind: "last_year_months", months: ["2025-11", "2025-12"] },
        { kind: "draft_invoices", count: 2, usd: 300 },
        { kind: "payouts_overdue", count: 1, usd: 500, first_day: "2026-11-03" },
      ],
    })));
    render(<CashForecastTab />);
    expect(await screen.findByText("Example Bank ••1234 is not counted. The Cash today card above says how to fix it.")).toBeInTheDocument();
    expect(screen.getByText(/Card ••5678 is not in the bank feed .*\$900 of charges in its last 30 days/)).toBeInTheDocument();
    expect(screen.getByText(/last year's money in for November 2025, December 2025/)).toBeInTheDocument();
    expect(screen.getByText("2 draft invoices ($300) were never sent. They are not counted.")).toBeInTheDocument();
    expect(screen.getByText("Stripe still shows a payout ($500) on the way past the arrival day (the first was due Nov 3). It is not counted: check that it reached the bank.")).toBeInTheDocument();
  });

  it("adds a planned item in cents, then reads the forecast again", async () => {
    let sent;
    routes.set("POST /api/admin/banking/cash-forecast/items", (body) => {
      sent = body;
      return response({ item: { id: "i1", ...body } }, 201);
    });
    render(<CashForecastTab />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a planned item" }));
    const card = screen; // one form is open
    fireEvent.change(field(card, "Name"), { target: { value: "Truck insurance" } });
    fireEvent.change(field(card, "Amount ($)"), { target: { value: "$1,234.56" } });
    fireEvent.change(field(card, "First date"), { target: { value: "2026-11-20" } });
    fireEvent.click(card.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(reads("GET /api/admin/banking/cash-forecast")).toBe(2));
    expect(sent).toEqual({ kind: "insurance", label: "Truck insurance", amount_cents: 123456, cadence: "monthly", first_date: "2026-11-20", last_date: null });
  });

  it("edits a planned item with PATCH and removes one with DELETE", async () => {
    const item = { id: "i9", kind: "ads", label: "Ads", amount_cents: 50000, cadence: "weekly", first_date: "2026-11-09", last_date: null };
    let patched;
    routes.set("GET /api/admin/banking/cash-forecast/inputs", () => response(inputsBody({ items: [item] })));
    routes.set("PATCH /api/admin/banking/cash-forecast/items/i9", (body) => {
      patched = body;
      return response({ item: { ...item, ...body } });
    });
    routes.set("DELETE /api/admin/banking/cash-forecast/items/i9", () => response({ item: { ...item, active: false } }));
    render(<CashForecastTab />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Amount ($)", { exact: true }), { target: { value: "650" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patched).toMatchObject({ amount_cents: 65000, cadence: "weekly", first_date: "2026-11-09" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(reads("DELETE /api/admin/banking/cash-forecast/items/i9")).toBe(1));
  });

  it("a refused save keeps the form and shows the server's reason", async () => {
    routes.set("POST /api/admin/banking/cash-forecast/items", () => response({ error: "label must be 1 to 120 characters" }, 400));
    render(<CashForecastTab />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a planned item" }));
    fireEvent.change(screen.getByLabelText("Amount ($)", { exact: true }), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("First date", { exact: true }), { target: { value: "2026-11-20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("label must be 1 to 120 characters")).toBeInTheDocument();
    expect(screen.getByLabelText("Amount ($)", { exact: true })).toHaveValue("10");
  });

  it("saves the floor and last year's months in cents; a blank month is left out", async () => {
    let put;
    routes.set("GET /api/admin/banking/cash-forecast", () => response(forecastBody({ missing: [{ kind: "last_year_months", months: ["2025-11", "2025-12"] }] })));
    routes.set("PUT /api/admin/banking/cash-forecast/settings", (body) => {
      put = body;
      return response({ settings: { ...body, updated_at: "2026-11-05T15:00:00.000Z" } });
    });
    render(<CashForecastTab />);
    fireEvent.change(await screen.findByLabelText("Floor: the lowest cash you want both accounts to hold ($)", { exact: true }), { target: { value: "5,500" } });
    fireEvent.change(screen.getByLabelText("November 2025 ($)", { exact: true }), { target: { value: "21000.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(put).toEqual({ floor_cents: 550000, last_year_receipts: { "2025-11": 2100050 } }));
  });

  it("a planned hire adds its own tile and column", async () => {
    routes.set("GET /api/admin/banking/cash-forecast", () => response(forecastBody({
      lowest: { booked: { week_start: "2026-11-09", usd: 8000 }, expected: null, booked_with_hire: { week_start: "2026-11-09", usd: 6400 }, expected_with_hire: null },
    })));
    routes.set("GET /api/admin/banking/cash-forecast/inputs", () => response(inputsBody({
      items: [{ id: "h1", kind: "hire", label: "Second tech", amount_cents: 80000, cadence: "weekly", first_date: "2026-11-09", last_date: null }],
    })));
    render(<CashForecastTab />);
    expect(await screen.findByText("Lowest week with the planned hire")).toBeInTheDocument();
    expect(screen.getByText("$6,400 · week of Nov 9")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getByText("With the hire")).toBeInTheDocument();
  });

  it("a failed first read offers a retry; a failed refresh keeps the last numbers", async () => {
    let fail = true;
    routes.set("GET /api/admin/banking/cash-forecast", () => (fail ? response({ error: "the forecast read failed" }, 500) : response(forecastBody())));
    render(<CashForecastTab />);
    expect(await screen.findByText("The forecast could not be read: the forecast read failed")).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("$10,000")).toBeInTheDocument();
    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/could not be read again: the forecast read failed\. These numbers are from the last read\./)).toBeInTheDocument();
    expect(screen.getByText("$10,000")).toBeInTheDocument();
  });
});
