// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminFetch, refresh } = vi.hoisted(() => ({
  adminFetch: vi.fn(),
  refresh: { callback: null },
}));
vi.mock("../../utils/admin-fetch", () => ({
  adminFetch: (...args) => adminFetch(...args),
}));
vi.mock("../../hooks/useVisiblePageRefresh", () => ({
  default: (callback) => {
    refresh.callback = callback;
  },
}));

import PendingDraftsTab from "./PendingDraftsTab";

const DRAFTS = {
  drafts: [
    {
      id: "d1",
      customerName: "Pat Customer",
      customerPhone: "+19415550100",
      recipientPhone: "+19415550100",
      inboundMessage: null,
      draftResponse: "Hi Pat, thanks for clicking through on your estimate.",
      // Real click-followup rows carry the intent and NO campaign_type
      // (click-followup.js inserts none) — the lane must come from intent.
      intent: "click_followup",
      campaignType: null,
      contextSummary: null,
      createdAt: new Date().toISOString(),
    },
    {
      id: "d2",
      customerName: "Sam Owner",
      customerPhone: "+19415550101",
      recipientPhone: "+19415550101",
      inboundMessage: "What time are you coming?",
      draftResponse: "We have you down for tomorrow between 9 and 11.",
      intent: "scheduling",
      campaignType: null,
      contextSummary: null,
      resolvedFromNumber: "+19415551000",
      createdAt: new Date().toISOString(),
    },
  ],
  pendingCount: 2,
};

describe("PendingDraftsTab", () => {
  beforeEach(() => {
    adminFetch.mockReset();
    adminFetch.mockResolvedValue(DRAFTS);
    refresh.callback = null;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("lists pending drafts with lane chips and deep links", async () => {
    render(<PendingDraftsTab embedded />);
    expect(await screen.findByText("Pat Customer")).toBeInTheDocument();
    expect(screen.getByText("2 pending drafts")).toBeInTheDocument();
    expect(screen.getByText("Click follow-up")).toBeInTheDocument();
    expect(screen.getByText("Reply draft")).toBeInTheDocument();
    const links = screen.getAllByText("Open in Communications");
    // The deep link pins the recipient; the From arrives via the
    // composer's own draft fetch (server-config-resolved), never a URL
    // number literal.
    expect(links[0]).toHaveAttribute("href", "/admin/communications?draftId=d1&phone=%2B19415550100");
    expect(links[1]).toHaveAttribute("href", "/admin/communications?draftId=d2&phone=%2B19415550101");
    expect(adminFetch).toHaveBeenCalledWith("/admin/drafts?status=pending");
  });

  it.each([false, true])("unlocks drafts when a refresh supersedes Retry (failure=%s)", async (fails) => {
    render(<PendingDraftsTab embedded />);
    await screen.findByText("Pat Customer");
    adminFetch.mockRejectedValueOnce(new Error("Temporary failure"));
    await act(async () => refresh.callback());
    const retry = screen.getByRole("button", { name: "Retry" });
    let finishRetry;
    let finishRefresh;
    adminFetch.mockReturnValueOnce(new Promise((resolve) => { finishRetry = resolve; }));
    adminFetch.mockReturnValueOnce(new Promise((resolve, reject) => {
      finishRefresh = () => fails ? reject(new Error("Refresh failed")) : resolve(DRAFTS);
    }));
    let refreshPromise;
    act(() => {
      retry.click();
      refreshPromise = refresh.callback();
    });
    await act(async () => finishRetry({ drafts: [], pendingCount: 0 }));
    expect(screen.getAllByText("Reject")[0]).toBeDisabled();
    await act(async () => { finishRefresh(); await refreshPromise; });
    expect(screen.getByText("Pat Customer")).toBeInTheDocument();
    expect(screen.getAllByText("Reject")[0]).not.toBeDisabled();
    if (fails) expect(screen.getByRole("button", { name: "Retry" })).not.toBeDisabled();
    await act(async () => refresh.callback());
    expect(adminFetch).toHaveBeenCalledTimes(5);
  });

  it("locks every card while one mutation is in flight", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PendingDraftsTab embedded />);
    await screen.findByText("Pat Customer");
    let finish;
    adminFetch.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getAllByText("Approve & send")[0]);
    // busyId names only d1, but d2's actions must lock too:
    // a second action would overwrite busyId and the first to finish
    // would re-enable everything with the other still pending.
    await waitFor(() => expect(screen.getAllByText("Approve & send")[1]).toBeDisabled());
    expect(screen.getAllByText("Reject")[1]).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
    finish({ success: true });
    await waitFor(() => expect(screen.queryByText("Pat Customer")).not.toBeInTheDocument());
    expect(screen.getAllByText("Approve & send")[0]).not.toBeDisabled();
  });

  it("approve confirms, PUTs, and removes the card", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PendingDraftsTab embedded />);
    await screen.findByText("Pat Customer");
    adminFetch.mockResolvedValueOnce({ success: true });
    fireEvent.click(screen.getAllByText("Approve & send")[0]);
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith("/admin/drafts/d1/approve", { method: "PUT" }));
    await waitFor(() => expect(screen.queryByText("Pat Customer")).not.toBeInTheDocument());
    expect(screen.getByText("Sam Owner")).toBeInTheDocument();
  });

  it("a declined confirm sends nothing", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<PendingDraftsTab embedded />);
    await screen.findByText("Pat Customer");
    fireEvent.click(screen.getAllByText("Approve & send")[0]);
    expect(adminFetch).toHaveBeenCalledTimes(1); // only the initial list load
  });

  it("revise sends the edited text through /revise", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PendingDraftsTab embedded />);
    await screen.findByText("Sam Owner");
    fireEvent.click(screen.getAllByText("Revise")[1]);
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Tomorrow 9-11am. See you then." } });
    adminFetch.mockResolvedValueOnce({ success: true });
    fireEvent.click(screen.getByText("Send revised"));
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith("/admin/drafts/d2/revise", {
      method: "PUT",
      body: JSON.stringify({ revisedResponse: "Tomorrow 9-11am. See you then." }),
    }));
  });

  it("a 409 (already actioned elsewhere) reloads the live queue", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PendingDraftsTab embedded />);
    await screen.findByText("Pat Customer");
    const conflict = Object.assign(new Error("Draft is no longer pending"), { status: 409 });
    adminFetch.mockRejectedValueOnce(conflict);
    adminFetch.mockResolvedValueOnce({ drafts: [], pendingCount: 0 });
    fireEvent.click(screen.getAllByText("Reject")[0]);
    await waitFor(() => expect(screen.getByText("Draft is no longer pending")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("No pending drafts", { exact: false })).toBeInTheDocument());
  });

  it("a photo-triage draft shows its lane and a View assessment link to its assessment", async () => {
    adminFetch.mockResolvedValue({
      drafts: [
        {
          id: "d3",
          customerName: "Lee Customer",
          customerPhone: "+19415550102",
          recipientPhone: "+19415550102",
          inboundMessage: "what is this in my yard",
          draftResponse: "Thanks for the photo, Lee.",
          intent: "photo_triage",
          campaignType: null,
          contextSummary: null,
          flags: { origin: "photo_triage", assessment_type: "lawn", assessment_id: "a-1" },
          createdAt: new Date().toISOString(),
        },
        { ...DRAFTS.drafts[1], flags: { assessment_type: "lawn", assessment_id: "a-2" } },
      ],
      pendingCount: 2,
    });
    render(<PendingDraftsTab embedded />);
    expect(await screen.findByText("Lee Customer")).toBeInTheDocument();
    expect(screen.getByText("Photo triage")).toBeInTheDocument();
    // Only the photo-triage card links out — a stray flag on another
    // intent never renders a link.
    const links = screen.getAllByText("View assessment");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/admin/lawn-assessments?open=lawn%3Aa-1");
  });

  it("hides Revise only on gauge-written photo-triage drafts; older ones stay revisable", async () => {
    const base = {
      customerPhone: "+19415550102", recipientPhone: "+19415550102", inboundMessage: "what is this",
      draftResponse: "Thanks for the photo.", intent: "photo_triage", campaignType: null, contextSummary: null,
      createdAt: new Date().toISOString(),
    };
    adminFetch.mockResolvedValue({
      drafts: [
        { ...base, id: "g1", customerName: "Gauged Customer", flags: { origin: "photo_triage", gauge_version: 1 } },
        { ...base, id: "l1", customerName: "Legacy Customer", flags: { origin: "photo_triage" } },
      ],
      pendingCount: 2,
    });
    render(<PendingDraftsTab embedded />);
    await screen.findByText("Gauged Customer");
    expect(screen.getAllByText("Revise")).toHaveLength(1);
    expect(screen.getAllByText("Approve & send")).toHaveLength(2);
  });

  it("empty queue renders the explainer", async () => {
    adminFetch.mockResolvedValue({ drafts: [], pendingCount: 0 });
    render(<PendingDraftsTab embedded />);
    expect(await screen.findByText("No pending drafts", { exact: false })).toBeInTheDocument();
  });

  it("a terminal 422 (campaign retired) also reloads the live queue", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PendingDraftsTab embedded />);
    await screen.findByText("Pat Customer");
    const ineligible = Object.assign(new Error("Campaign no longer eligible"), { status: 422 });
    adminFetch.mockRejectedValueOnce(ineligible);
    adminFetch.mockResolvedValueOnce({ drafts: [DRAFTS.drafts[1]], pendingCount: 1 });
    fireEvent.click(screen.getAllByText("Approve & send")[0]);
    await waitFor(() => expect(screen.getByText("Campaign no longer eligible")).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText("Pat Customer")).not.toBeInTheDocument());
    expect(screen.getByText("Sam Owner")).toBeInTheDocument();
  });

  it("a vanished lane filter falls back to All instead of stranding an empty view", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PendingDraftsTab embedded />);
    await screen.findByText("Pat Customer");
    fireEvent.click(screen.getByText("Click follow-up 1")); // filter to Pat's lane
    expect(screen.queryByText("Sam Owner")).not.toBeInTheDocument();
    adminFetch.mockResolvedValueOnce({ success: true });
    fireEvent.click(screen.getByText("Reject")); // action the lane's last draft
    await waitFor(() => expect(screen.queryByText("Pat Customer")).not.toBeInTheDocument());
    expect(screen.getByText("Sam Owner")).toBeInTheDocument(); // fell back to All
  });

  it("pages older drafts with the server cursor and appends without duplicates", async () => {
    adminFetch.mockResolvedValue({ drafts: DRAFTS.drafts, pendingCount: 3, nextCursor: "d2" });
    render(<PendingDraftsTab embedded />);
    await screen.findByText("Pat Customer");
    expect(screen.getByText("3 pending drafts")).toBeInTheDocument();
    expect(screen.getByText("(showing 2)")).toBeInTheDocument();
    adminFetch.mockResolvedValueOnce({
      drafts: [DRAFTS.drafts[1], { ...DRAFTS.drafts[0], id: "d3", customerName: "Old Draft" }],
      pendingCount: 3,
      nextCursor: null,
    });
    fireEvent.click(screen.getByText("Load older drafts"));
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith(
      "/admin/drafts?status=pending&before=d2",
    ));
    await waitFor(() => expect(screen.getByText("Old Draft")).toBeInTheDocument());
    expect(screen.getAllByText("Sam Owner")).toHaveLength(1); // dedup by id
    expect(screen.queryByText("Load older drafts")).not.toBeInTheDocument(); // cursor exhausted
  });

  it("keeps an older page when an earlier background refresh resolves last", async () => {
    const firstPage = { drafts: DRAFTS.drafts, pendingCount: 3, nextCursor: "d2" };
    adminFetch.mockResolvedValueOnce(firstPage);
    render(<PendingDraftsTab embedded />);
    await screen.findByText("Pat Customer");

    let finishRefresh;
    adminFetch.mockReturnValueOnce(new Promise((resolve) => { finishRefresh = resolve; }));
    act(() => { void refresh.callback(); });
    await waitFor(() => expect(adminFetch).toHaveBeenCalledTimes(2));

    const oldDraft = { ...DRAFTS.drafts[0], id: "d3", customerName: "Old Draft" };
    adminFetch.mockResolvedValueOnce({ drafts: [oldDraft], pendingCount: 3, nextCursor: null });
    fireEvent.click(screen.getByText("Load older drafts"));
    expect(await screen.findByText("Old Draft")).toBeInTheDocument();

    await act(async () => { finishRefresh(firstPage); });
    expect(screen.getByText("Old Draft")).toBeInTheDocument();
    expect(screen.queryByText("Load older drafts")).not.toBeInTheDocument();
  });

  it("keeps loaded older drafts when a background refresh runs", async () => {
    adminFetch.mockResolvedValueOnce({ drafts: DRAFTS.drafts, pendingCount: 3, nextCursor: "d2" });
    render(<PendingDraftsTab embedded />);
    await screen.findByText("Pat Customer");
    const oldDraft = { ...DRAFTS.drafts[0], id: "d3", customerName: "Old Draft" };
    adminFetch.mockResolvedValueOnce({ drafts: [oldDraft], pendingCount: 3, nextCursor: null });
    fireEvent.click(screen.getByText("Load older drafts"));
    expect(await screen.findByText("Old Draft")).toBeInTheDocument();

    adminFetch
      .mockResolvedValueOnce({ drafts: DRAFTS.drafts, pendingCount: 3, nextCursor: "d2" })
      .mockResolvedValueOnce({ drafts: [oldDraft], pendingCount: 3, nextCursor: null });
    await act(async () => refresh.callback());

    await waitFor(() => expect(adminFetch.mock.calls.filter(([url]) =>
      url === "/admin/drafts?status=pending&before=d2"
    )).toHaveLength(2));
    expect(screen.getByText("Old Draft")).toBeInTheDocument();
  });

  it("does not poll while a draft revision is open and dirty", async () => {
    render(<PendingDraftsTab embedded />);
    await screen.findByText("Pat Customer");

    fireEvent.click(screen.getAllByText("Revise")[0]);
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Unsaved revised message" } });

    await act(async () => refresh.callback());
    expect(adminFetch).toHaveBeenCalledTimes(1);
    expect(textarea).toHaveValue("Unsaved revised message");
  });

  it("discards a pending refresh when revision editing starts", async () => {
    render(<PendingDraftsTab embedded />);
    await screen.findByText("Pat Customer");

    let finishRefresh;
    adminFetch.mockReturnValueOnce(new Promise((resolve) => { finishRefresh = resolve; }));
    let refreshPromise;
    act(() => { refreshPromise = refresh.callback(); });
    await waitFor(() => expect(adminFetch).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getAllByText("Revise")[0]);
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Keep this pending revision" } });

    await act(async () => {
      finishRefresh({
        drafts: [{ ...DRAFTS.drafts[1], id: "d3", customerName: "New Draft" }],
        pendingCount: 2,
      });
      await refreshPromise;
    });

    expect(screen.getByText("Pat Customer")).toBeInTheDocument();
    expect(screen.queryByText("New Draft")).not.toBeInTheDocument();
    expect(textarea).toHaveValue("Keep this pending revision");
  });

  it("resumes polling after a revised draft is sent and unmounted", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PendingDraftsTab embedded />);
    await screen.findByText("Pat Customer");

    fireEvent.click(screen.getAllByText("Revise")[0]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Send this revision" } });
    adminFetch.mockResolvedValueOnce({ success: true });
    fireEvent.click(screen.getByText("Send revised"));
    await waitFor(() => expect(screen.queryByText("Pat Customer")).not.toBeInTheDocument());

    adminFetch.mockResolvedValueOnce({ drafts: [DRAFTS.drafts[1]], pendingCount: 1 });
    await act(async () => refresh.callback());
    expect(adminFetch.mock.calls.filter(([url]) => url === "/admin/drafts?status=pending")).toHaveLength(2);
  });
});
