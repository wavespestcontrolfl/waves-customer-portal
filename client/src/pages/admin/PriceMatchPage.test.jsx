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

it("refreshes a selected draft that remains in the list and removes obsolete actions", async () => {
  const pending = draft("draft-a", "Draft A");
  const sending = { ...pending, status: "sending", claimed_at: new Date().toISOString() };
  let current = pending;
  adminFetch.mockImplementation((path) => Promise.resolve(
    path.includes("?status=") ? list([current]) : { draft: current },
  ));
  render(<PriceMatchPage />);
  fireEvent.click(await screen.findByText("Draft A"));
  expect(await screen.findByRole("button", { name: "Send to rep…" })).toBeInTheDocument();
  current = sending;
  await act(async () => refresh.callback());
  expect(screen.getByRole("heading", { name: "Draft A" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Send to rep…" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  expect(screen.getAllByText("sending")).toHaveLength(2);
});

it("does not let an older detail poll overwrite a newer one", async () => {
  const pending = draft("draft-a", "Draft A");
  const sent = { ...pending, status: "sent" };
  let detailReads = 0;
  let resolveOld;
  adminFetch.mockImplementation((path) => {
    if (path.includes("?status=")) return Promise.resolve(list([pending]));
    detailReads += 1;
    if (detailReads === 2) return new Promise(resolve => { resolveOld = resolve; });
    return Promise.resolve({ draft: detailReads === 1 ? pending : sent });
  });
  render(<PriceMatchPage />);
  fireEvent.click(await screen.findByText("Draft A"));
  await screen.findByRole("button", { name: "Send to rep…" });
  let older;
  act(() => { older = refresh.callback(); });
  await waitFor(() => expect(detailReads).toBe(2));
  await act(async () => refresh.callback());
  expect(screen.queryByRole("button", { name: "Send to rep…" })).toBeNull();
  await act(async () => { resolveOld({ draft: pending }); await older; });
  expect(screen.queryByRole("button", { name: "Send to rep…" })).toBeNull();
  expect(screen.getByText("sent")).toBeInTheDocument();
});

it("ignores a detail poll after the operator selects another draft", async () => {
  const first = draft("draft-a", "Draft A");
  const second = draft("draft-b", "Draft B");
  let reads = 0;
  let resolveOld;
  adminFetch.mockImplementation((path) => {
    if (path.includes("?status=")) return Promise.resolve(list([first, second]));
    if (path.endsWith("draft-b")) return Promise.resolve({ draft: second });
    if (++reads === 1) return Promise.resolve({ draft: first });
    return new Promise(resolve => { resolveOld = resolve; });
  });
  render(<PriceMatchPage />);
  fireEvent.click(await screen.findByText("Draft A"));
  await screen.findByRole("heading", { name: "Draft A" });
  let older;
  act(() => { older = refresh.callback(); });
  await waitFor(() => expect(reads).toBe(2));
  fireEvent.click(screen.getByText("Draft B"));
  await screen.findByRole("heading", { name: "Draft B" });
  await act(async () => { resolveOld({ draft: first }); await older; });
  expect(screen.getByRole("heading", { name: "Draft B" })).toBeInTheDocument();
});

it("keeps an in-flight poll from changing the draft during send confirmation", async () => {
  const pending = draft("draft-a", "Draft A");
  let reads = 0;
  let resolvePoll;
  adminFetch.mockImplementation((path) => {
    if (path.includes("?status=")) return Promise.resolve(list([pending]));
    if (++reads === 1) return Promise.resolve({ draft: pending });
    return new Promise(resolve => { resolvePoll = resolve; });
  });
  render(<PriceMatchPage />);
  fireEvent.click(await screen.findByText("Draft A"));
  await screen.findByRole("button", { name: "Send to rep…" });
  let poll;
  act(() => { poll = refresh.callback(); });
  await waitFor(() => expect(reads).toBe(2));
  fireEvent.click(screen.getByRole("button", { name: "Send to rep…" }));
  await act(async () => {
    resolvePoll({ draft: { ...pending, subject: "Changed after confirmation" } });
    await poll;
  });
  expect(screen.getByRole("heading", { name: "Draft A" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Confirm send" })).toBeInTheDocument();
});

it("does not restore stale detail while a dismiss action is in flight", async () => {
  const pending = draft("draft-a", "Draft A");
  let detailReads = 0;
  let resolvePoll;
  let resolveDismiss;
  let dismissed = false;
  adminFetch.mockImplementation((path, options) => {
    if (options?.method === "POST") return new Promise(resolve => { resolveDismiss = resolve; });
    if (path.includes("?status=")) return Promise.resolve(list(dismissed ? [] : [pending]));
    if (++detailReads === 1) return Promise.resolve({ draft: pending });
    return new Promise(resolve => { resolvePoll = resolve; });
  });
  render(<PriceMatchPage />);
  fireEvent.click(await screen.findByText("Draft A"));
  await screen.findByRole("button", { name: "Dismiss" });
  let poll;
  act(() => { poll = refresh.callback(); });
  await waitFor(() => expect(detailReads).toBe(2));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await act(async () => {
    resolvePoll({ draft: { ...pending, subject: "Stale poll result" } });
    await poll;
  });
  expect(screen.getByRole("heading", { name: "Draft A" })).toBeInTheDocument();
  dismissed = true;
  await act(async () => { resolveDismiss({ ok: true }); });
  expect(await screen.findByText("Draft dismissed.")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Draft A" })).toBeNull();
});

it("never exposes the prior draft when a poll supersedes and fails a selection read", async () => {
  const first = draft("draft-a", "Draft A");
  const second = draft("draft-b", "Draft B");
  let secondReads = 0;
  let finishSelection;
  adminFetch.mockImplementation((path) => {
    if (path.includes("?status=")) return Promise.resolve(list([first, second]));
    if (path.endsWith("draft-a")) return Promise.resolve({ draft: first });
    if (++secondReads === 1) return new Promise(resolve => { finishSelection = resolve; });
    return Promise.reject(new Error("Detail temporarily unavailable"));
  });
  render(<PriceMatchPage />);
  fireEvent.click(await screen.findByText("Draft A"));
  await screen.findByRole("heading", { name: "Draft A" });
  fireEvent.click(screen.getByText("Draft B"));
  await waitFor(() => expect(secondReads).toBe(1));
  await act(async () => refresh.callback());
  expect(screen.getByText("Couldn't load this draft.")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Draft A" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Send to rep…" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  await act(async () => { finishSelection({ draft: second }); });
  expect(screen.getByRole("button", { name: /Draft B/ })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("heading", { name: "Draft A" })).toBeNull();
});
