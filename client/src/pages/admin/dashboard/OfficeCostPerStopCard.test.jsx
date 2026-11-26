// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import OfficeCostPerStopCard from "./OfficeCostPerStopCard";

// recharts' ResponsiveContainer needs ResizeObserver, which jsdom lacks.
beforeAll(() => {
  globalThis.ResizeObserver = globalThis.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
});

const month = (m, officeCost, paidStops, extra = {}) => ({
  month: m, officeCost, paidStops, officeCostPerStop: paidStops ? Math.round((officeCost / paidStops) * 100) / 100 : null, ...extra,
});
const DATA = {
  months: [month("2026-07-01", 900, 90), month("2026-08-01", 1000, 100), month("2026-09-01", 1100, 100), month("2026-10-01", 1200, 100)],
  trailing: { months: ["2026-08-01", "2026-09-01", "2026-10-01"], officeCost: 3300, paidStops: 300, officeCostPerStop: 11 },
  ownerOfficeTime: { counted: false, hoursPerMonth: null, hourlyRate: null },
  officeCategories: ["Office Expenses", "Utilities"],
};

describe("OfficeCostPerStopCard", () => {
  afterEach(cleanup);

  test("headline is the trailing three months, with the months, cost and stops it covers", () => {
    render(<OfficeCostPerStopCard data={DATA} />);
    expect(screen.getByText("$11.00")).toBeInTheDocument();
    expect(screen.getByText("per stop, last 3 months")).toBeInTheDocument();
    expect(screen.getByText(/Aug ’26 – Oct ’26/)).toBeInTheDocument();
    expect(screen.getByText(/\$3,300 office cost over 300 paid stops/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Office cost per stop" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Paid stops" })).toBeInTheDocument();
  });

  test("says the owner's own office time is not counted until it is", () => {
    const { rerender } = render(<OfficeCostPerStopCard data={DATA} />);
    expect(screen.getByText(/Your own office time is not counted yet/)).toBeInTheDocument();
    rerender(<OfficeCostPerStopCard data={{ ...DATA, ownerOfficeTime: { counted: true, hoursPerMonth: 10, hourlyRate: 40 } }} />);
    expect(screen.queryByText(/not counted yet/)).not.toBeInTheDocument();
  });

  test("no stops in the window shows a dash, never $0.00", () => {
    const data = { ...DATA, trailing: { months: ["2026-10-01"], officeCost: 200, paidStops: 0, officeCostPerStop: null } };
    render(<OfficeCostPerStopCard data={data} />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  test("no stored months yet is an empty state, not a chart of zeros", () => {
    render(<OfficeCostPerStopCard data={{ ...DATA, months: [], trailing: { months: [] } }} />);
    expect(screen.getByText(/No monthly snapshots yet/)).toBeInTheDocument();
  });
});
