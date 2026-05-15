// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PipelineAnalytics, {
  aggregateServiceLineRows,
  classifyEstimateServiceLine,
} from "./PipelineAnalytics";

const NOW = new Date("2026-05-15T12:00:00.000Z");

function daysAgo(days) {
  return new Date(NOW.getTime() - days * 86400000).toISOString();
}

function hoursAgo(hours) {
  return new Date(NOW.getTime() - hours * 3600000).toISOString();
}

function estimate(overrides = {}) {
  return {
    id: overrides.id || "estimate",
    status: "sent",
    monthlyTotal: 100,
    createdAt: daysAgo(1),
    serviceInterest: "pest control",
    ...overrides,
  };
}

function renderAnalytics(props = {}) {
  const onFilterChange = props.onFilterChange || vi.fn();
  const onDateRangeChange = props.onDateRangeChange || vi.fn();
  const result = render(
    <PipelineAnalytics
      estimates={props.estimates || []}
      activeFilter={props.activeFilter || "all"}
      onFilterChange={onFilterChange}
      dateRange={props.dateRange || "30d"}
      onDateRangeChange={onDateRangeChange}
    />,
  );
  return { ...result, onFilterChange, onDateRangeChange };
}

function kpiFixture() {
  return [
    ...Array.from({ length: 4 }, (_, i) =>
      estimate({
        id: `accepted-${i}`,
        status: "accepted",
        monthlyTotal: 100,
        serviceInterest: "pest control",
      }),
    ),
    ...Array.from({ length: 6 }, (_, i) =>
      estimate({
        id: `sent-${i}`,
        status: "sent",
        monthlyTotal: 50,
        serviceInterest: "mosquito",
      }),
    ),
    ...Array.from({ length: 4 }, (_, i) =>
      estimate({
        id: `viewed-${i}`,
        status: "viewed",
        monthlyTotal: 75,
        viewedAt: hoursAgo(24),
        serviceInterest: "lawn care",
      }),
    ),
    ...Array.from({ length: 3 }, (_, i) =>
      estimate({
        id: `draft-${i}`,
        status: "draft",
        monthlyTotal: 0,
        serviceInterest: "tree and shrub",
      }),
    ),
    ...Array.from({ length: 2 }, (_, i) =>
      estimate({
        id: `declined-${i}`,
        status: "declined",
        monthlyTotal: 80,
        serviceInterest: "termite bait",
      }),
    ),
    estimate({
      id: "expired-0",
      status: "expired",
      monthlyTotal: 90,
      serviceInterest: "rodent control",
    }),
  ];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("classifyEstimateServiceLine", () => {
  it.each([
    ["pest control", "pest"],
    ["mosquito service", "mosquito"],
    ["lawn care fertilization", "lawn"],
    ["tree & shrub program", "tree_shrub"],
    ["termite bait install", "termite"],
    ["rodent rat exclusion", "rodent"],
    ["palm injection", "tree_shrub"],
    ["Trelona ATBS", "termite"],
    ["", "pest"],
  ])("classifies %s as %s", (serviceInterest, expected) => {
    expect(classifyEstimateServiceLine({ serviceInterest })).toBe(expected);
  });
});

describe("aggregateServiceLineRows", () => {
  it("excludes drafts, computes integer acceptance and avg ticket, and sorts by sent count", () => {
    const rows = aggregateServiceLineRows([
      estimate({ id: "p1", status: "sent", monthlyTotal: 100, serviceInterest: "pest" }),
      estimate({ id: "p2", status: "accepted", monthlyTotal: 200, serviceInterest: "pest" }),
      estimate({ id: "p3", status: "viewed", monthlyTotal: 300, serviceInterest: "pest" }),
      estimate({ id: "p-draft", status: "draft", monthlyTotal: 999, serviceInterest: "pest" }),
      estimate({ id: "l1", status: "accepted", monthlyTotal: 80, serviceInterest: "lawn" }),
      estimate({ id: "l2", status: "sent", monthlyTotal: 40, serviceInterest: "lawn" }),
      estimate({ id: "t1", status: "sent", monthlyTotal: 500, serviceInterest: "termite" }),
    ]);

    expect(rows.map((row) => row.key)).toEqual(["pest", "lawn", "termite"]);
    expect(rows[0]).toMatchObject({
      sent: 3,
      won: 1,
      acceptancePct: 33,
      avgTicket: 200,
    });
    expect(rows[1]).toMatchObject({
      sent: 2,
      won: 1,
      acceptancePct: 50,
      avgTicket: 60,
    });
  });
});

describe("PipelineAnalytics", () => {
  it("renders four KPI tiles with correct values for 20 estimates", () => {
    renderAnalytics({ estimates: kpiFixture() });

    expect(screen.getByText("Pipeline value")).toBeInTheDocument();
    expect(screen.getAllByText("Avg ticket").length).toBeGreaterThan(0);
    expect(screen.getByText("Acceptance rate")).toBeInTheDocument();
    expect(screen.getByText("MRR won")).toBeInTheDocument();
    expect(screen.getByText("$600")).toBeInTheDocument();
    expect(screen.getByText("$63")).toBeInTheDocument();
    expect(screen.getByText("24%")).toBeInTheDocument();
    expect(screen.getByText("$400")).toBeInTheDocument();
  });

  it("fires the won filter from the Won funnel tile", () => {
    const { onFilterChange } = renderAnalytics({ estimates: kpiFixture() });

    fireEvent.click(screen.getByRole("button", { name: /Won/i }));

    expect(onFilterChange).toHaveBeenCalledWith("won");
  });

  it("fires combined filters that match Drafts and Sent funnel counts", () => {
    const { onFilterChange } = renderAnalytics({ estimates: kpiFixture() });

    fireEvent.click(screen.getByRole("button", { name: /Drafts/i }));
    fireEvent.click(screen.getByRole("button", { name: /Sent/i }));

    expect(onFilterChange).toHaveBeenNthCalledWith(1, "drafts");
    expect(onFilterChange).toHaveBeenNthCalledWith(2, "sent_group");
  });

  it("clears the active analytics filter", () => {
    const { onFilterChange } = renderAnalytics({
      estimates: kpiFixture(),
      activeFilter: "won",
    });

    fireEvent.click(screen.getByRole("button", { name: /Clear filter/i }));
    fireEvent.click(screen.getByRole("button", { name: /Won/i }));

    expect(onFilterChange).toHaveBeenNthCalledWith(1, "all");
    expect(onFilterChange).toHaveBeenNthCalledWith(2, "all");
  });

  it("fires follow_up from the follow-up overdue card", () => {
    const { onFilterChange } = renderAnalytics({
      estimates: [
        estimate({
          id: "overdue",
          status: "viewed",
          viewedAt: hoursAgo(72),
          monthlyTotal: 150,
        }),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: /Follow-up overdue/i }));

    expect(onFilterChange).toHaveBeenCalledWith("follow_up");
  });

  it("uses alert classes only on the follow-up overdue card", () => {
    const { container } = renderAnalytics({
      estimates: [
        estimate({
          id: "overdue",
          status: "viewed",
          viewedAt: hoursAgo(72),
          monthlyTotal: 150,
          pricingRisk: { hasRisk: true, missingCogsCount: 1, lowMarginCount: 1 },
        }),
      ],
    });

    const textAlert = container.querySelectorAll(".text-alert-fg");
    const bgAlert = container.querySelectorAll(".bg-alert-bg");

    expect(textAlert).toHaveLength(1);
    expect(bgAlert).toHaveLength(1);
    expect(textAlert[0]).toBe(bgAlert[0]);
    expect(textAlert[0]).toHaveTextContent("Follow-up overdue");
  });

  it("excludes estimates older than 7 days from KPI math", () => {
    renderAnalytics({
      dateRange: "7d",
      estimates: [
        estimate({ id: "fresh", status: "sent", monthlyTotal: 100, createdAt: daysAgo(3) }),
        estimate({ id: "old", status: "sent", monthlyTotal: 200, createdAt: daysAgo(10) }),
      ],
    });

    expect(screen.getAllByText("$100").length).toBeGreaterThan(0);
    expect(screen.queryByText("$300")).not.toBeInTheDocument();
  });
});
