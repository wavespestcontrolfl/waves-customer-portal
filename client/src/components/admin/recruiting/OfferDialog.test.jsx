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
    sendTo: { sms: "(941) ***-0142", email: "j***@example.com" },
    sendReplacesId: null,
    outStamp: "out-1",
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
function Harness({ initial, reads, onSent = async () => {}, outside = {}, draft = null }) {
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
      draft={draft}
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
    render(<Harness initial={panel(draftRow())} reads={[panel(draftRow({ hourlyRate: 26, stepRate: 28, draftHash: "hash-3" }))]} />);
    fireEvent.change(rate(), { target: { value: "24" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("This draft changed. Review the new version.")).toBeInTheDocument();
    expect(rate()).toHaveValue("24");
    expect(rate()).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Send offer" })).toBeNull();
    expect(screen.queryByText("Letter for hash-3.")).toBeNull();
    expect(saveOfferDraft).toHaveBeenCalledWith("app-1", expect.objectContaining({ hourlyRate: 24, draftId: "offer-1", draftHash: "hash-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Show the new version" }));
    expect(rate()).toHaveValue("26");
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
    expect(rate()).toHaveValue("24");
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
    expect(rate()).toHaveValue("24");
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
    expect(sendOffer).toHaveBeenCalledWith("app-1", "offer-1", "hash-1", "out-1");
  });

  // The read after a send is newer than its answer: another session may withdraw the offer in between. The result
  // follows that read, and keeps the send's own delivery outcomes.
  it("a send result follows the read after it: an offer withdrawn since reads as no longer open, with no Revise advice", async () => {
    sendOffer.mockResolvedValueOnce({ offer: draftRow({ status: "sent", updatedAt: "2026-12-12T13:15:00.000Z" }), comms: { sms: { outcome: "failed" }, email: { outcome: "failed" } } });
    const after = { ...panel(draftRow()), current: draftRow({ status: "withdrawn", updatedAt: "2026-12-12T13:16:00.000Z" }) };
    const outside = {};
    render(<Harness initial={panel(draftRow())} reads={[]} outside={outside} onSent={async () => { outside.read(after); return after; }} />);
    fireEvent.click(screen.getByRole("button", { name: "Send offer" }));
    const ask = await screen.findByRole("dialog", { name: "Send offer" });
    fireEvent.click(within(ask).getByRole("button", { name: "Send offer" }));
    expect(await screen.findByText("This offer is no longer open.")).toBeInTheDocument();
    expect(screen.queryByText("The offer is open.")).toBeNull();
    expect(screen.queryByText(/use Revise/)).toBeNull();
  });

  // The result keeps following the reads while it is open: a later read (a bell link, a Try again) can show the offer
  // withdrawn after the read that followed the send.
  it("a send result follows a later read: an offer withdrawn while the result is open reads as no longer open", async () => {
    const sentRow = draftRow({ status: "sent", updatedAt: "2026-12-12T13:15:00.000Z" });
    sendOffer.mockResolvedValueOnce({ offer: sentRow, comms: { sms: { outcome: "failed" }, email: { outcome: "failed" } } });
    const outside = {};
    const afterSend = { ...panel(draftRow()), current: sentRow };
    render(<Harness initial={panel(draftRow())} reads={[]} outside={outside} onSent={async () => { outside.read(afterSend); return afterSend; }} />);
    fireEvent.click(screen.getByRole("button", { name: "Send offer" }));
    const ask = await screen.findByRole("dialog", { name: "Send offer" });
    fireEvent.click(within(ask).getByRole("button", { name: "Send offer" }));
    expect(await screen.findByText("The offer is open.")).toBeInTheDocument();
    expect(screen.getByText(/use Revise/)).toBeInTheDocument();
    act(() => outside.read({ ...panel(draftRow()), current: draftRow({ status: "withdrawn", updatedAt: "2026-12-12T13:20:00.000Z" }) }));
    expect(await screen.findByText("This offer is no longer open.")).toBeInTheDocument();
    expect(screen.queryByText(/use Revise/)).toBeNull();
  });

  // A read older than the send's answer (one that started during the send and landed after it) does not undo it.
  it("a send result keeps its answer over an older read: an offer the answer shows withdrawn stays no longer open", async () => {
    sendOffer.mockResolvedValueOnce({ offer: draftRow({ status: "withdrawn", updatedAt: "2026-12-12T13:16:00.000Z" }), comms: { sms: { outcome: "sent" }, email: { outcome: "sent" } } });
    const outside = {};
    const older = { ...panel(draftRow()), current: draftRow({ status: "sent", updatedAt: "2026-12-12T13:15:00.000Z" }) };
    render(<Harness initial={panel(draftRow())} reads={[]} outside={outside} onSent={async () => { outside.read(older); return older; }} />);
    fireEvent.click(screen.getByRole("button", { name: "Send offer" }));
    const ask = await screen.findByRole("dialog", { name: "Send offer" });
    fireEvent.click(within(ask).getByRole("button", { name: "Send offer" }));
    expect(await screen.findByText("This offer is no longer open.")).toBeInTheDocument();
    expect(screen.queryByText(/Offer sent to/)).toBeNull();
  });

  // The server closes a sent offer past its expiry by the clock, without a write: a later read of the same version says
  // expired. The result says so in its own words (not "withdrawn or replaced") and gives no Revise advice.
  it("a send result shows an offer the server closed at its expiry as closed unsigned, from a read of the same version", async () => {
    const sentRow = draftRow({ status: "sent", updatedAt: "2026-12-12T13:15:00.000Z", expiresAt: "2026-12-19T13:15:00.000Z" });
    sendOffer.mockResolvedValueOnce({ offer: sentRow, comms: { sms: { outcome: "failed" }, email: { outcome: "failed" } } });
    const outside = {};
    const afterSend = { ...panel(draftRow()), current: sentRow };
    render(<Harness initial={panel(draftRow())} reads={[]} outside={outside} onSent={async () => { outside.read(afterSend); return afterSend; }} />);
    fireEvent.click(screen.getByRole("button", { name: "Send offer" }));
    const ask = await screen.findByRole("dialog", { name: "Send offer" });
    fireEvent.click(within(ask).getByRole("button", { name: "Send offer" }));
    expect(await screen.findByText("The offer is open.")).toBeInTheDocument();
    act(() => outside.read({ ...panel(draftRow()), current: { ...sentRow, status: "expired" } }));
    expect(await screen.findByText("This offer is no longer open.")).toBeInTheDocument();
    expect(screen.getByText("It passed its expiry before Jordan signed it. The offer card shows it as Closed unsigned.")).toBeInTheDocument();
    expect(screen.queryByText(/withdrawn or replaced/)).toBeNull();
    expect(screen.queryByText(/use Revise/)).toBeNull();
  });

  // A result left open past the expiry: when the expiry passes, the page's clock closes the offer with no read. The read
  // after the send still says sent: the card shows the same, so the result says it closed unsigned. Or the read failed
  // and still holds the draft: the result shows the send's answer, its expiry still counts, and the result says only
  // that the expiry passed. The clock is frozen (beforeEach) and moved by hand; the form's timer is real.
  it.each([
    [
      "the read after the send says sent",
      (outside, afterSend) => async () => { outside.read(afterSend); return afterSend; },
      "This offer is no longer open.",
      "It passed its expiry before Jordan signed it. The offer card shows it as Closed unsigned.",
    ],
    [
      "the read after the send failed",
      (outside) => async () => { outside.fail(); return null; },
      "This offer's expiry has passed.",
      "The page could not read the offer after the send, so it cannot tell whether Jordan signed it before then. Close this and use Try again on the offer card.",
    ],
  ])("a send result left open past the offer's expiry says so when the expiry passes, with no read (%s)", async (_case, onSentFor, headline, line) => {
    const sentRow = draftRow({ status: "sent", updatedAt: "2026-12-12T13:15:00.000Z", expiresAt: new Date(NOW.getTime() + 300).toISOString() });
    sendOffer.mockResolvedValueOnce({ offer: sentRow, comms: { sms: { outcome: "sent" }, email: { outcome: "sent" } } });
    const outside = {};
    const afterSend = { ...panel(draftRow()), current: sentRow };
    render(<Harness initial={panel(draftRow())} reads={[]} outside={outside} onSent={onSentFor(outside, afterSend)} />);
    fireEvent.click(screen.getByRole("button", { name: "Send offer" }));
    const ask = await screen.findByRole("dialog", { name: "Send offer" });
    fireEvent.click(within(ask).getByRole("button", { name: "Send offer" }));
    expect(await screen.findByText("Offer sent to Jordan.")).toBeInTheDocument();
    vi.setSystemTime(new Date(NOW.getTime() + 1300));
    expect(await screen.findByText(headline, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText(line)).toBeInTheDocument();
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
    act(() => outside.read(panel(draftRow({ hourlyRate: 26, stepRate: 28, draftHash: "hash-3" }))));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Send offer" })).toBeNull());
    expect(screen.getByText("This draft changed. Review the new version.")).toBeInTheDocument();
    expect(sendOffer).not.toHaveBeenCalled();
  });

  // The offers out (the read's outStamp) are pinned when the form opens. A read that changes them (the applicant asked
  // for another date) closes the Send question and locks the form until Show the new version, and Send then carries the
  // stamp the owner reviewed, never a later read's.
  it("closes the Send question when a read changes the offers out, and Send carries only the stamp the owner reviewed", async () => {
    const outside = {};
    sendOffer.mockResolvedValueOnce({ comms: {}, offer: { status: "sent" } });
    render(<Harness initial={panel(draftRow())} reads={[]} outside={outside} />);
    fireEvent.click(screen.getByRole("button", { name: "Send offer" }));
    expect(await screen.findByRole("dialog", { name: "Send offer" })).toBeInTheDocument();
    act(() => outside.read({ ...panel(draftRow()), outStamp: "out-2" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Send offer" })).toBeNull());
    expect(screen.getByText(/The offer you sent before changed after you opened this form/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send offer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue with this draft" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send offer" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Send offer" })).getByRole("button", { name: "Send offer" }));
    await waitFor(() => expect(sendOffer).toHaveBeenCalledTimes(1));
    expect(sendOffer).toHaveBeenCalledWith("app-1", "offer-1", "hash-1", "out-2");
  });

  // A revision is open with typed edits when the applicant asks for another date on the offer it replaces. The form says
  // what changed, by the card's words, before it takes the new stamp; Continue keeps the draft and the edits.
  it("says what changed when only the offers out moved, and Continue keeps the draft and the typed edits", async () => {
    const outside = {};
    const sentOffer = { id: "offer-0", applicationId: "app-1", status: "sent", timeline: [] };
    const revision = draftRow({ supersedesId: "offer-0" });
    const read = { ...panel(revision), current: sentOffer, draft: revision };
    render(<Harness initial={read} reads={[]} outside={outside} draft={revision} />);
    fireEvent.change(rate(), { target: { value: "24" } });
    act(() => outside.read({ ...read, outStamp: "out-2", current: { ...sentOffer, status: "date_requested", requestedStartDate: "2027-01-18", dateRequestNote: "Need two more weeks" } }));
    expect(await screen.findByText(/changed after you opened this form\. Asked to start Mon, Jan 18, 2027\. Note: Need two more weeks/)).toBeInTheDocument();
    expect(rate()).toBeDisabled();
    expect(rate()).toHaveValue("24");
    expect(screen.queryByRole("button", { name: "Show the new version" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue with this draft" }));
    expect(rate()).toBeEnabled();
    expect(rate()).toHaveValue("24");
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
    const theirs = draftRow({ id: "offer-2", hourlyRate: 27, stepRate: 29, draftHash: "hash-9" });
    render(<Harness initial={{ ...panel(draftRow()), current: null, letterPreview: null }} reads={[panel(theirs)]} outside={outside} />);
    fireEvent.change(rate(), { target: { value: "24" } });
    act(() => outside.fail());
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("This draft changed. Review the new version.")).toBeInTheDocument();
    expect(rate()).toHaveValue("24");
    expect(rate()).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Send offer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show the new version" }));
    expect(rate()).toHaveValue("27");
    expect(rate()).toBeEnabled();
  });

  // Another session can send the first offer while this form has no draft yet: the read then holds that offer out, and
  // a first draft is refused (OFFER_ALREADY_OPEN). The form locks, keeps the typing, and points to the card's Revise.
  it("a form with no draft yet locks when a read shows an offer another session sent, and keeps the typing", async () => {
    const outside = {};
    render(<Harness initial={{ ...panel(draftRow()), current: null, letterPreview: null }} reads={[]} outside={outside} />);
    fireEvent.change(rate(), { target: { value: "24" } });
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
    act(() => outside.read({ ...panel(draftRow({ id: "offer-2", status: "sent", draftHash: null })), draft: null }));
    expect(await screen.findByText("An offer is already out. Close this form and use Revise on the offer card to make an updated one.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(rate()).toHaveValue("24");
  });

  // Typed edits on a saved draft, then a background read fails. Try again's read shows the draft gone (another admin
  // sent it): the form keeps the edits, read-only, and says so, as after any read of that state. The owner closes it.
  it("keeps the typed edits when Try again finds the draft gone, and says the draft is no longer open", async () => {
    const outside = {};
    render(<Harness initial={panel(draftRow())} reads={[panel(draftRow({ status: "sent" }))]} outside={outside} />);
    fireEvent.change(rate(), { target: { value: "24" } });
    act(() => outside.fail());
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("This draft is no longer open. Close this form to see the offer.")).toBeInTheDocument();
    expect(rate()).toHaveValue("24");
    expect(rate()).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Send offer" })).toBeNull();
  });

  // A save whose read finds the draft gone (another admin sent it between the save and the read): the read worked, so
  // the form says the draft is no longer open, never that the read failed, and the owner closes it.
  it("after a save, a read that no longer holds the draft says it is no longer open, not that the read failed", async () => {
    saveOfferDraft.mockResolvedValueOnce({ offer: draftRow({ hourlyRate: 24, draftHash: "hash-2" }) });
    render(<Harness initial={panel(draftRow())} reads={[panel(draftRow({ hourlyRate: 24, draftHash: "hash-2", status: "sent" }))]} />);
    fireEvent.change(rate(), { target: { value: "24" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("This draft is no longer open. Close this form to see the offer.")).toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(rate()).toBeDisabled();
  });

  // Every rule the server checks on a save is checked as the owner types: Save stays off, with the reason beside the
  // field, instead of a save the server refuses.
  it.each([
    ["a blank job", "Job", "", "Enter the job title."],
    ["a job that mentions a drug test", "Job", "Technician (drug test required)", "The job title cannot mention a background check or a drug test."],
    ["a job whose double space hides a drug test", "Job", "Technician, drug  test", "The job title cannot mention a background check or a drug test."],
    ["a blank start date", "Start date", "", "Pick a start date."],
    ["blank hours", "Hours", " ", "Enter the hours."],
    ["a blank hourly rate", "Hourly rate ($)", "", "Enter the hourly rate."],
    ["an hourly rate under $15", "Hourly rate ($)", "14.99", "Enter $15.00 to $60.00."],
    ["a step rate over $60", "Step rate ($)", "60.01", "Enter $15.00 to $60.00."],
    ["a step rate not above the hourly rate", "Step rate ($)", "23", "Enter a step rate above the hourly rate."],
    ["a cleared step date with a step rate", "Step date", "", "Pick the step date."],
    ["a step date that is not a Monday", "Step date", "2027-04-06", "Pick a Monday."],
    ["a step date not after the start", "Step date", "2026-12-28", "Pick a day after the start date."],
  ])("keeps Save off for %s, with the reason beside the field", async (_case, label, value, message) => {
    render(<Harness initial={panel(draftRow())} reads={[]} />);
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(saveOfferDraft).not.toHaveBeenCalled();
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
    expect(sendOffer).toHaveBeenCalledWith("app-1", "offer-1", "hash-1", "out-1");
  });

  // A rate field holds the text the owner typed. Text that is not dollars and cents is an error to fix, never a cleared
  // rate: a number field reports such text as empty, which read as "no raise" and dropped the step date on Save.
  it("keeps a raise whose step rate text is not a number, says so, and keeps Save off", () => {
    render(<Harness initial={panel(draftRow())} reads={[]} />);
    fireEvent.change(screen.getByLabelText("Step rate ($)"), { target: { value: "2e" } });
    expect(screen.getByLabelText("Step rate ($)")).toHaveValue("2e");
    expect(screen.getByText("Enter dollars and cents, like 23.50.")).toBeInTheDocument();
    expect(screen.getByLabelText("Step date")).toBeEnabled();
    expect(screen.getByLabelText("Step date")).toHaveValue(STEP);
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Step rate ($)"), { target: { value: "26.5" } });
    expect(screen.queryByText("Enter dollars and cents, like 23.50.")).toBeNull();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
    expect(saveOfferDraft).not.toHaveBeenCalled();
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
