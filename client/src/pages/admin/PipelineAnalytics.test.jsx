// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PipelineAnalytics, {
  aggregateServiceLineRows,
  classifyEstimateServiceLine,
  isFollowUpOverdueEstimate,
  isGoingColdEstimate,
  withinDateRange,
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
      dateRange={props.dateRange || "all"}
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
    ["", "unknown"],
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

  it("uses API serviceLines so bundles count under each actual quoted service", () => {
    const rows = aggregateServiceLineRows([
      estimate({
        id: "bundle",
        status: "accepted",
        serviceInterest: "",
        monthlyTotal: 120,
        serviceLines: [
          { key: "pest", amount: 44 },
          { key: "lawn", amount: 76 },
        ],
      }),
      estimate({
        id: "pest-only",
        status: "viewed",
        serviceInterest: "",
        monthlyTotal: 30,
        serviceLines: [{ key: "pest", amount: 30 }],
      }),
      estimate({
        id: "missing-service",
        status: "sent",
        serviceInterest: "",
        monthlyTotal: 99,
        serviceLines: [{ key: "unknown", amount: null }],
      }),
    ]);

    expect(rows.map((row) => row.key)).toEqual(["pest", "lawn", "unknown"]);
    expect(rows[0]).toMatchObject({
      sent: 2,
      won: 1,
      acceptancePct: 50,
      avgTicket: 37,
    });
    expect(rows[1]).toMatchObject({
      sent: 1,
      won: 1,
      acceptancePct: 100,
      avgTicket: 76,
    });
    expect(rows[2]).toMatchObject({
      sent: 1,
      won: 0,
      acceptancePct: 0,
      avgTicket: 0,
    });
  });

  it("keeps one-time amounts out of the recurring avg ticket", () => {
    const rows = aggregateServiceLineRows([
      estimate({
        id: "monthly-1",
        status: "accepted",
        serviceInterest: "",
        serviceLines: [{ key: "pest", amount: 30, amountBasis: "monthly" }],
      }),
      estimate({
        id: "monthly-2",
        status: "viewed",
        serviceInterest: "",
        serviceLines: [{ key: "pest", amount: 40, amountBasis: "monthly" }],
      }),
      estimate({
        id: "one-time-job",
        status: "accepted",
        serviceInterest: "",
        serviceLines: [{ key: "pest", amount: 350, amountBasis: "one_time" }],
      }),
    ]);

    // Monthly basis dominates (2 vs 1): avg = (30+40)/2, not (30+40+350)/3.
    expect(rows[0]).toMatchObject({
      key: "pest",
      sent: 3,
      avgTicket: 35,
      ticketSuffix: "/mo recurring",
    });
  });

  it("labels a one-time-dominant line as one-time", () => {
    const rows = aggregateServiceLineRows([
      estimate({
        id: "termite-job",
        status: "accepted",
        serviceInterest: "",
        serviceLines: [{ key: "termite", amount: 996, amountBasis: "one_time" }],
      }),
    ]);

    expect(rows[0]).toMatchObject({
      key: "termite",
      avgTicket: 996,
      ticketSuffix: "one-time",
    });
  });

  it("keeps palm injection lines instead of silently dropping them", () => {
    const rows = aggregateServiceLineRows([
      estimate({
        id: "palms",
        status: "sent",
        serviceInterest: "",
        serviceLines: [{ key: "palm_injection", amount: 55, amountBasis: "monthly" }],
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: "palm_injection",
      label: "Palm injection",
      sent: 1,
      avgTicket: 55,
    });
  });

  it("buckets unrecognized line keys as unknown instead of dropping the offer", () => {
    const rows = aggregateServiceLineRows([
      estimate({
        id: "novel",
        status: "sent",
        serviceInterest: "",
        serviceLines: [{ key: "brand_new_service", amount: 10 }],
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "unknown", sent: 1 });
  });

  it("keeps commercial manual quote service lines in pipeline analytics", () => {
    const rows = aggregateServiceLineRows([
      estimate({
        id: "commercial-manual",
        status: "sent",
        serviceInterest: "",
        monthlyTotal: 0,
        serviceLines: [
          { key: "commercial_pest", amount: null },
          { key: "commercial_lawn", amount: null },
        ],
      }),
    ]);

    expect(rows.map((row) => row.key)).toEqual(["commercial_lawn", "commercial_pest"]);
    expect(rows[0]).toMatchObject({
      label: "Commercial lawn",
      sent: 1,
      won: 0,
      avgTicket: 0,
    });
    expect(rows[1]).toMatchObject({
      label: "Commercial pest",
      sent: 1,
      won: 0,
      avgTicket: 0,
    });
  });
});

describe("engagement-based idle checks", () => {
  it("does not flag follow-up overdue when the customer re-engaged recently", () => {
    const e = estimate({
      id: "re-engaged",
      status: "viewed",
      viewedAt: hoursAgo(120),
      lastViewedAt: hoursAgo(20),
    });
    expect(isFollowUpOverdueEstimate(e, NOW.getTime())).toBe(false);

    const clicked = estimate({
      id: "clicked",
      status: "viewed",
      viewedAt: hoursAgo(120),
      lastClickedAt: hoursAgo(10),
    });
    expect(isFollowUpOverdueEstimate(clicked, NOW.getTime())).toBe(false);
  });

  it("still flags follow-up overdue when the latest engagement is stale", () => {
    const e = estimate({
      id: "stale",
      status: "viewed",
      viewedAt: hoursAgo(120),
      lastViewedAt: hoursAgo(72),
    });
    expect(isFollowUpOverdueEstimate(e, NOW.getTime())).toBe(true);
  });

  it("counts sent-but-never-opened estimates past 72h as going cold (matches the row badge)", () => {
    const e = estimate({
      id: "unopened",
      status: "sent",
      sentAt: hoursAgo(96),
      viewedAt: null,
    });
    expect(isGoingColdEstimate(e, NOW.getTime())).toBe(true);
  });

  it("uses last engagement for the going-cold window", () => {
    const reEngaged = estimate({
      id: "warm",
      status: "viewed",
      viewedAt: hoursAgo(120),
      lastViewedAt: hoursAgo(20),
    });
    expect(isGoingColdEstimate(reEngaged, NOW.getTime())).toBe(false);

    const cold = estimate({
      id: "cold",
      status: "viewed",
      viewedAt: hoursAgo(120),
      lastViewedAt: hoursAgo(60),
    });
    expect(isGoingColdEstimate(cold, NOW.getTime())).toBe(true);

    const beyondWindow = estimate({
      id: "final",
      status: "viewed",
      viewedAt: hoursAgo(200),
    });
    expect(isGoingColdEstimate(beyondWindow, NOW.getTime())).toBe(false);
  });
});

describe("withinDateRange", () => {
  it("uses the ET calendar year for YTD boundaries", () => {
    const dec31EtNow = new Date("2026-01-01T04:30:00.000Z").getTime();
    const jan1EtNow = new Date("2026-01-01T05:30:00.000Z").getTime();

    expect(
      withinDateRange("2026-01-01T03:30:00.000Z", "ytd", dec31EtNow),
    ).toBe(true);
    expect(
      withinDateRange("2026-01-01T04:30:00.000Z", "ytd", jan1EtNow),
    ).toBe(false);
  });
});

describe("PipelineAnalytics", () => {
  it("renders four KPI tiles with correct values for 20 estimates", () => {
    renderAnalytics({ estimates: kpiFixture() });

    expect(screen.getByText("Pipeline value")).toBeInTheDocument();
    expect(screen.getAllByText("Avg ticket").length).toBeGreaterThan(0);
    expect(screen.getByText("Offer acceptance")).toBeInTheDocument();
    expect(screen.getByText("MRR won")).toBeInTheDocument();
    expect(screen.getByText("$600")).toBeInTheDocument();
    // Avg ticket over priced non-draft offers only: $1,250 / 17 → $74. The
    // three $0 drafts no longer drag the average down.
    expect(screen.getByText("$74")).toBeInTheDocument();
    // Resolved-only close rate: 4 accepted of 7 resolved (4 + 2 declined +
    // 1 expired) → 57%. The 10 still-open offers no longer count against it.
    expect(screen.getByText("57%")).toBeInTheDocument();
    expect(screen.getByText("4 accepted of 7 resolved")).toBeInTheDocument();
    expect(screen.getByText("$400")).toBeInTheDocument();
  });

  it("keeps still-open offers out of the acceptance denominator", () => {
    renderAnalytics({
      estimates: [
        estimate({ id: "won", status: "accepted", monthlyTotal: 40 }),
        estimate({ id: "no", status: "declined", monthlyTotal: 40 }),
        ...Array.from({ length: 8 }, (_, i) =>
          estimate({ id: `open-${i}`, status: "sent", monthlyTotal: 40 }),
        ),
      ],
    });

    // 1 of 2 resolved → 50%, not 1 of 10 → 10%.
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("counts archived wins in MRR won but keeps them out of every other metric", () => {
    renderAnalytics({
      estimates: [
        estimate({ id: "active-won", status: "accepted", monthlyTotal: 40 }),
        estimate({ id: "no", status: "declined", monthlyTotal: 30 }),
        estimate({
          id: "archived-won",
          status: "accepted",
          monthlyTotal: 60,
          archivedAt: daysAgo(2),
        }),
      ],
    });

    // MRR won: $40 + $60 — archiving the second win must not erase its MRR.
    expect(screen.getAllByText("$100").length).toBeGreaterThan(0);
    expect(screen.getByText("2 new accounts")).toBeInTheDocument();
    // Acceptance rate stays symmetric: archived losses are never fetched, so
    // archived wins don't inflate it. 1 of 2 active-resolved → 50%, not 2/3.
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("1 accepted of 2 resolved")).toBeInTheDocument();
    // Avg ticket over active priced offers only: (40 + 30) / 2 → $35, not $43.
    expect(screen.getAllByText("$35").length).toBeGreaterThan(0);
  });

  it("filters MRR won by acceptance date, not created date", () => {
    renderAnalytics({
      dateRange: "30d",
      estimates: [
        // Created outside the window but won inside it → counts.
        estimate({
          id: "old-created-recent-win",
          status: "accepted",
          monthlyTotal: 70,
          createdAt: daysAgo(60),
          acceptedAt: daysAgo(5),
        }),
        // Won outside the window → excluded even though created recently.
        estimate({
          id: "stale-win",
          status: "accepted",
          monthlyTotal: 25,
          createdAt: daysAgo(60),
          acceptedAt: daysAgo(45),
        }),
      ],
    });

    expect(screen.getAllByText("$70").length).toBeGreaterThan(0);
    expect(screen.getByText("1 new accounts")).toBeInTheDocument();
    // Acceptance uses the same resolution-date basis, so the recent win
    // shows in BOTH KPIs for the window — not "MRR won $70" alongside
    // "0 accepted of 0 resolved".
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByText("1 accepted of 1 resolved")).toBeInTheDocument();
  });

  it("keys the acceptance denominator on decline/expiry dates", () => {
    renderAnalytics({
      dateRange: "30d",
      estimates: [
        estimate({
          id: "recent-win",
          status: "accepted",
          monthlyTotal: 40,
          createdAt: daysAgo(10),
          acceptedAt: daysAgo(5),
        }),
        // Declined inside the window though created long before → counts.
        estimate({
          id: "recent-decline",
          status: "declined",
          monthlyTotal: 30,
          createdAt: daysAgo(60),
          declinedAt: daysAgo(3),
        }),
        // Declined outside the window → excluded.
        estimate({
          id: "old-decline",
          status: "declined",
          monthlyTotal: 30,
          createdAt: daysAgo(60),
          declinedAt: daysAgo(45),
        }),
      ],
    });

    // 1 of 2 resolved this window → 50%, not 1/1 or 1/3.
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("1 accepted of 2 resolved")).toBeInTheDocument();
  });

  it("excludes unpriced drafts and one-time-only rows from avg ticket", () => {
    renderAnalytics({
      estimates: [
        estimate({ id: "a", status: "accepted", monthlyTotal: 40 }),
        estimate({ id: "b", status: "viewed", monthlyTotal: 30, viewedAt: hoursAgo(2) }),
        estimate({ id: "draft-zero", status: "draft", monthlyTotal: 0 }),
        estimate({ id: "one-time", status: "accepted", monthlyTotal: 0, onetimeTotal: 996 }),
      ],
    });

    // (40 + 30) / 2, not (40 + 30 + 0 + 0) / 4. ($35 also shows in the ROI
    // table's pest row, so assert presence rather than uniqueness.)
    expect(screen.getAllByText("$35").length).toBeGreaterThan(0);
    expect(screen.queryByText("$18")).not.toBeInTheDocument();
  });

  it("splits the MRR-won subtitle when one-time jobs are among the wins", () => {
    renderAnalytics({
      estimates: [
        estimate({ id: "r1", status: "accepted", monthlyTotal: 40 }),
        estimate({ id: "r2", status: "accepted", monthlyTotal: 30 }),
        estimate({ id: "ot", status: "accepted", monthlyTotal: 0, onetimeTotal: 350 }),
      ],
    });

    expect(screen.getByText("2 recurring · 1 one-time")).toBeInTheDocument();
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

  it("fires the overdue filter from the follow-up overdue card", () => {
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

    expect(onFilterChange).toHaveBeenCalledWith("follow_up_overdue");
  });

  it("fires the archived filter from the Archived control", () => {
    const { onFilterChange } = renderAnalytics({ estimates: kpiFixture() });

    fireEvent.click(screen.getByRole("button", { name: /Archived/i }));

    expect(onFilterChange).toHaveBeenCalledWith("archived");
  });

  it("fires the going_cold filter from the Going cold card", () => {
    const { onFilterChange } = renderAnalytics({
      estimates: [
        estimate({
          id: "cold",
          status: "viewed",
          viewedAt: hoursAgo(60),
        }),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: /Going cold/i }));

    expect(onFilterChange).toHaveBeenCalledWith("going_cold");
  });

  it("fires dedicated pricing-risk subfilters", () => {
    const { onFilterChange } = renderAnalytics({
      estimates: [
        estimate({
          id: "missing",
          pricingRisk: { hasRisk: true, missingCogsCount: 1, lowMarginCount: 0 },
        }),
        estimate({
          id: "margin",
          pricingRisk: { hasRisk: true, missingCogsCount: 0, lowMarginCount: 1 },
        }),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: /Pricing risk/i }));
    fireEvent.click(screen.getByRole("button", { name: /1 missing COGS/i }));
    fireEvent.click(screen.getByRole("button", { name: /1 low margin/i }));

    expect(onFilterChange).toHaveBeenNthCalledWith(1, "pricing_risk");
    expect(onFilterChange).toHaveBeenNthCalledWith(2, "missing_cogs");
    expect(onFilterChange).toHaveBeenNthCalledWith(3, "low_margin");
  });

  it("discloses scheduled estimates in the Sent funnel subtitle", () => {
    renderAnalytics({
      estimates: [
        estimate({ id: "awaiting", status: "sent", sentAt: hoursAgo(12) }),
        estimate({ id: "scheduled", status: "scheduled" }),
      ],
    });

    expect(
      screen.getByText("1 awaiting · 0 viewed · 1 scheduled"),
    ).toBeInTheDocument();
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

  it("includes older estimates in the all-time default range", () => {
    renderAnalytics({
      estimates: [
        estimate({ id: "fresh", status: "sent", monthlyTotal: 100, createdAt: daysAgo(3) }),
        estimate({ id: "old", status: "sent", monthlyTotal: 200, createdAt: daysAgo(45) }),
      ],
    });

    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("$300")).toBeInTheDocument();
  });
});
