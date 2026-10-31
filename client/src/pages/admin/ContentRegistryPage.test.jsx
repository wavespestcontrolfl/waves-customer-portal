// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { adminFetch, refresh } = vi.hoisted(() => ({
  adminFetch: vi.fn(),
  refresh: { callback: null },
}));

vi.mock("../../utils/admin-fetch", () => ({ adminFetch }));
vi.mock("../../hooks/useVisiblePageRefresh", () => ({
  default: (callback) => {
    refresh.callback = callback;
  },
}));

import ContentRegistryPage from "./ContentRegistryPage";

const EMPTY_REGISTRY = {
  items: [],
  counts: {},
  facets: { content_type: {}, source: {}, live_status: {} },
  total: 0,
};

beforeEach(() => {
  adminFetch.mockReset();
  refresh.callback = null;
});

afterEach(cleanup);

it("preserves a failed sync while automatic reads clear only read errors", async () => {
  let readError = "";
  adminFetch.mockImplementation((path, options) => {
    if (options?.method === "POST") return Promise.reject(new Error("Registry sync failed"));
    if (readError) {
      const message = readError;
      readError = "";
      return Promise.reject(new Error(message));
    }
    return Promise.resolve(EMPTY_REGISTRY);
  });

  render(<ContentRegistryPage embedded />);
  expect(await screen.findByText("No registry rows match the current filters.")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Sync" }));
  await screen.findByText("Registry sync failed");

  readError = "Registry read failed";
  await act(async () => refresh.callback());
  expect(screen.getByText("Registry sync failed")).toBeInTheDocument();
  expect(screen.getByText("Registry read failed")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);

  await act(async () => refresh.callback());
  expect(screen.getByText("Registry sync failed")).toBeInTheDocument();
  expect(screen.queryByText("Registry read failed")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
});

it("pages the inventory past the first response and restarts on a filter change (BLOG-12)", async () => {
  adminFetch.mockImplementation((path) => {
    const offset = Number(new URL(path, "http://x").searchParams.get("offset") || 0);
    return Promise.resolve({
      ...EMPTY_REGISTRY,
      items: [{ id: `row-${offset}`, title: `Row at ${offset}`, reconciliation_status: "matched" }],
      total: 101,
      offset,
    });
  });

  render(<ContentRegistryPage embedded />);
  expect(await screen.findByText("1–1 of 101 filtered")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(await screen.findByText("2–2 of 101 filtered")).toBeInTheDocument();
  expect(screen.getAllByText("Row at 1").length).toBeGreaterThan(0);
  expect(adminFetch.mock.calls.at(-1)[0]).toContain("offset=1");

  fireEvent.change(screen.getByPlaceholderText("Search title, URL, slug, or source path"), {
    target: { value: "termite" },
  });
  expect(await screen.findByText("1–1 of 101 filtered")).toBeInTheDocument();
  const last = adminFetch.mock.calls.at(-1)[0];
  expect(last).toContain("search=termite");
  expect(last).not.toContain("offset=");
});
