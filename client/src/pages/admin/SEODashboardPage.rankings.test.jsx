// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SEODashboardPage from "./SEODashboardPage";

const reply = (data) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  clone() {
    return this;
  },
  json: async () => data,
});

async function renderRankings(rankings) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (String(url).includes("/rankings")) {
        return reply({ summary: {}, rankings });
      }
      if (String(url).includes("/ai-overview")) {
        return reply({ total: 0, withAIO: 0, wavesCited: 0, results: [] });
      }
      return reply({ llmStats: {} });
    }),
  );
  render(<SEODashboardPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Organic Rankings" }));
}

const cardFor = (title) =>
  screen.getByText(title).closest("div").parentElement;

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => "fixture-token" });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("lists a keyword that moved from #10 to #3 under Biggest Gains, not Drops", async () => {
  await renderRankings([
    {
      keyword: "gain keyword",
      currentPosition: 3,
      delta: 7,
      history: [{ position: 3 }, { position: 10 }],
    },
  ]);
  const gains = cardFor("Biggest Gains (7 days)");
  expect(within(gains).getByText("gain keyword")).toBeInTheDocument();
  expect(within(gains).getByText(/#10 → #3 \+7/)).toBeInTheDocument();
  const drops = cardFor("Biggest Drops (7 days)");
  expect(within(drops).queryByText("gain keyword")).not.toBeInTheDocument();
});

it("lists a keyword that moved from #3 to #10 under Biggest Drops", async () => {
  await renderRankings([
    {
      keyword: "drop keyword",
      currentPosition: 10,
      delta: -7,
      history: [{ position: 10 }, { position: 3 }],
    },
  ]);
  const drops = cardFor("Biggest Drops (7 days)");
  expect(within(drops).getByText("drop keyword")).toBeInTheDocument();
  expect(within(drops).getByText(/#3 → #10 -7/)).toBeInTheDocument();
  const gains = cardFor("Biggest Gains (7 days)");
  expect(within(gains).queryByText("drop keyword")).not.toBeInTheDocument();
});

it("filters by the stored service category and labels the pills", async () => {
  await renderRankings([
    { keyword: "ants near me", currentPosition: 4, service_category: "pest_control" },
    { keyword: "St Augustine fertilizer", currentPosition: 6, service_category: "lawn_care" },
    { keyword: "shrub care", currentPosition: 8, service_category: "tree_and_shrub_care" },
  ]);
  expect(screen.getByRole("button", { name: "Tree and Shrub Care" })).toBeInTheDocument();
  expect(screen.getByText("ants near me")).toBeInTheDocument();
  expect(screen.getByText("St Augustine fertilizer")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Pest Control" }));
  expect(screen.getByText("ants near me")).toBeInTheDocument();
  expect(screen.queryByText("St Augustine fertilizer")).not.toBeInTheDocument();
  expect(screen.queryByText("No keywords match filters")).not.toBeInTheDocument();

  // The city pills also start with "All"; the category row comes second.
  fireEvent.click(screen.getAllByRole("button", { name: "All" })[1]);
  expect(screen.getByText("ants near me")).toBeInTheDocument();
  expect(screen.getByText("St Augustine fertilizer")).toBeInTheDocument();
});
