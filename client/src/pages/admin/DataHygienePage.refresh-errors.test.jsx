// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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

import DataHygienePage from "./DataHygienePage";

beforeEach(() => {
  adminFetch.mockReset();
  refresh.callback = null;
});

afterEach(cleanup);

it("clears a recovered read error without hiding a scan failure", async () => {
  let failRead = false;
  adminFetch.mockImplementation((path, options) => {
    if (options?.method === "POST") {
      return Promise.reject(new Error("Synthetic scan failure"));
    }
    if (failRead) return Promise.reject(new Error("Synthetic read failure"));
    if (path.includes("/proposals?")) return Promise.resolve({ proposals: [] });
    if (path.includes("/metrics")) return Promise.resolve({});
    throw new Error(`Unexpected request: ${path}`);
  });

  render(
    <MemoryRouter>
      <DataHygienePage />
    </MemoryRouter>,
  );
  expect(await screen.findByText("No proposals found.")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Dry run" }));
  expect(await screen.findByText("Synthetic scan failure")).toBeInTheDocument();

  failRead = true;
  await act(async () => refresh.callback());
  expect(screen.getByText("Synthetic read failure")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();

  failRead = false;
  await act(async () => refresh.callback());
  expect(screen.queryByText("Synthetic read failure")).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(screen.getByText("Synthetic scan failure")).toBeInTheDocument();
});
