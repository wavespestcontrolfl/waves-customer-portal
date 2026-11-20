// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { adminFetch } = vi.hoisted(() => ({ adminFetch: vi.fn() }));
vi.mock("../../lib/adminFetch", () => ({ adminFetch }));

import RestaurantProspectsPage, { headlineText, readText, summaryText } from "./RestaurantProspectsPage";

const reply = (body, { ok = true, status = 200 } = {}) => Promise.resolve({ ok, status, json: async () => body });

const READ_AT = "2026-11-16T15:40:00.000Z";
const ROACHES = { code: "35A-02-4", text: "Live roaches seen in the dry storage area." };
const LIST30 = {
  days: 30, from: "2026-10-21", through: "2026-11-19", readAt: READ_AT,
  counts: { new_restaurant: 1, new_owner: 1, pest_finding: 1 },
  rows: [
    { id: "r-1", reason: "new_restaurant", name: "SAMPLE GRILL", address: "200 SAMPLE TRL", city: "BRADENTON", zip: "34208", county: "Manatee", phone: "9415550101", seats: 40, eventDate: "2026-11-18", licenseNumber: "SEA0000001", isNew: true, findings: [] },
    { id: "r-2", reason: "pest_finding", name: "SAMPLE BISTRO", address: "300 SAMPLE AVE", city: "SARASOTA", zip: "34231", county: "Sarasota", phone: null, seats: null, eventDate: "2026-11-12", licenseNumber: "SEA0000002", isNew: false, findings: [ROACHES] },
    { id: "r-3", reason: "new_owner", name: "SAMPLE CAFE", address: "400 SAMPLE BLVD", city: "PORT CHARLOTTE", zip: "33948", county: "Charlotte", phone: "9415550102", seats: 1200, eventDate: "2026-11-10", licenseNumber: "SEA0000003", isNew: false, findings: [] },
  ],
};
const LIST90 = {
  days: 90, from: "2026-08-22", through: "2026-11-19", readAt: READ_AT,
  counts: { new_restaurant: 1, new_owner: 0, pest_finding: 0 },
  rows: [{ id: "r-9", reason: "new_restaurant", name: "SAMPLE TAVERN", address: "500 SAMPLE WAY", city: "VENICE", zip: "34285", county: "Sarasota", phone: "9415550103", seats: 60, eventDate: "2026-08-25", licenseNumber: "SEA0000009", isNew: false, findings: [] }],
};

function route(handlers) {
  adminFetch.mockImplementation((path) => {
    const handler = handlers[path];
    return handler ? handler() : reply({ error: `unexpected ${path}` }, { ok: false, status: 500 });
  });
}
const renderPage = () => render(<MemoryRouter><RestaurantProspectsPage embedded /></MemoryRouter>);
const rowOf = (table, name) => within(table).getByText(name).closest("tr");

beforeEach(() => adminFetch.mockReset());
afterEach(() => cleanup());

it("opens on the last 30 days with the summary, the read day, the area note and one row per restaurant", async () => {
  route({ "/admin/prospects/restaurants?days=30": () => reply(LIST30) });
  renderPage();
  expect(await screen.findByText("1 new restaurant, 1 new owner and 1 pest finding from Oct 21 to Nov 19. The state files were last read on Nov 16, 2026.")).toBeInTheDocument();
  expect(screen.getByText(/Food trucks are left out/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Last 30 days" })).toHaveAttribute("aria-pressed", "true");

  const table = screen.getByRole("table", { name: "Restaurants" });
  expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Date", "Restaurant", "Why", "Address", "Phone", "Seats"]);
  const grill = rowOf(table, "SAMPLE GRILL");
  expect(within(grill).getByText("New")).toBeInTheDocument();
  expect(within(grill).getByText("New restaurant")).toBeInTheDocument();
  expect(within(grill).getByText("Nov 18, 2026")).toBeInTheDocument();
  expect(within(grill).getByText("200 SAMPLE TRL, BRADENTON, 34208")).toBeInTheDocument();
  expect(within(grill).getByText("(941) 555-0101")).toBeInTheDocument();
  expect(within(grill).getByText("40")).toBeInTheDocument();
  const bistro = rowOf(table, "SAMPLE BISTRO");
  expect(within(bistro).queryByText("New")).toBeNull();
  expect(within(bistro).getByText("Pest finding")).toBeInTheDocument();
  expect(within(bistro).getByText(ROACHES.text)).toBeInTheDocument();
  expect(within(bistro).getAllByText("Not listed")).toHaveLength(2); // no phone, no seat count
  const cafe = rowOf(table, "SAMPLE CAFE");
  expect(within(cafe).getByText("New owner")).toBeInTheDocument();
  expect(within(cafe).getByText("1,200")).toBeInTheDocument();
});

it("switching to the last 90 days loads that list", async () => {
  route({
    "/admin/prospects/restaurants?days=30": () => reply(LIST30),
    "/admin/prospects/restaurants?days=90": () => reply(LIST90),
  });
  renderPage();
  await screen.findByText("SAMPLE GRILL");
  fireEvent.click(screen.getByRole("button", { name: "Last 90 days" }));
  expect(await screen.findByText("SAMPLE TAVERN")).toBeInTheDocument();
  expect(screen.getByText(/^1 new restaurant, 0 new owners and 0 pest findings from Aug 22 to Nov 19\./)).toBeInTheDocument();
  expect(screen.queryByText("SAMPLE GRILL")).toBeNull();
  expect(screen.getByRole("button", { name: "Last 90 days" })).toHaveAttribute("aria-pressed", "true");
});

it("shows a plain error with Try again when the list fails, and recovers", async () => {
  let calls = 0;
  route({ "/admin/prospects/restaurants?days=30": () => (++calls === 1 ? reply({ error: "Could not load the restaurants list." }, { ok: false, status: 500 }) : reply(LIST30)) });
  renderPage();
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the restaurants list.");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("SAMPLE GRILL")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("a success answer whose body cannot be read shows Try again, and recovers", async () => {
  let calls = 0;
  const cutOff = () => Promise.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected end of JSON input"); } });
  route({ "/admin/prospects/restaurants?days=30": () => (++calls === 1 ? cutOff() : reply(LIST30)) });
  renderPage();
  expect(await screen.findByRole("alert")).toHaveTextContent("The answer could not be read.");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("SAMPLE GRILL")).toBeInTheDocument();
});

it("before the first full read, with no rows, it says not every file has been read, and claims no counts", async () => {
  route({ "/admin/prospects/restaurants?days=30": () => reply({ ...LIST30, readAt: null, counts: { new_restaurant: 0, new_owner: 0, pest_finding: 0 }, rows: [] }) });
  renderPage();
  expect(await screen.findByText("Not every state file has been read yet.")).toBeInTheDocument();
  expect(screen.queryByText(/new restaurants?,/)).toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
});

it("rows from a first run that did not read every file show with a not-complete line and no counts", async () => {
  // The license file was read and the inspection file failed: one new restaurant, and pest findings not known.
  route({ "/admin/prospects/restaurants?days=30": () => reply({ ...LIST30, readAt: null, counts: { new_restaurant: 1, new_owner: 0, pest_finding: 0 }, rows: [LIST30.rows[0]] }) });
  renderPage();
  expect(await screen.findByText("Not every state file has been read yet, so this list may be missing restaurants.")).toBeInTheDocument();
  expect(screen.queryByText(/pest findings?/)).toBeNull();
  expect(screen.queryByText(/new restaurants?,/)).toBeNull();
  expect(rowOf(screen.getByRole("table", { name: "Restaurants" }), "SAMPLE GRILL")).toBeInTheDocument();
  expect(screen.queryByText("Not every state file has been read yet.")).toBeNull();
});

it("a read with nothing in the window shows the zero counts and an empty message", async () => {
  route({ "/admin/prospects/restaurants?days=30": () => reply({ ...LIST30, counts: { new_restaurant: 0, new_owner: 0, pest_finding: 0 }, rows: [] }) });
  renderPage();
  expect(await screen.findByText("Nothing in the last 30 days.")).toBeInTheDocument();
  expect(screen.getByText("0 new restaurants, 0 new owners and 0 pest findings from Oct 21 to Nov 19. The state files were last read on Nov 16, 2026.")).toBeInTheDocument();
  expect(screen.queryByRole("table")).toBeNull();
});

it("a late answer for the period the owner left never replaces the list shown now", async () => {
  let answer30;
  route({
    "/admin/prospects/restaurants?days=30": () => new Promise((resolve) => { answer30 = resolve; }),
    "/admin/prospects/restaurants?days=90": () => reply(LIST90),
  });
  renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Last 90 days" })); // the 30-day read stays in flight
  expect(await screen.findByText("SAMPLE TAVERN")).toBeInTheDocument();
  await act(async () => {
    answer30({ ok: true, status: 200, json: async () => LIST30 }); // the 30-day answer arrives last
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  });
  expect(screen.getByText("SAMPLE TAVERN")).toBeInTheDocument();
  expect(screen.queryByText("SAMPLE GRILL")).toBeNull();
});

it("summaryText says one or many per reason; readText names the Eastern day of the read", () => {
  expect(summaryText({ from: "2026-10-21", through: "2026-11-19", counts: { new_restaurant: 2, new_owner: 0, pest_finding: 1 } }))
    .toBe("2 new restaurants, 0 new owners and 1 pest finding from Oct 21 to Nov 19.");
  expect(readText(null)).toBe("");
  // 11:30 PM on Nov 16 Eastern is already Nov 17 in UTC: the day named is Nov 16.
  expect(readText("2026-11-17T04:30:00.000Z")).toBe("The state files were last read on Nov 16, 2026.");
  // headlineText claims counts only after a full read.
  const counts = { new_restaurant: 2, new_owner: 0, pest_finding: 0 };
  expect(headlineText({ from: "2026-10-21", through: "2026-11-19", counts, readAt: null }))
    .toBe("Not every state file has been read yet, so this list may be missing restaurants.");
  expect(headlineText({ from: "2026-10-21", through: "2026-11-19", counts, readAt: "2026-11-17T04:30:00.000Z" }))
    .toBe("2 new restaurants, 0 new owners and 0 pest findings from Oct 21 to Nov 19. The state files were last read on Nov 16, 2026.");
});
