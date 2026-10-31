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

  it("a search refresh keeps the search focused and an unsaved reply; a failed one keeps the list", async () => {
    const fetch = vi.fn(async (url) => {
      if (String(url).includes("search=Ta")) {
        return response({ error: "Synthetic refresh failure" }, 503);
      }
      return response({
        reviews: [{
          id: "review-1",
          reviewerName: "Taylor Example",
          reviewText: "Synthetic review evidence",
          starRating: 5,
          locationId: "sarasota",
        }],
        locations: [],
        stats: { totalReviews: 1, avgRating: 5, unresponded: 1, responded: 0 },
      });
    });
    vi.stubGlobal("fetch", fetch);
    render(<ReviewsPage />);
    const reply = await screen.findByPlaceholderText("Write your reply...");
    // ReviewCard re-seeds its editor in an effect that runs after the card first renders. On a loaded runner that
    // effect can still be pending when the editor appears; React then runs it inside the first change event, after
    // the typed text, and the text is wiped (main 10-31). No person types inside that window. The first event has
    // run the pending effect, so typing again holds.
    fireEvent.change(reply, { target: { value: "Thanks, Taylor!" } });
    if (reply.value !== "Thanks, Taylor!") fireEvent.change(reply, { target: { value: "Thanks, Taylor!" } });
    expect(reply).toHaveValue("Thanks, Taylor!");

    const searchBox = screen.getByPlaceholderText("Search reviews...");
    searchBox.focus();
    fireEvent.change(searchBox, { target: { value: "T" } });
    await waitFor(() =>
      expect(fetch.mock.calls.some(([u]) => String(u).includes("search=T"))).toBe(true),
    );
    await screen.findByText("1 review");
    expect(document.activeElement).toBe(searchBox);
    expect(searchBox).toHaveValue("T");
    expect(screen.getByPlaceholderText("Write your reply...")).toHaveValue("Thanks, Taylor!");

    fireEvent.change(searchBox, { target: { value: "Ta" } });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not refresh reviews: Synthetic refresh failure",
    );
    expect(screen.getByText("Synthetic review evidence")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Write your reply...")).toHaveValue("Thanks, Taylor!");
    expect(document.activeElement).toBe(searchBox);
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

  it("shows why each match candidate fits the review or not", async () => {
    const fetch = vi.fn(async (url) => {
      const path = String(url);
      if (path.includes("/admin/reviews/incentives/attribution-candidates?")) {
        return response({
          candidates: [
            {
              id: "customer-fit",
              name: "Marlow Pemberton",
              services: [],
              evidence: {
                nameKind: "exact", role: "holder", dates: "fits", firstContactAt: "2025-10-24T04:00:00.000Z",
                tap: false, recent: true, saidReviewed: false, alreadyLinkedHere: false,
              },
            },
            {
              id: "customer-short",
              name: "Ottilie Pemberton",
              services: [],
              evidence: {
                nameKind: "near", role: "holder", dates: "unknown", firstContactAt: null,
                tap: false, recent: false, saidReviewed: false, alreadyLinkedHere: false,
              },
            },
            {
              id: "customer-late",
              name: "Gwen Pemberton",
              services: [],
              evidence: {
                nameKind: "household", role: "holder", dates: "clash", firstContactAt: "2026-05-14T16:00:00.000Z",
                tap: true, recent: false, saidReviewed: true, alreadyLinkedHere: true,
              },
            },
            { id: "customer-plain", name: "Dana Fenwick", services: [] },
          ],
          likelyReviewers: [],
        });
      }
      if (path.includes("/admin/reviews/incentives/attribution-queue?")) {
        return response({
          items: [{ id: "review-unmatched", reviewerName: "Marlow Pemberton", reason: "missing_customer", starRating: 5 }],
        });
      }
      if (path.includes("/admin/reviews/incentives?")) {
        return response({
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
    await screen.findByText("Dana Fenwick");

    // A card without evidence (an older server) shows no evidence line.
    expect(screen.getAllByTestId("link-evidence").map((node) => node.textContent)).toEqual([
      "Same name | First contact Oct 24, 2025 | Visit or review text in the 14 days before",
      "Close name, not the same | First contact unknown",
      'Same surname, different first name | First contact May 14, 2026, after this review | Tapped the review link within 3 hours | Texted "I left a review" | Already linked to another review on this profile',
    ]);
  });
});
