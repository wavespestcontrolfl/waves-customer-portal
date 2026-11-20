// @vitest-environment jsdom
import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OfferDialog from "./OfferDialog";
import { saveOfferDraft, sendOffer } from "./offerApi";
import { stepDateFor } from "./offerLogic";

vi.mock("./offerApi", () => ({ saveOfferDraft: vi.fn(), sendOffer: vi.fn() }));

const NOW = new Date("2026-11-19T15:00:00Z"); // the clock is frozen here (see beforeEach)
const START = "2027-01-04"; // a Monday after NOW
const STEP = stepDateFor(START);
const CONTACT = { name: "Jordan Rivera", phone: "+19415550142", email: "jordan.rivera@example.com" };

const DEFAULTS = {
  jobTitle: "Pest Control Technician",
  startDate: START,
  hourlyRate: 23,
  stepRate: 25,
  stepEffectiveOn: STEP,
  hoursLine: "40 paid hours each full week",
};

function draftRow(over = {}) {
  return {
    id: "offer-1",
    applicationId: "app-1",
    status: "draft",
    ...DEFAULTS,
    reportTo: "Sam Carter, owner",
    payDayLine: "Every Friday",
    draftHash: "hash-1",
    ...over,
  };
}

// The offer panel read, with the letter preview built for its open draft (`current`).
function panel(current) {
  return {
    enabled: true,
    viewer: { ownerActions: true },
    termsIssued: true,
    termsBlockers: [],
    terms: { title: "Technician Terms", versionId: "terms-1", issuedAt: "2026-11-01T14:00:00.000Z" },
    defaults: DEFAULTS,
    draft: null,
    current,
    letterPreview: { offerId: current.id, draftHash: current.draftHash, markdown: `Letter for ${current.draftHash}.` },
  };
}

const offersOff = () => Object.assign(new Error("Not found"), { status: 404, body: { enabled: false } });

// Holds the panel read as the offer flow does: a read that works replaces it (a read with offers off closes the
// form), and a failed read keeps the data on screen, marks it stale (the page's refreshError) and answers null.
// `outside.read(next)` is a read the form did not ask for (another screen's write, a stage change);
// `outside.fail()` is one that failed.
function Harness({ initial, reads, onSent = async () => {}, outside = {} }) {
  const [data, setData] = useState(initial);
  const [open, setOpen] = useState(true);
  const [stale, setStale] = useState(false);
  outside.read = setData;
  outside.fail = () => setStale(true);
  const onChanged = async () => {
    const next = reads.shift();
    if (!next) {
      setStale(true);
      return null;
    }
    setStale(false);
    setData(next);
    if (next.enabled !== true) setOpen(false);
    return next;
  };
  return (
    <OfferDialog
      open={open}
      applicationId="app-1"
      contact={CONTACT}
      data={data}
      draft={null}
      stale={stale}
      onClose={() => setOpen(false)}
      onChanged={onChanged}
      onSent={onSent}
    />
  );
}

const rate = () => screen.getByLabelText("Hourly rate ($)");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  saveOfferDraft.mockReset();
  sendOffer.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.style.overflow = "";
});

describe("OfferDialog", () => {
  // The read after a save can hold a newer version of the draft (another admin saved in between). The form keeps
  // the version this save wrote and shows the draft as changed, so Send waits until the owner reviews the new one.
  it("after a save, a read of another admin's newer version shows the draft as changed, and Send waits for review", async () => {
    saveOfferDraft.mockResolvedValueOnce({ offer: draftRow({ hourlyRate: 24, draftHash: "hash-2" }) });
    render(<Harness initial={panel(draftRow())} reads={[panel(draftRow({ hourlyRate: 26, draftHash: "hash-3" }))]} />);
    fireEvent.change(rate(), { target: { value: "24" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("This draft changed. Review the new version.")).toBeInTheDocument();
    expect(rate()).toHaveValue(24);
    expect(rate()).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Send offer" })).toBeNull();
    expect(screen.queryByText("Letter for hash-3.")).toBeNull();
    expect(saveOfferDraft).toHaveBeenCalledWith("app-1", expect.objectContaining({ hourlyRate: 24, draftId: "offer-1", draftHash: "hash-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Show the new version" }));
    expect(rate()).toHaveValue(26);
    expect(screen.getByRole("button", { name: "Send offer" })).toBeEnabled();
  });

  it("after a save, a read of the version that save wrote shows its letter and frees Send", async () => {
    const saved = draftRow({ hourlyRate: 24, draftHash: "hash-2" });
    saveOfferDraft.mockResolvedValueOnce({ offer: saved });
    render(<Harness initial={panel(draftRow())} reads={[panel(saved)]} />);
    fireEvent.change(rate(), { target: { value: "24" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("Letter for hash-2.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Send offer" })).toBeEnabled());
    expect(screen.queryByText("This draft changed. Review the new version.")).toBeNull();
    expect(rate()).toHaveValue(24);
    expect(rate()).toBeEnabled();
  });

  // A write that finds offers turned off wrote nothing. The read after it turns the flow off and closes the form;
  // until a read works, the form stays read-only with the owner's edits on screen.
  it("keeps the form read-only when a save finds offers turned off and the read fails, until a read closes it", async () => {
    saveOfferDraft.mockRejectedValueOnce(offersOff());
    render(<Harness initial={panel(draftRow())} reads={[null, { enabled: false }]} />);
    fireEvent.change(rate(), { target: { value: "24" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText(/The offer could not be loaded after your last change/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(rate()).toBeDisabled();
    expect(rate()).toHaveValue(24);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull());
  });

  it("closes the Send question and keeps Send off when a send finds offers turned off and the read fails", async () => {
    sendOffer.mockRejectedValueOnce(offersOff());
    render(<Harness initial={panel(draftRow())} reads={[null]} />);
    fireEvent.click(screen.getByRole("button", { name: "Send offer" }));
    const ask = await screen.findByRole("dialog", { name: "Send offer" });
    fireEvent.click(within(ask).getByRole("button", { name: "Send offer" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Send offer" })).toBeNull());
    expect(await screen.findByText(/The offer could not be loaded after your last change/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send offer" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(sendOffer).toHaveBeenCalledWith("app-1", "offer-1", "hash-1");
  });

  // A send refused for a reason the form does not show (the Terms lost their issued status, say): nothing was sent. The
  // question closes, the form re-reads the offer and the application, and Send follows that read; while the read fails,
  // Send stays off and Try again reads.
  it("closes the Send question and re-reads after a refused send, and keeps Send off until a read lands", async () => {
    sendOffer.mockRejectedValueOnce(
      Object.assign(new Error("The Technician Terms are not issued."), { status: 409, body: { code: "TERMS_NOT_ISSUED" } }),
    );
    const unissued = { ...panel(draftRow()), termsIssued: false, termsBlockers: ["The Technician Terms are not issued."] };
    render(<Harness initial={panel(draftRow())} reads={[null, unissued]} />);
    fireEvent.click(screen.getByRole("button", { name: "Send offer" }));
    const ask = await screen.findByRole("dialog", { name: "Send offer" });
    fireEvent.click(within(ask).getByRole("button", { name: "Send offer" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Send offer" })).toBeNull());
    expect(await screen.findByText("The shared Technician Terms are not issued yet. Issue them in Staff Documents first.")).toBeInTheDocument();
    expect(screen.getByText(/The offer could not be loaded after your last change/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send offer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByText(/could not be loaded/)).toBeNull());
    expect(screen.getByRole("button", { name: "Send offer" })).toBeDisabled();
    expect(sendOffer).toHaveBeenCalledTimes(1);
  });

  // Send carries the hash of the draft whose letter is on screen, so a read that changes the draft while the Send
  // question is open closes the question; the form shows the draft as changed.
  it("closes the Send question when a read changes the draft while it is open, and sends nothing", async () => {
    const outside = {};
    render(<Harness initial={panel(draftRow())} reads={[]} outside={outside} />);
    fireEvent.click(screen.getByRole("button", { name: "Send offer" }));
    expect(await screen.findByRole("dialog", { name: "Send offer" })).toBeInTheDocument();
    act(() => outside.read(panel(draftRow({ hourlyRate: 26, draftHash: "hash-3" }))));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Send offer" })).toBeNull());
    expect(screen.getByText("This draft changed. Review the new version.")).toBeInTheDocument();
    expect(sendOffer).not.toHaveBeenCalled();
  });

  // A background read that fails (after a stage change, say) leaves the data on screen out of date. The card turns its
  // actions off; the form goes read-only too, closes an open Send question, and reads again on Try again.
  it("locks the form and closes the Send question when a background read fails, until Try again reads", async () => {
    const outside = {};
    render(<Harness initial={panel(draftRow())} reads={[panel(draftRow())]} outside={outside} />);
    fireEvent.click(screen.getByRole("button", { name: "Send offer" }));
    expect(await screen.findByRole("dialog", { name: "Send offer" })).toBeInTheDocument();
    act(() => outside.fail());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Send offer" })).toBeNull());
    expect(screen.getByText(/The offer could not be refreshed\. Fields and Send stay off until it loads\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(rate()).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Send offer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send offer" })).toBeEnabled());
    expect(rate()).toBeEnabled();
    expect(sendOffer).not.toHaveBeenCalled();
  });

  // A form with no draft yet keeps the owner's typing when a read shows another admin's first draft: the form shows it
  // as changed, and only Show the new version replaces the typing.
  it("keeps the owner's typing when Try again finds another admin's first draft, until they load it", async () => {
    const outside = {};
    const theirs = draftRow({ id: "offer-2", hourlyRate: 27, draftHash: "hash-9" });
    render(<Harness initial={{ ...panel(draftRow()), current: null, letterPreview: null }} reads={[panel(theirs)]} outside={outside} />);
    fireEvent.change(rate(), { target: { value: "24" } });
    act(() => outside.fail());
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("This draft changed. Review the new version.")).toBeInTheDocument();
    expect(rate()).toHaveValue(24);
    expect(rate()).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Send offer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show the new version" }));
    expect(rate()).toHaveValue(27);
    expect(rate()).toBeEnabled();
  });

  // The send's result shows at once, but the card behind still shows the draft until the read after the send lands.
  it("keeps Close off until the read after a send lands", async () => {
    let landed;
    const onSent = vi.fn(() => new Promise((resolve) => { landed = resolve; }));
    sendOffer.mockResolvedValueOnce({ comms: {}, offer: { status: "sent" } });
    render(<Harness initial={panel(draftRow())} reads={[]} onSent={onSent} />);
    fireEvent.click(screen.getByRole("button", { name: "Send offer" }));
    const ask = await screen.findByRole("dialog", { name: "Send offer" });
    fireEvent.click(within(ask).getByRole("button", { name: "Send offer" }));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "Close" })).toBeDisabled();
    await act(async () => landed());
    await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toBeEnabled());
    expect(sendOffer).toHaveBeenCalledWith("app-1", "offer-1", "hash-1");
  });

  // A save sends a step date only with a step rate, so the date can be set only once a rate is.
  it("sets the step date only with a step rate, so a save never drops a date the owner typed", () => {
    render(<Harness initial={panel(draftRow())} reads={[]} />);
    expect(screen.getByLabelText("Step date")).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Step rate ($)"), { target: { value: "" } });
    expect(screen.getByLabelText("Step date")).toBeDisabled();
    expect(screen.getByLabelText("Step date")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Step rate ($)"), { target: { value: "26" } });
    expect(screen.getByLabelText("Step date")).toBeEnabled();
    expect(screen.getByLabelText("Step date")).toHaveValue(STEP);
  });
});
