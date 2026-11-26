// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import BuyerViewRow from "./BuyerViewRow";

const DATA = {
  months: { count: 12, from: "2025-06-01", to: "2026-05-01" },
  revenue: { value: 120000, growthPct: 12.5, monthsCounted: 12, basis: "Revenue basis text." },
  recurring: { share: 61.2, matureShareOfRecurring: 70, monthsCounted: 12, basis: "Recurring basis text." },
  planRevenueKept: { pct: 94.1, customers: 40, basis: "Kept basis text." },
  grossMargin: { bookPct: 48.3, bookMonthsCounted: 12, perJobAtStandardPct: 55.1, basis: "Margin basis text." },
  ownerProfit: { marginPct: 14.2, sde: 31000, sdeMonthsCounted: 12, monthsCounted: 12, ownerPay: { officeMonths: 12, fieldMonths: 12, months: 12 }, basis: "Profit basis text." },
  officeCost: { perStop: 11.5, pctOfRevenue: 8.1, monthsCounted: 12, basis: "Office basis text." },
  ownerFieldHoursPerWeek: { value: 21.5, available: true },
  pnlIncompleteMonths: [],
};

describe("BuyerViewRow", () => {
  afterEach(cleanup);

  test("six tiles: each number with its context, the books margin beside the per-job one, AR days on the last", () => {
    render(<BuyerViewRow data={DATA} arDays={12} />);
    for (const label of ["Revenue, 12 months", "Recurring share", "Plan revenue kept", "Gross margin", "Owner-paid profit", "Office cost per stop"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText("$120.0k")).toBeInTheDocument();
    expect(screen.getByText(/\+12.5% vs the 12 months before/)).toBeInTheDocument();
    expect(screen.getByText("61.2%")).toBeInTheDocument();
    expect(screen.getByText(/70% of it from plans over a year old/)).toBeInTheDocument();
    expect(screen.getByText("94.1%")).toBeInTheDocument();
    expect(screen.getByText("48.3%")).toBeInTheDocument();
    expect(screen.getByText(/per job at standard minutes 55.1%/)).toBeInTheDocument();
    expect(screen.getByText("14.2%")).toBeInTheDocument();
    expect(screen.getByText(/SDE \$31.0k/)).toBeInTheDocument();
    expect(screen.getByText(/you work 21.5 field hrs\/week/)).toBeInTheDocument();
    expect(screen.getByText("$11.50")).toBeInTheDocument();
    expect(screen.getByText(/8.1% of revenue · AR 12 days/)).toBeInTheDocument();
    // No partial-month note when every metric has all 12 months.
    expect(screen.queryByText(/of 12 months/)).not.toBeInTheDocument();
  });

  test("every metric's basis is in the how-calculated list", () => {
    render(<BuyerViewRow data={DATA} />);
    for (const text of ["Revenue basis text.", "Recurring basis text.", "Kept basis text.", "Margin basis text.", "Profit basis text.", "Office basis text."]) {
      expect(screen.getByText(new RegExp(text))).toBeInTheDocument();
    }
  });

  test("blank figures show a dash, never a zero, and a partial year says how many months", () => {
    const data = {
      ...DATA,
      revenue: { ...DATA.revenue, value: 4000, growthPct: null, monthsCounted: 5 },
      recurring: { ...DATA.recurring, share: null, matureShareOfRecurring: null, monthsCounted: 0 },
      planRevenueKept: { pct: null, customers: 0, basis: "Kept basis text." },
      grossMargin: { ...DATA.grossMargin, bookPct: null, bookMonthsCounted: 0 },
      ownerProfit: { ...DATA.ownerProfit, marginPct: null, sde: 0, sdeMonthsCounted: 0, monthsCounted: 0, ownerPay: { officeMonths: 0, fieldMonths: 0, months: 12 } },
      officeCost: { ...DATA.officeCost, perStop: null, pctOfRevenue: null },
      ownerFieldHoursPerWeek: { value: null, available: false },
    };
    render(<BuyerViewRow data={data} />);
    expect(screen.getByText(/growth needs 24 stored months · 5 of 12 months/)).toBeInTheDocument();
    expect(screen.getByText(/no plan revenue yet/)).toBeInTheDocument();
    expect(screen.getByText(/needs plan customers over 24 months old/)).toBeInTheDocument();
    expect(screen.getByText(/SDE — · 0 of 12 months · owner field wage not counted/)).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  test.each(["months", "revenue", "recurring", "planRevenueKept", "grossMargin", "ownerProfit", "officeCost"])(
    "a response missing %s shows the unavailable state and reads nothing from it", (missing) => {
      const data = { ...DATA };
      delete data[missing];
      render(<BuyerViewRow data={data} pending={false} />);
      expect(screen.getByText("buyer view is unavailable.")).toBeInTheDocument();
      expect(screen.queryByText("Recurring share")).not.toBeInTheDocument();
    },
  );

  test("the old minimal shape {revenue, officeCost} is unavailable, not a crash", () => {
    render(<BuyerViewRow data={{ revenue: {}, officeCost: {} }} pending={false} />);
    expect(screen.getByText("buyer view is unavailable.")).toBeInTheDocument();
  });

  test("a failed plan-revenue-kept query is that tile only", () => {
    render(<BuyerViewRow data={{ ...DATA, planRevenueKept: { error: "unavailable" } }} />);
    expect(screen.getByText("unavailable")).toBeInTheDocument();
    expect(screen.getByText("61.2%")).toBeInTheDocument();
  });

  test("while loading, or after a failed load, there are no tiles, and a failed load offers a retry", () => {
    const retry = vi.fn();
    const { rerender } = render(<BuyerViewRow data={null} pending />);
    expect(screen.getByText("Loading buyer view…")).toBeInTheDocument();
    expect(screen.queryByText("Recurring share")).not.toBeInTheDocument();
    rerender(<BuyerViewRow data={null} pending={false} onRetry={retry} />);
    expect(screen.getByText("buyer view is unavailable.")).toBeInTheDocument();
    expect(screen.queryByText("Recurring share")).not.toBeInTheDocument();
  });

  test("stored months written before the Stripe ledger finished are called out", () => {
    render(<BuyerViewRow data={{ ...DATA, pnlIncompleteMonths: ["2026-05-01"] }} />);
    expect(screen.getByText(/1 stored month\(s\) were written before the Stripe ledger finished/)).toBeInTheDocument();
  });
});
