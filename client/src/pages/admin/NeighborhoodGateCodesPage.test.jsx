// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { rawAdminFetch } = vi.hoisted(() => ({ rawAdminFetch: vi.fn() }));
vi.mock("../../lib/adminFetch", () => ({ adminFetch: rawAdminFetch }));

import NeighborhoodGateCodesPage from "./NeighborhoodGateCodesPage";

function response(body, { ok = true, status = 200 } = {}) {
  return Promise.resolve({ ok, status, json: async () => body });
}

const entry = (over = {}) => ({
  id: "e1", gateLabel: "Main gate", accessType: "keypad", code: "#4821", instructions: null,
  status: "active", source: "office", lastConfirmedAt: "2026-09-01T16:00:00.000Z", stale: false, conflict: false, ...over,
});
const ALL = {
  total: 2,
  neighborhoods: [
    { id: "n1", name: "Synthetic Oaks", county: "Manatee", propertyCount: 3, hasConflict: false, entries: [entry()] },
    {
      id: "n2", name: "Sample Pines", county: "Sarasota", propertyCount: 1, hasConflict: true,
      entries: [
        entry({ id: "e2", code: "1111", status: "needs_confirm", lastConfirmedAt: null, conflict: true }),
        entry({ id: "e3", gateLabel: "Back gate", accessType: "guard", code: null, instructions: "Stop at the booth", stale: true, lastConfirmedAt: "2025-01-05T16:00:00.000Z" }),
      ],
    },
  ],
};
const NEEDS = { total: 1, neighborhoods: [ALL.neighborhoods[1]] };

function renderPage() {
  return render(<MemoryRouter><NeighborhoodGateCodesPage /></MemoryRouter>);
}

beforeEach(() => {
  rawAdminFetch.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("a live code nobody has confirmed yet says so but carries no Unconfirmed badge", async () => {
  // Only an entry waiting on the office (needs_confirm) is "Unconfirmed", the
  // Needs confirm filter's rule; a code filed from a profile turns Stale later.
  const fresh = { total: 1, neighborhoods: [{ id: "n9", name: "Fresh Grove", county: "Manatee", propertyCount: 1, hasConflict: false,
    entries: [entry({ id: "e9", code: "2468", source: "profile", lastConfirmedAt: null })] }] };
  rawAdminFetch.mockImplementation(() => response(fresh));
  renderPage();
  expect(await screen.findByText("Fresh Grove")).toBeInTheDocument();
  expect(screen.getByText("Never confirmed")).toBeInTheDocument();
  expect(screen.queryByText("Unconfirmed")).toBeNull();
});

it("renders neighborhoods, entries and the stale / unconfirmed / conflict markers", async () => {
  rawAdminFetch.mockImplementation(() => response(ALL));
  renderPage();
  expect(await screen.findByText("Synthetic Oaks")).toBeInTheDocument();
  expect(screen.getByText("Manatee · 3 properties")).toBeInTheDocument();
  expect(screen.getByText("Sarasota · 1 property")).toBeInTheDocument();
  expect(screen.getByText("#4821")).toBeInTheDocument();
  expect(screen.getByText("Stop at the booth")).toBeInTheDocument();
  expect(screen.getByText("Conflicting codes")).toBeInTheDocument();
  expect(screen.getByText("Unconfirmed")).toBeInTheDocument();
  expect(screen.getByText("Stale")).toBeInTheDocument();
  expect(screen.getByText("Last confirmed Sep 1, 2026")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Confirm" })).toHaveLength(3);
  expect(rawAdminFetch.mock.calls[0][0]).toContain("/admin/neighborhood-access?");
});

it("the Needs confirm toggle re-queries with the filter", async () => {
  rawAdminFetch.mockImplementation((path) => response(path.includes("filter=needs_confirm") ? NEEDS : ALL));
  renderPage();
  await screen.findByText("Synthetic Oaks");
  fireEvent.click(screen.getByRole("button", { name: "Needs confirm" }));
  await waitFor(() => expect(screen.queryByText("Synthetic Oaks")).not.toBeInTheDocument());
  expect(screen.getByText("Sample Pines")).toBeInTheDocument();
  expect(rawAdminFetch.mock.calls.some(([p]) => p.includes("filter=needs_confirm"))).toBe(true);
  expect(screen.getByRole("button", { name: "Needs confirm" })).toHaveAttribute("aria-pressed", "true");
});

it("Confirm sends the confirm action and reloads", async () => {
  rawAdminFetch.mockImplementation((path, options) => (options?.method === "PATCH" ? response({ id: "e2", status: "active" }) : response(ALL)));
  renderPage();
  await screen.findByText("Sample Pines");
  fireEvent.click(screen.getAllByRole("button", { name: "Confirm" })[1]);
  await screen.findByText("Confirmed");
  const patch = rawAdminFetch.mock.calls.find(([, o]) => o?.method === "PATCH");
  expect(patch[0]).toBe("/admin/neighborhood-access/entries/e2");
  expect(JSON.parse(patch[1].body)).toEqual({ action: "confirm" });
});

it("Add entry posts a keypad code and shows a server error inline", async () => {
  rawAdminFetch.mockImplementation((path, options) => (
    options?.method === "POST"
      ? response({ error: "That code is already on file for this neighborhood" }, { ok: false, status: 409 })
      : response(ALL)
  ));
  renderPage();
  await screen.findByText("Synthetic Oaks");
  fireEvent.click(screen.getAllByRole("button", { name: "Add entry" })[0]);
  fireEvent.change(screen.getByLabelText("Code"), { target: { value: "2468" } });
  fireEvent.click(screen.getByRole("button", { name: "Save entry" }));
  expect(await screen.findByText("That code is already on file for this neighborhood")).toBeInTheDocument();
  const post = rawAdminFetch.mock.calls.find(([, o]) => o?.method === "POST");
  expect(post[0]).toBe("/admin/neighborhood-access/n1/entries");
  expect(JSON.parse(post[1].body)).toEqual({ gate_label: "Main gate", access_type: "keypad", code: "2468" });
});

it("shows the not-turned-on state when the API answers 404 enabled:false", async () => {
  rawAdminFetch.mockImplementation(() => response({ enabled: false }, { ok: false, status: 404 }));
  renderPage();
  expect(await screen.findByText("Gate codes are not turned on yet.")).toBeInTheDocument();
  expect(screen.queryByLabelText("Search neighborhoods")).not.toBeInTheDocument();
});
