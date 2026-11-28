// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import OpsScoreboardCard from "./OpsScoreboardCard";
import WeeklyBiCard from "./WeeklyBiCard";
import OrganicTrafficCard from "./OrganicTrafficCard";
import CashRunwayCard from "./CashRunwayCard";

afterEach(cleanup);

describe("OpsScoreboardCard", () => {
  it("renders voicemail alert, drive/stop, bookings, route adherence, and picker conversion", () => {
    render(
      <OpsScoreboardCard
        data={{
          window: { from: "2026-11-20", to: "2026-11-26" },
          aiCallShare: { aiHandled: 10, transferred: 2, humanAnswered: 3, voicemail: 5, share: 0.67 },
          driveMinutesPerStop: { share: 11.4, timedStops: 42, completedStops: 45, vanDrivingMiles: 312.6 },
          bookingsWithoutStaff: { share: 0.4, ai: 3, customerSelfServe: 1, staff: 6, aiPendingReview: 2 },
          aiRouteDays: { share: 0.75, daysFollowed: 6, denominator: 8 },
          customerPickerConversion: { numerator: 5, denominator: 10, share: 0.5 },
        }}
      />,
    );
    const vmVal = screen.getByText("25%");
    expect(vmVal.className).toContain("text-alert-fg");
    expect(screen.getByText("11.4m")).toBeInTheDocument();
    expect(screen.getByText(/313 van mi/)).toBeInTheDocument();
    expect(screen.getByText("40%")).toBeInTheDocument();
    expect(screen.getByText(/2 pending/)).toBeInTheDocument();
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(screen.getByText(/50%/)).toBeInTheDocument();
  });

  it("handles degraded sub-metrics without crashing", () => {
    render(
      <OpsScoreboardCard
        data={{
          window: { from: "2026-11-20", to: "2026-11-26" },
          aiCallShare: { error: "unavailable" },
          driveMinutesPerStop: { error: "unavailable" },
          bookingsWithoutStaff: { error: "unavailable" },
          aiRouteDays: { error: "unavailable" },
        }}
      />,
    );
    expect(screen.getByText("call data unavailable")).toBeInTheDocument();
    expect(screen.getByText("drive data unavailable")).toBeInTheDocument();
  });
});

describe("WeeklyBiCard", () => {
  it("renders summary and toggles action items & anomalies", () => {
    render(
      <WeeklyBiCard
        data={{
          reports: [{
            id: "r1",
            week_of: "2026-11-23",
            summary: "Revenue rose 12% week over week.",
            action_items: "- Follow up on 4 unpaid invoices\n- Review voicemail hours",
            anomalies_section: "Tuesday voicemail rate spiked to 35%.",
          }],
        }}
      />,
    );
    expect(screen.getByText("Week of 2026-11-23")).toBeInTheDocument();
    expect(screen.getByText("Revenue rose 12% week over week.")).toBeInTheDocument();
    expect(screen.queryByText(/Follow up on 4 unpaid invoices/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /View 2 action items/ }));
    expect(screen.getByText("Follow up on 4 unpaid invoices")).toBeInTheDocument();
    expect(screen.getByText("Tuesday voicemail rate spiked to 35%.")).toBeInTheDocument();
  });
});

describe("OrganicTrafficCard", () => {
  it("renders GSC + GA4 metrics, deltas, and link to /admin/seo", () => {
    render(
      <MemoryRouter>
        <OrganicTrafficCard
          data={{
            gsc: { clicks: 412, impressions: 18500, avgPosition: 14.2, nonbrandClicks: 290, clicksDeltaPct: 18.5, latestDate: "2026-11-24" },
            ga4: { sessions: 980, users: 740, conversions: 24, pageviews: 2150, sessionsDeltaPct: -20, latestDate: "2026-11-26" },
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("412 clicks")).toBeInTheDocument();
    expect(screen.getByText("+18.5% vs prior 30d")).toBeInTheDocument();
    expect(screen.getByText("980 sessions")).toBeInTheDocument();
    expect(screen.getByText("-20% vs prior 30d").className).toContain("text-alert-fg");
    expect(screen.getByRole("link", { name: /Open SEO/ })).toHaveAttribute("href", "/admin/seo");
  });
});

describe("CashRunwayCard", () => {
  it("renders bank balance, card owed, 13-week lows, alerts on negative balance, and links to Banking", () => {
    render(
      <MemoryRouter>
        <CashRunwayCard
          data={{
            window_end: "2027-02-25",
            opening: { bank_usd: 18400, partial: false, card_owed_usd: 2150 },
            expected_available: true,
            lowest: {
              booked: { week_start: "2027-01-11", usd: -450 },
              expected: { week_start: "2026-12-14", usd: 11200 },
            },
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("$18,400")).toBeInTheDocument();
    expect(screen.getByText("$2,150")).toBeInTheDocument();
    expect(screen.getByText("-$450").className).toContain("text-alert-fg");
    expect(screen.getByText("$11,200")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open cash forecast/ })).toHaveAttribute("href", "/admin/banking?tab=cash-forecast");
  });
});
