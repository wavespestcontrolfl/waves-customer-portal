// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./ReviewVelocityEngine", () => ({
  default: () => <div>Velocity workspace</div>,
}));
vi.mock("./GBPManagement", () => ({ default: () => <div>GBP workspace</div> }));

import ReviewsPage from "./ReviewsPage";

const response = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Reviews workspace foundation", () => {
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
    expect(screen.getByRole("button", { name: "Review Outreach" })).toHaveClass(
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

    fireEvent.click(screen.getByRole("button", { name: "GBP" }));
    expect(screen.getByText("GBP workspace")).toBeInTheDocument();
  });
});
