// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import CrossSellCard from "./CrossSellCard";

// recharts' ResponsiveContainer needs ResizeObserver, which jsdom lacks.
beforeAll(() => {
  globalThis.ResizeObserver = globalThis.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
});

const DATA = {
  series: [
    { month: "2026-09-01", recurringCustomers: 250, multiServiceCustomers: 30, share: 0.12 },
    { month: "2026-10-01", recurringCustomers: 260, multiServiceCustomers: 31, share: 0.1192 },
  ],
  now: { asOf: "2026-11-26", recurringCustomers: 275, multiServiceCustomers: 33, share: 0.12 },
  sources: { app: 2, office: 30, phone_call: 1, website_quote: 0 },
  pestOnly: [
    { id: "c1", firstName: "Sample", lastName: "Alpha", city: "Parrish", pestServiceKey: "pest_general_quarterly" },
    { id: "c2", firstName: "Sample", lastName: "Zed", city: "Venice", pestServiceKey: "pest_general_quarterly" },
  ],
};

describe("CrossSellCard", () => {
  afterEach(cleanup);

  test("shows today's share with its counts and the plain note that nothing is sent", () => {
    render(<CrossSellCard data={DATA} />);
    expect(screen.getByText("12.0%")).toBeInTheDocument();
    expect(screen.getByText("of recurring customers have 2+ services")).toBeInTheDocument();
    expect(screen.getByText(/33 of 275/)).toBeInTheDocument();
    expect(screen.getByText(/as of Nov 26/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Customers with 2+ services by month" })).toBeInTheDocument();
    expect(screen.getByText("Counts recurring visits on the schedule. Sends nothing.")).toBeInTheDocument();
  });

  test("lists the sources that have customers, biggest first, and leaves out zeros", () => {
    render(<CrossSellCard data={DATA} />);
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items.slice(0, 3)).toEqual(["Added by the office30", "Bought in the Waves app2", "Phone call1"]);
    expect(screen.queryByText("Website quote")).not.toBeInTheDocument();
  });

  test("the pest-only list is collapsed, counts its customers and shows names and city only", () => {
    render(<CrossSellCard data={DATA} />);
    expect(screen.getByText("Pest-only customers (2)").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Sample Alpha")).toBeInTheDocument();
    expect(screen.getByText("Parrish")).toBeInTheDocument();
    expect(screen.queryByText(/pest_general/)).not.toBeInTheDocument();
  });

  test("a day with no recurring customers shows a dash, not 0%, and no stored months says so", () => {
    render(<CrossSellCard data={{ ...DATA, series: [], now: { asOf: "2026-11-26", recurringCustomers: 0, multiServiceCustomers: 0, share: null }, pestOnly: [] }} />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText(/No stored months yet/)).toBeInTheDocument();
    expect(screen.getByText("Pest-only customers (0)")).toBeInTheDocument();
  });

  test("shows a loading note until the data arrives", () => {
    render(<CrossSellCard data={null} />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });
});
