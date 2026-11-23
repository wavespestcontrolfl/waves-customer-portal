// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { adminFetch } = vi.hoisted(() => ({ adminFetch: vi.fn() }));
vi.mock("../../lib/adminFetch", () => ({ adminFetch }));

import MailProspectsPage, { runText } from "./MailProspectsPage";

const reply = (body, { ok = true, status = 200 } = {}) => Promise.resolve({ ok, status, json: async () => body });

const COUNTS = { eligible: 2, heldBack: 1, notEligible: 3, unmatched: 1 };
const REASONS = [
  { status: "not_eligible", reason: "company_buyer", count: 2 },
  { status: "unmatched", reason: "no_permit", count: 1 },
  { status: "not_eligible", reason: "odd_new_code", count: 1 },
];
// 4:30 PM on Nov 21 Eastern (standard time) is 21:30 UTC.
const CHECKED = "2026-11-21T21:30:00.000Z";
const base = { counts: COUNTS, reasons: REASONS, newestRecordedDate: "2026-11-20", lastCheckedAt: CHECKED, truncated: false };
const home = (over) => ({
  id: "m-1", recordedDate: "2026-11-20", status: "eligible", reason: null, recipientNames: ["TESTER ALEX J", "TESTER BEA K"],
  addressLine1: "101 EXAMPLE TRL", city: "SAMPLETON", zip: "34212", subdivision: "SAMPLETON ESTATES", matchBasis: "lot_block",
  coDate: "2026-10-30", livingSqft: 2100, legalDescription: "LOT 12 SAMPLETON ESTATES PH 2", ...over,
});
const LIVE = {
  ...base, view: "live",
  rows: [
    home(),
    home({ id: "m-2", recordedDate: "2026-11-19", status: "held_back", recipientNames: ["TESTER CAL D"], addressLine1: "102 EXAMPLE TRL", subdivision: null }),
  ],
};
const NOT_ELIGIBLE = {
  ...base, view: "not_eligible",
  rows: [
    home({ id: "n-1", status: "not_eligible", reason: "company_buyer", recipientNames: ["SAMPLE HOLDINGS LLC"], legalDescription: "LOT 3 SAMPLETON PH 1", addressLine1: null }),
    home({ id: "n-2", status: "not_eligible", reason: "odd_new_code", recipientNames: [], legalDescription: null, addressLine1: null }),
  ],
};
const UNMATCHED = {
  ...base, view: "unmatched",
  rows: [home({ id: "u-1", status: "unmatched", reason: "no_permit", recipientNames: ["TESTER EVE F"], legalDescription: "LOT 9 SAMPLETON PH 3", addressLine1: null })],
};

function route(handlers) {
  adminFetch.mockImplementation((path) => {
    const handler = handlers[path];
    return handler ? handler() : reply({ error: `unexpected ${path}` }, { ok: false, status: 500 });
  });
}
const renderPage = () => render(<MemoryRouter><MailProspectsPage embedded /></MemoryRouter>);
const rowOf = (table, text) => within(table).getByText(text).closest("tr");

beforeEach(() => adminFetch.mockReset());
afterEach(() => cleanup());

it("opens on Homes with the intro, the four counts, the run line and one row per home", async () => {
  route({ "/admin/prospects/mail?view=live": () => reply(LIVE) });
  renderPage();
  expect(await screen.findByText("TESTER ALEX J, TESTER BEA K")).toBeInTheDocument();
  expect(screen.getByText("New-home buyers from the county deed list. Nothing is mailed yet.")).toBeInTheDocument();
  expect(screen.getByText("Get a card").nextSibling).toHaveTextContent("2");
  expect(screen.getByText("Held back", { selector: "div" }).nextSibling).toHaveTextContent("1");
  expect(screen.getByText("No card: the comparison group")).toBeInTheDocument();
  expect(screen.getByText("Not eligible", { selector: "div" }).nextSibling).toHaveTextContent("3");
  expect(screen.getByText("No match yet", { selector: "div" }).nextSibling).toHaveTextContent("1");
  expect(screen.getByText("Newest deed: Nov 20, 2026 · Last checked: Nov 21, 2026, 4:30 PM")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Homes" })).toHaveAttribute("aria-pressed", "true");

  const table = screen.getByRole("table", { name: "Homes" });
  expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Recorded", "Buyer", "Address", "Subdivision", "Group"]);
  const card = rowOf(table, "TESTER ALEX J, TESTER BEA K");
  expect(within(card).getByText("Nov 20, 2026")).toBeInTheDocument();
  expect(within(card).getByText("101 EXAMPLE TRL, SAMPLETON, 34212")).toBeInTheDocument();
  expect(within(card).getByText("SAMPLETON ESTATES")).toBeInTheDocument();
  expect(within(card).getByText("Card")).toBeInTheDocument();
  const held = rowOf(table, "TESTER CAL D");
  expect(within(held).getByText("Held back")).toBeInTheDocument();
  expect(within(held).getByText("Not listed")).toBeInTheDocument(); // no subdivision
  // Nothing on the screen changes data, and the live view has no reasons list.
  expect(screen.queryByRole("list", { name: "Reasons" })).toBeNull();
  expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Homes", "Not eligible", "No match yet"]);
});

it("the Not eligible view refetches with ?view= and shows the lot, a plain reason and the grouped reasons", async () => {
  route({
    "/admin/prospects/mail?view=live": () => reply(LIVE),
    "/admin/prospects/mail?view=not_eligible": () => reply(NOT_ELIGIBLE),
  });
  renderPage();
  await screen.findByText("TESTER CAL D");
  fireEvent.click(screen.getByRole("button", { name: "Not eligible" }));
  const table = await screen.findByRole("table", { name: "Not eligible" });
  expect(adminFetch).toHaveBeenLastCalledWith("/admin/prospects/mail?view=not_eligible");
  expect(screen.getByRole("button", { name: "Not eligible" })).toHaveAttribute("aria-pressed", "true");
  expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Recorded", "Buyer", "Lot", "Reason"]);
  const company = rowOf(table, "SAMPLE HOLDINGS LLC");
  expect(within(company).getByText("LOT 3 SAMPLETON PH 1")).toBeInTheDocument();
  expect(within(company).getByText("Company buyer")).toBeInTheDocument();
  // An unknown code shows as it is; no names or no lot read "Not listed".
  const odd = within(table).getByText("odd_new_code").closest("tr");
  expect(within(odd).getAllByText("Not listed")).toHaveLength(2);
  // Only this view's reasons, biggest first as the service sent them.
  const reasons = within(screen.getByRole("list", { name: "Reasons" })).getAllByRole("listitem").map((item) => item.textContent);
  expect(reasons).toEqual(["Company buyer: 2", "odd_new_code: 1"]);
});

it("the No match yet view shows its own reasons and the plain label for each code", async () => {
  route({
    "/admin/prospects/mail?view=live": () => reply(LIVE),
    "/admin/prospects/mail?view=unmatched": () => reply(UNMATCHED),
  });
  renderPage();
  await screen.findByText("TESTER CAL D");
  fireEvent.click(screen.getByRole("button", { name: "No match yet" }));
  const table = await screen.findByRole("table", { name: "No match yet" });
  expect(within(rowOf(table, "TESTER EVE F")).getByText("No new-home permit")).toBeInTheDocument();
  expect(within(screen.getByRole("list", { name: "Reasons" })).getByText("No new-home permit: 1")).toBeInTheDocument();
});

it("says when the list is cut at 300 rows", async () => {
  route({ "/admin/prospects/mail?view=live": () => reply({ ...LIVE, truncated: true }) });
  renderPage();
  expect(await screen.findByText("Showing the newest 300.")).toBeInTheDocument();
});

it("an empty view says nothing is here yet, and counts still show", async () => {
  route({ "/admin/prospects/mail?view=live": () => reply({ ...LIVE, rows: [] }) });
  renderPage();
  expect(await screen.findByText("Nothing here yet.")).toBeInTheDocument();
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.getByText("Get a card")).toBeInTheDocument();
});

it("before the first run it says no run yet", async () => {
  route({ "/admin/prospects/mail?view=live": () => reply({ ...LIVE, counts: { eligible: 0, heldBack: 0, notEligible: 0, unmatched: 0 }, reasons: [], newestRecordedDate: null, lastCheckedAt: null, rows: [] }) });
  renderPage();
  expect(await screen.findByText("No run yet.")).toBeInTheDocument();
  expect(screen.getByText("Nothing here yet.")).toBeInTheDocument();
});

it("shows a plain error with Try again when the list fails, and recovers", async () => {
  let calls = 0;
  route({ "/admin/prospects/mail?view=live": () => (++calls === 1 ? reply({ error: "Could not load the mail list." }, { ok: false, status: 500 }) : reply(LIVE)) });
  renderPage();
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the mail list.");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("TESTER CAL D")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("a success answer whose body cannot be read shows Try again, and recovers", async () => {
  let calls = 0;
  const cutOff = () => Promise.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected end of JSON input"); } });
  route({ "/admin/prospects/mail?view=live": () => (++calls === 1 ? cutOff() : reply(LIVE)) });
  renderPage();
  expect(await screen.findByRole("alert")).toHaveTextContent("The answer could not be read.");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("TESTER CAL D")).toBeInTheDocument();
});

it("a late answer for the view the owner left never replaces the list shown now", async () => {
  let answerLive;
  route({
    "/admin/prospects/mail?view=live": () => new Promise((resolve) => { answerLive = resolve; }),
    "/admin/prospects/mail?view=unmatched": () => reply(UNMATCHED),
  });
  renderPage();
  fireEvent.click(screen.getByRole("button", { name: "No match yet" })); // the first read stays in flight
  expect(await screen.findByText("TESTER EVE F")).toBeInTheDocument();
  await act(async () => {
    answerLive({ ok: true, status: 200, json: async () => LIVE }); // the first answer arrives last
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  });
  expect(screen.getByText("TESTER EVE F")).toBeInTheDocument();
  expect(screen.queryByText("TESTER CAL D")).toBeNull();
});

it("runText names the Eastern day and time, and either half can be missing", () => {
  // 11:30 PM on Nov 21 Eastern is already Nov 22 in UTC: the day named is Nov 21.
  expect(runText({ newestRecordedDate: "2026-11-20", lastCheckedAt: "2026-11-22T04:30:00.000Z" }))
    .toBe("Newest deed: Nov 20, 2026 · Last checked: Nov 21, 2026, 11:30 PM");
  expect(runText({ newestRecordedDate: null, lastCheckedAt: CHECKED })).toBe("Newest deed: none · Last checked: Nov 21, 2026, 4:30 PM");
  expect(runText({ newestRecordedDate: "2026-11-20", lastCheckedAt: null })).toBe("Newest deed: Nov 20, 2026 · Last checked: never");
  expect(runText({ newestRecordedDate: null, lastCheckedAt: null })).toBe("No run yet.");
});
