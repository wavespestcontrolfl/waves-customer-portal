// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { rawAdminFetch, refresh } = vi.hoisted(() => ({
  rawAdminFetch: vi.fn(),
  refresh: { callback: null },
}));

vi.mock("../../lib/adminFetch", () => ({ adminFetch: rawAdminFetch }));
vi.mock("../../hooks/useVisiblePageRefresh", () => ({
  default: (callback) => {
    refresh.callback = callback;
  },
}));

import DuplicateCustomersPage from "./DuplicateCustomersPage";

function response(body, { ok = true, status = 200 } = {}) {
  return Promise.resolve({ ok, status, json: async () => body });
}

const duplicateGroups = {
  groups: [
    {
      phone10: "9415550100",
      winner: { id: "winner", first_name: "Kept", last_name: "Customer" },
      candidates: [
        {
          customer: { id: "duplicate", first_name: "Duplicate", last_name: "Customer" },
          tier: "red",
          reasons: ["name_conflict"],
        },
      ],
    },
  ],
};

beforeEach(() => {
  rawAdminFetch.mockReset();
  refresh.callback = null;
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps a mutation error while a later successful poll clears its read error", async () => {
  let failRead = false;
  rawAdminFetch.mockImplementation((path, options) => {
    if (options?.method === "POST") {
      return response({ error: "Synthetic action failure" }, { ok: false, status: 500 });
    }
    if (path === "/admin/customer-duplicates") {
      return failRead
        ? response({ error: "Synthetic read failure" }, { ok: false, status: 500 })
        : response(duplicateGroups);
    }
    if (path === "/admin/customer-duplicates/merges") {
      return response({ merges: [] });
    }
    throw new Error(`Unexpected request: ${path}`);
  });

  render(
    <MemoryRouter>
      <DuplicateCustomersPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Not a duplicate" }));
  expect(await screen.findByText("Synthetic action failure")).toBeInTheDocument();

  failRead = true;
  await act(async () => refresh.callback());
  expect(screen.getByText("Synthetic read failure")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();

  failRead = false;
  await act(async () => refresh.callback());
  expect(screen.queryByText("Synthetic read failure")).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(screen.getByText("Synthetic action failure")).toBeInTheDocument();
});


it("retains loaded merge history on a failed secondary poll and accepts a later empty journal", async () => {
  let journalMode = "loaded";
  rawAdminFetch.mockImplementation((path) => {
    if (path === "/admin/customer-duplicates") {
      return response(journalMode === "loaded" ? duplicateGroups : { groups: [] });
    }
    if (path === "/admin/customer-duplicates/merges") {
      if (journalMode === "failed") return Promise.reject(new Error("Journal unavailable"));
      return response({ merges: journalMode === "loaded" ? [{
        journalId: "journal-1", winnerId: "winner", winnerName: "Kept Customer",
        loserName: "Prior Customer", createdAt: "2026-09-24T12:00:00Z",
        performedBy: "Fixture operator", tier: "green", revertible: true,
      }] : [] });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  render(<MemoryRouter><DuplicateCustomersPage /></MemoryRouter>);
  expect(await screen.findByRole("button", { name: "Undo merge" })).toBeInTheDocument();
  journalMode = "failed";
  await act(async () => refresh.callback());
  expect(screen.getByText("No duplicate customers pending review.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Undo merge" })).toBeInTheDocument();
  expect(screen.getByText("Prior Customer")).toBeInTheDocument();
  journalMode = "empty";
  await act(async () => refresh.callback());
  expect(screen.queryByRole("button", { name: "Undo merge" })).toBeNull();
});
