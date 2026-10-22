// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { rawAdminFetch } = vi.hoisted(() => ({ rawAdminFetch: vi.fn() }));

vi.mock("../../lib/adminFetch", () => ({ adminFetch: rawAdminFetch }));
vi.mock("../../hooks/useVisiblePageRefresh", () => ({ default: () => {} }));

import DuplicateCustomersPage from "./DuplicateCustomersPage";

const response = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });
const merge = (journalId, skipped) => ({
  journalId, winnerId: "w1", loserId: `l-${journalId}`, winnerName: "Pat Real", loserName: `Lead ${journalId}`,
  tier: "green", performedBy: "auto:dedupe-cron", createdAt: "2026-10-22T08:40:00Z", undoneAt: null, undoneBy: null,
  revertible: false, skipped_backfills: skipped,
});

beforeEach(() => {
  rawAdminFetch.mockReset();
  rawAdminFetch.mockImplementation((path) => {
    if (path === "/admin/customer-duplicates") return response({ groups: [] });
    if (path === "/admin/customer-duplicates/merges") {
      return response({ merges: [merge("a", { email: "typed@example.test" }), merge("b", null)] });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
});
afterEach(() => cleanup());

it("Recent merges shows the email an automatic merge did not copy, only on the merge that skipped it", async () => {
  render(<MemoryRouter><DuplicateCustomersPage /></MemoryRouter>);
  expect(await screen.findByText("Lead a")).toBeInTheDocument();
  const notes = screen.getAllByTestId("merge-skipped-email");
  expect(notes).toHaveLength(1);
  expect(notes[0]).toHaveTextContent("Email not copied");
  expect(notes[0]).toHaveTextContent("typed@example.test");
});
