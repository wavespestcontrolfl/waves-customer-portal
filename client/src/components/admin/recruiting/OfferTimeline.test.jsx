// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OfferTimeline from "./OfferTimeline";
import { fetchSignedCopy, reviseOffer, withdrawOffer } from "./offerApi";

vi.mock("./offerApi", () => ({ fetchSignedCopy: vi.fn(), reviseOffer: vi.fn(), withdrawOffer: vi.fn() }));

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
  // read still holds as a draft, and otherwise the refreshed card shows where the offer stands.
  it("opens the revision's editor only while the read still holds it as a draft", async () => {
    const revision = record({ id: "offer-2", status: "draft", draftHash: "hash-2" });
    reviseOffer.mockResolvedValue({ offer: revision });
    const onOpenDraft = vi.fn();
    const { unmount } = render(card({ onOpenDraft, onChanged: async () => ({ current: { ...revision, status: "sent" }, draft: null }) }));
    fireEvent.click(screen.getByRole("button", { name: "Revise" }));
    await waitFor(() => expect(reviseOffer).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Revise" })).toBeEnabled());
    expect(onOpenDraft).not.toHaveBeenCalled();
    expect(screen.queryByText("The new draft could not be loaded. Try again.")).toBeNull();
    unmount();
    render(card({ onOpenDraft, onChanged: async () => ({ current: record(), draft: revision, outStamp: "out-2" }) }));
    fireEvent.click(screen.getByRole("button", { name: "Revise" }));
    // The form opens on the offers out this card showed before the Revise, not the read after it.
    await waitFor(() => expect(onOpenDraft).toHaveBeenCalledWith(revision, "out-1"));
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

  it("withdraws what the owner saw while the question is still valid", async () => {
    withdrawOffer.mockResolvedValueOnce({ offer: record({ status: "withdrawn" }) });
    render(card());
    fireEvent.click(screen.getByRole("button", { name: "Withdraw offer" }));
    const ask = await screen.findByRole("dialog", { name: "Withdraw offer" });
    fireEvent.click(within(ask).getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(withdrawOffer).toHaveBeenCalledWith("app-1", "offer-1", { expectedStatus: "sent" }));
  });
});
