// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { adminFetch } = vi.hoisted(() => ({ adminFetch: vi.fn() }));
vi.mock("../../lib/adminFetch", () => ({ adminFetch }));

import RestaurantProspectsPage, { headlineText, reportNote, statusText, summaryText } from "./RestaurantProspectsPage";

const reply = (body, { ok = true, status = 200 } = {}) => Promise.resolve({ ok, status, json: async () => body });

const READ_AT = "2026-11-16T15:40:00.000Z";
const ROACHES = { code: "35A-02-4", text: "Live roaches seen in the dry storage area." };
const DROPPINGS = { code: "35A-03-4", text: "Rodent droppings under the prep table." };
const LIST30 = {
  days: 30, from: "2026-10-21", through: "2026-11-19", readAt: READ_AT,
  counts: { new_restaurant: 1, new_owner: 1, pest_finding: 1 }, readUnfinishedSince: null, readFailedAt: null, reportsRead: true,
  rows: [
    { id: "r-1", reason: "new_restaurant", name: "SAMPLE GRILL", address: "200 SAMPLE TRL", city: "BRADENTON", zip: "34208", county: "Manatee", phone: "9415550101", seats: 40, eventDate: "2026-11-18", licenseNumber: "SEA0000001", isNew: true, findings: [] },
    { id: "r-2", reason: "pest_finding", name: "SAMPLE BISTRO", address: "300 SAMPLE AVE", city: "SARASOTA", zip: "34231", county: "Sarasota", phone: null, seats: null, eventDate: "2026-11-12", licenseNumber: "SEA0000002", isNew: false, findings: [ROACHES, DROPPINGS] },
    { id: "r-3", reason: "new_owner", name: "SAMPLE CAFE", address: "400 SAMPLE BLVD", city: "PORT CHARLOTTE", zip: "33948", county: "Charlotte", phone: "9415550102", seats: 1200, eventDate: "2026-11-10", licenseNumber: "SEA0000003", isNew: false, findings: [] },
  ],
};
const LIST90 = {
  days: 90, from: "2026-08-22", through: "2026-11-19", readAt: READ_AT,
  counts: { new_restaurant: 1, new_owner: 0, pest_finding: 0 }, readUnfinishedSince: null, readFailedAt: null, reportsRead: true,
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
  // The line gives no pest count; the pest row shows in the list.
  expect(await screen.findByText("The weekly reads through Nov 16, 2026 have collected 1 new restaurant and 1 new owner dated Oct 21 to Nov 19.")).toBeInTheDocument();
  expect(screen.getByText(/An inspection shows once its report has been read/)).toBeInTheDocument();
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
  expect(within(bistro).getByText("Pests found")).toBeInTheDocument();
  expect(within(bistro).getByText(ROACHES.text)).toBeInTheDocument();
  expect(within(bistro).getByText(DROPPINGS.text)).toBeInTheDocument();
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
  expect(screen.getByText("The weekly reads through Nov 16, 2026 have collected 1 new restaurant and 0 new owners dated Aug 22 to Nov 19.")).toBeInTheDocument();
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

it("before any full read, with no rows, the line says so, with no counts and no empty claim", async () => {
  route({ "/admin/prospects/restaurants?days=30": () => reply({ ...LIST30, readAt: null, counts: { new_restaurant: 0, new_owner: 0, pest_finding: 0 }, rows: [] }) });
  renderPage();
  expect(await screen.findByText("No weekly read has read every state file yet, so this list may be missing restaurants.")).toBeInTheDocument();
  expect(screen.queryByText(/new restaurants? and/)).toBeNull();
  expect(screen.queryByText(/^No restaurants to show/)).toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
});

it("rows from before any full read show with a not-complete line and no counts", async () => {
  // A first run read the license file and stopped: one new restaurant.
  route({ "/admin/prospects/restaurants?days=30": () => reply({ ...LIST30, readAt: null, counts: { new_restaurant: 1, new_owner: 0, pest_finding: 0 }, rows: [LIST30.rows[0]] }) });
  renderPage();
  expect(await screen.findByText("No weekly read has read every state file yet, so this list may be missing restaurants.")).toBeInTheDocument();
  expect(screen.queryByText(/new restaurants? and/)).toBeNull();
  expect(rowOf(screen.getByRole("table", { name: "Restaurants" }), "SAMPLE GRILL")).toBeInTheDocument();
});

const FAILED_FIRST = { ...LIST30, readAt: null, readFailedAt: "2026-11-23T15:40:00.000Z" };
const FAILED_FIRST_LINE = "The weekly read on Nov 23, 2026 failed, so this list may be missing restaurants. No weekly read has read every state file yet.";

it("a failed first read names its day beside its rows, so a broken read never looks like one not run yet", async () => {
  route({ "/admin/prospects/restaurants?days=30": () => reply({ ...FAILED_FIRST, counts: { new_restaurant: 1, new_owner: 0, pest_finding: 0 }, rows: [LIST30.rows[0]] }) });
  renderPage();
  expect(await screen.findByText(FAILED_FIRST_LINE)).toBeInTheDocument();
  expect(rowOf(screen.getByRole("table", { name: "Restaurants" }), "SAMPLE GRILL")).toBeInTheDocument();
});

it("a failed first read with no rows names its day too, with no empty claim", async () => {
  route({ "/admin/prospects/restaurants?days=30": () => reply({ ...FAILED_FIRST, counts: { new_restaurant: 0, new_owner: 0, pest_finding: 0 }, rows: [] }) });
  renderPage();
  expect(await screen.findByText(FAILED_FIRST_LINE)).toBeInTheDocument();
  expect(screen.queryByText(/^No restaurants to show/)).toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
});

it("while a weekly read has not finished the rows show with a not-finished line and no counts", async () => {
  route({ "/admin/prospects/restaurants?days=30": () => reply({ ...LIST30, readUnfinishedSince: "2026-11-23T15:36:00.000Z" }) });
  renderPage();
  expect(await screen.findByText("The weekly read that started on Nov 23, 2026 has not finished, so this list may be missing restaurants. The state files were last read in full on Nov 16, 2026.")).toBeInTheDocument();
  expect(screen.queryByText(/new restaurants? and/)).toBeNull();
  expect(rowOf(screen.getByRole("table", { name: "Restaurants" }), "SAMPLE GRILL")).toBeInTheDocument();
});

it("after a failed weekly read the rows show with a may-be-missing line and no counts", async () => {
  route({ "/admin/prospects/restaurants?days=30": () => reply({ ...LIST30, readFailedAt: "2026-11-23T15:40:00.000Z" }) });
  renderPage();
  expect(await screen.findByText("The weekly read on Nov 23, 2026 failed, so this list may be missing restaurants. The state files were last read in full on Nov 16, 2026.")).toBeInTheDocument();
  expect(screen.queryByText(/new restaurants? and/)).toBeNull();
  expect(rowOf(screen.getByRole("table", { name: "Restaurants" }), "SAMPLE GRILL")).toBeInTheDocument();
});

it("a read with nothing in the window shows the zero counts and an empty message", async () => {
  route({ "/admin/prospects/restaurants?days=30": () => reply({ ...LIST30, counts: { new_restaurant: 0, new_owner: 0, pest_finding: 0 }, rows: [] }) });
  renderPage();
  // The message speaks of the list, not the period: the counts are what the reads collected.
  expect(await screen.findByText("No restaurants to show for the last 30 days.")).toBeInTheDocument();
  expect(screen.getByText("The weekly reads through Nov 16, 2026 have collected 0 new restaurants and 0 new owners dated Oct 21 to Nov 19.")).toBeInTheDocument();
  expect(screen.queryByRole("table")).toBeNull();
});

it("until any inspection report has been read, the area note says the list shows no pest findings", async () => {
  route({ "/admin/prospects/restaurants?days=30": () => reply({ ...LIST30, reportsRead: false, rows: [LIST30.rows[0], LIST30.rows[2]] }) });
  renderPage();
  expect(await screen.findByText(/No inspection report has been read yet, so the list shows no pest findings\.$/)).toBeInTheDocument();
  expect(screen.queryByText(/An inspection shows once its report has been read/)).toBeNull();
  expect(reportNote({ reportsRead: true })).toBe("An inspection shows once its report has been read.");
});

it("a last full read from before the period claims no counts and no empty result for it", async () => {
  // The weekly job stopped a month ago: its last full read is Oct 19, before this period starts on Oct 21.
  const stale = { ...LIST30, readAt: "2026-10-19T15:40:00.000Z", counts: { new_restaurant: 0, new_owner: 0, pest_finding: 0 }, rows: [] };
  route({ "/admin/prospects/restaurants?days=30": () => reply(stale) });
  renderPage();
  expect(await screen.findByText("The state files were last read on Oct 19, 2026, before this period began, so this list may be missing restaurants.")).toBeInTheDocument();
  expect(screen.queryByText(/new restaurants? and/)).toBeNull();
  expect(screen.queryByText(/^No restaurants to show/)).toBeNull();
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

it("summaryText says one or many per reason and names the Eastern day of the read", () => {
  // 11:30 PM on Nov 16 Eastern is already Nov 17 in UTC: the day named is Nov 16.
  expect(summaryText({ from: "2026-10-21", through: "2026-11-19", readAt: "2026-11-17T04:30:00.000Z", counts: { new_restaurant: 2, new_owner: 1, pest_finding: 1 } }))
    .toBe("The weekly reads through Nov 16, 2026 have collected 2 new restaurants and 1 new owner dated Oct 21 to Nov 19.");
});

it("statusText lets the counts show only after a full read that reached the period, with no unfinished or failed run after it", () => {
  const good = { from: "2026-10-21", readAt: "2026-11-17T04:30:00.000Z", readUnfinishedSince: null, readFailedAt: null };
  expect(statusText(good)).toBeNull();
  // A run that has not finished is named first, even after an earlier failure; then a failure; then no full read.
  expect(statusText({ ...good, readUnfinishedSince: "2026-11-24T04:30:00.000Z", readFailedAt: "2026-11-17T05:30:00.000Z" }))
    .toBe("The weekly read that started on Nov 23, 2026 has not finished, so this list may be missing restaurants. The state files were last read in full on Nov 16, 2026.");
  expect(statusText({ ...good, readFailedAt: "2026-11-24T04:30:00.000Z" }))
    .toBe("The weekly read on Nov 23, 2026 failed, so this list may be missing restaurants. The state files were last read in full on Nov 16, 2026.");
  expect(statusText({ ...good, readAt: null, readUnfinishedSince: "2026-11-24T04:30:00.000Z" }))
    .toBe("The weekly read that started on Nov 23, 2026 has not finished, so this list may be missing restaurants. No weekly read has read every state file yet.");
  expect(statusText({ ...good, readAt: null, readFailedAt: "2026-11-24T04:30:00.000Z" }))
    .toBe("The weekly read on Nov 23, 2026 failed, so this list may be missing restaurants. No weekly read has read every state file yet.");
  expect(statusText({ ...good, readAt: null })).toBe("No weekly read has read every state file yet, so this list may be missing restaurants.");
  // A full read reaches the period from its first day, by the Eastern day: 11:30 PM on Oct 20 Eastern (daylight
  // time) is already Oct 21 in UTC, and 12:30 AM on Oct 21 is the first day.
  expect(statusText({ ...good, readAt: "2026-10-21T03:30:00.000Z" }))
    .toBe("The state files were last read on Oct 20, 2026, before this period began, so this list may be missing restaurants.");
  expect(statusText({ ...good, readAt: "2026-10-21T04:30:00.000Z" })).toBeNull();
});

it("headlineText shows the counts only when statusText allows, and says when the list stops short of them", () => {
  const counts = { new_restaurant: 2, new_owner: 0, pest_finding: 0 };
  const window = { from: "2026-10-21", through: "2026-11-19", counts, readUnfinishedSince: null, readFailedAt: null, rows: [LIST30.rows[0], LIST30.rows[0]] };
  expect(headlineText({ ...window, readAt: null }))
    .toBe("No weekly read has read every state file yet, so this list may be missing restaurants.");
  expect(headlineText({ ...window, readAt: "2026-11-17T04:30:00.000Z" }))
    .toBe("The weekly reads through Nov 16, 2026 have collected 2 new restaurants and 0 new owners dated Oct 21 to Nov 19.");
  expect(headlineText({ ...window, counts: { new_restaurant: 1500, new_owner: 2, pest_finding: 1 }, readAt: "2026-11-17T04:30:00.000Z" }))
    .toBe("The weekly reads through Nov 16, 2026 have collected 1,500 new restaurants and 2 new owners dated Oct 21 to Nov 19. The list shows the newest 2.");
  // After a failed run: no counts, and no cut line either.
  expect(headlineText({ ...window, counts: { new_restaurant: 1500, new_owner: 2, pest_finding: 1 }, readAt: "2026-11-17T04:30:00.000Z", readFailedAt: "2026-11-24T04:30:00.000Z" }))
    .toBe("The weekly read on Nov 23, 2026 failed, so this list may be missing restaurants. The state files were last read in full on Nov 16, 2026.");
});
