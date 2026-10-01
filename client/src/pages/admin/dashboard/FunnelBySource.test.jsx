// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import FunnelBySource from "./FunnelBySource";

const ANTS = "wavespestcontrol.com/pest-control/ants";
const data = {
  period: { label: "Month to Date" },
  sources: [
    { sourceKey: "organic", source: "Organic", isPaid: false, leads: 6, contacted: 0, estimate: 0, booked: 2, completed: 1, lost: 1, revenue: 300, rates: { bookRate: 33, completeRate: 17 } },
  ],
  stagesPresent: { contacted: false, estimate: false, booked: true },
  totals: { leads: 6, contacted: 0, estimate: 0, booked: 2, completed: 1, lost: 1, revenue: 300, bookRate: 33, completeRate: 17 },
  paid: { leads: 0, booked: 0, completed: 0 },
  organic: { leads: 6, booked: 2, completed: 1 },
  breakdowns: {
    page: [
      { key: ANTS, label: ANTS, leads: 4, contacted: 0, estimate: 0, booked: 2, completed: 1, lost: 0, revenue: 300 },
      { key: "(unknown)", label: "(unknown)", leads: 2, contacted: 0, estimate: 0, booked: 0, completed: 0, lost: 1, revenue: 0 },
    ],
    service: [],
    city: [],
    heard: [{ key: "chatgpt", label: "ChatGPT", leads: 1, contacted: 0, estimate: 0, booked: 0, completed: 0, lost: 0, revenue: 0 }],
  },
};

describe("FunnelBySource views", () => {
  afterEach(cleanup);

  test("the same funnel switches from sources to landing pages, with won revenue on the row", () => {
    render(<FunnelBySource data={data} />);
    expect(screen.getByText("Organic")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "page" } });
    expect(screen.getByText(ANTS)).toBeInTheDocument();
    expect(screen.getByText("(unknown)")).toBeInTheDocument();
    expect(screen.getByText(/\$300 won/)).toBeInTheDocument();
    expect(screen.queryByText("Organic")).not.toBeInTheDocument();
  });

  test("the self-reported answer is its own view", () => {
    render(<FunnelBySource data={data} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "heard" } });
    expect(screen.getByText("ChatGPT")).toBeInTheDocument();
    expect(screen.queryByText(ANTS)).not.toBeInTheDocument();
  });
});
