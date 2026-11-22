// @vitest-environment jsdom
// Referrals → Queue: the thank-you notes the office still has to write (Step 2: one handwritten note to the member
// for every friend who books). The card shows the member and the mailing address, never the friend.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import ReferralsPageV2 from "./ReferralsPageV2";

const FIRST = "00000000-0000-4000-8000-000000000031";
const SECOND = "00000000-0000-4000-8000-000000000032";
const THIRD = "00000000-0000-4000-8000-000000000033";
const MEMBER = "00000000-0000-4000-8000-000000000041";
const NOTES = [
  { referralId: FIRST, owedSince: "2027-02-03T15:00:00.000Z", memberCustomerId: MEMBER, memberName: "Fixture Member", addressLines: ["12 Sample Way", "Unit 4", "Parrish, FL 34219"], addressComplete: true },
  { referralId: SECOND, owedSince: "2027-02-05T15:00:00.000Z", memberCustomerId: "00000000-0000-4000-8000-000000000042", memberName: "Second Member", addressLines: [], addressComplete: false },
];
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

// The fixture server: `owed` is what it still holds. It answers pages of `batch` rows (the real page is 200), the
// count of all of them, and the next position (opaque to the page: here "after:<the last row's id>").
let owed;
let everOwed;
let batch;
let notesResponse;
let writtenResponse;
const LIST = "/api/admin/referrals/thank-you-notes";
const listReads = () => fetch.mock.calls.map(([url]) => url).filter((url) => url.split("?")[0] === LIST);
beforeEach(() => {
  owed = [...NOTES];
  everOwed = null; // taken at the first read: a test sets `owed` before it opens the page
  batch = 200;
  notesResponse = (url) => {
    const after = new URL(url, "http://fixture").searchParams.get("after");
    everOwed = everOwed || owed;
    // The position names a row by id; a row that was written since still marks its place in `everOwed`.
    const start = after ? everOwed.findIndex((note) => `after:${note.referralId}` === after) + 1 : 0;
    const later = everOwed.slice(start).filter((note) => owed.includes(note));
    const notes = later.slice(0, batch);
    return response({ notes, total: owed.length, nextCursor: later.length > batch ? `after:${notes.at(-1).referralId}` : null });
  };
  writtenResponse = (url) => {
    owed = owed.filter((note) => !url.includes(note.referralId));
    return response({ success: true, written: true });
  };
  localStorage.setItem("waves_admin_token", "fixture-token");
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (url === "/api/admin/referrals/stats") return response({ activePromoters: 0, totalReferrals: 0, convertedReferrals: 0, pendingReferrals: 0, totalRewardsDollars: 0, totalPaidOutCents: 0, pendingPayouts: 0, programROI: 0 });
    if (url === "/api/admin/referrals/promoters?status=all") return response({ promoters: [] });
    if (url === "/api/admin/referrals/queue") return response({ referrals: [] });
    if (url === "/api/admin/referrals/payouts") return response({ payouts: [] });
    if (url === "/api/admin/referrals/inbound") return response({ items: [] });
    if (url.split("?")[0] === LIST) return notesResponse(url);
    if (url.endsWith("/written")) return writtenResponse(url);
    throw new Error(`Unexpected fixture request: ${url}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const writes = () => fetch.mock.calls.filter(([url]) => url.endsWith("/written"));

async function openQueue() {
  render(<MemoryRouter initialEntries={["/admin/referrals"]}><ReferralsPageV2 /></MemoryRouter>);
  // The tab prints its count ("Queue (0)"): the count is the referrals waiting, not the notes.
  fireEvent.click(await screen.findByRole("button", { name: /^Queue/ }));
}

describe("Referrals queue: thank-you notes to write", () => {
  it("lists each member with the mailing lines and the day the note became owed, and tells the office not to name the friend", async () => {
    await openQueue();

    expect(await screen.findByText("Thank-you notes to write (2)")).toBeInTheDocument();
    expect(screen.getByText(/Do not name the friend in\s+the note\./)).toBeInTheDocument();
    // The name opens the member's profile, where an address is corrected.
    expect(screen.getByRole("link", { name: "Fixture Member" })).toHaveAttribute("href", `/admin/customers?customerId=${MEMBER}`);
    expect(screen.getByText("12 Sample Way")).toBeInTheDocument();
    expect(screen.getByText("Unit 4")).toBeInTheDocument();
    expect(screen.getByText("Parrish, FL 34219")).toBeInTheDocument();
    // The day is when the referral was converted, which can be later than the day the friend signed up.
    expect(screen.getByText("Owed since Feb 3, 2027")).toBeInTheDocument();
    expect(screen.queryByText(/Friend booked/)).not.toBeInTheDocument();
    // A member with no address on file is still owed a note; the row says what is missing.
    expect(screen.getByText("Second Member")).toBeInTheDocument();
    expect(screen.getByText("No mailing address on file")).toBeInTheDocument();
    expect(screen.queryByText("Mailing address is not complete")).not.toBeInTheDocument();
  });

  it("a row with some address lines but not a full mailing address says so, and can still be marked", async () => {
    // A profile made from a lead: no street, no ZIP, the state at its default.
    owed = [{ ...NOTES[0], addressLines: ["FL"], addressComplete: false }];
    await openQueue();

    expect(await screen.findByText("FL")).toBeInTheDocument();
    expect(screen.getByText("Mailing address is not complete")).toBeInTheDocument();
    expect(screen.queryByText("No mailing address on file")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark written" })).toBeEnabled();
  });

  it("Mark written posts that referral once, takes the row off the card and keeps the other row", async () => {
    await openQueue();
    const buttons = await screen.findAllByRole("button", { name: "Mark written" });
    fireEvent.click(buttons[0]);

    expect(await screen.findByText("Thank-you note for Fixture Member marked written")).toBeInTheDocument();
    expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe(`/api/admin/referrals/thank-you-notes/${FIRST}/written`);
    expect(writes()[0][1].method).toBe("POST");
    expect(screen.queryByText("Fixture Member")).not.toBeInTheDocument();
    expect(screen.getByText("Thank-you notes to write (1)")).toBeInTheDocument();
    expect(screen.getByText("Second Member")).toBeInTheDocument();
  });

  it("the count is every note owed; when the last row on screen is written the next page comes up, and the card does not hide while one is owed", async () => {
    batch = 1;
    await openQueue();
    expect(await screen.findByText("Thank-you notes to write (2)")).toBeInTheDocument();
    expect(screen.getByText("Showing the oldest 1 of 2.")).toBeInTheDocument();
    expect(screen.queryByText("Second Member")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Mark written" }));

    expect(await screen.findByText("Second Member")).toBeInTheDocument();
    expect(screen.getByText("Thank-you notes to write (1)")).toBeInTheDocument();
    expect(screen.queryByText("Fixture Member")).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing the oldest/)).not.toBeInTheDocument();
    // The second read asked for the page after the first one. It did not read the first page again.
    expect(listReads()).toEqual([`${LIST}?after=`, `${LIST}?after=${encodeURIComponent(`after:${FIRST}`)}`]);

    fireEvent.click(screen.getByRole("button", { name: "Mark written" }));
    await waitFor(() => expect(screen.queryByText(/Thank-you notes to write/)).not.toBeInTheDocument());
    expect(writes()).toHaveLength(2);
  });

  it("Show more adds the next page below the rows on screen, with no mark on an earlier note", async () => {
    // Page 1 is one row that waits for an address; the note behind it can be written today.
    batch = 1;
    owed = [
      { ...NOTES[0], addressLines: ["FL"], addressComplete: false },
      { ...NOTES[1], addressLines: ["8 Sample Court", "Palmetto, FL 34221"], addressComplete: true },
      { ...NOTES[1], referralId: THIRD, memberName: "Third Member" },
    ];
    await openQueue();
    expect(await screen.findByText("Showing the oldest 1 of 3.")).toBeInTheDocument();
    expect(screen.queryByText("Second Member")).not.toBeInTheDocument();
    expect(listReads()).toEqual([`${LIST}?after=`]);

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));

    expect(await screen.findByText("Second Member")).toBeInTheDocument();
    expect(screen.getByText("Fixture Member")).toBeInTheDocument();
    expect(screen.getByText("Thank-you notes to write (3)")).toBeInTheDocument();
    expect(screen.getByText("Showing the oldest 2 of 3.")).toBeInTheDocument();
    // One page was asked for: the position after the first row. The first page was not read again.
    expect(listReads()).toEqual([`${LIST}?after=`, `${LIST}?after=${encodeURIComponent(`after:${FIRST}`)}`]);
    expect(writes()).toHaveLength(0);

    // A mark on the later note keeps both pages on screen and reads nothing.
    fireEvent.click(screen.getAllByRole("button", { name: "Mark written" })[1]);
    await waitFor(() => expect(screen.queryByText("Second Member")).not.toBeInTheDocument());
    expect(screen.getByText("Fixture Member")).toBeInTheDocument();
    expect(screen.getByText("Thank-you notes to write (2)")).toBeInTheDocument();
    expect(listReads()).toHaveLength(2);

    // The last page: the control leaves.
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(await screen.findByText("Third Member")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
    expect(listReads().at(-1)).toBe(`${LIST}?after=${encodeURIComponent(`after:${SECOND}`)}`);
  });

  it("one action at a time: no mark while a page is read, and no page read while a mark is saved", async () => {
    batch = 1;
    await openQueue();
    await screen.findByText("Showing the oldest 1 of 2.");

    // A page read that has not answered yet.
    const answer = notesResponse;
    let release;
    notesResponse = (url) => new Promise((resolve) => { release = () => resolve(answer(url)); });
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(await screen.findByRole("button", { name: "Loading..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Mark written" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Mark written" }));
    expect(writes()).toHaveLength(0);
    release();
    expect(await screen.findByText("Second Member")).toBeInTheDocument();
    notesResponse = answer;

    // A mark that has not answered yet.
    const saved = writtenResponse;
    let finish;
    writtenResponse = (url) => new Promise((resolve) => { finish = () => resolve(saved(url)); });
    owed = [...owed, { ...NOTES[1], referralId: THIRD, memberName: "Third Member" }];
    everOwed = owed;
    fireEvent.click(screen.getAllByRole("button", { name: "Mark written" })[0]);
    expect(await screen.findByRole("button", { name: "Saving..." })).toBeDisabled();
    for (const button of screen.getAllByRole("button", { name: "Mark written" })) expect(button).toBeDisabled();
    const reads = listReads().length;
    finish();
    await waitFor(() => expect(screen.queryByText("Fixture Member")).not.toBeInTheDocument());
    expect(listReads()).toHaveLength(reads);
    expect(screen.getByText("Thank-you notes to write (1)")).toBeInTheDocument();
  });

  it("more notes owed than rows and no next page named: Refresh list reads the list from its start", async () => {
    // Another login worked the list: the count and the rows went apart.
    notesResponse = () => response({ notes: [NOTES[0]], total: 2, nextCursor: null });
    await openQueue();
    expect(await screen.findByText("Showing the oldest 1 of 2.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();

    notesResponse = () => response({ notes: NOTES, total: 2, nextCursor: null });
    fireEvent.click(screen.getByRole("button", { name: "Refresh list" }));

    expect(await screen.findByText("Second Member")).toBeInTheDocument();
    expect(screen.queryByText(/Showing the oldest/)).not.toBeInTheDocument();
    expect(listReads()).toEqual([`${LIST}?after=`, `${LIST}?after=`]);
  });

  it("a next page that fails to load says so and keeps the rows and the control", async () => {
    batch = 1;
    await openQueue();
    await screen.findByText("Showing the oldest 1 of 2.");
    const first = notesResponse;
    notesResponse = () => response({ error: "down" }, 503);

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));

    expect(await screen.findByText("Error: down")).toBeInTheDocument();
    expect(screen.getByText("Fixture Member")).toBeInTheDocument();
    notesResponse = first;
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(await screen.findByText("Second Member")).toBeInTheDocument();
  });

  it("a note the server says is no longer owed leaves the card and the count, and the reason is shown", async () => {
    // Another login rejected the referral (or archived the member) after this list was read.
    writtenResponse = () => {
      owed = owed.filter((note) => note.referralId !== FIRST);
      return response({ error: "This referral has no thank-you note to write", code: "NO_NOTE_OWED" }, 404);
    };
    await openQueue();
    fireEvent.click((await screen.findAllByRole("button", { name: "Mark written" }))[0]);

    expect(await screen.findByText("Error: This referral has no thank-you note to write")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Fixture Member")).not.toBeInTheDocument());
    expect(screen.getByText("Thank-you notes to write (1)")).toBeInTheDocument();
    expect(screen.getByText("Second Member")).toBeInTheDocument();
  });

  it("a mark that failed to save keeps the row for another try", async () => {
    writtenResponse = () => response({ error: "down" }, 503);
    await openQueue();
    fireEvent.click((await screen.findAllByRole("button", { name: "Mark written" }))[0]);

    expect(await screen.findByText("Error: down")).toBeInTheDocument();
    // No reason code from the server: the note may still be owed, so the row stays.
    expect(screen.getByText("Fixture Member")).toBeInTheDocument();
    expect(screen.getByText("Thank-you notes to write (2)")).toBeInTheDocument();
  });

  it("shows no card when no note is owed", async () => {
    owed = [];
    await openQueue();

    await screen.findByText("Submit Referral");
    await waitFor(() => expect(listReads()).toHaveLength(1));
    expect(screen.queryByText(/Thank-you notes to write/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a failed read is an error with Retry, not an empty list; Retry reads the list again", async () => {
    notesResponse = () => response({ error: "down" }, 503);
    await openQueue();

    expect(await screen.findByText("Could not load thank-you notes to write. This is not an empty list.")).toBeInTheDocument();
    notesResponse = () => response({ notes: owed, total: owed.length, nextCursor: null });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Thank-you notes to write (2)")).toBeInTheDocument();
    expect(screen.queryByText(/Could not load thank-you notes/)).not.toBeInTheDocument();
  });
});
