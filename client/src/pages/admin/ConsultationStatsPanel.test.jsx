// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ConsultationStatsPanel from "./ConsultationStatsPanel";

afterEach(cleanup);

const fullStats = {
  booked: 20,
  showed: 16,
  won: 8,
  won_by_via: { estimate_accept: 5, office_booking: 3 },
  warm: 4,
  cold: 2,
  lost: 2,
  no_show: 2,
  lost_by_reason: { price: 1, no_show: 1 },
  by_technician: [
    { technician_id: "tech-1", name: "Adam", showed: 10, won: 5 },
    { technician_id: "tech-2", name: "Jordan", showed: 6, won: 3 },
  ],
  by_source: [
    { lead_source: "Google Ads", showed: 10, won: 5 },
    { lead_source: "Referral", showed: 6, won: 3 },
  ],
  median_days_to_close: 4.5,
};

const emptyStats = {
  booked: 0,
  showed: 0,
  won: 0,
  won_by_via: {},
  warm: 0,
  cold: 0,
  lost: 0,
  no_show: 0,
  lost_by_reason: {},
  by_technician: [],
  by_source: [],
  median_days_to_close: null,
};

it("renders counts and derived rates from a stubbed response", async () => {
  const adminFetch = vi.fn().mockResolvedValue(fullStats);
  render(<ConsultationStatsPanel adminFetch={adminFetch} />);
  expect(await screen.findByText("Consultations")).toBeInTheDocument();
  expect(adminFetch).toHaveBeenCalledWith("/admin/consultations/stats");

  // Booked / showed / won counts.
  expect(screen.getByText("20")).toBeInTheDocument();
  expect(screen.getByText("16")).toBeInTheDocument();
  expect(screen.getByText("8")).toBeInTheDocument();

  // Show rate 16/20 = 80.0%, close rate 8/16 = 50.0%.
  expect(screen.getByText("Show rate 80.0%")).toBeInTheDocument();
  expect(screen.getByText("Close rate 50.0%")).toBeInTheDocument();

  // Still-open warm/cold.
  expect(screen.getByText("Warm 4 · Cold 2")).toBeInTheDocument();

  // Median days to close.
  expect(screen.getByText("4.5 days")).toBeInTheDocument();

  // Lost by reason + won by via labels.
  expect(screen.getByText("Price")).toBeInTheDocument();
  expect(screen.getByText("No-show")).toBeInTheDocument();
  expect(screen.getByText("Accepted estimate")).toBeInTheDocument();
  expect(screen.getByText("Office booking")).toBeInTheDocument();

  // By-technician and by-source tables with their own close rates.
  expect(screen.getByText("Adam")).toBeInTheDocument();
  expect(screen.getByText("Jordan")).toBeInTheDocument();
  expect(screen.getByText("Google Ads")).toBeInTheDocument();
  expect(screen.getByText("Referral")).toBeInTheDocument();
  // 5/10 (Adam, Google Ads) and 3/6 (Jordan, Referral) each = 50.0%, four
  // table cells total.
  expect(screen.getAllByText("50.0%").length).toBe(4);
});

it("shows a sparse-data empty state instead of zero-filled cards when nothing is booked", async () => {
  const adminFetch = vi.fn().mockResolvedValue(emptyStats);
  render(<ConsultationStatsPanel adminFetch={adminFetch} />);
  expect(
    await screen.findByText(/No consultations or outcomes recorded yet/),
  ).toBeInTheDocument();
  // The metric-grid-only elements must not render in the empty state.
  expect(screen.queryByText("By technician")).not.toBeInTheDocument();
});

it("guards divide-by-zero when booked visits exist but none have shown yet", async () => {
  // booked > 0 but showed = 0: show rate is a real 0.0% (denominator 3 is
  // real), while close rate (won/showed) divides by zero and must read "—".
  const sparse = { ...emptyStats, booked: 3, by_technician: [], by_source: [] };
  render(<ConsultationStatsPanel adminFetch={vi.fn().mockResolvedValue(sparse)} />);
  expect(await screen.findByText("Show rate 0.0%")).toBeInTheDocument();
  expect(screen.getByText("Close rate —")).toBeInTheDocument();
});

it("renders a retryable error state on fetch failure without crashing the tab", async () => {
  const adminFetch = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(fullStats);
  render(<ConsultationStatsPanel adminFetch={adminFetch} />);
  expect(
    await screen.findByText("Couldn't load consultation stats: offline"),
  ).toBeInTheDocument();
  screen.getByRole("button", { name: "Try again" }).click();
  await waitFor(() => expect(screen.getByText("20")).toBeInTheDocument());
  expect(adminFetch).toHaveBeenCalledTimes(2);
});
