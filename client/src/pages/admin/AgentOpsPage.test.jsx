// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import AgentOpsPage from "./AgentOpsPage";

function payload(title) {
  return {
    summary: {},
    agents: [],
    sources: [],
    tasks: [{
      id: "task-1",
      agentId: "lead_conversion",
      priority: "high",
      sourceLabel: "Fixture",
      title,
      createdAt: "2026-09-24T12:00:00.000Z",
      actions: [{ key: "complete", label: "Complete", endpoint: "/admin/tasks/task-1", method: "POST" }],
    }],
  };
}

beforeEach(() => {
  adminFetch.mockReset();
  refresh.callback = null;
});

afterEach(cleanup);

it("does not let a stale background read overwrite a task action reload", async () => {
  let resolveBackground;
  let overviewReads = 0;
  adminFetch.mockImplementation((path, options) => {
    if (options?.method === "POST") return Promise.resolve({ message: "Complete" });
    if (path === "/admin/agents/overview") {
      overviewReads += 1;
      if (overviewReads === 1) return Promise.resolve(payload("Before action"));
      if (overviewReads === 2) return new Promise((resolve) => { resolveBackground = resolve; });
      return Promise.resolve(payload("After action"));
    }
    throw new Error(`Unexpected request: ${path}`);
  });

  render(<MemoryRouter><AgentOpsPage embedded /></MemoryRouter>);
  expect(await screen.findByText("Before action")).toBeInTheDocument();

  let backgroundPromise;
  act(() => {
    backgroundPromise = refresh.callback();
  });
  await waitFor(() => expect(overviewReads).toBe(2));

  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  expect(await screen.findByText("After action")).toBeInTheDocument();

  await act(async () => {
    resolveBackground(payload("Stale background"));
    await backgroundPromise;
  });
  expect(screen.getByText("After action")).toBeInTheDocument();
  expect(screen.queryByText("Stale background")).toBeNull();
});

it("recovers after a failed task action supersedes an in-flight Retry", async () => {
  let resolveRetry;
  let overviewReads = 0;
  adminFetch.mockImplementation((path, options) => {
    if (options?.method === "POST") return Promise.reject(new Error("Action failed"));
    if (path === "/admin/agents/overview") {
      overviewReads += 1;
      if (overviewReads === 1) return Promise.resolve(payload("Current task"));
      if (overviewReads === 2) return Promise.reject(new Error("Refresh failed"));
      if (overviewReads === 3) return new Promise((resolve) => { resolveRetry = resolve; });
      return Promise.resolve(payload("Recovered task"));
    }
    throw new Error(`Unexpected request: ${path}`);
  });

  render(<MemoryRouter><AgentOpsPage embedded /></MemoryRouter>);
  await screen.findByText("Current task");

  await act(async () => refresh.callback());
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => expect(overviewReads).toBe(3));

  fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Action failed");
  const retry = screen.getByRole("button", { name: "Retry" });
  expect(retry).toBeEnabled();

  await act(async () => resolveRetry(payload("Superseded retry")));
  expect(screen.queryByText("Superseded retry")).not.toBeInTheDocument();

  fireEvent.click(retry);
  expect(await screen.findByText("Recovered task")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
