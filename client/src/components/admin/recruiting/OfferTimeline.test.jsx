// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OfferTimeline from "./OfferTimeline";
import { withdrawOffer } from "./offerApi";

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
      canMakeOffer={false}
      ownerActions
      refreshError={null}
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
});

afterEach(() => {
  cleanup();
});

describe("OfferTimeline", () => {
  // The Withdraw question writes what the owner saw. A read that fails, changes the offer, or takes away the owner's
  // access while it is open closes it, and nothing is written.
  it.each([
    ["the next read fails", { refreshError: "The offer could not be loaded." }],
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

  it("closes the Discard question when the draft it was opened for changes, and discards nothing", async () => {
    const draft = record({ id: "offer-2", status: "draft", draftHash: "hash-2" });
    const { rerender } = render(card({ draft }));
    fireEvent.click(screen.getByRole("button", { name: "Discard this draft — the offer you sent stays open" }));
    expect(await screen.findByRole("dialog", { name: "Discard draft" })).toBeInTheDocument();
    rerender(card({ draft: { ...draft, hourlyRate: 26, draftHash: "hash-3" } }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Discard draft" })).toBeNull());
    expect(withdrawOffer).not.toHaveBeenCalled();
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
