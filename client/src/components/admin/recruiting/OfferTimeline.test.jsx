// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OfferTimeline from "./OfferTimeline";
import { fetchSignedCopy, reviseOffer, setChecklistItem, withdrawOffer } from "./offerApi";

vi.mock("./offerApi", () => ({ fetchSignedCopy: vi.fn(), reviseOffer: vi.fn(), setChecklistItem: vi.fn(), withdrawOffer: vi.fn() }));

const TERMS = {
  jobTitle: "Pest Control Technician",
  startDate: "2027-01-04",
  hourlyRate: 23,
  stepRate: 25,
  stepEffectiveOn: "2027-04-05",
  hoursLine: "40 paid hours each full week",
  reportTo: "Sam Carter, owner",
  payDayLine: "Every Friday",
};
const record = (over = {}) => ({ id: "offer-1", applicationId: "app-1", status: "sent", ...TERMS, draftHash: "hash-1", timeline: [], ...over });

function card(props = {}) {
  return (
    <OfferTimeline
      applicationId="app-1"
      firstName="Jordan"
      offer={record()}
      draft={null}
      history={[]}
      outStamp="out-1"
      canMakeOffer={false}
      ownerActions
      stale={false}
      onMakeOffer={() => {}}
      onChanged={async () => null}
      onOpenDraft={() => {}}
      onEdit={() => {}}
      {...props}
    />
  );
}

beforeEach(() => {
  withdrawOffer.mockReset();
  reviseOffer.mockReset();
  fetchSignedCopy.mockReset();
  setChecklistItem.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("OfferTimeline", () => {
  // The Withdraw question writes what the owner saw. A read that fails, changes the offer, or takes away the owner's
  // access while it is open closes it, and nothing is written.
  it.each([
    ["the next read of the offer or the application fails", { stale: true }],
    ["the offer moves on (the applicant signed)", { offer: record({ status: "accepted", signedAt: "2026-12-12T15:00:00Z" }) }],
    ["the owner's access ends", { ownerActions: false }],
  ])("closes the Withdraw question when %s, and withdraws nothing", async (_label, change) => {
    const { rerender } = render(card());
    fireEvent.click(screen.getByRole("button", { name: "Withdraw offer" }));
    expect(await screen.findByRole("dialog", { name: "Withdraw offer" })).toBeInTheDocument();
    rerender(card(change));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Withdraw offer" })).toBeNull());
    expect(withdrawOffer).not.toHaveBeenCalled();
  });

  // A refusal for a reason the card does not show (the owner account lost its access, say) re-reads like every failed
  // write: the question closes and the card follows that read, so Withdraw is not pressed again in vain.
  it("closes the Withdraw question and re-reads after an OWNER_ONLY refusal", async () => {
    withdrawOffer.mockRejectedValueOnce(
      Object.assign(new Error("This action is limited to the owner account."), { status: 403, body: { code: "OWNER_ONLY" } }),
    );
    const onChanged = vi.fn(async () => null);
    render(card({ onChanged }));
    fireEvent.click(screen.getByRole("button", { name: "Withdraw offer" }));
    const ask = await screen.findByRole("dialog", { name: "Withdraw offer" });
    fireEvent.click(within(ask).getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Withdraw offer" })).toBeNull());
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByText("This action is limited to the owner account.")).toBeInTheDocument();
    expect(withdrawOffer).toHaveBeenCalledTimes(1);
  });

  it("closes the Discard question when the draft it was opened for changes, and discards nothing", async () => {
    const draft = record({ id: "offer-2", status: "draft", draftHash: "hash-2" });
    const { rerender } = render(card({ draft }));
    fireEvent.click(screen.getByRole("button", { name: "Discard this draft — the offer you sent is unchanged" }));
    expect(await screen.findByRole("dialog", { name: "Discard draft" })).toBeInTheDocument();
    rerender(card({ draft: { ...draft, hourlyRate: 26, draftHash: "hash-3" } }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Discard draft" })).toBeNull());
    expect(withdrawOffer).not.toHaveBeenCalled();
  });

  // Another owner session can send the revision before the read after Revise: the editor opens only for a row the
  // read still holds as a draft, and otherwise the card says what the read shows now.
  it("opens the revision's editor only while the read still holds it as a draft", async () => {
    const revision = record({ id: "offer-2", status: "draft", draftHash: "hash-2" });
    reviseOffer.mockResolvedValue({ offer: revision });
    const onOpenDraft = vi.fn();
    const { unmount } = render(card({ onOpenDraft, onChanged: async () => ({ current: { ...revision, status: "sent" }, draft: null }) }));
    fireEvent.click(screen.getByRole("button", { name: "Revise" }));
    await waitFor(() => expect(reviseOffer).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Revise" })).toBeEnabled());
    expect(onOpenDraft).not.toHaveBeenCalled();
    expect(screen.getByText("The new draft is no longer a draft. It now shows: Sent.")).toBeInTheDocument();
    expect(screen.queryByText("The new draft could not be loaded. Try again.")).toBeNull();
    unmount();
    render(card({ onOpenDraft, onChanged: async () => ({ current: record(), draft: revision, outStamp: "out-2" }) }));
    fireEvent.click(screen.getByRole("button", { name: "Revise" }));
    // The form opens on the offers out this card showed before the Revise, not the read after it.
    await waitFor(() => expect(onOpenDraft).toHaveBeenCalledWith(revision, "out-1"));
  });

  // Another session can discard the revision before the read after Revise: the read holds it in the history, and the
  // offer sent before stays current. The card says so; it does not report a failed read or ask for a retry, which
  // would make another draft.
  it("a revision discarded before the read after Revise says so, with no retry", async () => {
    const revision = record({ id: "offer-2", status: "draft", draftHash: "hash-2" });
    reviseOffer.mockResolvedValue({ offer: revision });
    const onOpenDraft = vi.fn();
    render(card({ onOpenDraft, onChanged: async () => ({ current: record(), draft: null, history: [{ ...revision, status: "withdrawn" }] }) }));
    fireEvent.click(screen.getByRole("button", { name: "Revise" }));
    expect(await screen.findByText("The new draft is no longer a draft. It now shows: Withdrawn.")).toBeInTheDocument();
    expect(screen.queryByText("The new draft could not be loaded. Try again.")).toBeNull();
    expect(onOpenDraft).not.toHaveBeenCalled();
  });

  // Two signed copies in the history: while one loads, every signed-copy button waits, so a slower read can never
  // replace the copy the owner chose last.
  it("keeps every signed-copy button off while one signed copy loads", async () => {
    fetchSignedCopy.mockReturnValue(new Promise(() => {}));
    const history = [
      record({ id: "offer-7", status: "accepted", signedAt: "2026-06-01T15:00:00Z", signedName: "Jordan Rivera" }),
      record({ id: "offer-8", status: "accepted", signedAt: "2026-08-01T15:00:00Z", signedName: "Jordan Rivera" }),
    ];
    render(card({ history }));
    fireEvent.click(screen.getByText("Earlier offers (2)"));
    const [first, second] = screen.getAllByRole("button", { name: "View signed copy" });
    fireEvent.click(first);
    await waitFor(() => expect(second).toBeDisabled());
    expect(first).toBeDisabled();
    expect(fetchSignedCopy).toHaveBeenCalledTimes(1);
  });

  // A date request whose day has come (Eastern): the server would pick another start date, so the card keeps the
  // request as history and offers only Revise.
  it("offers the update for the asked date only while that day is still ahead in Eastern time", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-19T15:00:00Z")); // 10 AM ET, Thursday Nov 19
    try {
      const asked = (day) => record({ status: "date_requested", requestedStartDate: day });
      const { rerender } = render(card({ offer: asked("2026-11-19") }));
      expect(screen.getByText(/Asked to start/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Make an updated offer for/ })).toBeNull();
      expect(screen.getByRole("button", { name: "Revise" })).toBeInTheDocument();
      rerender(card({ offer: asked("2026-11-23") }));
      expect(screen.getByRole("button", { name: /Make an updated offer for/ })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  // A card left open across Eastern midnight still shows the dated update for the day that has come. The server would
  // start that draft on another date, so the click writes nothing: the card says why and drops the button.
  it("a dated update clicked after its day has come writes nothing, says why, and leaves Revise", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-22T15:00:00Z")); // 10 AM ET, Sunday Nov 22
    try {
      const onChanged = vi.fn(async () => null);
      render(card({ offer: record({ status: "date_requested", requestedStartDate: "2026-11-23" }), onChanged }));
      const update = screen.getByRole("button", { name: "Make an updated offer for Mon, Nov 23, 2026" });
      vi.setSystemTime(new Date("2026-11-23T05:30:00Z")); // 12:30 AM ET, Monday Nov 23: the asked day has come
      fireEvent.click(update);
      expect(reviseOffer).not.toHaveBeenCalled();
      expect(onChanged).not.toHaveBeenCalled();
      expect(
        screen.getByText("Mon, Nov 23, 2026 is no longer in the future, so an updated offer cannot start then. Nothing was changed. Use Revise to choose another start date."),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Make an updated offer for/ })).toBeNull();
      expect(screen.getByRole("button", { name: "Revise" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("withdraws what the owner saw while the question is still valid", async () => {
    withdrawOffer.mockResolvedValueOnce({ offer: record({ status: "withdrawn" }) });
    render(card());
    fireEvent.click(screen.getByRole("button", { name: "Withdraw offer" }));
    const ask = await screen.findByRole("dialog", { name: "Withdraw offer" });
    fireEvent.click(within(ask).getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(withdrawOffer).toHaveBeenCalledWith("app-1", "offer-1", { expectedStatus: "sent" }));
  });

  // The first-days checklist of a signed offer: the server's labels and due lines, one button for each item.
  describe("the first-days checklist", () => {
    const signed = () => record({ status: "accepted", signedAt: "2026-12-12T15:00:00Z" });
    const firstDays = (over = {}) => ({
      offerId: "offer-1",
      firstDay: "2027-01-04",
      items: [
        { key: "driving_record", label: "Driving record copy", due: "Due before the first day, Mon, Jan 4, 2027", doneAt: "2026-12-14T15:00:00Z", doneByName: "Sam Carter" },
        { key: "i9", label: "Form I-9", due: "Due Thu, Jan 7, 2027, 3 business days after the first day", doneAt: null, doneByName: null },
      ],
      ...over,
    });
    const rowOf = (label) => screen.getByText(label).closest("li");

    it("marks an open item done and a done item not done, then re-reads the card", async () => {
      setChecklistItem.mockResolvedValue({ firstDays: firstDays() });
      const onChanged = vi.fn(async () => null);
      render(card({ offer: signed(), firstDays: firstDays(), onChanged }));
      // An open item shows its due line; a done one shows when and by whom, in Eastern time.
      expect(within(rowOf("Form I-9")).getByText("Due Thu, Jan 7, 2027, 3 business days after the first day")).toBeInTheDocument();
      expect(within(rowOf("Driving record copy")).getByText(/^Done .*Dec 14.* by Sam Carter$/)).toBeInTheDocument();
      expect(within(rowOf("Driving record copy")).queryByText(/Due before/)).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Mark done: Form I-9" }));
      await waitFor(() => expect(setChecklistItem).toHaveBeenCalledWith("app-1", "offer-1", "i9", true, null));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole("button", { name: "Undo: Driving record copy" }));
      // An undo names the mark the card shows.
      await waitFor(() => expect(setChecklistItem).toHaveBeenLastCalledWith("app-1", "offer-1", "driving_record", false, "2026-12-14T15:00:00Z"));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    });

    it("a refused write shows why and re-reads the card", async () => {
      setChecklistItem.mockRejectedValueOnce(Object.assign(new Error("This checklist is closed."), { status: 409, body: { code: "CHECKLIST_CLOSED" } }));
      const onChanged = vi.fn(async () => null);
      render(card({ offer: signed(), firstDays: firstDays(), onChanged }));
      fireEvent.click(screen.getByRole("button", { name: "Mark done: Form I-9" }));
      expect(await screen.findByText("This checklist is closed.")).toBeInTheDocument();
      expect(onChanged).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["an admin who is not the owner account", { ownerActions: false }],
      ["a card whose last read failed", { stale: true }],
    ])("shows the list with no buttons to %s", (_label, change) => {
      render(card({ offer: signed(), firstDays: firstDays(), ...change }));
      expect(screen.getByTestId("offer-first-days")).toBeInTheDocument();
      expect(screen.getByText("Form I-9")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^(Mark done|Undo):/ })).toBeNull();
    });

    it("shows an open item's note (what to do), and not once the item is done", () => {
      const login = (over) => ({
        key: "google_login", label: "Waves Google login", note: "On the Team tab, link the Waves Google address, then press Hired.",
        due: "Due before the first day, Mon, Jan 4, 2027", doneAt: null, doneByName: null, ...over,
      });
      const { rerender } = render(card({ offer: signed(), firstDays: firstDays({ items: [login(), ...firstDays().items] }) }));
      const row = () => within(rowOf("Waves Google login"));
      expect(row().getByText("Due before the first day, Mon, Jan 4, 2027")).toBeInTheDocument();
      expect(row().getByText("On the Team tab, link the Waves Google address, then press Hired.")).toBeInTheDocument();
      expect(row().getByRole("button", { name: "Mark done: Waves Google login" })).toBeInTheDocument();

      rerender(card({ offer: signed(), firstDays: firstDays({ items: [login({ doneAt: "2026-12-20T15:00:00Z", doneByName: "Sam Carter" }), ...firstDays().items] }) }));
      expect(row().getByText(/^Done .*Dec 20.* by Sam Carter$/)).toBeInTheDocument();
      expect(row().queryByText(/On the Team tab/)).toBeNull();
    });

    it("shows no checklist when the read has none", () => {
      render(card({ offer: signed(), firstDays: null }));
      expect(screen.queryByTestId("offer-first-days")).toBeNull();
    });

    // A later offer that was withdrawn can be the card's offer while the application is Hired on an earlier signature.
    it("shows the hire's checklist on a card whose offer is not the signed one, and a write names the checklist's offer", async () => {
      setChecklistItem.mockResolvedValue({ firstDays: firstDays({ offerId: "offer-9" }) });
      render(card({ offer: record({ status: "withdrawn" }), firstDays: firstDays({ offerId: "offer-9" }) }));
      fireEvent.click(screen.getByRole("button", { name: "Mark done: Form I-9" }));
      await waitFor(() => expect(setChecklistItem).toHaveBeenCalledWith("app-1", "offer-9", "i9", true, null));
    });
  });
});
