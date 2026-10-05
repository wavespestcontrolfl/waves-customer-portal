// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import ServiceLineTiles from "./ServiceLineTiles";

const data = {
  period: { label: "Month to Date" },
  lines: [
    {
      key: "pest", label: "Pest Control", sent: 12, accepted: 6, lost: 4, resolved: 10, open: 2, close_rate: 60, aging7: 3,
      ret90: { cohort: 8, retained: 6, rate: 75 },
      cac: { leads: 20, converted: 4, spend: 200, value: 50 },
    },
    {
      key: "lawn", label: "Lawn Care", sent: 0, accepted: 0, lost: 0, resolved: 0, open: 0, close_rate: null, aging7: 0,
      ret90: { cohort: 0, retained: 0, rate: null },
      cac: { leads: 0, converted: 0, spend: 0, value: null },
    },
    {
      key: "termite", label: "Termite", sent: null, accepted: null, lost: null, resolved: null, open: null, close_rate: null, aging7: null,
      ret90: null, cac: null,
    },
  ],
  caveats: ["Open >7d is the live backlog today.", "Cost per new customer could not be loaded right now."],
};

describe("ServiceLineTiles", () => {
  afterEach(cleanup);

  test("renders one row per line with its four numbers and the API caveats", () => {
    render(<ServiceLineTiles data={data} />);
    const pest = screen.getByText("Pest Control").closest("tr");
    expect(within(pest).getByText("60%")).toBeInTheDocument();
    expect(within(pest).getByText("6/10 resolved")).toBeInTheDocument();
    expect(within(pest).getByText("3")).toBeInTheDocument();
    expect(within(pest).getByText("75%")).toBeInTheDocument();
    expect(within(pest).getByText("6/8 kept")).toBeInTheDocument();
    expect(within(pest).getByText("$50")).toBeInTheDocument();
    expect(screen.getByText("Open >7d is the live backlog today.")).toBeInTheDocument();
    expect(screen.getByText(/could not be loaded right now/)).toBeInTheDocument();
  });

  test("shows a dash for null numbers, never a zero", () => {
    render(<ServiceLineTiles data={data} />);
    const termite = screen.getByText("Termite").closest("tr");
    // close rate, open >7d, retention and cost per new customer
    expect(within(termite).getAllByText("—").length).toBeGreaterThanOrEqual(4);
    const lawn = screen.getByText("Lawn Care").closest("tr");
    expect(within(lawn).queryByText("0%")).not.toBeInTheDocument();
    expect(within(lawn).getAllByText("—").length).toBeGreaterThanOrEqual(3);
  });

  test("shows a retry button when the feed failed", () => {
    const retry = vi.fn();
    render(<ServiceLineTiles data={null} pending={false} onRetry={retry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  test("shows a loading note while the first load is pending", () => {
    render(<ServiceLineTiles data={null} pending onRetry={() => {}} />);
    expect(screen.getByText(/Loading service line numbers/)).toBeInTheDocument();
  });
});
