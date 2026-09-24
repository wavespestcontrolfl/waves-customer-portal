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

import PriceMatchPage from "./PriceMatchPage";

function draft(id, subject) {
  return {
    id,
    subject,
    status: "pending",
    included_count: 1,
    created_at: "2026-09-24T12:00:00.000Z",
    recipient: "rep@example.test",
    matches: [],
    html: `<p>${subject}</p>`,
  };
}

function list(drafts) {
  return { drafts, recipient: "rep@example.test" };
}

beforeEach(() => {
  adminFetch.mockReset();
  refresh.callback = null;
});

afterEach(cleanup);

it("clears the selected draft and detail when a poll removes it", async () => {
  const first = draft("draft-a", "Draft A");
  let listReads = 0;
  adminFetch.mockImplementation((path) => {
    if (path === "/admin/price-match/drafts?status=active") {
      listReads += 1;
      return Promise.resolve(list(listReads === 1 ? [first] : []));
    }
    if (path === "/admin/price-match/drafts/draft-a") {
      return Promise.resolve({ draft: first });
    }
    throw new Error(`Unexpected request: ${path}`);
  });

  render(<PriceMatchPage />);
  fireEvent.click(await screen.findByText("Draft A"));
  expect(
    await screen.findByRole("button", { name: "Send to rep…" }),
  ).toBeInTheDocument();

  await act(async () => refresh.callback());

  expect(
    screen.getByText("Select a draft to review what will be sent."),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Send to rep…" })).toBeNull();
  expect(screen.queryByText("Draft A")).toBeNull();
});

it("reconciles a completed poll against the operator's latest selection", async () => {
  const first = draft("draft-a", "Draft A");
  const second = draft("draft-b", "Draft B");
  let resolvePoll;
  let listReads = 0;
  adminFetch.mockImplementation((path) => {
    if (path === "/admin/price-match/drafts?status=active") {
      listReads += 1;
      if (listReads === 1) return Promise.resolve(list([first, second]));
      return new Promise((resolve) => {
        resolvePoll = resolve;
      });
    }
    if (path === "/admin/price-match/drafts/draft-a") {
      return Promise.resolve({ draft: first });
    }
    if (path === "/admin/price-match/drafts/draft-b") {
      return Promise.resolve({ draft: second });
    }
    throw new Error(`Unexpected request: ${path}`);
  });

  render(<PriceMatchPage />);
  fireEvent.click(await screen.findByText("Draft A"));
  expect(await screen.findByRole("heading", { name: "Draft A" })).toBeInTheDocument();

  let poll;
  act(() => {
    poll = refresh.callback();
  });
  await waitFor(() => expect(listReads).toBe(2));

  fireEvent.click(screen.getByText("Draft B"));
  expect(await screen.findByRole("heading", { name: "Draft B" })).toBeInTheDocument();

  await act(async () => {
    resolvePoll(list([second]));
    await poll;
  });

  expect(screen.getByRole("heading", { name: "Draft B" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Draft B/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("button", { name: "Send to rep…" })).toBeInTheDocument();
});

it("clears a recovered poll error without hiding an action failure", async () => {
  let failRead = false;
  adminFetch.mockImplementation((path, options) => {
    if (options?.method === "POST") {
      return Promise.reject(new Error("Synthetic scan failure"));
    }
    if (path === "/admin/price-match/drafts?status=active") {
      return failRead
        ? Promise.reject(new Error("Synthetic read failure"))
        : Promise.resolve(list([]));
    }
    throw new Error(`Unexpected request: ${path}`);
  });

  render(<PriceMatchPage />);
  expect(await screen.findByText("No drafts in this view.")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Preview scan" }));
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
