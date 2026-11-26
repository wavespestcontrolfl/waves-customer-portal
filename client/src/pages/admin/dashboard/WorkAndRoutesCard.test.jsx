// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import WorkAndRoutesCard from "./WorkAndRoutesCard";

const DATA = {
  generatedFor: "2026-11-26",
  errors: {},
  ownerReliance: {
    ownerFieldHoursPerWeek: { source: "time_clock", last4Weeks: 31.5, last12Weeks: 28, basis: "Owner shifts on the time clock." },
    nonOwnerStopShare: { share: 0.25, ownerStops: 300, otherStops: 100, unassignedStops: 0, basis: "Admin role is the owner." },
  },
  revenuePerRouteDay: {
    last12Months: { revenue: 100000, routeDays: 500, revenuePerRouteDay: 200 },
    last90Days: { revenue: 30000, routeDays: 120, revenuePerRouteDay: 250 },
    basis: "Revenue / route days.",
  },
  routeFill: {
    scheduledStops: 120, routeDaysAvailable: 20, stopsPerFullDay: 12, fillRatio: 0.5,
    label: "planning only, not a pay target", basis: "Stops / capacity.",
  },
  returnVisitRate: { returnVisits: 20, completedStops: 400, rate: 0.05, basis: "Callbacks / stops." },
};

describe("WorkAndRoutesCard", () => {
  afterEach(cleanup);

  test("shows the four metrics with their windows, and the planning-only label on route fill", () => {
    render(<WorkAndRoutesCard data={DATA} />);
    expect(screen.getByText("31.5 h")).toBeInTheDocument();
    expect(screen.getByText(/28\.0 h per week over the last 12 weeks · from the time clock/)).toBeInTheDocument();
    expect(screen.getByText(/25% of the last 12 months' stops done by someone other than the owner \(100 of 400\)/)).toBeInTheDocument();
    expect(screen.getByText("$200")).toBeInTheDocument();
    expect(screen.getByText("$250 over the last 90 days")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("120 scheduled stops over 20 route days (12 stops is a full day)")).toBeInTheDocument();
    expect(screen.getByText("planning only, not a pay target")).toBeInTheDocument();
    expect(screen.getByText("5%")).toBeInTheDocument();
  });

  test("an estimate from stops names itself as an estimate", () => {
    const data = { ...DATA, ownerReliance: { ...DATA.ownerReliance, ownerFieldHoursPerWeek: { source: "stops_standard", last4Weeks: 20, last12Weeks: 22, basis: "" } } };
    render(<WorkAndRoutesCard data={data} />);
    expect(screen.getByText(/estimated from completed stops \(no time-clock shifts\)/)).toBeInTheDocument();
  });

  test("a failed metric shows unavailable and the others still render", () => {
    render(<WorkAndRoutesCard data={{ ...DATA, routeFill: null, errors: { routeFill: "routeFill could not be read" } }} />);
    expect(screen.getByText("Route fill")).toBeInTheDocument();
    expect(screen.getByText("Unavailable. Try again shortly.")).toBeInTheDocument();
    expect(screen.getByText("$200")).toBeInTheDocument();
  });

  test("ratios with no denominator show a dash, never 0", () => {
    const data = {
      ...DATA,
      ownerReliance: { ownerFieldHoursPerWeek: { source: "stops_standard", last4Weeks: 0, last12Weeks: 0 }, nonOwnerStopShare: { share: null, ownerStops: 0, otherStops: 0 } },
      revenuePerRouteDay: { last12Months: { routeDays: 0, revenuePerRouteDay: null }, last90Days: { routeDays: 0, revenuePerRouteDay: null } },
      routeFill: { ...DATA.routeFill, routeDaysAvailable: 0, scheduledStops: 0, fillRatio: null },
      returnVisitRate: { returnVisits: 0, completedStops: 0, rate: null },
    };
    render(<WorkAndRoutesCard data={data} />);
    expect(screen.getAllByText("—")).toHaveLength(3);
    expect(screen.getByText(/^— of the last 12 months' stops/)).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  test("no data yet shows loading", () => {
    render(<WorkAndRoutesCard data={null} />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });
});
