// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { refresh } = vi.hoisted(() => ({
  refresh: { callback: null },
}));

vi.mock("./ReviewVelocityEngine", () => ({
  default: () => <div>Velocity workspace</div>,
}));
vi.mock("./GBPManagement", () => ({ default: () => <div>GBP workspace</div> }));
vi.mock("../../hooks/useVisiblePageRefresh", () => ({
  default: (callback) => {
    refresh.callback = callback;
  },
}));

import ReviewsPage from "./ReviewsPage";

const response = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => {
  cleanup();
  refresh.callback = null;
  vi.unstubAllGlobals();
});

describe("Reviews workspace foundation", () => {
  it("renders location and pipeline badges on a populated review feed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      reviews: [{
        id: "review-1",
        reviewerName: "Taylor Example",
        reviewText: "Synthetic review evidence",
        starRating: 2,
        locationId: "sarasota",
        autoReply: { status: "parked", reason: "low_rating" },
      }],
      locations: [],
      stats: { totalReviews: 1, avgRating: 2, unresponded: 1, responded: 0 },
    })));
    render(<ReviewsPage />);
    expect(await screen.findByText("Synthetic review evidence")).toBeInTheDocument();
    expect(screen.getByText("Needs you (low rating)")).toBeInTheDocument();
    expect(screen.getByText("Sarasota", { selector: "span" })).toBeInTheDocument();
  });

  it("keeps the grouped Reviews, Outreach, Incentives, and GBP workspaces reachable", async () => {
    const fetch = vi.fn(async () =>
      response({
        reviews: [],
        locations: [],
        stats: { totalReviews: 0, avgRating: 0, unresponded: 0, responded: 0 },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    render(<ReviewsPage />);
    await screen.findByText("No reviews match your filters");

    fireEvent.click(screen.getByRole("button", { name: "Outreach" }));
    expect(screen.getByText("Velocity workspace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Requests" })).toHaveClass(
      "bg-zinc-900",
    );

    fireEvent.click(screen.getByRole("button", { name: "Incentives" }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([url]) =>
          String(url).includes("/admin/reviews/incentives?days=30"),
        ),
      ).toBe(true),
    );

    const period = screen.getByRole("combobox");
    expect(period).toHaveValue("30");
    for (const days of ["7", "90"]) {
      fireEvent.change(period, { target: { value: days } });
      await waitFor(() => {
        expect(fetch).toHaveBeenCalledWith(
          `/api/admin/reviews/incentives?days=${days}`,
          expect.any(Object),
        );
        expect(fetch).toHaveBeenCalledWith(
          `/api/admin/reviews/incentives/attribution-queue?days=${days}`,
          expect.any(Object),
        );
      });
    }

    fireEvent.click(screen.getByRole("button", { name: "GBP" }));
    expect(screen.getByText("GBP workspace")).toBeInTheDocument();
  });

  it("clears a recovered incentive read error without hiding a candidate-search failure", async () => {
    let failRead = false;
    const fetch = vi.fn(async (url) => {
      const path = String(url);
      if (path.includes("/admin/reviews/incentives/attribution-candidates?")) {
        return response({ error: "Synthetic candidate failure" }, 500);
      }
      if (path.includes("/admin/reviews/incentives/attribution-queue?")) {
        return failRead
          ? response({ error: "Synthetic incentive read failure" }, 503)
          : response({
              items: [{
                id: "review-unmatched",
                reviewerName: "Fixture Reviewer",
                reason: "missing_customer",
                starRating: 5,
              }],
            });
      }
      if (path.includes("/admin/reviews/incentives?")) {
        return failRead
          ? response({ error: "Synthetic incentive read failure" }, 503)
          : response({
              summary: { confirmedGoogleReviews: 1 },
              payouts: [],
              leaderboard: [],
              policy: { enabled: true, amountCents: 500 },
            });
      }
      if (path.includes("/admin/reviews")) {
        return response({
          reviews: [],
          locations: [],
          stats: { totalReviews: 0, avgRating: 0, unresponded: 0, responded: 0 },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetch);

    render(<ReviewsPage />);
    await screen.findByText("No reviews match your filters");
    fireEvent.click(screen.getByRole("button", { name: "Outreach" }));
    fireEvent.click(screen.getByRole("button", { name: "Incentives" }));
    fireEvent.click(await screen.findByRole("button", { name: "Match" }));
    expect(await screen.findByText("Synthetic candidate failure")).toBeInTheDocument();

    failRead = true;
    await act(async () => refresh.callback());
    expect(screen.getByText("Synthetic incentive read failure")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();

    failRead = false;
    await act(async () => refresh.callback());
    expect(screen.queryByText("Synthetic incentive read failure")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByText("Synthetic candidate failure")).toBeInTheDocument();
  });
});
