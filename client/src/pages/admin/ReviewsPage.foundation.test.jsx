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
                nameKind: "exact", role: "holder", dates: "fits", firstContactAt: "2025-10-24T04:00:00.000Z", contactAfterReview: false,
                tap: false, recent: true, saidReviewed: false, alreadyLinkedHere: false,
              },
            },
            {
              id: "customer-short",
              name: "Ottilie Pemberton",
              services: [],
              evidence: {
                nameKind: "near", role: "holder", dates: "fits", firstContactAt: "2026-05-16T14:00:00.000Z", contactAfterReview: true,
                tap: false, recent: false, saidReviewed: false, alreadyLinkedHere: false,
              },
            },
            {
              id: "customer-late",
              name: "Gwen Pemberton",
              services: [],
              evidence: {
                nameKind: "household", role: "holder", dates: "clash", firstContactAt: "2026-05-14T16:00:00.000Z", contactAfterReview: true,
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
      // Inside the matcher's 3-day allowance ("fits") the panel still says the contact came later.
      "Close name, not the same | First contact May 16, 2026, after this review",
      'Same surname, different first name | First contact May 14, 2026, after this review | Tapped the review link within 3 hours | Texted "I left a review" | Already linked to another review on this profile',
    ]);
  });

  it("settles a review matcher suggestion: dismiss it, or match a late contact on a second click", async () => {
    const posts = [];
    const fetch = vi.fn(async (url, options = {}) => {
      const path = String(url);
      if (options.method === "POST") {
        posts.push({ path, body: JSON.parse(options.body || "{}") });
        return response({ success: true });
      }
      if (path.includes("/admin/reviews/incentives/attribution-candidates?")) {
        return response({
          candidates: [{
            id: "customer-dana",
            name: "Dana Fenwick",
            services: [{ id: "svc-1", technicianId: "tech-1", technicianName: "Synthetic Tech", serviceDate: "2026-10-01" }],
            evidence: {
              nameKind: "near", role: "holder", dates: "fits", firstContactAt: "2026-10-22T14:00:00.000Z", contactAfterReview: true,
              tap: false, recent: false, saidReviewed: false, alreadyLinkedHere: false,
            },
          }, {
            // An old review's customer often has no visit near it: the no-visit confirm is offered.
            id: "customer-old",
            name: "Dana Fenwick Senior",
            services: [],
          }],
          likelyReviewers: [],
        });
      }
      if (path.includes("/admin/reviews/incentives/attribution-queue?")) {
        return response({
          items: [{
            id: "review-pause",
            reviewerName: "Dana Fenwikc",
            reason: "name_match_pause",
            starRating: 5,
            suggestedCustomerId: "customer-dana",
            suggestedCustomerName: "Dana Fenwick",
            nameMatchResult: "pause",
          }],
        });
      }
      if (path.includes("/admin/reviews/incentives?")) {
        return response({ summary: { confirmedGoogleReviews: 1 }, payouts: [], leaderboard: [], policy: { enabled: true, amountCents: 500 } });
      }
      if (path.includes("/admin/reviews")) {
        return response({ reviews: [], locations: [], stats: { totalReviews: 0, avgRating: 0, unresponded: 0, responded: 0 } });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetch);

    render(<ReviewsPage />);
    await screen.findByText("No reviews match your filters");
    fireEvent.click(screen.getByRole("button", { name: "Outreach" }));
    fireEvent.click(screen.getByRole("button", { name: "Incentives" }));
    expect(await screen.findByText("Possibly Dana Fenwick: close name")).toBeInTheDocument();

    // A first contact after the review: the first click only warns.
    fireEvent.click(screen.getByRole("button", { name: "Match" }));
    const matchButton = await screen.findByRole("button", { name: /Synthetic Tech/ });
    expect(screen.getByRole("button", { name: "Confirm match (no visit on file)" })).toBeInTheDocument();
    fireEvent.click(matchButton);
    expect(await screen.findByRole("status")).toHaveTextContent("first contact came after the review");
    expect(posts).toEqual([]);
    fireEvent.click(matchButton);
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual(["/api/admin/reviews/incentives/attribute"]));

    fireEvent.click(screen.getByRole("button", { name: "Not this customer" }));
    await waitFor(() => expect(posts.at(-1)).toEqual({
      path: "/api/admin/reviews/review-pause/name-match/dismiss",
      body: { customerId: "customer-dana", result: "pause" },
    }));
  });

  it("shows the monthly review cap and labels a payout over it (owner 2026-11-20 D4)", async () => {
    const incentives = (policy, payouts) => vi.fn(async (url) => {
      const path = String(url);
      if (path.includes("/admin/reviews/incentives/attribution-queue?")) return response({ items: [] });
      if (path.includes("/admin/reviews/incentives?")) {
        return response({ summary: { confirmedGoogleReviews: 1 }, payouts, leaderboard: [], policy });
      }
      if (path.includes("/admin/reviews")) {
        return response({ reviews: [], locations: [], stats: { totalReviews: 0, avgRating: 0, unresponded: 0, responded: 0 } });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const payout = (id, patch) => ({
      id, technicianName: "Sample Alpha", source: "google_review", amountCents: 1500, status: "earned",
      earnedAt: "2027-01-10T15:00:00Z", ...patch,
    });
    vi.stubGlobal("fetch", incentives(
      { enabled: true, amountCents: 1500, monthlyCapCount: 15 },
      [payout("p-ok"), payout("p-over", { overMonthlyCap: true })],
    ));
    render(<ReviewsPage />);
    await screen.findByText("No reviews match your filters");
    fireEvent.click(screen.getByRole("button", { name: "Outreach" }));
    fireEvent.click(screen.getByRole("button", { name: "Incentives" }));
    expect(await screen.findByText("15 reviews a month")).toBeInTheDocument();
    expect(screen.getByText("Over monthly cap \u2014 not paid")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();

    cleanup();
    vi.stubGlobal("fetch", incentives({ enabled: true, amountCents: 500, monthlyCapCount: null }, []));
    render(<ReviewsPage />);
    await screen.findByText("No reviews match your filters");
    fireEvent.click(screen.getByRole("button", { name: "Outreach" }));
    fireEvent.click(screen.getByRole("button", { name: "Incentives" }));
    expect(await screen.findByText("No monthly cap")).toBeInTheDocument();

    // A failed policy load shows Unavailable, never "No monthly cap".
    cleanup();
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const path = String(url);
      if (path.includes("/admin/reviews/incentives/attribution-queue?")) return response({ items: [] });
      if (path.includes("/admin/reviews/incentives?")) return response({ error: "Synthetic policy failure" }, 503);
      if (path.includes("/admin/reviews")) {
        return response({ reviews: [], locations: [], stats: { totalReviews: 0, avgRating: 0, unresponded: 0, responded: 0 } });
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    render(<ReviewsPage />);
    await screen.findByText("No reviews match your filters");
    fireEvent.click(screen.getByRole("button", { name: "Outreach" }));
    fireEvent.click(screen.getByRole("button", { name: "Incentives" }));
    expect(await screen.findByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No monthly cap")).toBeNull();
  }, 30000);

  it("the cap card says Unavailable when a refresh fails after a successful load", async () => {
    let failing = false;
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const path = String(url);
      if (path.includes("/admin/reviews/incentives/attribution-queue?")) return response({ items: [] });
      if (path.includes("/admin/reviews/incentives?")) {
        return failing
          ? response({ error: "Synthetic refresh failure" }, 503)
          : response({ summary: { confirmedGoogleReviews: 1 }, payouts: [], leaderboard: [], policy: { enabled: true, amountCents: 1500, monthlyCapCount: 15 } });
      }
      if (path.includes("/admin/reviews")) {
        return response({ reviews: [], locations: [], stats: { totalReviews: 0, avgRating: 0, unresponded: 0, responded: 0 } });
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    render(<ReviewsPage />);
    await screen.findByText("No reviews match your filters");
    fireEvent.click(screen.getByRole("button", { name: "Outreach" }));
    fireEvent.click(screen.getByRole("button", { name: "Incentives" }));
    expect(await screen.findByText("15 reviews a month")).toBeInTheDocument();
    failing = true;
    await act(async () => refresh.callback());
    expect(await screen.findByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText("15 reviews a month")).toBeNull();
  }, 30000);

  it("Mark Pending Paid sends only the pending ids the button was enabled from, never over-cap rows", async () => {
    const posts = [];
    const payout = (id, patch) => ({
      id, technicianName: "Sample Alpha", source: "google_review", amountCents: 1500, status: "earned",
      earnedAt: "2027-01-10T15:00:00Z", ...patch,
    });
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const path = String(url);
      if (options.method === "POST") {
        posts.push({ path, body: JSON.parse(options.body || "{}") });
        return response({ success: true, updated: 1, skippedOverCap: 2 });
      }
      if (path.includes("/admin/reviews/incentives/attribution-queue?")) return response({ items: [] });
      if (path.includes("/admin/reviews/incentives?")) {
        return response({
          summary: { confirmedGoogleReviews: 1 },
          payouts: [payout("p-ok"), payout("p-over", { overMonthlyCap: true }), payout("p-paid", { status: "paid" })],
          leaderboard: [],
          policy: { enabled: true, amountCents: 1500, monthlyCapCount: 1 },
        });
      }
      if (path.includes("/admin/reviews")) {
        return response({ reviews: [], locations: [], stats: { totalReviews: 0, avgRating: 0, unresponded: 0, responded: 0 } });
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    render(<ReviewsPage />);
    await screen.findByText("No reviews match your filters");
    fireEvent.click(screen.getByRole("button", { name: "Outreach" }));
    fireEvent.click(screen.getByRole("button", { name: "Incentives" }));
    fireEvent.click(await screen.findByRole("button", { name: /Mark Pending Paid/ }));
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual(["/api/admin/reviews/incentives/mark-paid"]));
    expect(posts[0].body).toEqual({ ids: ["p-ok"] });
    expect(await screen.findByText("Marked 1 paid; 2 skipped (over the monthly cap)")).toBeInTheDocument();
  });
});
