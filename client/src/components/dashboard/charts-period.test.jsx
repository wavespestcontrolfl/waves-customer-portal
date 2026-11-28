// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EstimateFunnel, RevenueByCity } from "./charts";

describe("Period-driven dashboard chart states", () => {
  afterEach(cleanup);

  it("renders EstimateFunnel activity when sent is 0 but an earlier quote was accepted this period", () => {
    render(
      <EstimateFunnel
        funnel={{ sent: 0, viewed: 0, accepted: 1, declined: 0, pending: 0 }}
        rates={{ view_rate: 0, close_rate: 0, decline_rate: 0 }}
        totalAcceptedValue={1200}
      />,
    );
    expect(screen.queryByText(/No estimates sent this period/)).not.toBeInTheDocument();
    expect(screen.getByText("Accepted")).toBeInTheDocument();
    expect(screen.getByText("$1,200")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it("renders EstimateFunnel empty state only when every stage is zero", () => {
    render(<EstimateFunnel funnel={{ sent: 0, viewed: 0, accepted: 0, declined: 0, pending: 0 }} rates={{}} />);
    expect(screen.getByText("No estimates sent this period")).toBeInTheDocument();
  });

  it("suppresses >100% carry-over rates and explains carry-over activity when acceptances exceed sends", () => {
    render(
      <EstimateFunnel
        funnel={{ sent: 1, viewed: 1, accepted: 2, declined: 0, pending: 0 }}
        rates={{ view_rate: 100, close_rate: 200, decline_rate: 0 }}
        totalAcceptedValue={2400}
      />,
    );
    expect(screen.queryByText("200%")).not.toBeInTheDocument();
    expect(screen.getByText(/Counts include earlier quotes decided this period/)).toBeInTheDocument();
  });

  it("detects carry-over when acceptances stay below sends but exceed the sent cohort", () => {
    const { container } = render(
      <EstimateFunnel
        funnel={{ sent: 10, viewed: 4, accepted: 3, declined: 0, pending: 10 }}
        cohort={{ sent: 10, viewed: 4, accepted: 0, declined: 0 }}
        rates={{ view_rate: 40, close_rate: 0, decline_rate: 0 }}
        totalAcceptedValue={3600}
      />,
    );
    expect(screen.getByText(/Counts include earlier quotes decided this period/)).toBeInTheDocument();
    // Accepted bar width scales by count/maxCount (30%) rather than collapsing to 0%.
    expect(container.innerHTML).toContain("width: 30%");
  });

  it("handles null rates without throwing", () => {
    render(
      <EstimateFunnel
        funnel={{ sent: 2, viewed: 1, accepted: 1, declined: 0, pending: 1 }}
        rates={null}
      />,
    );
    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(screen.getByText("Accepted")).toBeInTheDocument();
  });

  it("uses period-neutral empty copy for RevenueByCity", () => {
    render(<RevenueByCity cities={[]} total={0} />);
    expect(screen.getByText("No completed-service revenue this period")).toBeInTheDocument();
  });
});
